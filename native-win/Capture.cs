using System.Runtime.InteropServices;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.MediaFoundation;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using WinRT;

namespace Loupe.Native;

[ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IGraphicsCaptureItemInterop
{
    IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);
    IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
}

[ComImport, Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDirect3DDxgiInterfaceAccess
{
    IntPtr GetInterface([In] ref Guid iid);
}

// `loupe-native capture --source <display:N|window:N> --out <file.mp4> --mic <0|1>
//   [--system-audio <0|1>] [--crop-x N --crop-y N --crop-w N --crop-h N]`
//
// The Windows counterpart of Capture.swift: Windows.Graphics.Capture for the
// pixels (without the cursor -- it is drawn at export, like on macOS), Media
// Foundation's sink writer for a hardware-encoded H.264 MP4, and the
// microphone into the same file. Messages:
//   {"type":"started","clock","now"}  the first frame, on the QPC clock inputtap uses
//   {"type":"progress","frames","bytes","now"}
//   {"type":"system_audio","file"}  computer sound is being written (SystemAudio.cs)
//   {"type":"warning","message"}    computer sound failed; the video carries on
//   {"type":"stopped","duration"}
//   {"type":"error","message"}
// Crop values are physical pixels in global screen space (main.js converts
// from DIPs). Loupe's own windows use SetWindowDisplayAffinity
// (WDA_EXCLUDEFROMCAPTURE, set by Electron's setContentProtection), which
// keeps them out of the capture, so --exclude-window is accepted and ignored.
static class Capture
{
    static readonly Guid GraphicsCaptureItemIid = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");

    [DllImport("d3d11.dll", EntryPoint = "CreateDirect3D11DeviceFromDXGIDevice")]
    static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

    public static int Run(string[] argv)
    {
        var sourceId = Args.Get(argv, "--source");
        var outPath = Args.Get(argv, "--out");
        if (sourceId == null || outPath == null)
            return Out.Fail("usage: capture --source <id> --out <path> --mic <0|1> [--mic-name <name>] [--system-audio <0|1>] [--crop-x N --crop-y N --crop-w N --crop-h N]");
        bool withMic = Args.Get(argv, "--mic") == "1";
        bool withSystemAudio = Args.Get(argv, "--system-audio") == "1";
        var micName = Args.Get(argv, "--mic-name");

        var parts = sourceId.Split(':');
        if (parts.Length != 2 || !ulong.TryParse(parts[1], out var handleValue))
            return Out.Fail($"bad source id: {sourceId}");
        var handle = new IntPtr((long)handleValue);

        if (!GraphicsCaptureSession.IsSupported())
            return Out.Fail("screen capture needs Windows 10 version 2004 or later");

        // Where the source sits on screen, for rebasing a crop against it.
        Win32.RECT origin;
        if (parts[0] == "display")
        {
            var monitor = Win32.Monitors().FirstOrDefault(m => m.handle == handle);
            if (monitor.handle == IntPtr.Zero) return Out.Fail($"display not found: {sourceId}");
            origin = monitor.rect;
        }
        else if (parts[0] == "window")
        {
            if (!Win32.IsWindow(handle)) return Out.Fail($"window not found: {sourceId}");
            origin = Win32.FrameBounds(handle);
        }
        else return Out.Fail($"bad source id: {sourceId}");

        var cx = Args.Number(argv, "--crop-x");
        var cy = Args.Number(argv, "--crop-y");
        var cw = Args.Number(argv, "--crop-w");
        var ch = Args.Number(argv, "--crop-h");
        bool cropped = cx != null && cy != null && cw != null && ch != null;

        MediaFactory.MFStartup(true).CheckError();
        using var session = new Session(outPath, withMic, withSystemAudio, micName);
        try
        {
            session.Start(parts[0] == "display", handle, origin,
                cropped ? (cx!.Value, cy!.Value, cw!.Value, ch!.Value) : null);
        }
        catch (Exception e)
        {
            return Out.Fail(e.Message);
        }
        StopSignal.OnStop(session.Stop);
        int code = session.WaitUntilFinished();
        Out.Drain();
        return code;
    }

    sealed class Session : IDisposable
    {
        const long Ticks = 10_000_000; // Media Foundation time is in 100ns
        const double MinFrameInterval = 1.0 / 60 - 0.002;
        const double IdleRepaintInterval = 0.5; // see Capture.swift: same reasoning

        readonly string outPath;
        readonly bool withMic, withSystemAudio;
        SystemAudio? systemAudio;
        readonly object gate = new();
        readonly ManualResetEventSlim finished = new();
        int exitCode;

        ID3D11Device device = null!;
        ID3D11DeviceContext context = null!;
        IDirect3DDevice winrtDevice = null!;
        GraphicsCaptureItem item = null!;
        Direct3D11CaptureFramePool pool = null!;
        GraphicsCaptureSession capture = null!;
        Windows.Graphics.SizeInt32 poolSize;
        ID3D11Texture2D? staging;

        int outW, outH;
        int offsetX, offsetY; // crop origin inside the captured content
        byte[] frame = Array.Empty<byte>();

        IMFSinkWriter writer = null!;
        int videoStream, audioStream = -1;
        double? startClock;
        double lastFrameClock = double.NegativeInfinity; // last time real content arrived
        long lastSampleTime = -1;
        int frames;
        bool stopping, finalized;
        Timer? idleTimer;

        IMFSourceReader? micReader;
        IMFMediaSource? micSource;
        Thread? micThread;

        readonly string? micName;

        public Session(string outPath, bool withMic, bool withSystemAudio, string? micName = null)
        {
            this.micName = micName;
            this.outPath = outPath;
            this.withMic = withMic;
            this.withSystemAudio = withSystemAudio;
        }

        public void Start(bool isDisplay, IntPtr handle, Win32.RECT origin, (double x, double y, double w, double h)? crop)
        {
            // ---- Direct3D, shared with Windows.Graphics.Capture --------------
            var result = D3D11.D3D11CreateDevice(null, DriverType.Hardware, DeviceCreationFlags.BgraSupport,
                null!, out device!);
            if (result.Failure)
                D3D11.D3D11CreateDevice(null, DriverType.Warp, DeviceCreationFlags.BgraSupport, null!, out device!).CheckError();
            context = device.ImmediateContext;
            using (var dxgi = device.QueryInterface<IDXGIDevice>())
            {
                int hr = CreateDirect3D11DeviceFromDXGIDevice(dxgi.NativePointer, out var ptr);
                if (hr < 0) throw new InvalidOperationException($"could not create a capture device (0x{hr:X8})");
                winrtDevice = MarshalInterface<IDirect3DDevice>.FromAbi(ptr);
                Marshal.Release(ptr);
            }

            var interop = GraphicsCaptureItem.As<IGraphicsCaptureItemInterop>();
            var iid = GraphicsCaptureItemIid;
            IntPtr itemPtr = isDisplay ? interop.CreateForMonitor(handle, ref iid) : interop.CreateForWindow(handle, ref iid);
            item = GraphicsCaptureItem.FromAbi(itemPtr);
            Marshal.Release(itemPtr);

            poolSize = item.Size;
            if (crop is { } c)
            {
                offsetX = (int)Math.Round(c.x - origin.Left);
                offsetY = (int)Math.Round(c.y - origin.Top);
                outW = (int)Math.Round(c.w);
                outH = (int)Math.Round(c.h);
            }
            else
            {
                outW = poolSize.Width;
                outH = poolSize.Height;
            }
            // H.264 needs even dimensions.
            outW -= outW % 2;
            outH -= outH % 2;
            if (outW < 2 || outH < 2) throw new InvalidOperationException("the area to record is empty");
            frame = new byte[outW * outH * 4];

            staging = device.CreateTexture2D(new Texture2DDescription
            {
                Width = (uint)outW, Height = (uint)outH, MipLevels = 1, ArraySize = 1,
                Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Staging, CPUAccessFlags = CpuAccessFlags.Read, BindFlags = BindFlags.None
            });

            // ---- the file ------------------------------------------------------
            if (File.Exists(outPath)) File.Delete(outPath);
            CreateWriter();

            // ---- start ---------------------------------------------------------
            pool = Direct3D11CaptureFramePool.CreateFreeThreaded(winrtDevice,
                DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, poolSize);
            pool.FrameArrived += (p, _) => OnFrame(p);
            item.Closed += (_, _) => Fail("the recorded window was closed");
            capture = pool.CreateCaptureSession(item);
            try { capture.IsCursorCaptureEnabled = false; } catch { /* before 2004 */ }
            try { capture.IsBorderRequired = false; } catch { /* Windows 10: no yellow border to remove */ }
            // Computer sound starts before the first frame so none is missed;
            // SystemAudio drops what arrives before it.
            if (withSystemAudio) StartSystemAudio();
            capture.StartCapture();

            idleTimer = new Timer(_ => RepaintIfIdle(), null, 500, 500);
        }

        void StartSystemAudio()
        {
            // Losing the computer sound is not worth losing the recording
            // over: a warning, not an error (the same as Capture.swift).
            try
            {
                var path = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(outPath))!, SystemAudio.FileName);
                systemAudio = new SystemAudio(path, () => { lock (gate) return startClock; },
                    message => Out.Emit(new { type = "warning", message }));
                systemAudio.Start();
            }
            catch (Exception e)
            {
                systemAudio?.Dispose();
                systemAudio = null;
                Out.Emit(new { type = "warning", message = $"computer sound could not be recorded: {e.Message}" });
            }
        }

        void CreateWriter()
        {
            using var attrs = MediaFactory.MFCreateAttributes(4);
            attrs.Set(SinkWriterAttributeKeys.ReadwriteEnableHardwareTransforms, 1u);
            writer = MediaFactory.MFCreateSinkWriterFromURL(outPath, null!, attrs);

            // Quality high enough that the export, which re-encodes a crop of
            // this, has detail to zoom into.
            long bitrate = Math.Clamp((long)outW * outH * 60 / 8, 8_000_000, 80_000_000);
            using (var output = MediaFactory.MFCreateMediaType())
            {
                output.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Video);
                output.Set(MediaTypeAttributeKeys.Subtype, VideoFormatGuids.H264);
                output.Set(MediaTypeAttributeKeys.AvgBitrate, (uint)bitrate);
                output.Set(MediaTypeAttributeKeys.InterlaceMode, (uint)VideoInterlaceMode.Progressive);
                MediaFactory.MFSetAttributeSize(output, MediaTypeAttributeKeys.FrameSize, (uint)outW, (uint)outH);
                MediaFactory.MFSetAttributeRatio(output, MediaTypeAttributeKeys.FrameRate, 60, 1);
                MediaFactory.MFSetAttributeRatio(output, MediaTypeAttributeKeys.PixelAspectRatio, 1, 1);
                videoStream = writer.AddStream(output);
            }
            using (var input = MediaFactory.MFCreateMediaType())
            {
                input.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Video);
                input.Set(MediaTypeAttributeKeys.Subtype, VideoFormatGuids.Rgb32);
                input.Set(MediaTypeAttributeKeys.InterlaceMode, (uint)VideoInterlaceMode.Progressive);
                input.Set(MediaTypeAttributeKeys.DefaultStride, (uint)(outW * 4)); // top-down rows
                MediaFactory.MFSetAttributeSize(input, MediaTypeAttributeKeys.FrameSize, (uint)outW, (uint)outH);
                MediaFactory.MFSetAttributeRatio(input, MediaTypeAttributeKeys.FrameRate, 60, 1);
                MediaFactory.MFSetAttributeRatio(input, MediaTypeAttributeKeys.PixelAspectRatio, 1, 1);
                writer.SetInputMediaType(videoStream, input, null!);
            }

            if (withMic) AddMicrophone();
            writer.BeginWriting();
        }

        // The microphone chosen in Settings, by the name the app showed for it
        // (Chromium's label, e.g. "Default - Microphone (Realtek Audio)", which
        // contains the device's friendly name); else the first (default) one,
        // so an unplugged choice still records.
        static IMFActivate? ChooseMicrophone(List<IMFActivate> devices, string? name)
        {
            if (!string.IsNullOrEmpty(name))
            {
                IMFActivate? best = null;
                int bestLength = 0;
                foreach (var d in devices)
                {
                    string? friendly;
                    try { friendly = d.GetAllocatedString(CaptureDeviceAttributeKeys.FriendlyName); }
                    catch { continue; }
                    if (string.IsNullOrEmpty(friendly)) continue;
                    if (friendly == name) return d;
                    if (name.Contains(friendly) && friendly.Length > bestLength) { best = d; bestLength = friendly.Length; }
                }
                if (best != null) return best;
            }
            return devices.FirstOrDefault();
        }

        void AddMicrophone()
        {
            IMFActivate? activate;
            try { activate = ChooseMicrophone(MediaFactory.MFEnumAudioDeviceSources(Vortice.Multimedia.AudioEndpointRole.Console).ToList(), micName); }
            catch { activate = null; }
            if (activate == null) throw new InvalidOperationException("no microphone available");
            try { micSource = activate.ActivateObject<IMFMediaSource>(); }
            catch (Exception e) { throw new InvalidOperationException($"no microphone available: {e.Message}"); }
            micReader = MediaFactory.MFCreateSourceReaderFromMediaSource(micSource, null!);

            using var native = micReader.GetNativeMediaType(SourceReaderIndex.FirstAudioStream, 0);
            uint rate = MediaFactory.MFGetAttributeUInt32(native, MediaTypeAttributeKeys.AudioSamplesPerSecond, 48000);
            uint channels = Math.Min(2u, MediaFactory.MFGetAttributeUInt32(native, MediaTypeAttributeKeys.AudioNumChannels, 1));
            // The AAC encoder takes 16-bit PCM at 44.1 or 48 kHz; ask the
            // reader to convert to that.
            if (rate != 44100 && rate != 48000) rate = 48000;
            using (var pcm = MediaFactory.MFCreateMediaType())
            {
                pcm.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Audio);
                pcm.Set(MediaTypeAttributeKeys.Subtype, AudioFormatGuids.Pcm);
                pcm.Set(MediaTypeAttributeKeys.AudioBitsPerSample, 16u);
                pcm.Set(MediaTypeAttributeKeys.AudioSamplesPerSecond, rate);
                pcm.Set(MediaTypeAttributeKeys.AudioNumChannels, channels);
                pcm.Set(MediaTypeAttributeKeys.AudioBlockAlignment, channels * 2);
                pcm.Set(MediaTypeAttributeKeys.AudioAvgBytesPerSecond, rate * channels * 2);
                micReader.SetCurrentMediaType(SourceReaderIndex.FirstAudioStream, pcm);
            }
            using var current = micReader.GetCurrentMediaType(SourceReaderIndex.FirstAudioStream);

            using (var aac = MediaFactory.MFCreateMediaType())
            {
                aac.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Audio);
                aac.Set(MediaTypeAttributeKeys.Subtype, AudioFormatGuids.Aac);
                aac.Set(MediaTypeAttributeKeys.AudioBitsPerSample, 16u);
                aac.Set(MediaTypeAttributeKeys.AudioSamplesPerSecond, rate);
                aac.Set(MediaTypeAttributeKeys.AudioNumChannels, channels);
                aac.Set(MediaTypeAttributeKeys.AudioAvgBytesPerSecond, 16000u); // 128 kbps
                audioStream = writer.AddStream(aac);
            }
            writer.SetInputMediaType(audioStream, current, null!);

            micThread = new Thread(MicLoop) { IsBackground = true, Name = "microphone" };
        }

        void MicLoop()
        {
            double? audioTime = null;
            while (true)
            {
                IMFSample? sample;
                SourceReaderFlag flags;
                try
                {
                    sample = micReader!.ReadSample(SourceReaderIndex.FirstAudioStream, SourceReaderControlFlag.None,
                        out _, out flags, out _);
                }
                catch (Exception e)
                {
                    lock (gate) { if (stopping) return; }
                    Fail($"microphone stopped: {e.Message}");
                    return;
                }
                using (sample)
                {
                    if ((flags & SourceReaderFlag.EndOfStream) != 0) return;
                    if (sample == null) continue;
                    lock (gate)
                    {
                        if (stopping || finalized) return;
                        if (startClock == null) continue; // before the first frame
                        double duration = sample.SampleDuration / (double)Ticks;
                        double now = Clock.Now() - startClock.Value;
                        // Stamped on the capture clock: the sound in this
                        // buffer ended about now. Kept continuous, and only
                        // pulled back into line if it drifts noticeably.
                        double expected = Math.Max(0, now - duration);
                        if (audioTime == null || Math.Abs(audioTime.Value - expected) > 0.1) audioTime = expected;
                        sample.SampleTime = (long)(audioTime.Value * Ticks);
                        try { writer.WriteSample(audioStream, sample); }
                        catch (Exception e) { ReportWriterFailure(e); }
                        audioTime += duration;
                    }
                }
            }
        }

        void OnFrame(Direct3D11CaptureFramePool p)
        {
            using var captured = p.TryGetNextFrame();
            if (captured == null) return;
            lock (gate)
            {
                if (stopping || finalized) return;

                var content = captured.ContentSize;
                if (content.Width != poolSize.Width || content.Height != poolSize.Height)
                {
                    // A window was resized: keep recording at the original size.
                    poolSize = content;
                    p.Recreate(winrtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, content);
                }

                double clock = captured.SystemRelativeTime.Ticks / (double)Ticks;
                if (startClock != null && clock - lastFrameClock < MinFrameInterval) return;

                var access = captured.Surface.As<IDirect3DDxgiInterfaceAccess>();
                var texIid = typeof(ID3D11Texture2D).GUID;
                using var texture = new ID3D11Texture2D(access.GetInterface(ref texIid));
                if (!ReadBack(texture, content.Width, content.Height)) return;

                if (startClock == null)
                {
                    startClock = clock;
                    micThread?.Start();
                    // `now` pairs this helper's clock with the recorder's
                    // (src/main/clock-sync.js); here it is the same QPC base.
                    Out.Emit(new { type = "started", clock, now = Clock.Now() });
                }
                lastFrameClock = clock;
                WriteFrame(clock - startClock.Value);

                if (frames % 60 == 0)
                {
                    long bytes = 0;
                    try { bytes = new FileInfo(outPath).Length; } catch { }
                    Out.Emit(new { type = "progress", frames, bytes, now = Clock.Now() });
                }
            }
        }

        // Copies the recorded area of the captured texture into `frame`.
        // Must hold `gate` (the immediate context is not thread-safe).
        bool ReadBack(ID3D11Texture2D texture, int contentW, int contentH)
        {
            int left = Math.Clamp(offsetX, 0, contentW), top = Math.Clamp(offsetY, 0, contentH);
            int right = Math.Clamp(offsetX + outW, 0, contentW), bottom = Math.Clamp(offsetY + outH, 0, contentH);
            int w = right - left, h = bottom - top;
            int dstX = left - offsetX, dstY = top - offsetY;
            if (w > 0 && h > 0)
            {
                context.CopySubresourceRegion(staging!, 0, (uint)dstX, (uint)dstY, 0, texture, 0,
                    new Vortice.Mathematics.Box(left, top, 0, right, bottom, 1));
            }
            var mapped = context.Map(staging!, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
            try
            {
                unsafe
                {
                    fixed (byte* dst = frame)
                    {
                        byte* src = (byte*)mapped.DataPointer;
                        int row = outW * 4;
                        for (int y = 0; y < outH; y++)
                        {
                            byte* d = dst + y * row;
                            bool inside = y >= dstY && y < dstY + h;
                            if (!inside || w <= 0) { new Span<byte>(d, row).Clear(); continue; }
                            Buffer.MemoryCopy(src + y * mapped.RowPitch, d, row, row);
                            // Outside the content (a window smaller than when
                            // recording began, or a crop past its edge): black.
                            if (dstX > 0) new Span<byte>(d, dstX * 4).Clear();
                            int after = dstX + w;
                            if (after < outW) new Span<byte>(d + after * 4, (outW - after) * 4).Clear();
                        }
                    }
                }
            }
            finally
            {
                context.Unmap(staging!, 0);
            }
            return true;
        }

        // Must hold `gate`.
        void WriteFrame(double seconds)
        {
            long time = Math.Max((long)(seconds * Ticks), lastSampleTime + 1);
            var buffer = MediaFactory.MFCreateMemoryBuffer(frame.Length);
            try
            {
                buffer.Lock(out var ptr, out _, out _);
                Marshal.Copy(frame, 0, ptr, frame.Length);
                buffer.Unlock();
                buffer.CurrentLength = frame.Length;
                using var sample = MediaFactory.MFCreateSample();
                sample.AddBuffer(buffer);
                sample.SampleTime = time;
                sample.SampleDuration = Ticks / 60;
                writer.WriteSample(videoStream, sample);
                lastSampleTime = time;
                frames++;
            }
            catch (Exception e)
            {
                ReportWriterFailure(e);
            }
            finally
            {
                buffer.Dispose();
            }
        }

        bool writerFailureReported;
        void ReportWriterFailure(Exception e)
        {
            if (writerFailureReported) return;
            writerFailureReported = true;
            Out.Error($"video append failed: {e.Message}");
        }

        // A still screen produces no frames; re-append the last one so the
        // file keeps pace with the clock (the same idea as Capture.swift).
        void RepaintIfIdle()
        {
            lock (gate)
            {
                if (stopping || finalized || startClock == null) return;
                double now = Clock.Now();
                if (now - lastFrameClock < IdleRepaintInterval) return;
                double lastWritten = lastSampleTime / (double)Ticks + startClock.Value;
                if (now - lastWritten < IdleRepaintInterval) return;
                WriteFrame(now - startClock.Value);
            }
        }

        public void Stop() => Finish(0, null);

        void Fail(string message) => Finish(1, message);

        void Finish(int code, string? error)
        {
            lock (gate)
            {
                if (stopping) return;
                stopping = true;
            }
            idleTimer?.Dispose();
            try { capture?.Dispose(); } catch { }
            try { pool?.Dispose(); } catch { }
            try { micReader?.Flush(SourceReaderIndex.FirstAudioStream); } catch { }
            try { micSource?.Shutdown(); } catch { }
            micThread?.Join(1000);

            double duration = 0;
            lock (gate) { if (startClock != null) duration = Clock.Now() - startClock.Value; }
            try { systemAudio?.Finish(duration); } catch (Exception e) { Out.Emit(new { type = "warning", message = $"computer sound: {e.Message}" }); }
            lock (gate)
            {
                if (startClock != null)
                {
                    duration = Clock.Now() - startClock.Value;
                    // Hold the last picture to the very end of the recording.
                    WriteFrame(duration);
                }
                try
                {
                    if (startClock != null) writer.Finalize();
                }
                catch (Exception e)
                {
                    Out.Error($"could not finish the recording: {e.Message}");
                    code = 1;
                }
                finalized = true;
            }
            Out.Emit(new { type = "stopped", duration });
            if (error != null) Out.Error(error);
            exitCode = code;
            finished.Set();
        }

        public int WaitUntilFinished()
        {
            finished.Wait();
            return exitCode;
        }

        public void Dispose()
        {
            try { writer?.Dispose(); } catch { }
            try { systemAudio?.Dispose(); } catch { }
            try { micReader?.Dispose(); } catch { }
            try { micSource?.Dispose(); } catch { }
            staging?.Dispose();
            context?.Dispose();
            device?.Dispose();
        }
    }
}
