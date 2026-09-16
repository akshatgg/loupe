import Foundation
import CoreGraphics
import AppKit
import QuartzCore
import Carbon.HIToolbox

let outputQueue = DispatchQueue(label: "tech.markai.loupe.inputtap.out")

func emit(_ dict: [String: Any]) {
    outputQueue.async {
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}

func fail(_ message: String) -> Never {
    emit(["type": "error", "message": message])
    outputQueue.sync {}
    exit(1)
}

func arg(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

// The zoom shortcuts, from Loupe's settings (settings.js inputTapArgs): a
// comma list of buttons, any of which held while scrolling zooms. "" means
// none; with no flag at all this is the original behaviour, Option only.
struct ZoomTriggers {
    var modifiers: CGEventFlags = []
    var sideButtons = false   // back/forward: button 3 and up
    var middleButton = false  // button 2

    init(_ spec: String?) {
        for name in (spec ?? "option").split(separator: ",") {
            switch name {
            case "option": modifiers.insert(.maskAlternate)
            case "control": modifiers.insert(.maskControl)
            case "command": modifiers.insert(.maskCommand)
            case "shift": modifiers.insert(.maskShift)
            case "mouse-side": sideButtons = true
            case "mouse-middle": middleButton = true
            default: break
            }
        }
    }

    func matches(button: Int64) -> Bool {
        (sideButtons && button >= 3) || (middleButton && button == 2)
    }
}

// Tags the mouse clicks this tap replays (see replayClick), so the tap lets
// its own replays through instead of catching them again.
let replayTag: Int64 = 0x4C4F555045 // "LOUPE"

final class TapState {
    var tap: CFMachPort?
    var lastCursorEmit: Double = 0
    let cursorInterval = 1.0 / 120.0
    let triggers = ZoomTriggers(arg("--zoom-triggers"))
    // The shortcut mouse button currently held down (swallowed until
    // release), and whether any scroll-zoom happened while it was.
    var buttonHeld: Int64?
    var zoomedDuringHold = false
    // `--keys 1`: report keyboard shortcuts (see shortcutLabel).
    let keys = arg("--keys") == "1"
}

// ---- keyboard shortcuts -----------------------------------------------------
// Only presses that are clearly commands are reported: a key held with ⌘, ⌃
// or ⌥, or one of the keys that is a command on its own (Esc, Tab, Return,
// Delete, the arrows, function keys). Plain typing -- letters, digits,
// punctuation, with or without Shift -- is never reported, so nothing typed
// (a password, a message) ends up in a recording. Password fields also turn
// on Secure Event Input, which hides every key from event taps anyway.

// Keys that are commands on their own, by virtual key code, with the symbol
// macOS menus use for them.
let standaloneKeys: [Int: String] = [
    kVK_Escape: "⎋", kVK_Tab: "⇥", kVK_Return: "↩", kVK_ANSI_KeypadEnter: "⌤",
    kVK_Delete: "⌫", kVK_ForwardDelete: "⌦",
    kVK_LeftArrow: "←", kVK_RightArrow: "→", kVK_UpArrow: "↑", kVK_DownArrow: "↓",
    kVK_F1: "F1", kVK_F2: "F2", kVK_F3: "F3", kVK_F4: "F4", kVK_F5: "F5", kVK_F6: "F6",
    kVK_F7: "F7", kVK_F8: "F8", kVK_F9: "F9", kVK_F10: "F10", kVK_F11: "F11", kVK_F12: "F12",
    kVK_F13: "F13", kVK_F14: "F14", kVK_F15: "F15", kVK_F16: "F16", kVK_F17: "F17",
    kVK_F18: "F18", kVK_F19: "F19", kVK_F20: "F20"
]

// Keys only worth naming as part of a shortcut.
let namedKeys: [Int: String] = [
    kVK_Space: "Space", kVK_Home: "↖", kVK_End: "↘", kVK_PageUp: "⇞", kVK_PageDown: "⇟"
]

// What the key prints with no modifiers, on the current keyboard layout, so
// ⌘Z reads "⌘Z" on a QWERTZ keyboard too, and ⌘⇧2 is "⌘⇧2" rather than "⌘⇧@".
func layoutCharacter(keyCode: Int) -> String? {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
          let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return nil }
    let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
    var deadKeys: UInt32 = 0
    var chars = [UniChar](repeating: 0, count: 4)
    var length = 0
    let status = data.withUnsafeBytes { (ptr: UnsafeRawBufferPointer) -> OSStatus in
        guard let layout = ptr.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else {
            return -1
        }
        return UCKeyTranslate(layout, UInt16(keyCode), UInt16(kUCKeyActionDisplay), 0,
                              UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysBit),
                              &deadKeys, chars.count, &length, &chars)
    }
    guard status == noErr, length > 0 else { return nil }
    let text = String(utf16CodeUnits: chars, count: length).trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text.uppercased()
}

