using System.Numerics;

namespace Loupe.Native;

// The picture side of an export frame, in plain C# so it runs (and is tested)
// anywhere: crop the recording to the camera, scale it to the output size,
// then draw the click ripples and the cursor -- the same steps as Render.swift,
// with the same shapes, sizes and colours. Pixels are BGRA, top-down rows.
static class Compositor
{
    public readonly record struct Camera(double Zoom, double Cx, double Cy);

    // Resamples the camera's view of `src` into `dst`. Each output pixel is a
    // tent filter over the source pixels it covers: bilinear when zoomed in,
    // an area average when scaling down, so text doesn't shimmer at 1x.
    public static void Crop(byte[] src, int srcW, int srcH, byte[] dst, int outW, int outH,
                            double sourceWidth, double sourceHeight, Camera cam)
    {
        double scale = srcW / sourceWidth; // recording pixels per source point
        double zoom = cam.Zoom > 0 ? cam.Zoom : 1;
        double vw = sourceWidth / zoom * scale, vh = sourceHeight / zoom * scale;
        double x0 = cam.Cx * scale - vw / 2, y0 = cam.Cy * scale - vh / 2;

        var cols = Taps(outW, x0, vw / outW, srcW);
        var rows = Taps(outH, y0, vh / outH, srcH);
        int colMin = srcW, colMax = 0;
        foreach (var c in cols) { colMin = Math.Min(colMin, c.Start); colMax = Math.Max(colMax, c.Start + c.Weights.Length); }
        int span = colMax - colMin;

        Parallel.For(0, outH, () => new float[span * 4], (j, _, row) =>
        {
            // Vertical pass into one float row covering only the columns used.
            Array.Clear(row);
            var tap = rows[j];
            for (int k = 0; k < tap.Weights.Length; k++)
            {
                float w = tap.Weights[k];
                int at = (tap.Start + k) * srcW * 4 + colMin * 4;
                for (int i = 0; i < span * 4; i++) row[i] += src[at + i] * w;
            }
            // Horizontal pass into the output row.
            int o = j * outW * 4;
            for (int x = 0; x < outW; x++)
            {
                var c = cols[x];
                float b = 0, g = 0, r = 0;
                for (int k = 0; k < c.Weights.Length; k++)
                {
                    int s = (c.Start - colMin + k) * 4;
                    float w = c.Weights[k];
                    b += row[s] * w; g += row[s + 1] * w; r += row[s + 2] * w;
                }
                dst[o++] = Byte(b); dst[o++] = Byte(g); dst[o++] = Byte(r); dst[o++] = 255;
            }
            return row;
        }, _ => { });
    }

    readonly record struct Tap(int Start, float[] Weights);

    static Tap[] Taps(int count, double origin, double step, int limit)
    {
        var taps = new Tap[count];
        double radius = Math.Max(1.0, step);
        for (int i = 0; i < count; i++)
        {
            double center = origin + (i + 0.5) * step - 0.5;
            int first = (int)Math.Floor(center - radius) + 1;
            int last = (int)Math.Floor(center + radius);
            // Past an edge, the edge pixel repeats.
            first = Math.Clamp(first, 0, limit - 1);
            last = Math.Clamp(last, 0, limit - 1);
            var weights = new float[last - first + 1];
            double sum = 0;
            for (int s = first; s <= last; s++)
            {
                double w = Math.Max(0, 1 - Math.Abs(s - center) / radius);
                weights[s - first] = (float)w;
                sum += w;
            }
            if (sum <= 0)
            {
                weights = new float[] { 1 };
                first = Math.Clamp((int)Math.Round(center), 0, limit - 1);
            }
            else
            {
                for (int k = 0; k < weights.Length; k++) weights[k] = (float)(weights[k] / sum);
            }
            taps[i] = new Tap(first, weights);
        }
        return taps;
    }

    static byte Byte(float v) => v <= 0 ? (byte)0 : v >= 255 ? (byte)255 : (byte)(v + 0.5f);

    // ---- overlays ------------------------------------------------------------

    // The arrow from Render.swift, in points from its tip.
    static readonly Vector2[] Arrow =
    {
        new(0, 0), new(0, 17), new(4.5f, 13), new(7.5f, 19),
        new(10.5f, 17.5f), new(7.5f, 11.5f), new(12, 11.5f)
    };

