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

final class TapState {
    var tap: CFMachPort?
    var lastCursorEmit: Double = 0
    let cursorInterval = 1.0 / 120.0
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

    let now = CACurrentMediaTime()
    let location = event.location

    switch type {
    case .scrollWheel:
        // ONLY Option+scroll is consumed. Everything else passes through
        // untouched, with no added latency.
        guard event.flags.contains(.maskAlternate) else {
            return Unmanaged.passUnretained(event)
        }
        let dy = event.getDoubleValueField(.scrollWheelEventPointDeltaAxis1)
        emit(["type": "zoom", "clock": now, "dy": dy,
              "x": location.x, "y": location.y])
        return nil

    case .leftMouseDown, .rightMouseDown:
        emit(["type": "click", "clock": now,
              "x": location.x, "y": location.y,
              "button": type == .leftMouseDown ? "left" : "right"])
        return Unmanaged.passUnretained(event)

    case .mouseMoved, .leftMouseDragged:
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
    (1 << CGEventType.leftMouseDragged.rawValue)

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
