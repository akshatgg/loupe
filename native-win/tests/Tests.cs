using Loupe.Native;

// A dependency-free runner: each test throws on failure.
var tests = new (string name, Action run)[]
{
    ("crop at 1x and the same size copies the picture", CropIdentity),
    ("crop at 2x shows the centred quarter, scaled up", CropZoomCentre),
    ("scaling down averages the pixels it covers", CropDownscaleAverages),
    ("the cursor is white inside, and nothing changes far away", CursorDraws),
    ("a ripple tints its ring and not its centre", RippleDraws),
    ("at 1x the audio comes through unchanged", AudioIdentity),
    ("at 2x with pitch kept the tone stays the same", AudioFasterSamePitch),
    ("at 2x tape speed the tone goes up an octave", AudioFasterTapeSpeed),
    ("the time map follows the plan and extends past it", TimeMapExtends),
};

int failed = 0;
foreach (var (name, run) in tests)
{
    try { run(); Console.WriteLine($"ok   {name}"); }
    catch (Exception e) { failed++; Console.WriteLine($"FAIL {name}: {e.Message}"); }
}
Console.WriteLine(failed == 0 ? $"all {tests.Length} passed" : $"{failed} of {tests.Length} failed");
return failed == 0 ? 0 : 1;

static void Assert(bool ok, string message) { if (!ok) throw new Exception(message); }

static byte[] Pattern(int w, int h, Func<int, int, (byte b, byte g, byte r)> at)
{
    var px = new byte[w * h * 4];
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++)
        {
            var (b, g, r) = at(x, y);
            int i = (y * w + x) * 4;
            px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = 255;
        }
    return px;
}

static void CropIdentity()
{
    int w = 64, h = 40;
    var src = Pattern(w, h, (x, y) => ((byte)(x * 4), (byte)(y * 6), (byte)((x + y) % 256)));
    var dst = new byte[src.Length];
    Compositor.Crop(src, w, h, dst, w, h, w, h, new Compositor.Camera(1, w / 2.0, h / 2.0));
    for (int i = 0; i < src.Length; i++) Assert(Math.Abs(src[i] - dst[i]) <= 1, $"byte {i}: {src[i]} vs {dst[i]}");
}

static void CropZoomCentre()
{
    // Four colour quadrants; at 2x on the centre the output's corners show
    // each quadrant's inner part.
    int w = 80, h = 80;
    var src = Pattern(w, h, (x, y) => x < 40 ? (y < 40 ? ((byte)255, (byte)0, (byte)0) : ((byte)0, (byte)255, (byte)0))
                                             : (y < 40 ? ((byte)0, (byte)0, (byte)255) : ((byte)255, (byte)255, (byte)0)));
    var dst = new byte[w * h * 4];
    // Source measured in points at half the pixel density, like a 2x display.
    Compositor.Crop(src, w, h, dst, w, h, 40, 40, new Compositor.Camera(2, 20, 20));
    Assert(dst[0] == 255 && dst[1] == 0, "top-left quadrant");
    int tr = (79) * 4;
    Assert(dst[tr + 2] == 255 && dst[tr] == 0, "top-right quadrant");
    // 2x zoom of 80px into 80px: the visible area is 40px wide, from 20 to 60.
    int mid = (60 * w + 10) * 4; // output (10, 60) -> source (25, 50): bottom-left
    Assert(dst[mid + 1] == 255 && dst[mid] == 0, $"bottom-left quadrant, got {dst[mid]},{dst[mid + 1]},{dst[mid + 2]}");
}

static void CropDownscaleAverages()
{
    int w = 8, h = 8;
    var src = Pattern(w, h, (x, y) => (x + y) % 2 == 0 ? ((byte)255, (byte)255, (byte)255) : ((byte)0, (byte)0, (byte)0));
    var dst = new byte[4 * 4 * 4];
    Compositor.Crop(src, w, h, dst, 4, 4, w, h, new Compositor.Camera(1, 4, 4));
    for (int i = 0; i < dst.Length; i += 4) Assert(Math.Abs(dst[i] - 128) <= 20, $"pixel {i / 4} = {dst[i]}, expected grey");
}

