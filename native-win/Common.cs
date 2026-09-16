using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Loupe.Native;

// The same NDJSON protocol the macOS helpers speak (src/main/helpers.js):
// one JSON object per line on stdout. Writes go through one background
// thread, so a hook or capture callback never blocks on a slow pipe.
static class Out
{
    static readonly BlockingCollection<string> Lines = new();
    static readonly Thread Writer;

    static Out()
    {
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = false };
        Writer = new Thread(() =>
        {
            foreach (var line in Lines.GetConsumingEnumerable())
            {
                stdout.Write(line);
                stdout.Write('\n');
                if (Lines.Count == 0) stdout.Flush();
            }
            stdout.Flush();
        }) { IsBackground = true, Name = "stdout" };
        Writer.Start();
    }

    public static void Emit(object value) => Lines.Add(JsonSerializer.Serialize(value));

    // Waits until every queued line is on stdout. Call before exiting.
    public static void Drain()
    {
        Lines.CompleteAdding();
        Writer.Join(2000);
    }

    public static void Error(string message) => Emit(new { type = "error", message });

    public static int Fail(string message)
    {
        Error(message);
        Drain();
        return 1;
    }
}

static class Args
{
    public static string? Get(string[] argv, string name)
    {
        int i = Array.IndexOf(argv, name);
        return i >= 0 && i + 1 < argv.Length ? argv[i + 1] : null;
    }

    public static double? Number(string[] argv, string name) =>
        double.TryParse(Get(argv, name), System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : null;
}

// One clock for every helper: QueryPerformanceCounter in seconds. It is the
// base Windows.Graphics.Capture stamps frames with (SystemRelativeTime), so
// capture's "started" clock and inputtap's event clocks line up exactly, the
// way CACurrentMediaTime() does on macOS.
static class Clock
{
    public static double Now() => Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency;
}

// Windows has no SIGTERM for a console child: Node's child.kill() is
// TerminateProcess, which would leave a half-written MP4. helpers.js instead
// closes our stdin (or writes "stop"); this fires once when that happens.
static class StopSignal
{
    public static void OnStop(Action stop)
    {
        var fired = 0;
        void Fire() { if (Interlocked.Exchange(ref fired, 1) == 0) stop(); }
        new Thread(() =>
        {
            try
            {
                using var stdin = new StreamReader(Console.OpenStandardInput());
                string? line;
                while ((line = stdin.ReadLine()) != null)
                    if (line.Trim() == "stop") break;
            }
            catch { /* a broken pipe means the parent is gone: stop too */ }
            Fire();
        }) { IsBackground = true, Name = "stdin" }.Start();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; Fire(); };
    }
}
