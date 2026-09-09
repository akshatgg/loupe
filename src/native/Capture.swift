import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import AppKit

func emit(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String) -> Never {
    emit(["type": "error", "message": message])
    exit(1)
}

func arg(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

/// Holds the mutable capture state (first/last presentation timestamps, frame
/// count) that is written from the ScreenCaptureKit sample callback and the
/// microphone sample callback, and read from `finish()` which runs on the
/// main actor after the signal handler fires.
///
/// Both callbacks are dispatched serially on `Capture.queue` (the stream and
/// the audio session are both configured with that same queue as their
/// sample-buffer delegate queue), so writers never race each other. `finish()`
/// itself hops onto that same queue before reading the final values, so the
/// read happens-after every write. Using a plain `NSLock`-free approach here
/// would not be safe for Swift 6 strict concurrency to verify statically
/// (the compiler cannot see that both callbacks share a queue), so the state
/// lives behind a tiny actor-free serial-queue wrapper instead of being
/// silenced with `@unchecked Sendable`.
final class CaptureState: @unchecked Sendable {
    private let queue: DispatchQueue
    private var firstPTS: CMTime?
    private var lastPTS: CMTime = .zero
    private var frameCount = 0

    init(queue: DispatchQueue) {
        self.queue = queue
    }

    /// Must only be called from `queue`. Returns the PTS to report as
    /// "started" if this is the first frame observed, else nil.
    func recordFrame(pts: CMTime) -> CMTime? {
        dispatchPrecondition(condition: .onQueue(queue))
        let isFirst = firstPTS == nil
        if isFirst { firstPTS = pts }
        lastPTS = pts
        frameCount += 1
        return isFirst ? pts : nil
    }

    /// Must only be called from `queue`.
    func hasFirstFrame() -> Bool {
        dispatchPrecondition(condition: .onQueue(queue))
        return firstPTS != nil
    }

    /// Must only be called from `queue`.
    func currentFrameCount() -> Int {
        dispatchPrecondition(condition: .onQueue(queue))
        return frameCount
    }

    /// Safe to call from any queue: hops onto `queue` to read a consistent
    /// snapshot after all capture callbacks have quiesced (i.e. after
    /// `SCStream.stopCapture()` has completed).
    func finalDuration() -> Double {
        queue.sync {
            guard let firstPTS else { return 0 }
            return lastPTS.seconds - firstPTS.seconds
        }
    }
}

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate,
                     AVCaptureAudioDataOutputSampleBufferDelegate {
    private let writer: AVAssetWriter
    private let videoInput: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput?
    private var stream: SCStream?
    private var audioSession: AVCaptureSession?

    private let state: CaptureState
    private let queue = DispatchQueue(label: "tech.markai.loupe.capture")

    init(outURL: URL, width: Int, height: Int, withMic: Bool) throws {
        writer = try AVAssetWriter(outputURL: outURL, fileType: .mov)

        videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.hevc,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height
        ])
        videoInput.expectsMediaDataInRealTime = true
        writer.add(videoInput)

        if withMic {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVNumberOfChannelsKey: 1,
                AVSampleRateKey: 48000,
                AVEncoderBitRateKey: 128000
            ])
            input.expectsMediaDataInRealTime = true
            writer.add(input)
            audioInput = input
        } else {
            audioInput = nil
        }
        // `state` and the delegate-callback queue must be the exact same
        // DispatchQueue instance (not merely two queues with the same
        // label) so that CaptureState's dispatchPrecondition checks are
        // checking the queue that callbacks actually run on.
        self.state = CaptureState(queue: queue)
        super.init()
    }

    func start(filter: SCContentFilter, config: SCStreamConfiguration) async throws {
        writer.startWriting()

        if audioInput != nil {
            let session = AVCaptureSession()
            guard let device = AVCaptureDevice.default(for: .audio),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else {
                fail("no microphone available")
            }
            session.addInput(input)
            let output = AVCaptureAudioDataOutput()
            output.setSampleBufferDelegate(self, queue: queue)
            guard session.canAddOutput(output) else { fail("cannot attach audio output") }
            session.addOutput(output)
            session.startRunning()
            audioSession = session
        }

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await stream.startCapture()
        self.stream = stream
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .screen, buffer.isValid, CMSampleBufferGetNumSamples(buffer) > 0 else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer,
                createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: raw) == .complete else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(buffer)

        if let startPTS = state.recordFrame(pts: pts) {
            writer.startSession(atSourceTime: startPTS)
            // The frame's own timestamp shares the mach timebase with
            // CACurrentMediaTime() in bin/inputtap, so this alignment is exact.
            emit(["type": "started", "clock": startPTS.seconds])
        }

        guard videoInput.isReadyForMoreMediaData else { return }
        videoInput.append(buffer)

        let frames = state.currentFrameCount()
        if frames % 60 == 0 {
            let bytes = (try? FileManager.default.attributesOfItem(
                atPath: writer.outputURL.path)[.size] as? Int) ?? nil
            emit(["type": "progress", "frames": frames, "bytes": bytes ?? 0])
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput buffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard let audioInput, state.hasFirstFrame(), audioInput.isReadyForMoreMediaData else { return }
        audioInput.append(buffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail("stream stopped: \(error.localizedDescription)")
    }

    func finish() async {
        try? await stream?.stopCapture()
        audioSession?.stopRunning()
        videoInput.markAsFinished()
        audioInput?.markAsFinished()
        await writer.finishWriting()
        let duration = state.finalDuration()
        emit(["type": "stopped", "duration": duration])
    }
}

