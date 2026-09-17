using System.Diagnostics;

namespace Loupe.Native;

// `loupe-native sources [--exclude-pid N]`: the displays and windows that can
// be recorded, as one JSON array -- the shape Sources.swift prints. Rects are
// in physical pixels; main.js converts them to Electron's DIP space (the
// Windows equivalent of macOS points) and adds thumbnails from
// desktopCapturer, so nothing here has to encode images.
static class Sources
{
    // Shell surfaces that are technically top-level windows but are not
    // anything a person would choose to record.
    static readonly HashSet<string> ShellClasses = new(StringComparer.OrdinalIgnoreCase)
    {
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
        "Windows.UI.Core.CoreWindow", "ApplicationManager_ImmersiveShellWindow",
        "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland"
    };

    public static int Run(string[] argv)
    {
        uint? excludePid = uint.TryParse(Args.Get(argv, "--exclude-pid"), out var p) ? p : null;
        var outList = new List<object>();

        var monitors = Win32.Monitors();
        int n = 1;
        foreach (var (handle, r, primary) in monitors.OrderByDescending(m => m.primary).ThenBy(m => m.rect.Left))
        {
            outList.Add(new
            {
                id = $"display:{(ulong)handle.ToInt64()}",
                kind = "display",
                title = monitors.Count > 1
                    ? $"Display {n}{(primary ? " (main)" : "")} — {r.Width}×{r.Height}"
                    : $"Display {r.Width}×{r.Height}",
                app = (string?)null,
                width = r.Width, height = r.Height, x = r.Left, y = r.Top,
                thumbnail = (string?)null
            });
            n++;
        }

        var names = new Dictionary<uint, string>();
        Win32.EnumWindows((hwnd, _) =>
        {
            if (!Win32.IsWindowVisible(hwnd) || Win32.IsIconic(hwnd) || Win32.IsCloaked(hwnd)) return true;
            if (Win32.GetWindow(hwnd, Win32.GW_OWNER) != IntPtr.Zero) return true;
            long ex = Win32.GetWindowLongPtr(hwnd, Win32.GWL_EXSTYLE).ToInt64();
            if ((ex & Win32.WS_EX_TOOLWINDOW) != 0 && (ex & Win32.WS_EX_APPWINDOW) == 0) return true;
            if (ShellClasses.Contains(Win32.ClassName(hwnd))) return true;
            var title = Win32.Text(hwnd);
            if (string.IsNullOrWhiteSpace(title)) return true;
            var r = Win32.FrameBounds(hwnd);
            if (r.Width <= 40 || r.Height <= 40) return true;
            Win32.GetWindowThreadProcessId(hwnd, out uint pid);
            if (excludePid == pid) return true;

            if (!names.TryGetValue(pid, out var app))
            {
                app = AppName(pid);
                names[pid] = app;
            }
            outList.Add(new
            {
                id = $"window:{(ulong)hwnd.ToInt64()}",
                kind = "window",
                title, app,
                width = r.Width, height = r.Height, x = r.Left, y = r.Top,
                thumbnail = (string?)null
            });
            return true;
        }, IntPtr.Zero);

        Out.Emit(outList);
        Out.Drain();
        return 0;
    }

    // "Google Chrome" rather than "chrome": the file description when the
    // process can be opened, else its image name.
    static string AppName(uint pid)
    {
        try
        {
            using var proc = Process.GetProcessById((int)pid);
            try
            {
                var desc = proc.MainModule?.FileVersionInfo.FileDescription;
                if (!string.IsNullOrWhiteSpace(desc)) return desc.Trim();
            }
            catch { /* elevated or protected process: no module access */ }
            return proc.ProcessName;
        }
        catch
        {
            return "";
        }
    }
}