/// The label for a key press, like "⌘⇧K" -- or nil when the press is typing
/// rather than a shortcut. Modifiers in the order macOS menus show them.
func shortcutLabel(keyCode: Int, flags: CGEventFlags) -> String? {
    let command = flags.contains(.maskCommand)
    let control = flags.contains(.maskControl)
    let option = flags.contains(.maskAlternate)
    let shift = flags.contains(.maskShift)
    let standalone = standaloneKeys[keyCode]
    guard command || control || option || standalone != nil else { return nil }
    // ⌥ with a character key (and no ⌘/⌃) types a character on macOS
    // (⌥E for an accent, ⌥2 for € and so on): typing, not a shortcut.
    // ⌥ with a named key (⌥←, ⌥Space, ⌥↩) is still a shortcut.
    let named = standalone ?? namedKeys[keyCode]
    if option && !command && !control && named == nil { return nil }
    guard let key = named ?? layoutCharacter(keyCode: keyCode) else {
        return nil
    }
    var label = ""
    if control { label += "⌃" }
    if option { label += "⌥" }
    if shift { label += "⇧" }
    if command { label += "⌘" }
    return label + key
}

// A shortcut-button press that turned out NOT to be a zoom gesture is
// replayed on release, so the button still does its normal job (browser
// Back/Forward for a side button, open-in-new-tab for the middle one).
func replayClick(button: Int64, at location: CGPoint) {
    for type in [CGEventType.otherMouseDown, .otherMouseUp] {
        guard let e = CGEvent(mouseEventSource: nil, mouseType: type,
                              mouseCursorPosition: location, mouseButton: .center)
        else { continue }
        e.setIntegerValueField(.mouseEventButtonNumber, value: button)
        e.setIntegerValueField(.eventSourceUserData, value: replayTag)
        e.post(tap: .cgSessionEventTap)
    }
}

func cursorShape() -> String {
    guard let current = NSCursor.currentSystem else { return "arrow" }
    switch current {
    case NSCursor.iBeam: return "ibeam"
    case NSCursor.pointingHand: return "pointinghand"
    case NSCursor.resizeLeftRight, NSCursor.resizeUpDown: return "resize"
    default: return "arrow"
    }
}

