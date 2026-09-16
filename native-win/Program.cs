using Loupe.Native;

// One executable for all four helpers, so the installer carries one .NET
// runtime instead of four: `loupe-native <sources|capture|inputtap|render> ...`.
// Each speaks exactly the protocol its macOS counterpart in src/native does.
Win32.SetProcessDpiAwarenessContext(Win32.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

var tool = args.Length > 0 ? args[0] : "";
var rest = args.Skip(1).ToArray();
try
{
    return tool switch
    {
        "sources" => Sources.Run(rest),
        "capture" => Capture.Run(rest),
        "inputtap" => InputTap.Run(rest),
        "render" => Render.Run(rest),
        _ => Out.Fail("usage: loupe-native <sources|capture|inputtap|render> [args]")
    };
}
catch (Exception e)
{
    return Out.Fail($"{tool}: {e.Message}");
}
