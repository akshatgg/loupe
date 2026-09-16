using System.Runtime.InteropServices;
using System.Text.Json;
using Vortice.MediaFoundation;

namespace Loupe.Native;

// `loupe-native render --project <dir> --out <file.mp4> --width W --height H [--codec h264|hevc]`
//
// The Windows counterpart of Render.swift, reading the same project files
// (project.json, camera.bin, cursor.bin, retime.json) and speaking the same
// messages: {"type":"progress","frame","total"}, {"type":"done",...},
// {"type":"error","message"}. Media Foundation decodes and encodes; the
// picture and sound work is Compositor and AudioStretch.
static class Render
{
    const long Ticks = 10_000_000;

    sealed record Plan(int Fps, double OutputDuration, double[] Frames, bool PreservePitch);

    public static int Run(string[] argv)
    {
        var dir = Args.Get(argv, "--project");
        var outPath = Args.Get(argv, "--out");
        if (dir == null || outPath == null || !int.TryParse(Args.Get(argv, "--width"), out int outW)
            || !int.TryParse(Args.Get(argv, "--height"), out int outH) || outW < 2 || outH < 2)
            return Out.Fail("usage: render --project <dir> --out <path> --width W --height H [--codec h264|hevc]");
        bool hevc = Args.Get(argv, "--codec") == "hevc";

        JsonElement project;
        try { project = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "project.json"))).RootElement; }
        catch { return Out.Fail("could not read project.json"); }

        double sourceWidth = project.GetProperty("source").GetProperty("width").GetDouble();
        double sourceHeight = project.GetProperty("source").GetProperty("height").GetDouble();
        var settings = project.TryGetProperty("settings", out var st) ? st : default;
        bool clickHighlights = Bool(settings, "clickHighlights", true);
        bool showCursor = Bool(settings, "showCursor", true);
        var clicks = project.TryGetProperty("clicks", out var cl) && cl.ValueKind == JsonValueKind.Array
            ? cl.EnumerateArray().Select(c => (t: c.GetProperty("t").GetDouble(), x: c.GetProperty("x").GetDouble(), y: c.GetProperty("y").GetDouble())).ToArray()
            : Array.Empty<(double t, double x, double y)>();
        string file = project.TryGetProperty("capture", out var cap) && cap.TryGetProperty("file", out var f)
            ? f.GetString() ?? "raw.mp4" : "raw.mp4";

        var camera = Records(Path.Combine(dir, "camera.bin"));
        var cursor = Records(Path.Combine(dir, "cursor.bin"));
        var noZoom = new Compositor.Camera(1, sourceWidth / 2, sourceHeight / 2);

        MediaFactory.MFStartup(true).CheckError();

        var video = new VideoReader(Path.Combine(dir, file));
        var plan = ReadPlan(dir, video.Duration);

        if (File.Exists(outPath)) File.Delete(outPath);
        var audio = AudioTrack.Read(Path.Combine(dir, file), plan);
        using var writer = new Writer(outPath, outW, outH, plan.Fps, hevc, audio);

        var output = new byte[outW * outH * 4];
        int frame = 0, skipped = 0;
        for (int k = 0; k < plan.Frames.Length; k++)
        {
            double t = plan.Frames[k];
            var source = video.FrameAt(t);
            if (source == null) { skipped++; continue; }

            var cam = Nearest(camera, t) is { } c ? new Compositor.Camera(c[1] == 0 ? 1 : c[1], c[2], c[3]) : noZoom;
            Compositor.Crop(source, video.Width, video.Height, output, outW, outH, sourceWidth, sourceHeight, cam);

            double scale = video.Width / sourceWidth;
            double vw = sourceWidth / cam.Zoom * scale, vh = sourceHeight / cam.Zoom * scale;
            double x0 = cam.Cx * scale - vw / 2, y0 = cam.Cy * scale - vh / 2;
            double OutX(double px) => (px * scale - x0) * (outW / vw);
            double OutY(double py) => (py * scale - y0) * (outH / vh);
            double overlayScale = outW / vw * scale;

            if (clickHighlights)
                foreach (var click in clicks)
                    if (t >= click.t && t - click.t <= 0.5)
                        Compositor.DrawRipple(output, outW, outH, OutX(click.x), OutY(click.y), t - click.t, overlayScale);
            if (showCursor && Nearest(cursor, t) is { } p)
                Compositor.DrawCursor(output, outW, outH, OutX(p[1]), OutY(p[2]), overlayScale);

            writer.WriteVideo(output, k);
            frame++;
            if (frame % 30 == 0) Out.Emit(new { type = "progress", frame, total = plan.Frames.Length });
        }
        writer.Finish();
        video.Dispose();

        Out.Emit(new { type = "done", file = outPath, frames = frame, skippedFrames = skipped });
        Out.Drain();
        return 0;
    }

    static bool Bool(JsonElement obj, string name, bool fallback) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? v.GetBoolean() : fallback;

    static Plan ReadPlan(string dir, double duration)
    {
        try
        {
            var root = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "retime.json"))).RootElement;
            return new Plan(
                root.GetProperty("fps").GetInt32(),
                root.GetProperty("outputDuration").GetDouble(),
                root.GetProperty("frames").EnumerateArray().Select(e => e.GetDouble()).ToArray(),
                !root.TryGetProperty("preservePitch", out var pp) || pp.ValueKind != JsonValueKind.False);
        }
        catch
        {
            // No speed stretches: the recording, straight through, at 60fps.
            int count = Math.Max(1, (int)Math.Ceiling(duration * 60));
            return new Plan(60, duration, Enumerable.Range(0, count).Select(i => i / 60.0).ToArray(), true);
        }
    }

    // camera.bin / cursor.bin: 16-byte little-endian float32 records, time first.
    static float[][] Records(string path)
    {
        if (!File.Exists(path)) return Array.Empty<float[]>();
        var bytes = File.ReadAllBytes(path);
        var list = new float[bytes.Length / 16][];
        for (int i = 0; i < list.Length; i++)
        {
            list[i] = new float[4];
            for (int fld = 0; fld < 4; fld++) list[i][fld] = BitConverter.ToSingle(bytes, i * 16 + fld * 4);
        }
        return list;
    }

    // Nearest sample by time (tracks are 120Hz, denser than any output rate).
    static float[]? Nearest(float[][] track, double t)
    {
        if (track.Length == 0) return null;
        int lo = 0, hi = track.Length - 1;
        while (hi - lo > 1)
        {
            int mid = (lo + hi) / 2;
            if (track[mid][0] <= t) lo = mid; else hi = mid;
        }
        return Math.Abs(track[lo][0] - t) <= Math.Abs(track[hi][0] - t) ? track[lo] : track[hi];
    }

    // ---- decoding --------------------------------------------------------------

    sealed class VideoReader : IDisposable
    {
        readonly IMFSourceReader reader;
        readonly int stride;
        byte[]? current, next, spare;
        double currentTime, nextTime;
        bool ended;

        public int Width { get; }
        public int Height { get; }
        public double Duration { get; }

        public VideoReader(string path)
        {
            using var attrs = MediaFactory.MFCreateAttributes(2);
            attrs.Set(SourceReaderAttributeKeys.EnableVideoProcessing, 1u);
            reader = MediaFactory.MFCreateSourceReaderFromURL(path, attrs);
            reader.SetStreamSelection(SourceReaderIndex.AllStreams, false);
            reader.SetStreamSelection(SourceReaderIndex.FirstVideoStream, true);
            using (var type = MediaFactory.MFCreateMediaType())
            {
                type.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Video);
                type.Set(MediaTypeAttributeKeys.Subtype, VideoFormatGuids.Rgb32);
                reader.SetCurrentMediaType(SourceReaderIndex.FirstVideoStream, type);
            }
            using var actual = reader.GetCurrentMediaType(SourceReaderIndex.FirstVideoStream);
            MediaFactory.MFGetAttributeSize(actual, MediaTypeAttributeKeys.FrameSize, out uint w, out uint h).CheckError();
            Width = (int)w;
            Height = (int)h;
            // A missing stride means the RGB default: bottom-up rows.
            int s = unchecked((int)MediaFactory.MFGetAttributeUInt32(actual, MediaTypeAttributeKeys.DefaultStride, 0));
            stride = s == 0 ? -Width * 4 : s;
            try
            {
                var d = reader.GetPresentationAttribute(SourceReaderIndex.MediaSource, PresentationDescriptionAttributeKeys.Duration);
                Duration = Convert.ToUInt64(d.Value) / (double)Ticks;
            }
            catch { Duration = 0; }
            next = ReadNext(new byte[Width * Height * 4], out nextTime);
        }

        byte[]? ReadNext(byte[] into, out double time)
        {
            time = 0;
            while (!ended)
            {
                var sample = reader.ReadSample(SourceReaderIndex.FirstVideoStream, SourceReaderControlFlag.None,
                    out _, out var flags, out long stamp);
                using (sample)
                {
                    if ((flags & SourceReaderFlag.EndOfStream) != 0) { ended = true; return null; }
                    if (sample == null) continue;
                    time = stamp / (double)Ticks;
                    using var buffer = sample.ConvertToContiguousBuffer();
                    buffer.Lock(out IntPtr data, out _, out int length);
                    try { CopyRows(data, length, into); }
                    finally { buffer.Unlock(); }
                    return into;
                }
            }
            return null;
        }

        void CopyRows(IntPtr data, int length, byte[] into)
        {
            int row = Width * 4, pitch = Math.Abs(stride);
            if (length < pitch * (Height - 1) + row) throw new InvalidOperationException("short video frame");
            for (int y = 0; y < Height; y++)
            {
                int srcRow = stride > 0 ? y : Height - 1 - y;
                Marshal.Copy(data + srcRow * pitch, into, y * row, row);
            }
        }

        // The newest recorded frame at or before `t` (before the first frame,
        // the first frame) -- a fast stretch skips frames, a slow one holds.
        public byte[]? FrameAt(double t)
        {
            while (next != null && nextTime <= t + 1e-4)
            {
                spare = current;
                current = next;
                currentTime = nextTime;
                next = ReadNext(spare ?? new byte[Width * Height * 4], out nextTime);
            }
            return current ?? next;
        }

        public void Dispose() => reader.Dispose();
    }

    sealed class AudioTrack
    {
        public required int Rate, Channels;
        public required short[] Samples; // interleaved, already on the video timeline

        public static AudioTrack? Read(string path, Plan plan)
        {
            IMFSourceReader reader;
            try
            {
                reader = MediaFactory.MFCreateSourceReaderFromURL(path, null!);
                reader.SetStreamSelection(SourceReaderIndex.AllStreams, false);
                reader.SetStreamSelection(SourceReaderIndex.FirstAudioStream, true);
            }
            catch { return null; } // no sound in the recording
            using var owned = reader;

            int rate, channels;
            using (var native = reader.GetNativeMediaType(SourceReaderIndex.FirstAudioStream, 0))
            {
                rate = (int)MediaFactory.MFGetAttributeUInt32(native, MediaTypeAttributeKeys.AudioSamplesPerSecond, 48000);
                channels = (int)Math.Clamp(MediaFactory.MFGetAttributeUInt32(native, MediaTypeAttributeKeys.AudioNumChannels, 2), 1, 2);
            }
            if (rate != 44100 && rate != 48000) rate = 48000;
            using (var pcm = MediaFactory.MFCreateMediaType())
            {
                pcm.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Audio);
                pcm.Set(MediaTypeAttributeKeys.Subtype, AudioFormatGuids.Float);
                pcm.Set(MediaTypeAttributeKeys.AudioBitsPerSample, 32u);
                pcm.Set(MediaTypeAttributeKeys.AudioSamplesPerSecond, (uint)rate);
                pcm.Set(MediaTypeAttributeKeys.AudioNumChannels, (uint)channels);
                pcm.Set(MediaTypeAttributeKeys.AudioBlockAlignment, (uint)(channels * 4));
                pcm.Set(MediaTypeAttributeKeys.AudioAvgBytesPerSecond, (uint)(rate * channels * 4));
                reader.SetCurrentMediaType(SourceReaderIndex.FirstAudioStream, pcm);
            }

            // Laid out by timestamp, so a gap in the recording stays a gap.
            var source = new List<float>();
            while (true)
            {
                var sample = reader.ReadSample(SourceReaderIndex.FirstAudioStream, SourceReaderControlFlag.None,
                    out _, out var flags, out long stamp);
                using (sample)
                {
                    if ((flags & SourceReaderFlag.EndOfStream) != 0) break;
                    if (sample == null) continue;
                    long at = (long)Math.Round(stamp / (double)Ticks * rate) * channels;
                    if (at > source.Count && at - source.Count < (long)rate * channels * 60)
                        source.AddRange(new float[at - source.Count]);
                    using var buffer = sample.ConvertToContiguousBuffer();
                    buffer.Lock(out IntPtr data, out _, out int length);
                    try
                    {
                        var chunk = new float[length / 4];
                        Marshal.Copy(data, chunk, 0, chunk.Length);
                        source.AddRange(chunk);
                    }
                    finally { buffer.Unlock(); }
                }
            }
            if (source.Count == 0) return null;

            int outFrames = (int)Math.Round(plan.OutputDuration * rate);
            var stretched = AudioStretch.Stretch(source.ToArray(), channels, rate,
                new AudioStretch.TimeMap(plan.Frames, plan.Fps), outFrames, plan.PreservePitch);
            var samples = new short[stretched.Length];
            for (int i = 0; i < stretched.Length; i++)
                samples[i] = (short)Math.Clamp(Math.Round(stretched[i] * 32767), short.MinValue, short.MaxValue);
            return new AudioTrack { Rate = rate, Channels = channels, Samples = samples };
        }
    }

    // ---- encoding --------------------------------------------------------------

    sealed class Writer : IDisposable
    {
        readonly IMFSinkWriter writer;
        readonly int videoStream, audioStream = -1;
        readonly int width, height, fps;
        readonly AudioTrack? audio;
        int audioWritten; // frames of audio (not samples)

        public Writer(string path, int width, int height, int fps, bool hevc, AudioTrack? audio)
        {
            this.width = width;
            this.height = height;
            this.fps = fps;
            this.audio = audio;

            using var attrs = MediaFactory.MFCreateAttributes(2);
            attrs.Set(SinkWriterAttributeKeys.ReadwriteEnableHardwareTransforms, 1u);
            writer = MediaFactory.MFCreateSinkWriterFromURL(path, null!, attrs);

            long bitrate = Math.Clamp((long)width * height * fps / 8, 6_000_000, 100_000_000);
            using (var output = MediaFactory.MFCreateMediaType())
            {
                output.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Video);
                output.Set(MediaTypeAttributeKeys.Subtype, hevc ? VideoFormatGuids.Hevc : VideoFormatGuids.H264);
                output.Set(MediaTypeAttributeKeys.AvgBitrate, (uint)bitrate);
                output.Set(MediaTypeAttributeKeys.InterlaceMode, (uint)VideoInterlaceMode.Progressive);
                MediaFactory.MFSetAttributeSize(output, MediaTypeAttributeKeys.FrameSize, (uint)width, (uint)height);
                MediaFactory.MFSetAttributeRatio(output, MediaTypeAttributeKeys.FrameRate, (uint)fps, 1);
                MediaFactory.MFSetAttributeRatio(output, MediaTypeAttributeKeys.PixelAspectRatio, 1, 1);
                videoStream = writer.AddStream(output);
            }
            using (var input = MediaFactory.MFCreateMediaType())
            {
                input.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Video);
                input.Set(MediaTypeAttributeKeys.Subtype, VideoFormatGuids.Rgb32);
                input.Set(MediaTypeAttributeKeys.InterlaceMode, (uint)VideoInterlaceMode.Progressive);
                input.Set(MediaTypeAttributeKeys.DefaultStride, (uint)(width * 4));
                MediaFactory.MFSetAttributeSize(input, MediaTypeAttributeKeys.FrameSize, (uint)width, (uint)height);
                MediaFactory.MFSetAttributeRatio(input, MediaTypeAttributeKeys.FrameRate, (uint)fps, 1);
                MediaFactory.MFSetAttributeRatio(input, MediaTypeAttributeKeys.PixelAspectRatio, 1, 1);
                writer.SetInputMediaType(videoStream, input, null!);
            }

            if (audio != null)
            {
                using (var aac = MediaFactory.MFCreateMediaType())
                {
                    aac.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Audio);
                    aac.Set(MediaTypeAttributeKeys.Subtype, AudioFormatGuids.Aac);
                    aac.Set(MediaTypeAttributeKeys.AudioBitsPerSample, 16u);
                    aac.Set(MediaTypeAttributeKeys.AudioSamplesPerSecond, (uint)audio.Rate);
                    aac.Set(MediaTypeAttributeKeys.AudioNumChannels, (uint)audio.Channels);
                    aac.Set(MediaTypeAttributeKeys.AudioAvgBytesPerSecond, 24000u); // 192 kbps
                    audioStream = writer.AddStream(aac);
                }
                using var pcm = MediaFactory.MFCreateMediaType();
                pcm.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Audio);
                pcm.Set(MediaTypeAttributeKeys.Subtype, AudioFormatGuids.Pcm);
                pcm.Set(MediaTypeAttributeKeys.AudioBitsPerSample, 16u);
                pcm.Set(MediaTypeAttributeKeys.AudioSamplesPerSecond, (uint)audio.Rate);
                pcm.Set(MediaTypeAttributeKeys.AudioNumChannels, (uint)audio.Channels);
                pcm.Set(MediaTypeAttributeKeys.AudioBlockAlignment, (uint)(audio.Channels * 2));
                pcm.Set(MediaTypeAttributeKeys.AudioAvgBytesPerSecond, (uint)(audio.Rate * audio.Channels * 2));
                writer.SetInputMediaType(audioStream, pcm, null!);
            }
            writer.BeginWriting();
        }

        public void WriteVideo(byte[] pixels, int index)
        {
            using var buffer = MediaFactory.MFCreateMemoryBuffer(pixels.Length);
            buffer.Lock(out IntPtr ptr, out _, out _);
            Marshal.Copy(pixels, 0, ptr, pixels.Length);
            buffer.Unlock();
            buffer.CurrentLength = pixels.Length;
            using var sample = MediaFactory.MFCreateSample();
            sample.AddBuffer(buffer);
            sample.SampleTime = index * Ticks / fps;
            sample.SampleDuration = Ticks / fps;
            writer.WriteSample(videoStream, sample);
            // Sound goes in alongside, up to a second ahead of the picture.
            WriteAudio((index + 1.0) / fps + 1.0);
        }

        void WriteAudio(double until)
        {
            if (audio == null) return;
            int total = audio.Samples.Length / audio.Channels;
            int limit = double.IsInfinity(until) ? total : Math.Min(total, (int)(until * audio.Rate));
            const int Chunk = 1024;
            while (audioWritten < limit)
            {
                int frames = Math.Min(Chunk, total - audioWritten);
                int bytes = frames * audio.Channels * 2;
                using var buffer = MediaFactory.MFCreateMemoryBuffer(bytes);
                buffer.Lock(out IntPtr ptr, out _, out _);
                Marshal.Copy(audio.Samples, audioWritten * audio.Channels, ptr, frames * audio.Channels);
                buffer.Unlock();
                buffer.CurrentLength = bytes;
                using var sample = MediaFactory.MFCreateSample();
                sample.AddBuffer(buffer);
                sample.SampleTime = audioWritten * Ticks / audio.Rate;
                sample.SampleDuration = frames * Ticks / audio.Rate;
                writer.WriteSample(audioStream, sample);
                audioWritten += frames;
            }
        }

        public void Finish()
        {
            WriteAudio(double.PositiveInfinity);
            writer.Finalize();
        }

        public void Dispose() => writer.Dispose();
    }
}
