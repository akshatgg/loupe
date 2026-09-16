namespace Loupe.Native;

// The platform-independent half of computer-sound recording on Windows
// (SystemAudio.cs is the WASAPI half): a 16-bit PCM WAV writer, sample format
// conversion, and the rule that places each loopback packet on the capture
// clock. Tested on any OS (native-win/tests).

/// A growing 16-bit PCM .wav file. The sizes in the header are written as
/// placeholders and filled in by Finish(), so a file cut short by a crash is
/// still mostly readable.
public sealed class WavWriter : IDisposable
{
    readonly Stream stream;
    public readonly int SampleRate, Channels;
    public long FramesWritten { get; private set; }
    bool finished;

    public WavWriter(Stream stream, int sampleRate, int channels)
    {
        this.stream = stream;
        SampleRate = sampleRate;
        Channels = channels;
        WriteHeader(0);
    }

    void WriteHeader(long dataBytes)
    {
        uint data = (uint)Math.Min(dataBytes, uint.MaxValue - 36);
        var h = new byte[44];
        void Str(int at, string s) { for (int i = 0; i < 4; i++) h[at + i] = (byte)s[i]; }
        void U32(int at, uint v) => BitConverter.TryWriteBytes(h.AsSpan(at, 4), v);
        void U16(int at, ushort v) => BitConverter.TryWriteBytes(h.AsSpan(at, 2), v);
        Str(0, "RIFF"); U32(4, 36 + data); Str(8, "WAVE");
        Str(12, "fmt "); U32(16, 16); U16(20, 1); U16(22, (ushort)Channels);
        U32(24, (uint)SampleRate); U32(28, (uint)(SampleRate * Channels * 2));
        U16(32, (ushort)(Channels * 2)); U16(34, 16);
        Str(36, "data"); U32(40, data);
        stream.Position = 0;
        stream.Write(h);
        stream.Position = 44 + dataBytes;
    }

    /// Interleaved 16-bit samples, whole frames.
    public void Write(ReadOnlySpan<short> samples)
    {
        var bytes = System.Runtime.InteropServices.MemoryMarshal.AsBytes(samples);
        stream.Write(bytes);
        FramesWritten += samples.Length / Channels;
    }

    public void WriteSilence(long frames)
    {
        var zeros = new byte[Math.Min(frames, 48000) * Channels * 2];
        while (frames > 0)
        {
            long n = Math.Min(frames, zeros.Length / (Channels * 2));
            stream.Write(zeros, 0, (int)(n * Channels * 2));
            frames -= n;
            FramesWritten += n;
        }
    }

    public void Finish()
    {
        if (finished) return;
        finished = true;
        WriteHeader(FramesWritten * Channels * 2);
        stream.Flush();
    }

    public void Dispose()
    {
        Finish();
        stream.Dispose();
    }
}

public static class PcmConvert
{
    /// Converts one packet of the device's mix format into 16-bit samples.
    /// `isFloat` with 32 bits is IEEE float (the usual shared-mode format);
    /// otherwise integer PCM of 16, 24 or 32 bits.
    public static short[] ToInt16(ReadOnlySpan<byte> data, int bitsPerSample, bool isFloat)
    {
        int bytes = bitsPerSample / 8;
        int count = data.Length / bytes;
        var output = new short[count];
        for (int i = 0; i < count; i++)
        {
            var s = data.Slice(i * bytes, bytes);
            double v = (isFloat, bitsPerSample) switch
            {
                (true, 32) => BitConverter.ToSingle(s),
                (true, 64) => BitConverter.ToDouble(s),
                (_, 16) => BitConverter.ToInt16(s) / 32768.0,
                (_, 24) => ((s[2] << 24) | (s[1] << 16) | (s[0] << 8)) / 2147483648.0,
                (_, 32) => BitConverter.ToInt32(s) / 2147483648.0,
                _ => 0
            };
            output[i] = (short)Math.Clamp(Math.Round(v * 32767.0), -32768, 32767);
        }
        return output;
    }
}

/// Where each loopback packet goes in the file. WASAPI stamps a packet with
/// the QPC time of its first frame (IAudioCaptureClient::GetBuffer's
/// qpcPosition, in 100 ns), the clock Windows.Graphics.Capture stamps frames
/// with and Clock.Now() reads, so frame N of system.wav plays at
///
///   sourceTime = N / sampleRate,   i.e. packetClock - startClock
///
/// with startClock the first video frame's clock ({"type":"started"}): second
/// 0 of the file is second 0 of the video, the same as system.m4a on macOS.
/// Loopback delivers nothing at all while nothing is playing, so gaps are
/// filled with silence; small timing jitter (under Tolerance) is ignored so
/// continuous sound is never chopped; sound from before the first frame is
/// dropped.
public static class LoopbackAlign
{
    public const double Tolerance = 0.02;

    /// For a packet of `frames` frames stamped `packetClock` with the file
    /// holding `written` frames: how many frames of silence to write first,
    /// and how many leading frames of the packet to drop.
    public static (long silence, long skip) Place(double packetClock, double startClock, int sampleRate,
        long written, long frames)
    {
        long at = (long)Math.Round((packetClock - startClock) * sampleRate);
        long slack = (long)(Tolerance * sampleRate);
        // The file's first frame is exactly the video's first frame.
        if (written == 0) return at >= 0 ? (at, 0) : (0, Math.Min(frames, -at));
        if (at > written + slack) return (at - written, 0);
        // Late or overlapping (the file ran ahead, or the packet began before
        // the first frame): drop the part already covered.
        if (at < written - slack) return (0, Math.Min(frames, written - at));
        return (0, 0);
    }
}