    public static void DrawCursor(byte[] dst, int w, int h, double x, double y, double s)
    {
        var poly = Arrow.Select(p => new Vector2((float)(x + p.X * s), (float)(y + p.Y * s))).ToArray();
        float stroke = (float)(1.2 * s), blur = (float)(3 * s), drop = (float)s;
        float minX = poly.Min(p => p.X) - blur - 2, maxX = poly.Max(p => p.X) + blur + 2;
        float minY = poly.Min(p => p.Y) - blur - 2, maxY = poly.Max(p => p.Y) + blur + drop + 2;

        ForPixels(w, h, minX, minY, maxX, maxY, (px, py, at) =>
        {
            var p = new Vector2(px + 0.5f, py + 0.5f);
            // Soft shadow a point below the arrow.
            float sd = SignedDistance(poly, p - new Vector2(0, drop));
            float shadow = 0.45f * Math.Clamp(0.5f - sd / blur, 0, 1);
            Blend(dst, at, 0, 0, 0, shadow);

            float d = SignedDistance(poly, p);
            Blend(dst, at, 255, 255, 255, Math.Clamp(0.5f - d, 0, 1));
            Blend(dst, at, 0, 0, 0, 0.85f * Math.Clamp(stroke / 2 + 0.5f - Math.Abs(d), 0, 1));
        });
    }

    public static void DrawRipple(byte[] dst, int w, int h, double x, double y, double age, double s)
    {
        double progress = age / 0.5;
        if (progress < 0 || progress > 1) return;
        float radius = (float)((6 + 34 * progress) * s), line = (float)(2.5 * s);
        float alpha = (float)(0.55 * (1 - progress));
        float cx = (float)x, cy = (float)y, reach = radius + line;
        ForPixels(w, h, cx - reach, cy - reach, cx + reach, cy + reach, (px, py, at) =>
        {
            float d = Math.Abs(Vector2.Distance(new Vector2(px + 0.5f, py + 0.5f), new Vector2(cx, cy)) - radius);
            float cover = Math.Clamp(line / 2 + 0.5f - d, 0, 1);
            // rgb(0.23, 0.51, 0.96)
            Blend(dst, at, 245, 130, 59, alpha * cover);
        });
    }

    static void ForPixels(int w, int h, float minX, float minY, float maxX, float maxY, Action<int, int, int> each)
    {
        int x1 = Math.Max(0, (int)Math.Floor(minX)), x2 = Math.Min(w - 1, (int)Math.Ceiling(maxX));
        int y1 = Math.Max(0, (int)Math.Floor(minY)), y2 = Math.Min(h - 1, (int)Math.Ceiling(maxY));
        for (int py = y1; py <= y2; py++)
            for (int px = x1; px <= x2; px++)
                each(px, py, (py * w + px) * 4);
    }

    // Source-over, in BGRA order: b, g, r.
    static void Blend(byte[] dst, int at, byte b, byte g, byte r, float a)
    {
        if (a <= 0) return;
        if (a > 1) a = 1;
        dst[at] = Mix(dst[at], b, a);
        dst[at + 1] = Mix(dst[at + 1], g, a);
        dst[at + 2] = Mix(dst[at + 2], r, a);
    }

    static byte Mix(byte from, byte to, float a) => (byte)MathF.Round(from + (to - from) * a);

    // Distance to the polygon's outline: negative inside, positive outside.
    static float SignedDistance(Vector2[] poly, Vector2 p)
    {
        float best = float.MaxValue;
        bool inside = false;
        for (int i = 0, j = poly.Length - 1; i < poly.Length; j = i++)
        {
            Vector2 a = poly[j], b = poly[i];
            var ab = b - a;
            float t = Math.Clamp(Vector2.Dot(p - a, ab) / Math.Max(ab.LengthSquared(), 1e-6f), 0, 1);
            best = Math.Min(best, Vector2.Distance(p, a + ab * t));
            if ((a.Y > p.Y) != (b.Y > p.Y) && p.X < (b.X - a.X) * (p.Y - a.Y) / (b.Y - a.Y) + a.X) inside = !inside;
        }
        return inside ? -best : best;
    }
}
