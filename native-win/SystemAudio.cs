using System.Runtime.InteropServices;

namespace Loupe.Native;

// Computer sound on Windows (`capture --system-audio 1`): WASAPI loopback of
// the default playback device, written to system.wav next to raw.mp4. Plain
// COM interop against the Core Audio interfaces, so nothing beyond what the
// helper already ships is needed. WavFile.cs holds the file format and the
// clock alignment (LoopbackAlign documents the math).
//
// Loopback is polled every 10 ms rather than event-driven: event callbacks for
// loopback streams are unreliable before Windows 10 1703.

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    void EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    void GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient
{
    void Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    void GetBufferSize(out uint frames);
    void GetStreamLatency(out long latency);
    void GetCurrentPadding(out uint frames);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    void GetMixFormat(out IntPtr format);
    void GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    void Start();
    void Stop();
    void Reset();
    void SetEventHandle(IntPtr handle);
    void GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient
{
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
}

sealed class SystemAudio : IDisposable
{
    const int eRender = 0, eConsole = 0, CLSCTX_ALL = 0x17;
    const int AUDCLNT_SHAREMODE_SHARED = 0, AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
    const ushort WAVE_FORMAT_IEEE_FLOAT = 3, WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
    static readonly Guid FloatSubtype = new("00000003-0000-0010-8000-00AA00389B71");

    public const string FileName = "system.wav";

    readonly string path;
    readonly WavWriter wav;
    readonly IAudioClient client;
    readonly IAudioCaptureClient capture;
    readonly int channels, bits, blockAlign;
    readonly bool isFloat;
    readonly Func<double?> startClock;
    readonly Action<string> warn;
    readonly Thread thread;
    volatile bool stopping;
    readonly object fileGate = new();
    bool announced, failed;

    /// Opens the default playback device for loopback. Throws when there is
    /// none (the caller reports a warning and records without it).
    /// `startClock` returns the first video frame's clock once known.
    public SystemAudio(string path, Func<double?> startClock, Action<string> warn)
    {
        this.path = path;
        this.startClock = startClock;
        this.warn = warn;

        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out var device);
        var iid = typeof(IAudioClient).GUID;
        device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out var clientObject);
        client = (IAudioClient)clientObject;

        client.GetMixFormat(out var format);
        int sampleRate;
        try
        {
            ushort tag = (ushort)Marshal.ReadInt16(format, 0);
            channels = Marshal.ReadInt16(format, 2);
            sampleRate = Marshal.ReadInt32(format, 4);
            blockAlign = Marshal.ReadInt16(format, 12);
            bits = Marshal.ReadInt16(format, 14);
            isFloat = tag == WAVE_FORMAT_IEEE_FLOAT ||
                (tag == WAVE_FORMAT_EXTENSIBLE && Marshal.PtrToStructure<Guid>(format + 24) == FloatSubtype);
            // 100 ms of buffer: polled every 10 ms, so it never overflows.
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 1_000_000, 0, format, IntPtr.Zero);
        }
        finally
        {
            Marshal.FreeCoTaskMem(format);
        }
        var captureIid = typeof(IAudioCaptureClient).GUID;
        client.GetService(ref captureIid, out var captureObject);
        capture = (IAudioCaptureClient)captureObject;

        // Stereo is what the editor mixes; more channels keep only the front pair.
        if (File.Exists(path)) File.Delete(path);
        wav = new WavWriter(File.Create(path), sampleRate, Math.Min(channels, 2));
        thread = new Thread(Loop) { IsBackground = true, Name = "computer sound" };
    }

    public void Start()
    {
        client.Start();
        thread.Start();
    }

    void Loop()
    {
        while (!stopping)
        {
            try
            {
                Drain();
            }
            catch (Exception e)
            {
                // A playback device unplugged mid-recording (headphones)
                // invalidates the stream: the video carries on without it.
                if (!failed)
                {
                    failed = true;
                    warn($"computer sound stopped recording: {e.Message}");
                }
                return;
            }
            Thread.Sleep(10);
        }
    }

    void Drain()
    {
        while (true)
        {
            int hr = capture.GetNextPacketSize(out uint packet);
            Marshal.ThrowExceptionForHR(hr);
            if (packet == 0) return;
            hr = capture.GetBuffer(out var data, out uint frames, out uint flags, out _, out ulong qpc);
            Marshal.ThrowExceptionForHR(hr);
            try
            {
                double? start = startClock();
                if (start == null || frames == 0) continue; // before the first video frame
                short[] samples;
                if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0)
                {
                    samples = new short[frames * wav.Channels];
                }
                else
                {
                    var bytes = new byte[frames * blockAlign];
                    Marshal.Copy(data, bytes, 0, bytes.Length);
                    samples = KeepChannels(PcmConvert.ToInt16(bytes, bits, isFloat), channels, wav.Channels);
                }
                // qpcPosition is in 100 ns units of the performance counter.
                double packetClock = qpc / 10_000_000.0;
                lock (fileGate)
                {
                    if (stopping) return;
                    AnnounceOnce();
                    var (silence, skip) = LoopbackAlign.Place(packetClock, start.Value, wav.SampleRate, wav.FramesWritten, frames);
                    if (silence > 0) wav.WriteSilence(silence);
                    if (skip < frames) wav.Write(samples.AsSpan((int)skip * wav.Channels));
                }
            }
            finally
            {
                capture.ReleaseBuffer(frames);
            }
        }
    }

    static short[] KeepChannels(short[] samples, int from, int to)
    {
        if (from == to) return samples;
        int frames = samples.Length / from;
        var output = new short[frames * to];
        for (int f = 0; f < frames; f++)
            for (int c = 0; c < to; c++)
                output[f * to + c] = samples[f * from + Math.Min(c, from - 1)];
        return output;
    }

    // Must hold fileGate.
    void AnnounceOnce()
    {
        if (announced) return;
        announced = true;
        Out.Emit(new { type = "system_audio", file = FileName });
    }

    /// Stops and pads the file with silence to `duration` seconds, so it is as
    /// long as the video even when nothing played at the end.
    public void Finish(double duration)
    {
        stopping = true;
        thread.Join(1000);
        try { client.Stop(); } catch { }
        lock (fileGate)
        {
            if (startClock() != null)
            {
                AnnounceOnce();
                long target = (long)Math.Round(duration * wav.SampleRate);
                if (target > wav.FramesWritten) wav.WriteSilence(target - wav.FramesWritten);
            }
            wav.Finish();
        }
    }

    public void Dispose()
    {
        stopping = true;
        wav.Dispose();
        // Stopped before the first frame: no recording points at the file.
        if (!announced) try { File.Delete(path); } catch { }
        try { Marshal.ReleaseComObject(capture); } catch { }
        try { Marshal.ReleaseComObject(client); } catch { }
    }
}
