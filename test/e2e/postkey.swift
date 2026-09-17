// Presses one key through the HID event stream, the way a keyboard would,
// for test/e2e/recording.e2e.js: `postkey <keycode> <flags>`. Only used with
// function keys F13-F20, which do nothing in any app, so running it cannot
// type into or trigger anything on the machine running the test.
import CoreGraphics
import Foundation

let argv = CommandLine.arguments
guard argv.count == 3, let code = UInt16(argv[1]), let flags = UInt64(argv[2]) else {
    FileHandle.standardError.write(Data("usage: postkey <keycode> <flags>\n".utf8))
    exit(2)
}
let allowed: Set<UInt16> = [105, 107, 113, 106, 64, 79, 80, 90] // F13-F20
guard allowed.contains(code) else {
    FileHandle.standardError.write(Data("postkey only presses F13-F20\n".utf8))
    exit(2)
}
for down in [true, false] {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { exit(1) }
    event.flags = CGEventFlags(rawValue: flags)
    event.post(tap: .cghidEventTap)
    usleep(20_000)
}