let callback: CGEventTapCallBack = { _, type, event, userInfo in
    let state = Unmanaged<TapState>.fromOpaque(userInfo!).takeUnretainedValue()

    // macOS disables a tap whose callback runs slow. Re-enable immediately.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = state.tap { CGEvent.tapEnable(tap: tap, enable: true) }
        emit(["type": "tap_reenabled", "clock": CACurrentMediaTime()])
        return nil
    }

    // Our own replayed side-button clicks go straight through.
    if event.getIntegerValueField(.eventSourceUserData) == replayTag {
        return Unmanaged.passUnretained(event)
    }

    let now = CACurrentMediaTime()
    let location = event.location

    switch type {
    case .scrollWheel:
        // ONLY a zoom-trigger scroll is consumed. Everything else passes
        // through untouched, with no added latency.
        let byModifier = !event.flags.intersection(state.triggers.modifiers).isEmpty
        let byButton = state.buttonHeld != nil
        guard byModifier || byButton else {
            return Unmanaged.passUnretained(event)
        }
        var dy = event.getDoubleValueField(.scrollWheelEventPointDeltaAxis1)
        // Zoom follows the wheel/fingers physically -- scroll up (away from
        // you) zooms in, back down zooms out -- whatever the Natural
        // scrolling setting, which flips the delta macOS reports.
        if NSEvent(cgEvent: event)?.isDirectionInvertedFromDevice == true { dy = -dy }
        if byButton { state.zoomedDuringHold = true }
        emit(["type": "zoom", "clock": now, "dy": dy,
              "x": location.x, "y": location.y])
        return nil

    case .otherMouseDown:
        let button = event.getIntegerValueField(.mouseEventButtonNumber)
        guard state.buttonHeld == nil, state.triggers.matches(button: button) else {
            return Unmanaged.passUnretained(event)
        }
        // Held back until release: only then do we know whether this was a
        // zoom (swallow it) or an ordinary click (replay it).
        state.buttonHeld = button
        state.zoomedDuringHold = false
        return nil

    case .otherMouseUp:
        let button = event.getIntegerValueField(.mouseEventButtonNumber)
        guard state.buttonHeld == button else { return Unmanaged.passUnretained(event) }
        state.buttonHeld = nil
        if !state.zoomedDuringHold { replayClick(button: button, at: location) }
        return nil

    case .keyDown:
        // Held keys repeat; one press is one shortcut.
        guard state.keys, event.getIntegerValueField(.keyboardEventAutorepeat) == 0 else {
            return Unmanaged.passUnretained(event)
        }
        let keyCode = Int(event.getIntegerValueField(.keyboardEventKeycode))
        if let label = shortcutLabel(keyCode: keyCode, flags: event.flags) {
            emit(["type": "key", "clock": now, "label": label])
        }
        return Unmanaged.passUnretained(event)

    case .leftMouseDown, .rightMouseDown:
        emit(["type": "click", "clock": now,
              "x": location.x, "y": location.y,
              "button": type == .leftMouseDown ? "left" : "right"])
        return Unmanaged.passUnretained(event)

    // otherMouseDragged: moving the mouse while holding a side button to zoom.
    case .mouseMoved, .leftMouseDragged, .otherMouseDragged:
        if now - state.lastCursorEmit >= state.cursorInterval {
            state.lastCursorEmit = now
            emit(["type": "cursor", "clock": now,
                  "x": location.x, "y": location.y,
                  "shape": cursorShape()])
        }
        return Unmanaged.passUnretained(event)

    default:
        return Unmanaged.passUnretained(event)
    }
}

// bin/capture needed NSApplication.shared initialised to avoid a
// CGS_REQUIRE_INIT crash when talking to the window server. CGEventTap calls
// into the same window-server plumbing (it is what backs cursor-shape and
// event-flag queries), so initialise the app object here too before touching
// any CoreGraphics/AppKit APIs that require it.
_ = NSApplication.shared

// `inputtap --describe-key <keycode> <flags>` prints the label a press would
// get ("" for plain typing) and exits, without installing a tap: lets
// test/native-keys.test.js check the shortcut rules without pressing keys.
if let i = CommandLine.arguments.firstIndex(of: "--describe-key"), i + 2 < CommandLine.arguments.count,
   let keyCode = Int(CommandLine.arguments[i + 1]), let flags = UInt64(CommandLine.arguments[i + 2]) {
    print(shortcutLabel(keyCode: keyCode, flags: CGEventFlags(rawValue: flags)) ?? "")
    exit(0)
}

let state = TapState()

// Key events only when asked for: without --keys the tap never sees a key.
let keyMask: CGEventMask = state.keys ? (1 << CGEventType.keyDown.rawValue) : 0

let mask: CGEventMask =
    keyMask |
    (1 << CGEventType.scrollWheel.rawValue) |
    (1 << CGEventType.leftMouseDown.rawValue) |
    (1 << CGEventType.rightMouseDown.rawValue) |
    (1 << CGEventType.mouseMoved.rawValue) |
    (1 << CGEventType.leftMouseDragged.rawValue) |
    (1 << CGEventType.otherMouseDown.rawValue) |
    (1 << CGEventType.otherMouseUp.rawValue) |
    (1 << CGEventType.otherMouseDragged.rawValue)

guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .defaultTap,
    eventsOfInterest: mask,
    callback: callback,
    userInfo: Unmanaged.passUnretained(state).toOpaque()
) else {
    fail("could not create event tap: Accessibility permission is required")
}

state.tap = tap
let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

emit(["type": "ready"])
CFRunLoopRun()
