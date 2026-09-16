using System.Runtime.InteropServices;
using static Loupe.Native.Win32;

namespace Loupe.Native;

// `loupe-native inputtap [--zoom-triggers option,mouse-side] [--keys 1]`: the zoom
// gesture, clicks and cursor track, from low-level mouse and keyboard hooks.
// The Windows counterpart of InputTap.swift, with the same messages:
//   {"type":"zoom","clock","dy","x","y"}   a zoom-trigger scroll (swallowed)
//   {"type":"click","clock","x","y","button"}
//   {"type":"cursor","clock","x","y","shape"}
//   {"type":"key","clock","label"}         a keyboard shortcut (--keys 1; Keys.cs)
// Coordinates are physical screen pixels (this process is per-monitor DPI
// aware); main.js maps them to DIPs. Low-level hooks need no permission on
// Windows, so there is no Accessibility step.
static class InputTap
{
    // Settings names are shared with macOS: option = Alt, command = Windows key.
    sealed class Triggers
    {
        public readonly HashSet<uint> Keys = new();
        public bool SideButtons, MiddleButton;

        public Triggers(string? spec)
        {
            foreach (var name in (spec ?? "option").Split(',', StringSplitOptions.RemoveEmptyEntries))
            {
                switch (name)
                {
                    case "option": Keys.UnionWith(new uint[] { 0x12, 0xA4, 0xA5 }); break;   // VK_MENU, L/R
                    case "control": Keys.UnionWith(new uint[] { 0x11, 0xA2, 0xA3 }); break;
                    case "command": Keys.UnionWith(new uint[] { 0x5B, 0x5C }); break;        // L/R Win
                    case "shift": Keys.UnionWith(new uint[] { 0x10, 0xA0, 0xA1 }); break;
                    case "mouse-side": SideButtons = true; break;
                    case "mouse-middle": MiddleButton = true; break;
                }
            }
        }

        // Button numbers as on macOS: 2 middle, 3 and 4 the side buttons.
        public bool Matches(int button) => (SideButtons && button >= 3) || (MiddleButton && button == 2);
    }

    // Marks the input this helper injects, so the hooks let it through.
    static readonly UIntPtr ReplayTag = new(0x4C4F555045); // "LOUPE"

    // An unassigned virtual key. Tapped before an Alt or Windows key release
    // that followed a zoom, so the release does not open the window's menu
    // bar or the Start menu -- the key was used as a modifier, not pressed.
    const ushort MaskKey = 0xE8;

    static Triggers triggers = null!;
    static IntPtr mouseHook, keyboardHook;
    static HookProc? mouseProc, keyboardProc; // held so the GC cannot collect them
    static readonly HashSet<uint> down = new();
    static bool zoomedWhileModifierDown;
    static int? buttonHeld;
    static bool zoomedDuringHold;
    static double lastCursorEmit;
    static bool reportKeys;
    const double CursorInterval = 1.0 / 120.0;

    static readonly IntPtr ArrowCursor = LoadCursor(IntPtr.Zero, new IntPtr(IDC_ARROW));
    static readonly IntPtr IBeamCursor = LoadCursor(IntPtr.Zero, new IntPtr(IDC_IBEAM));
    static readonly IntPtr HandCursor = LoadCursor(IntPtr.Zero, new IntPtr(IDC_HAND));
    static readonly IntPtr[] ResizeCursors =
    {
        LoadCursor(IntPtr.Zero, new IntPtr(IDC_SIZEWE)), LoadCursor(IntPtr.Zero, new IntPtr(IDC_SIZENS)),
        LoadCursor(IntPtr.Zero, new IntPtr(IDC_SIZENWSE)), LoadCursor(IntPtr.Zero, new IntPtr(IDC_SIZENESW)),
        LoadCursor(IntPtr.Zero, new IntPtr(IDC_SIZEALL))
    };