static void CursorDraws()
{
    int w = 100, h = 100;
    var px = Pattern(w, h, (_, _) => ((byte)40, (byte)40, (byte)40));
    Compositor.DrawCursor(px, w, h, 20, 20, 2);
    int inside = ((20 + 20) * w + 24) * 4; // a little right of the arrow's left edge, halfway down
    Assert(px[inside] > 200, $"inside the arrow should be white, got {px[inside]}");
    int far = (90 * w + 90) * 4;
    Assert(px[far] == 40, "far pixels untouched");
}

static void RippleDraws()
{
    int w = 120, h = 120;
    var px = Pattern(w, h, (_, _) => ((byte)0, (byte)0, (byte)0));
    Compositor.DrawRipple(px, w, h, 60, 60, 0.0, 2); // radius 12 at age 0
    int ring = (60 * w + 72) * 4;
    int centre = (60 * w + 60) * 4;
    Assert(px[ring] > 60, $"ring should be blue-ish, got b={px[ring]}");
    Assert(px[centre] == 0, "centre untouched");
}

static float[] Sine(double freq, int rate, double seconds, int channels = 1)
{
    int n = (int)(rate * seconds);
    var s = new float[n * channels];
    for (int i = 0; i < n; i++)
        for (int c = 0; c < channels; c++)
            s[i * channels + c] = (float)(0.5 * Math.Sin(2 * Math.PI * freq * i / rate));
    return s;
}

static double[] Frames(double duration, double pace, int fps = 60)
{
    int count = (int)Math.Ceiling(duration / pace * fps);
    return Enumerable.Range(0, count).Select(k => Math.Min(duration, k / (double)fps * pace)).ToArray();
}

static double Frequency(float[] s, int rate, int from, int to)
{
    int crossings = 0;
    for (int i = from + 1; i < to; i++) if (s[i - 1] < 0 && s[i] >= 0) crossings++;
    return crossings / ((to - from) / (double)rate);
}

static void AudioIdentity()
{
    int rate = 48000;
    var src = Sine(440, rate, 1.0, 2);
    var map = new AudioStretch.TimeMap(Frames(1.0, 1), 60);
    var output = AudioStretch.Stretch(src, 2, rate, map, rate, true);
    double worst = 0;
    for (int i = 0; i < output.Length; i++) worst = Math.Max(worst, Math.Abs(output[i] - src[i]));
    Assert(worst < 1e-3, $"largest difference {worst}");
}

static void AudioFasterSamePitch()
{
    int rate = 48000;
    var src = Sine(440, rate, 2.0);
    var map = new AudioStretch.TimeMap(Frames(2.0, 2), 60);
    var output = AudioStretch.Stretch(src, 1, rate, map, rate, true);
    double f = Frequency(output, rate, 2000, rate - 2000);
    Assert(Math.Abs(f - 440) < 15, $"frequency {f}");
}

static void AudioFasterTapeSpeed()
{
    int rate = 48000;
    var src = Sine(440, rate, 2.0);
    var map = new AudioStretch.TimeMap(Frames(2.0, 2), 60);
    var output = AudioStretch.Stretch(src, 1, rate, map, rate, false);
    double f = Frequency(output, rate, 2000, rate - 2000);
    Assert(Math.Abs(f - 880) < 15, $"frequency {f}");
}

static void TimeMapExtends()
{
    var map = new AudioStretch.TimeMap(new[] { 0.0, 0.5, 1.0 }, 2); // 2fps at 1x... pace 1
    Assert(Math.Abs(map.SourceAt(0.25) - 0.25) < 1e-9, "interpolates");
    Assert(Math.Abs(map.SourceAt(2.0) - 2.0) < 1e-9, $"extends: {map.SourceAt(2.0)}");
}
