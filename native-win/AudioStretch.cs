namespace Loupe.Native;

// The sound side of an export: plays the recording's audio along the same
// recording-to-video time map the frames follow (retime.json, from speed.js),
// so a sped-up stretch sounds sped up and stays in sync. With preservePitch
// voices keep their natural pitch (WSOLA: overlap-add of short windows, each
// nudged to where it best continues the last); without it, tape-speed
// resampling. Plain C#, so it is tested off Windows.
static class AudioStretch
{
    // Recording time shown at video time `seconds`, from the plan's per-frame
    // map: linear between frames, and continuing at the final pace after.
    public sealed class TimeMap
    {
        readonly double[] frames;
        readonly int fps;

        public TimeMap(double[] frames, int fps)
        {
            this.frames = frames.Length > 0 ? frames : new[] { 0.0 };
            this.fps = fps > 0 ? fps : 60;
        }

        public double SourceAt(double seconds)
        {
            double f = seconds * fps;
            int n = frames.Length;
            if (f <= 0) return frames[0] + f / fps;
            int i = (int)Math.Floor(f);
            if (i + 1 < n) return frames[i] + (frames[i + 1] - frames[i]) * (f - i);
            double slope = n >= 2 ? (frames[n - 1] - frames[n - 2]) * fps : 1;
            return frames[n - 1] + slope * (f - (n - 1)) / fps;
        }
    }

    const int Window = 1024;          // ~21ms at 48kHz
    const int Hop = Window / 2;
    const int Tolerance = Window / 2; // how far a window may slide to line up

    // `source` is interleaved float samples. Returns `outputFrames` frames.
    public static float[] Stretch(float[] source, int channels, int rate, TimeMap map,
                                  int outputFrames, bool preservePitch)
    {
        var output = new float[outputFrames * channels];
        int sourceFrames = source.Length / channels;
        if (sourceFrames == 0 || outputFrames == 0) return output;
        if (preservePitch) Wsola(source, sourceFrames, channels, rate, map, output, outputFrames);
        else Resample(source, sourceFrames, channels, rate, map, output, outputFrames);
        return output;
    }

    static void Resample(float[] src, int srcFrames, int ch, int rate, TimeMap map, float[] dst, int outFrames)
    {
        for (int j = 0; j < outFrames; j++)
        {
            double pos = map.SourceAt(j / (double)rate) * rate;
            int i = (int)Math.Floor(pos);
            float frac = (float)(pos - i);
            for (int c = 0; c < ch; c++)
                dst[j * ch + c] = Sample(src, srcFrames, ch, i, c) * (1 - frac) + Sample(src, srcFrames, ch, i + 1, c) * frac;
        }
    }

    static float Sample(float[] src, int frames, int ch, int i, int c) =>
        i < 0 || i >= frames ? 0 : src[i * ch + c];

    static void Wsola(float[] src, int srcFrames, int ch, int rate, TimeMap map, float[] dst, int outFrames)
    {
        // Periodic Hann: at 50% overlap the windows sum to exactly 1, so
        // wherever the pace is 1x the sound comes through unchanged.
        var window = new float[Window];
        for (int i = 0; i < Window; i++) window[i] = (float)(0.5 - 0.5 * Math.Cos(2 * Math.PI * i / Window));

        var mono = new float[srcFrames];
        for (int i = 0; i < srcFrames; i++)
        {
            float sum = 0;
            for (int c = 0; c < ch; c++) sum += src[i * ch + c];
            mono[i] = sum / ch;
        }

        int previous = int.MinValue;
        // Start one hop early so the first samples get a full pair of windows.
        for (int o = -Hop; o < outFrames; o += Hop)
        {
            // Where this window "should" come from: the recording time at its centre.
            int nominal = (int)Math.Round(map.SourceAt((o + Window / 2.0) / rate) * rate) - Window / 2;
            int chosen = nominal;
            if (previous != int.MinValue)
            {
                int natural = previous + Hop; // seamless continuation of the last window
                if (Math.Abs(natural - nominal) <= 1) chosen = natural;
                else chosen = BestAlignment(mono, srcFrames, natural, nominal);
            }
            previous = chosen;

            for (int i = 0; i < Window; i++)
            {
                int oi = o + i;
                if (oi < 0 || oi >= outFrames) continue;
                int si = chosen + i;
                if (si < 0 || si >= srcFrames) continue;
                float w = window[i];
                for (int c = 0; c < ch; c++) dst[oi * ch + c] += src[si * ch + c] * w;
            }
        }
    }

    // The offset near `nominal` whose opening half best matches what would
    // have followed the previous window (`natural`). Coarse search on every
    // 4th sample, then refined.
    static int BestAlignment(float[] mono, int frames, int natural, int nominal)
    {
        int overlap = Window - Hop;
        int best = nominal;
        double bestScore = double.NegativeInfinity;
        for (int d = -Tolerance; d <= Tolerance; d += 4)
        {
            double score = Correlation(mono, frames, natural, nominal + d, overlap, 4);
            if (score > bestScore) { bestScore = score; best = nominal + d; }
        }
        int coarse = best;
        for (int d = -3; d <= 3; d++)
        {
            double score = Correlation(mono, frames, natural, coarse + d, overlap, 1);
            if (score > bestScore) { bestScore = score; best = coarse + d; }
        }
        return best;
    }

    static double Correlation(float[] mono, int frames, int a, int b, int length, int step)
    {
        double sum = 0, energy = 1e-9;
        for (int i = 0; i < length; i += step)
        {
            float x = a + i >= 0 && a + i < frames ? mono[a + i] : 0;
            float y = b + i >= 0 && b + i < frames ? mono[b + i] : 0;
            sum += x * y;
            energy += y * y;
        }
        return sum / Math.Sqrt(energy);
    }
}
