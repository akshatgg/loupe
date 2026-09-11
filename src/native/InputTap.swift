import Foundation
import CoreGraphics
import AppKit
import QuartzCore

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

let state = TapState()

let mask: CGEventMask =
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
