namespace Loupe.Native;

// Keyboard shortcut labels for `inputtap --keys 1` (the Windows side of
// shortcutLabel in InputTap.swift). Kept free of Win32 calls so the rules are
// testable on any OS (native-win/tests); the hook passes in the layout lookup.
//
// Only presses that are clearly commands are reported: a key held with Ctrl,
// Alt or the Windows key, or a key that is a command on its own (Esc, Tab,
// Enter, the arrows, function keys). Plain typing --
// letters, digits, punctuation, with or without Shift, and Backspace/Delete on
// their own, which only correct typing -- is never reported, so
// nothing typed (a password, a message) ends up in a recording. AltGr (which
// Windows reports as Ctrl+right Alt) types characters on many keyboards, so a
// printable key with AltGr and nothing else is typing too.
public static class Keys
{
    public readonly record struct Modifiers(bool Ctrl, bool Alt, bool Shift, bool Win, bool AltGr);

    // Keys that are commands on their own.
    static readonly Dictionary<uint, string> Standalone = new()
    {
        [0x1B] = "Esc", [0x09] = "Tab", [0x0D] = "Enter",
        [0x25] = "Left", [0x26] = "Up", [0x27] = "Right", [0x28] = "Down",
    };

    // Keys only worth naming as part of a shortcut.
    static readonly Dictionary<uint, string> Named = new()
    {
        [0x20] = "Space", [0x08] = "Backspace", [0x2E] = "Delete",
        [0x24] = "Home", [0x23] = "End", [0x21] = "Page Up", [0x22] = "Page Down",
        [0x2D] = "Insert", [0x2C] = "Print Screen", [0x13] = "Pause",
        [0x6A] = "Num *", [0x6B] = "Num +", [0x6D] = "Num -", [0x6E] = "Num .", [0x6F] = "Num /",
    };

    // Modifier keys themselves never make a label (Ctrl, Alt, Shift, Win, L/R).
    static readonly HashSet<uint> ModifierKeys = new() { 0x10, 0x11, 0x12, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C };

    public static bool IsModifier(uint vk) => ModifierKeys.Contains(vk);

    static bool IsFunctionKey(uint vk) => vk >= 0x70 && vk <= 0x87; // F1..F24

    /// The label for a key press, like "Ctrl+Shift+K" -- or null when the
    /// press is typing rather than a shortcut. `layoutChar` returns what the
    /// key prints on the current layout (MapVirtualKey), or '\0'.
    public static string? ShortcutLabel(uint vk, Modifiers m, Func<uint, char> layoutChar)
    {
        if (IsModifier(vk)) return null;
        bool standalone = Standalone.ContainsKey(vk) || IsFunctionKey(vk);
        // AltGr is Ctrl+Alt to Windows; count it as a modifier only when the
        // Windows key is also down.
        bool ctrl = m.Ctrl && !m.AltGr, alt = m.Alt && !m.AltGr;
        if (!(ctrl || alt || m.Win || standalone)) return null;

        string? key;
        if (Standalone.TryGetValue(vk, out var s)) key = s;
        else if (IsFunctionKey(vk)) key = $"F{vk - 0x70 + 1}";
        else if (Named.TryGetValue(vk, out var n)) key = n;
        else if (vk >= 0x41 && vk <= 0x5A) key = ((char)vk).ToString();          // A..Z
        else if (vk >= 0x30 && vk <= 0x39) key = ((char)vk).ToString();          // 0..9
        else if (vk >= 0x60 && vk <= 0x69) key = $"Num {vk - 0x60}";
        else
        {
            char c = layoutChar(vk);
            key = c == '\0' || char.IsControl(c) || char.IsWhiteSpace(c) ? null : char.ToUpperInvariant(c).ToString();
        }
        if (key == null) return null;

        var parts = new List<string>(5);
        if (ctrl) parts.Add("Ctrl");
        if (m.Win) parts.Add("Win");
        if (alt) parts.Add("Alt");
        if (m.Shift) parts.Add("Shift");
        parts.Add(key);
        return string.Join("+", parts);
    }
}