@main
struct CaptureTool {
    static func main() async {
        // Touching AppKit's shared application connects this process to the
        // window server (CGS) before ScreenCaptureKit needs it. Without
        // this, filtering capture by an individual window (as opposed to a
        // whole display) crashes with "Assertion failed: (did_initialize),
        // function CGS_REQUIRE_INIT" the first time SCContentFilter touches
        // window-server state, because a bare command-line process — unlike
        // an app with a normal AppKit run loop — never otherwise opens that
        // connection. Display-only capture doesn't need this, but window
        // capture (and `--exclude-window`, which also names windows) does.
        _ = NSApplication.shared

        guard let sourceId = arg("--source"), let out = arg("--out") else {
            fail("usage: capture --source <id> --out <path> --mic <0|1> [--exclude-window <id>]")
        }
        let withMic = arg("--mic") == "1"
        let excludeWindowID = arg("--exclude-window").flatMap { UInt32($0) }

        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            let parts = sourceId.split(separator: ":")
            guard parts.count == 2 else { fail("bad source id: \(sourceId)") }

            var filter: SCContentFilter
            var width = 0
            var height = 0

            if parts[0] == "display" {
                guard let id = UInt32(parts[1]),
                      let display = content.displays.first(where: { $0.displayID == id })
                else { fail("display not found: \(sourceId)") }
                let excluded = content.windows.filter { $0.windowID == excludeWindowID }
                filter = SCContentFilter(display: display, excludingWindows: excluded)
                width = display.width
                height = display.height
            } else {
                guard let id = UInt32(parts[1]),
                      let window = content.windows.first(where: { $0.windowID == id })
                else { fail("window not found: \(sourceId)") }
                filter = SCContentFilter(desktopIndependentWindow: window)
                width = Int(window.frame.width)
                height = Int(window.frame.height)
            }

            let scale = filter.pointPixelScale
            width = Int(Double(width) * Double(scale))
            height = Int(Double(height) * Double(scale))
            // H.264/HEVC encoders require even dimensions.
            width -= width % 2
            height -= height % 2

            let config = SCStreamConfiguration()
            config.width = width
            config.height = height
            config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.showsCursor = false      // drawn at render time instead
            config.capturesAudio = false    // system audio is a non-goal
            config.queueDepth = 6

            let url = URL(fileURLWithPath: out)
            try? FileManager.default.removeItem(at: url)
            let capture = try Capture(outURL: url, width: width, height: height, withMic: withMic)
            try await capture.start(filter: filter, config: config)

            // Ignore the default SIGTERM disposition *before* creating and
            // arming the DispatchSource. If we resume() the source first and
            // only then call signal(SIGTERM, SIG_IGN), a SIGTERM delivered in
            // that window still runs the default action (process termination)
            // instead of reaching our handler, and we'd skip finishWriting()
            // and lose the last few seconds of the recording.
            signal(SIGTERM, SIG_IGN)

            // Wait for SIGTERM, then finish writing and return normally
            // (falling off the end of an `async` @main function exits 0).
            //
            // The brief's sample used `try await Task.sleep(nanoseconds:
            // .max)` to "wait forever"; UInt64.max nanoseconds is not a
            // documented safe input and isn't the conventional way to block
            // an async main task. A more conventional alternative,
            // `dispatchMain()`, was also tried here and rejected: it
            // reliably crashed with SIGTRAP/EXC_BREAKPOINT inside
            // `dispatch_main()` itself when called from the async task that
            // backs a Swift `@main` entry point — that task does not run on
            // a context `dispatch_main()` accepts, so it hits its "must be
            // called once, from the real main thread" precondition.
            //
            // Instead, suspend on a `CheckedContinuation` that only the
            // SIGTERM handler resumes. This is a plain async wait: no
            // arbitrary large sleep, no libdispatch run-loop takeover, and
            // it composes correctly with the `await capture.finish()` call
            // that must complete before the process is allowed to exit.
            // Declared here (outside the continuation closure) so the
            // DispatchSourceSignal has a strong reference for as long as
            // `main()` itself is suspended waiting on it — a dispatch
            // source with no other owner can be deallocated (and silently
            // stop firing) as soon as the closure that created it returns.
            var term: DispatchSourceSignal?
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
                source.setEventHandler {
                    Task {
                        await capture.finish()
                        continuation.resume()
                    }
                }
                term = source
                source.resume()
            }
            withExtendedLifetime(term) {}
        } catch {
            fail(error.localizedDescription)
        }
    }
}
