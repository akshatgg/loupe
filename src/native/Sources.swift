import Foundation
import ScreenCaptureKit
import AppKit

struct SourceOut: Encodable {
    let id: String
    let kind: String
    let title: String
    let app: String?
    let width: Int
    let height: Int
    let thumbnail: String?
}

func emit(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func arg(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func thumbnail(for filter: SCContentFilter, width: Int, height: Int) async -> String? {
    let config = SCStreamConfiguration()
    let scale = 320.0 / Double(max(width, 1))
    config.width = 320
    config.height = max(1, Int(Double(height) * scale))
    config.showsCursor = false
    guard let image = try? await SCScreenshotManager.captureImage(contentFilter: filter,
                                                                 configuration: config) else {
        return nil
    }
    let rep = NSBitmapImageRep(cgImage: image)
    guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
    return "data:image/png;base64," + png.base64EncodedString()
}

@main
struct SourcesTool {
    static func main() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            var out: [SourceOut] = []

            for display in content.displays {
                let filter = SCContentFilter(display: display, excludingWindows: [])
                out.append(SourceOut(
                    id: "display:\(display.displayID)",
                    kind: "display",
                    title: "Display \(display.width)x\(display.height)",
                    app: nil,
                    width: display.width,
                    height: display.height,
                    thumbnail: await thumbnail(for: filter,
                                               width: display.width,
                                               height: display.height)))
            }

            let excludeBundle = arg("--exclude-bundle")
            for window in content.windows {
                guard let title = window.title, !title.isEmpty,
                      window.frame.width > 40, window.frame.height > 40,
                      excludeBundle == nil || window.owningApplication?.bundleIdentifier != excludeBundle
                else { continue }

                let filter = SCContentFilter(desktopIndependentWindow: window)
                let w = Int(window.frame.width)
                let h = Int(window.frame.height)
                out.append(SourceOut(
                    id: "window:\(window.windowID)",
                    kind: "window",
                    title: title,
                    app: window.owningApplication?.applicationName,
                    width: w,
                    height: h,
                    thumbnail: await thumbnail(for: filter, width: w, height: h)))
            }

            let data = try JSONEncoder().encode(out)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
            exit(0)
        } catch {
            emit(["type": "error", "message": error.localizedDescription])
            exit(1)
        }
    }
}