    public static int Run(string[] argv)
    {
        triggers = new Triggers(Args.Get(argv, "--zoom-triggers"));
        reportKeys = Args.Get(argv, "--keys") == "1";
        uint thread = GetCurrentThreadId();

        mouseProc = MouseHook;
        keyboardProc = KeyboardHook;
        var module = GetModuleHandle(null);
        mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, module, 0);
        if (mouseHook == IntPtr.Zero)
            return Out.Fail($"could not install the mouse hook (error {Marshal.GetLastWin32Error()})");
        keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, module, 0);
        if (keyboardHook == IntPtr.Zero)
            return Out.Fail($"could not install the keyboard hook (error {Marshal.GetLastWin32Error()})");

        StopSignal.OnStop(() => PostThreadMessage(thread, WM_QUIT, IntPtr.Zero, IntPtr.Zero));
        Out.Emit(new { type = "ready" });

        // Low-level hooks are called on this thread, through its message loop.
        while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0) { }

        UnhookWindowsHookEx(mouseHook);
        UnhookWindowsHookEx(keyboardHook);
        Out.Drain();
        return 0;
    }

    static string CursorShape()
    {
        var info = new CURSORINFO { cbSize = Marshal.SizeOf<CURSORINFO>() };
        if (!GetCursorInfo(ref info)) return "arrow";
        if (info.hCursor == IBeamCursor) return "ibeam";
        if (info.hCursor == HandCursor) return "pointinghand";
        if (Array.IndexOf(ResizeCursors, info.hCursor) >= 0) return "resize";
        return "arrow";
    }

    static IntPtr MouseHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code < 0) return CallNextHookEx(mouseHook, code, wParam, lParam);
        var e = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
        if (e.dwExtraInfo == ReplayTag) return CallNextHookEx(mouseHook, code, wParam, lParam);

        double now = Clock.Now();
        int x = e.pt.X, y = e.pt.Y;
        int message = wParam.ToInt32();

        switch (message)
        {
            case WM_MOUSEWHEEL:
            {
                bool byModifier = down.Overlaps(triggers.Keys);
                bool byButton = buttonHeld != null;
                if (!byModifier && !byButton) break;
                // 120 per wheel notch, positive away from you. /12 gives the
                // ~10 per notch a macOS mouse reports, which zoom.js is tuned
                // for; precision touchpads send proportionally smaller steps.
                double dy = (short)(e.mouseData >> 16) / 12.0;
                if (byModifier) zoomedWhileModifierDown = true;
                if (byButton) zoomedDuringHold = true;
                Out.Emit(new { type = "zoom", clock = now, dy, x, y });
                return new IntPtr(1); // swallowed: the app underneath never scrolls
            }

            case WM_MBUTTONDOWN:
            case WM_XBUTTONDOWN:
            {
                int button = ButtonNumber(message, e.mouseData);
                if (buttonHeld != null || !triggers.Matches(button)) break;
                // Held back until release: only then is it known whether this
                // was a zoom (swallow it) or an ordinary click (replay it).
                buttonHeld = button;
                zoomedDuringHold = false;
                return new IntPtr(1);
            }

            case WM_MBUTTONUP:
            case WM_XBUTTONUP:
            {
                int button = ButtonNumber(message, e.mouseData);
                if (buttonHeld != button) break;
                buttonHeld = null;
                if (!zoomedDuringHold) ReplayClick(button);
                return new IntPtr(1);
            }

            case WM_LBUTTONDOWN:
            case WM_RBUTTONDOWN:
                Out.Emit(new { type = "click", clock = now, x, y, button = message == WM_LBUTTONDOWN ? "left" : "right" });
                break;

            case WM_MOUSEMOVE:
                if (now - lastCursorEmit >= CursorInterval)
                {
                    lastCursorEmit = now;
                    Out.Emit(new { type = "cursor", clock = now, x, y, shape = CursorShape() });
                }
                break;
        }
        return CallNextHookEx(mouseHook, code, wParam, lParam);
    }

    static int ButtonNumber(int message, uint mouseData)
    {
        if (message == WM_MBUTTONDOWN || message == WM_MBUTTONUP) return 2;
        return (mouseData >> 16) == 1 ? 3 : 4; // XBUTTON1 back, XBUTTON2 forward
    }

    static void ReplayClick(int button)
    {
        uint downFlag, upFlag, data = 0;
        if (button == 2) { downFlag = MOUSEEVENTF_MIDDLEDOWN; upFlag = MOUSEEVENTF_MIDDLEUP; }
        else { downFlag = MOUSEEVENTF_XDOWN; upFlag = MOUSEEVENTF_XUP; data = button == 3 ? 1u : 2u; }
        var inputs = new[]
        {
            new INPUT { type = INPUT_MOUSE, u = new InputUnion { mi = new MOUSEINPUT { mouseData = data, dwFlags = downFlag, dwExtraInfo = ReplayTag } } },
            new INPUT { type = INPUT_MOUSE, u = new InputUnion { mi = new MOUSEINPUT { mouseData = data, dwFlags = upFlag, dwExtraInfo = ReplayTag } } }
        };
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }

    static void ReportShortcut(uint vk)
    {
        bool Held(params uint[] keys) => keys.Any(down.Contains);
        // AltGr arrives as a left Ctrl press followed by right Alt.
        bool altGr = Held(0xA5) && Held(0xA2);
        var modifiers = new Keys.Modifiers(
            Ctrl: Held(0x11, 0xA2, 0xA3), Alt: Held(0x12, 0xA4, 0xA5), Shift: Held(0x10, 0xA0, 0xA1),
            Win: Held(0x5B, 0x5C), AltGr: altGr);
        var label = Keys.ShortcutLabel(vk, modifiers, v => (char)(MapVirtualKey(v, MAPVK_VK_TO_CHAR) & 0x7FFFFFFF));
        if (label != null) Out.Emit(new { type = "key", clock = Clock.Now(), label });
    }

    static IntPtr KeyboardHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code < 0) return CallNextHookEx(keyboardHook, code, wParam, lParam);
        var e = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
        if (e.dwExtraInfo == ReplayTag) return CallNextHookEx(keyboardHook, code, wParam, lParam);

        int message = wParam.ToInt32();
        if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)
        {
            if (down.Count == 0) zoomedWhileModifierDown = false;
            // A key already down is auto-repeating: one press, one shortcut.
            bool repeat = !down.Add(e.vkCode);
            if (reportKeys && !repeat) ReportShortcut(e.vkCode);
        }
        else if (message == WM_KEYUP || message == WM_SYSKEYUP)
        {
            down.Remove(e.vkCode);
            bool menuKey = e.vkCode is 0x12 or 0xA4 or 0xA5 or 0x5B or 0x5C;
            bool mask = menuKey && zoomedWhileModifierDown;
            if (down.Count == 0) zoomedWhileModifierDown = false;
            if (mask)
            {
                // Input injected from here arrives after this event, so the
                // real release is held back and re-sent behind the mask key.
                uint extended = (e.flags & 0x01) != 0 ? 1u : 0u; // LLKHF_EXTENDED -> KEYEVENTF_EXTENDEDKEY
                var inputs = new[]
                {
                    new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = MaskKey, dwExtraInfo = ReplayTag } } },
                    new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = MaskKey, dwFlags = KEYEVENTF_KEYUP, dwExtraInfo = ReplayTag } } },
                    new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = (ushort)e.vkCode, wScan = (ushort)e.scanCode, dwFlags = KEYEVENTF_KEYUP | extended, dwExtraInfo = ReplayTag } } }
                };
                SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
                return new IntPtr(1);
            }
        }
        return CallNextHookEx(keyboardHook, code, wParam, lParam);
    }
}
