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

/// Holds the mutable capture state (first-frame PTS, frame count, and the
/// wall-clock bounds of the recording) that is written from the
/// ScreenCaptureKit sample callback and the microphone sample callback, and
/// read from `finish()` which runs on the main actor after the signal
/// handler fires.
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
    private var frameCount = 0
    // Recording length is measured on the wall clock (CACurrentMediaTime),
    // not from frame PTS deltas: ScreenCaptureKit only delivers a frame when
    // content changes, so a static window can go many seconds between
    // frames and a PTS-delta duration would collapse to near zero even
    // though the recording ran the whole time. CACurrentMediaTime() shares
    // the mach timebase with CMSampleBuffer presentation timestamps and
    // with bin/inputtap's clock, so mixing it with `firstPTS.seconds`
    // elsewhere in this file stays consistent.
    private var startWallClock: CFTimeInterval?
    private var stopWallClock: CFTimeInterval?

    init(queue: DispatchQueue) {
        self.queue = queue
    }

    /// Must only be called from `queue`. Returns the PTS to report as
    /// "started" if this is the first frame observed, else nil.
    func recordFrame(pts: CMTime) -> CMTime? {
        dispatchPrecondition(condition: .onQueue(queue))
        let isFirst = firstPTS == nil
        if isFirst {
            firstPTS = pts
            startWallClock = CACurrentMediaTime()
        }
        frameCount += 1
        return isFirst ? pts : nil
    }

    /// Must only be called from `queue`. Bumps the frame count for a
    /// synthetic (idle-repaint) frame without disturbing `firstPTS` /
    /// `startWallClock`, which must stay pinned to the first *real* frame.
    func recordSyntheticFrame() {
        dispatchPrecondition(condition: .onQueue(queue))
        frameCount += 1
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

    /// Must only be called from `queue`, once, when capture has stopped
    /// (i.e. right after `SCStream.stopCapture()` returns). Marks the end
    /// of the wall-clock window used by `finalDuration()`.
    func markStopped() {
        dispatchPrecondition(condition: .onQueue(queue))
        stopWallClock = CACurrentMediaTime()
    }

    /// Safe to call from any queue: hops onto `queue` to read a consistent
    /// snapshot after `markStopped()` has run. If no frame ever arrived,
    /// returns 0 rather than dividing/subtracting against a missing start.
    func finalDuration() -> Double {
        queue.sync {
            guard let startWallClock else { return 0 }
            let end = stopWallClock ?? CACurrentMediaTime()
            return end - startWallClock
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

    // Idle-repaint support: when ScreenCaptureKit stops delivering frames
    // because nothing on screen changed, we re-append the last frame on a
    // timer so the output file keeps pace with wall-clock time instead of
    // holding a single frame for the whole recording. `lastSampleBuffer`,
    // `lastFrameHostTime`, `lastAppendedPTS`, and `writerFailureReported`
    // are read and written only from `queue` (inside the stream-output
    // callback and inside `repaintIfIdle`, which only ever runs as
    // `idleTimer`'s event handler on `queue`), preserving the same
    // single-queue confinement as `CaptureState`.
    //
    // 500ms was chosen over something closer to a frame interval (~16.7ms
    // at 60fps): a static screen is by definition not changing, so
    // repainting every frame tick buys no visual fidelity and would inflate
    // the file by ~60x for a static recording. 500ms keeps the file's
    // frame timeline dense enough that editor scrubbing, thumbnailing, and
    // the downstream camera solver never see a gap wider than half a
    // second, while adding only ~2 duplicate frames per second of
    // stillness. Much longer (multi-second) intervals would risk a solver
    // keyframe landing in a gap between synthetic frames, and would make a
    // player's "how far along is this" progress bar visibly stutter when
    // seeking through a static stretch.
    private static let idleRepaintInterval: TimeInterval = 0.5
    private var idleTimer: DispatchSourceTimer?
    private var lastSampleBuffer: CMSampleBuffer?
    private var lastFrameHostTime: CFTimeInterval = 0

    // The PTS actually handed to `videoInput.append`, whichever path
    // produced it (real frame or synthetic repaint). Every append — real or
    // synthetic — is enforced strictly greater than this before it is
    // attempted, so `AVAssetWriterInput`'s monotonic-PTS requirement holds
    // regardless of which path fires next. Read/written only from `queue`.
    private var lastAppendedPTS: CMTime?

    // Set the first time `videoInput.append` returns false, so a failed
    // writer (which fails every subsequent append too) produces exactly one
    // `error` line instead of one per dropped frame for the rest of the
    // recording. Read/written only from `queue`.
    private var writerFailureReported = false

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

        // Scheduled on `queue` so its event handler (`repaintIfIdle`) runs
        // with the same queue confinement as the stream and audio
        // callbacks. The `idleTimer` field itself is *not* queue-confined —
        // this assignment runs wherever `start()`'s caller runs, not on
        // `queue` — so its safety is a sequencing argument, not confinement:
        // the only other access is `finish()`'s `queue.sync` block, and
        // `finish()` cannot be called until `start()` has already returned
        // (this assignment included), so that later access always happens
        // after this write.
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + Self.idleRepaintInterval,
                        repeating: Self.idleRepaintInterval)
        timer.setEventHandler { [weak self] in self?.repaintIfIdle() }
        timer.resume()
        idleTimer = timer
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

        guard let appended = appendAndTrack(buffer, pts: pts) else { return }
        lastSampleBuffer = appended
        lastFrameHostTime = lastAppendedPTS?.seconds ?? pts.seconds

        let frames = state.currentFrameCount()
        if frames % 60 == 0 {
            let bytes = (try? FileManager.default.attributesOfItem(
                atPath: writer.outputURL.path)[.size] as? Int) ?? nil
            emit(["type": "progress", "frames": frames, "bytes": bytes ?? 0])
        }
    }

    /// Runs only as `idleTimer`'s event handler, which is scheduled on
    /// `queue` — so this has the same queue confinement as the stream
    /// output callback it shares `lastSampleBuffer`/`lastFrameHostTime`
    /// with. If no real frame has landed in the last idle interval,
    /// re-stamps and re-appends the most recent frame so the file's frame
    /// timeline keeps pace with wall-clock time instead of holding a
    /// single frame for the whole idle stretch.
    private func repaintIfIdle() {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let last = lastSampleBuffer, state.hasFirstFrame() else { return }
        let now = CACurrentMediaTime()
        guard now - lastFrameHostTime >= Self.idleRepaintInterval else { return }
        guard videoInput.isReadyForMoreMediaData else { return }

        let candidatePTS = CMTime(seconds: now, preferredTimescale: 600)
        var timing = CMSampleTimingInfo(duration: .invalid,
                                         presentationTimeStamp: candidatePTS,
                                         decodeTimeStamp: .invalid)
        var repainted: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault,
            sampleBuffer: last,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleBufferOut: &repainted)
        guard status == noErr, let repainted else { return }

        // `appendAndTrack` re-checks and, if needed, re-stamps `candidatePTS`
        // against `lastAppendedPTS` — this is what keeps a synthetic repaint
        // from landing behind a real frame that was appended after `now` was
        // read above but before this append happens.
        guard let appended = appendAndTrack(repainted, pts: candidatePTS) else { return }
        lastSampleBuffer = appended
        lastFrameHostTime = lastAppendedPTS?.seconds ?? now
        state.recordSyntheticFrame()
    }

    /// Appends `buffer` to `videoInput`, enforcing the strictly-increasing
    /// presentation-timestamp invariant `AVAssetWriterInput` requires, and
    /// checking the append's result. Both the real-frame path (in
    /// `stream(_:didOutputSampleBuffer:of:)`) and the idle-repaint path (in
    /// `repaintIfIdle`) go through this one function so the invariant holds
    /// no matter which one fires next. Must only be called from `queue`.
    ///
    /// If `pts` is at or behind `lastAppendedPTS`, the frame is restamped to
    /// land just past it rather than dropped. The reachable case is a real
    /// frame racing a synthetic repaint: content changes and a frame is
    /// captured stamped `T − ε`, but before it is delivered the idle timer
    /// fires and appends a synthetic frame stamped `T`, so the real frame
    /// arrives already behind. That real frame is exactly the content this
    /// whole idle-repaint scheme exists to keep — skipping it would throw
    /// away a genuine on-screen change, whereas nudging its timestamp by one
    /// tick (~1.7ms at the 600 timescale used below) is far below the
    /// granularity (one frame interval, ~16.7ms at 60fps) that downstream
    /// zoom keyframes align against. So: restamp, don't skip, for both real
    /// and synthetic frames.
    ///
    /// Returns the buffer actually appended (identical to `buffer` unless
    /// restamped), or `nil` if nothing was appended.
    @discardableResult
    private func appendAndTrack(_ buffer: CMSampleBuffer, pts: CMTime) -> CMSampleBuffer? {
        dispatchPrecondition(condition: .onQueue(queue))
        var toAppend = buffer
        var appendedPTS = pts

        if let last = lastAppendedPTS, pts <= last {
            // Bump by exactly one tick of a fixed 600 timescale using integer
            // value arithmetic, not `last.seconds + epsilon` reconstructed via
            // `CMTime(seconds:preferredTimescale:)`: a small-enough seconds
            // epsilon can round back down to the same tick it started from
            // (e.g. `10.000 + 0.001` at timescale 600, whose tick is
            // ~0.001667s, rounds to the same `CMTime` as `10.000`), which
            // would silently fail to advance the timestamp at all. Adding 1
            // to the integer tick value cannot round away — it is always
            // strictly greater.
            let last600 = CMTimeConvertScale(last, timescale: 600, method: .default)
            appendedPTS = CMTime(value: last600.value + 1, timescale: 600)
            var timing = CMSampleTimingInfo(duration: .invalid,
                                             presentationTimeStamp: appendedPTS,
                                             decodeTimeStamp: .invalid)
            var restamped: CMSampleBuffer?
            let status = CMSampleBufferCreateCopyWithNewTiming(
                allocator: kCFAllocatorDefault,
                sampleBuffer: buffer,
                sampleTimingEntryCount: 1,
                sampleTimingArray: &timing,
                sampleBufferOut: &restamped)
            guard status == noErr, let restamped else { return nil }
            toAppend = restamped
        }

        guard videoInput.isReadyForMoreMediaData else { return nil }
        guard videoInput.append(toAppend) else {
            reportWriterFailureIfNeeded()
            return nil
        }
        lastAppendedPTS = appendedPTS
        return toAppend
    }

    /// Emits one `error` NDJSON line the first time `videoInput.append`
    /// fails, rather than one per subsequent dropped frame: once
    /// `AVAssetWriter.status` is `.failed`, every later append fails too, so
    /// without this guard the rest of the recording would flood stdout with
    /// a duplicate line per frame instead of the single line that actually
    /// tells the caller the recording is being lost. Must only be called
    /// from `queue`.
    private func reportWriterFailureIfNeeded() {
        dispatchPrecondition(condition: .onQueue(queue))
        guard !writerFailureReported else { return }
        writerFailureReported = true
        let detail = writer.error?.localizedDescription ?? "unknown error"
        emit(["type": "error",
              "message": "video append failed, writer status \(writer.status.rawValue): \(detail)"])
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
        // Stop the idle-repaint timer and mark the wall-clock stop time in
        // the same trip onto `queue`, so no further repaint can fire after
        // we've decided the recording is over.
        queue.sync {
            idleTimer?.cancel()
            idleTimer = nil
            state.markStopped()
        }
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
            fail("usage: capture --source <id> --out <path> --mic <0|1> " +
                 "[--exclude-window <id>] [--crop-x N --crop-y N --crop-w N --crop-h N]")
        }
        let withMic = arg("--mic") == "1"
        let excludeWindowID = arg("--exclude-window").flatMap { UInt32($0) }

        // A region crop, if present: the four --crop-* args are all-or-nothing
        // (main.js's recorder.js only ever passes all four together), in
        // logical points, in the SAME global display coordinate space
        // bin/sources reports source x/y in -- not yet rebased against any
        // particular display's origin. That rebasing happens below, once we
        // know which display was requested, because SCStreamConfiguration's
        // sourceRect is relative to the display's own origin, not global.
        let crop: CGRect? = {
            guard let cx = arg("--crop-x").flatMap(Double.init),
                  let cy = arg("--crop-y").flatMap(Double.init),
                  let cw = arg("--crop-w").flatMap(Double.init),
                  let ch = arg("--crop-h").flatMap(Double.init)
            else { return nil }
            return CGRect(x: cx, y: cy, width: cw, height: ch)
        }()

        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            let parts = sourceId.split(separator: ":")
            guard parts.count == 2 else { fail("bad source id: \(sourceId)") }

            // Region cropping is scoped to display sources: a window's own
            // frame already IS the "crop" a user would draw against a window,
            // and SCStreamConfiguration's sourceRect is documented against a
            // display's coordinate space, not a window's.
            if crop != nil, parts[0] != "display" {
                fail("region crop is only supported for display sources")
            }

            var filter: SCContentFilter
            var width = 0
            var height = 0
            var sourceRect: CGRect?

            if parts[0] == "display" {
                guard let id = UInt32(parts[1]),
                      let display = content.displays.first(where: { $0.displayID == id })
                else { fail("display not found: \(sourceId)") }
                let excluded = content.windows.filter { $0.windowID == excludeWindowID }
                filter = SCContentFilter(display: display, excludingWindows: excluded)
                if let crop {
                    // Rebase the crop's global-space origin against this
                    // display's own origin -- SCStreamConfiguration.sourceRect
                    // is display-local, unlike every other coordinate this
                    // tool and bin/sources deal in.
                    let origin = display.frame.origin
                    sourceRect = CGRect(x: crop.origin.x - origin.x,
                                         y: crop.origin.y - origin.y,
                                         width: crop.width, height: crop.height)
                    width = Int(crop.width)
                    height = Int(crop.height)
                } else {
                    width = display.width
                    height = display.height
                }
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
            if let sourceRect { config.sourceRect = sourceRect }
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
