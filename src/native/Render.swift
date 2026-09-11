import Foundation
import AVFoundation
import CoreImage
import CoreGraphics
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

// Spins until `isReady()` is true, but aborts via `fail` (naming `stage`) the
// moment the writer has failed instead of spinning forever. AVFoundation
// leaves an input permanently not-ready once its writer fails, so without
// this check a failed writer would hang the process rather than exit.
func waitForReady(_ writer: AVAssetWriter, stage: String, isReady: () -> Bool) {
    while !isReady() {
        if writer.status == .failed {
            fail("\(stage): writer failed: \(writer.error?.localizedDescription ?? "unknown")")
        }
        usleep(2000)
    }
}

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

struct CameraSample { var t: Double; var zoom: Double; var cx: Double; var cy: Double }
struct CursorSample { var t: Double; var x: Double; var y: Double }

struct Click: Decodable { let t: Double; let x: Double; let y: Double }
// showCursor is optional: projects from before it existed have no key, and
// those have always shown the cursor.
struct Settings: Decodable { let clickHighlights: Bool; let showCursor: Bool? }
struct SourceInfo: Decodable { let width: Double; let height: Double }
// retime.json, written by main.js (speed.js retimePlan) at export: for each
// output frame k (shown at k/fps), the recording time it shows; and the
// constant-rate slices to stretch the audio by, so it matches the video.
struct AudioSlice: Decodable { let srcStart: Double; let srcEnd: Double; let rate: Double }
struct RetimePlan: Decodable {
    let fps: Int
    let outputDuration: Double
    let frames: [Double]
    let audio: [AudioSlice]
    let preservePitch: Bool

    // No speed stretches: the recording, straight through, at 60fps.
    static func straight(duration: Double) -> RetimePlan {
        let count = max(1, Int((duration * 60).rounded(.up)))
        return RetimePlan(fps: 60, outputDuration: duration,
                          frames: (0..<count).map { Double($0) / 60 },
                          audio: [], preservePitch: true)
    }
}

func cmTime(_ seconds: Double) -> CMTime { CMTime(seconds: seconds, preferredTimescale: 1_000_000) }

struct Project: Decodable {
    let source: SourceInfo
    let clicks: [Click]
    let settings: Settings
}

// Reads fixed-width little-endian float32 records from a binary track file
// (camera.bin / cursor.bin). Both are 16-byte records of 4 float32 fields;
// for cursor.bin the 4th field overlaps the 1-byte shape tag plus 3 padding
// bytes, which decodes to a meaningless float we simply never read.
func readRecords(_ url: URL, stride: Int) -> [[Float]] {
    guard let data = try? Data(contentsOf: url) else { return [] }
    let fieldsPerRecord = stride / 4
    var out: [[Float]] = []
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        var at = 0
        while at + stride <= raw.count {
            var fields: [Float] = []
            fields.reserveCapacity(fieldsPerRecord)
            for f in 0..<fieldsPerRecord {
                let bits = raw.loadUnaligned(fromByteOffset: at + f * 4, as: UInt32.self)
                fields.append(Float(bitPattern: UInt32(littleEndian: bits)))
            }
            out.append(fields)
            at += stride
        }
    }
    return out
}

// Nearest-sample lookup. The camera track is 120Hz, denser than any output
// frame rate, so interpolation buys nothing visible.
func sample(_ track: [CameraSample], at t: Double, default def: CameraSample) -> CameraSample {
    guard !track.isEmpty else { return def }
    var lo = 0, hi = track.count - 1
    while hi - lo > 1 {
        let mid = (lo + hi) / 2
        if track[mid].t <= t { lo = mid } else { hi = mid }
    }
    return abs(track[lo].t - t) <= abs(track[hi].t - t) ? track[lo] : track[hi]
}

func sampleCursor(_ track: [CursorSample], at t: Double) -> CursorSample? {
    guard !track.isEmpty else { return nil }
    var lo = 0, hi = track.count - 1
    while hi - lo > 1 {
        let mid = (lo + hi) / 2
        if track[mid].t <= t { lo = mid } else { hi = mid }
    }
    return abs(track[lo].t - t) <= abs(track[hi].t - t) ? track[lo] : track[hi]
}

func drawCursor(_ ctx: CGContext, at p: CGPoint, scale: CGFloat) {
    // Classic arrow, drawn rather than blitted so it stays crisp at any zoom.
    let s = scale
    let path = CGMutablePath()
    path.move(to: CGPoint(x: p.x, y: p.y))
    path.addLine(to: CGPoint(x: p.x, y: p.y + 17 * s))
    path.addLine(to: CGPoint(x: p.x + 4.5 * s, y: p.y + 13 * s))
    path.addLine(to: CGPoint(x: p.x + 7.5 * s, y: p.y + 19 * s))
    path.addLine(to: CGPoint(x: p.x + 10.5 * s, y: p.y + 17.5 * s))
    path.addLine(to: CGPoint(x: p.x + 7.5 * s, y: p.y + 11.5 * s))
    path.addLine(to: CGPoint(x: p.x + 12 * s, y: p.y + 11.5 * s))
    path.closeSubpath()

    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -1 * s), blur: 3 * s,
                  color: CGColor(gray: 0, alpha: 0.45))
    ctx.addPath(path)
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.fillPath()
    ctx.addPath(path)
    ctx.setStrokeColor(CGColor(gray: 0, alpha: 0.85))
    ctx.setLineWidth(1.2 * s)
    ctx.strokePath()
    ctx.restoreGState()
}

func drawRipple(_ ctx: CGContext, at p: CGPoint, age: Double, scale: CGFloat) {
    let progress = age / 0.5
    guard progress >= 0, progress <= 1 else { return }
    let radius = (6 + 34 * progress) * scale
    ctx.setStrokeColor(CGColor(red: 0.23, green: 0.51, blue: 0.96,
                               alpha: 0.55 * (1 - progress)))
    ctx.setLineWidth(2.5 * scale)
    ctx.strokeEllipse(in: CGRect(x: p.x - radius, y: p.y - radius,
                                 width: radius * 2, height: radius * 2))
}

@main
struct RenderTool {
    static func main() async {
        guard let projectDir = arg("--project"), let outPath = arg("--out"),
              let outW = Int(arg("--width") ?? ""), let outH = Int(arg("--height") ?? "")
        else { fail("usage: render --project <dir> --out <path> --width W --height H [--codec h264|hevc]") }

        let codec: AVVideoCodecType = (arg("--codec") == "hevc") ? .hevc : .h264
        let dir = URL(fileURLWithPath: projectDir)

        guard let projectData = try? Data(contentsOf: dir.appendingPathComponent("project.json")),
              let project = try? JSONDecoder().decode(Project.self, from: projectData)
        else { fail("could not read project.json") }

        let camera = readRecords(dir.appendingPathComponent("camera.bin"), stride: 16)
            .map { CameraSample(t: Double($0[0]), zoom: Double($0[1]),
                                cx: Double($0[2]), cy: Double($0[3])) }
        let cursor = readRecords(dir.appendingPathComponent("cursor.bin"), stride: 16)
            .map { CursorSample(t: Double($0[0]), x: Double($0[1]), y: Double($0[2])) }
        // If there is no camera track (zoom disabled, or nothing solved yet),
        // fall back to an unzoomed frame centred on the source, rather than
        // the degenerate (zoom:1, cx:0, cy:0) a naive empty-track default
        // would produce, which would crop the top-left corner instead of
        // showing the whole screen.
        let noZoomDefault = CameraSample(t: 0, zoom: 1,
                                          cx: project.source.width / 2,
                                          cy: project.source.height / 2)

        let asset = AVURLAsset(url: dir.appendingPathComponent("raw.mov"))
        guard let videoTrack = try? await asset.loadTracks(withMediaType: .video).first
        else { fail("no video track in raw.mov") }

        guard let naturalSize = try? await videoTrack.load(.naturalSize) else {
            fail("could not read video dimensions")
        }
        // Camera math is in logical points; the video is in physical pixels.
        let scale = naturalSize.width / project.source.width

        // Which moment of the recording each output frame shows, and how to
        // stretch the audio to match -- written by main.js from speed.js, so
        // no timing math lives here. A project exported before speed control
        // existed has no plan: play it straight through at 60fps.
        let plan: RetimePlan
        if let data = try? Data(contentsOf: dir.appendingPathComponent("retime.json")),
           let decoded = try? JSONDecoder().decode(RetimePlan.self, from: data) {
            plan = decoded
        } else {
            plan = RetimePlan.straight(duration: (try? await asset.load(.duration).seconds) ?? 0)
        }

        guard let reader = try? AVAssetReader(asset: asset) else { fail("cannot read raw.mov") }
        let videoOut = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ])
        reader.add(videoOut)

        // Audio goes through a composition whose time ranges are scaled by
        // the plan's slices, read back through an audio mix output that
        // time-stretches with pitch kept natural (PRD FR-22/23) -- or at tape
        // speed if that setting is off. With no speed stretches this is just
        // the original audio.
        var audioReader: AVAssetReader?
        var audioOut: AVAssetReaderAudioMixOutput?
        if let audioTrack = try? await asset.loadTracks(withMediaType: .audio).first,
           let assetDuration = try? await asset.load(.duration) {
            let composition = AVMutableComposition()
            if let track = composition.addMutableTrack(withMediaType: .audio,
                                                       preferredTrackID: kCMPersistentTrackID_Invalid),
               (try? track.insertTimeRange(CMTimeRange(start: .zero, duration: assetDuration),
                                           of: audioTrack, at: .zero)) != nil {
                // Later slices first: scaling a range shifts everything after
                // it, so going backwards keeps every slice not yet scaled at
                // its original (recording-time) position in the composition.
                for slice in plan.audio.reversed() {
                    let length = slice.srcEnd - slice.srcStart
                    track.scaleTimeRange(CMTimeRange(start: cmTime(slice.srcStart), duration: cmTime(length)),
                                         toDuration: cmTime(length / slice.rate))
                }
                let out = AVAssetReaderAudioMixOutput(audioTracks: [track], audioSettings: [
                    AVFormatIDKey: kAudioFormatLinearPCM,
                    AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2,
                    AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
                    AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false
                ])
                out.audioTimePitchAlgorithm = plan.preservePitch ? .spectral : .varispeed
                if let r = try? AVAssetReader(asset: composition), r.canAdd(out) {
                    r.add(out)
                    r.timeRange = CMTimeRange(start: .zero, duration: cmTime(plan.outputDuration))
                    audioReader = r
                    audioOut = out
                }
            }
        }

        let outURL = URL(fileURLWithPath: outPath)
        try? FileManager.default.removeItem(at: outURL)
        guard let writer = try? AVAssetWriter(outputURL: outURL, fileType: .mp4)
        else { fail("cannot create output file") }

        let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: codec,
            AVVideoWidthKey: outW,
            AVVideoHeightKey: outH
        ])
        videoIn.expectsMediaDataInRealTime = false
        writer.add(videoIn)

        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: videoIn,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: outW,
                kCVPixelBufferHeightKey as String: outH
            ])

        var audioIn: AVAssetWriterInput?
        if audioOut != nil {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 256_000
            ])
            input.expectsMediaDataInRealTime = false
            if writer.canAdd(input) { writer.add(input); audioIn = input }
        }

        guard reader.startReading() else {
            fail("reader failed to start: \(reader.error?.localizedDescription ?? "unknown")")
        }
        if let audioReader, audioIn != nil, !audioReader.startReading() {
            fail("audio reader failed to start: \(audioReader.error?.localizedDescription ?? "unknown")")
        }
        guard writer.startWriting() else {
            fail("writer failed to start: \(writer.error?.localizedDescription ?? "unknown")")
        }
        writer.startSession(atSourceTime: .zero)

        let ciContext = CIContext(options: [.useSoftwareRenderer: false])
        var frame = 0
        var skippedFrames = 0
        var audioFrames = 0
        var audioDone = audioIn == nil
        var pendingAudio: CMSampleBuffer?

        // Audio is written interleaved with the video -- up to a second
        // ahead of the latest video frame -- rather than all at the end:
        // AVAssetWriter can hold one input back while the other lags.
        func pumpAudio(upTo limit: Double) {
            guard !audioDone, let audioIn, let audioOut else { return }
            while audioIn.isReadyForMoreMediaData {
                guard let buffer = pendingAudio ?? audioOut.copyNextSampleBuffer() else {
                    audioIn.markAsFinished()
                    audioDone = true
                    return
                }
                if CMSampleBufferGetPresentationTimeStamp(buffer).seconds > limit {
                    pendingAudio = buffer
                    return
                }
                pendingAudio = nil
                guard audioIn.append(buffer) else {
                    fail("audio frame \(audioFrames): append failed: \(writer.error?.localizedDescription ?? "unknown")")
                }
                audioFrames += 1
            }
        }

        func nextSourceFrame() -> CMSampleBuffer? {
            while let buffer = videoOut.copyNextSampleBuffer() {
                if CMSampleBufferGetImageBuffer(buffer) != nil { return buffer }
                skippedFrames += 1
            }
            return nil
        }

        // Output-driven: one frame per plan entry, at a steady fps. Each shows
        // the newest recorded frame at or before its recording time -- a fast
        // stretch skips frames, a slow one holds them -- with the zoom, cursor
        // and click ripples drawn for that exact recording time, so they stay
        // smooth even where the screen itself (and so the recording) is still.
        var current: CMSampleBuffer?
        var next = nextSourceFrame()
        for (k, t) in plan.frames.enumerated() {
            while let n = next, CMSampleBufferGetPresentationTimeStamp(n).seconds <= t + 1e-4 {
                current = n
                next = nextSourceFrame()
            }
            // Before the first recorded frame arrives, show that first frame.
            guard let buffer = current ?? next, let pixels = CMSampleBufferGetImageBuffer(buffer) else {
                skippedFrames += 1
                continue
            }
            var cam = sample(camera, at: t, default: noZoomDefault)
            // Defensive only: the solver never emits zoom == 0, but a
            // malformed camera.bin could, and dividing by it would make
            // vw/vh infinite and produce a degenerate crop rect.
            if cam.zoom == 0 { cam.zoom = 1 }

            // Crop rect in top-left pixel space.
            let vw = project.source.width / cam.zoom * scale
            let vh = project.source.height / cam.zoom * scale
            let x0 = cam.cx * scale - vw / 2
            let y0Top = cam.cy * scale - vh / 2

            // Core Image is bottom-left origin, so flip once here.
            let ciRect = CGRect(x: x0, y: naturalSize.height - y0Top - vh, width: vw, height: vh)

            let source = CIImage(cvPixelBuffer: pixels)
                .cropped(to: ciRect)
                .transformed(by: CGAffineTransform(translationX: -ciRect.origin.x,
                                                   y: -ciRect.origin.y))
                .transformed(by: CGAffineTransform(scaleX: CGFloat(outW) / vw,
                                                   y: CGFloat(outH) / vh))

            guard let pool = adaptor.pixelBufferPool else { fail("no pixel buffer pool") }
            var dest: CVPixelBuffer?
            let poolStatus = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &dest)
            guard let dest, poolStatus == kCVReturnSuccess else {
                fail("frame \(frame): could not allocate output frame (CVReturn \(poolStatus))")
            }

            ciContext.render(source, to: dest)

            CVPixelBufferLockBaseAddress(dest, [])
            if let base = CVPixelBufferGetBaseAddress(dest),
               let ctx = CGContext(data: base, width: outW, height: outH,
                                   bitsPerComponent: 8,
                                   bytesPerRow: CVPixelBufferGetBytesPerRow(dest),
                                   space: CGColorSpaceCreateDeviceRGB(),
                                   bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                                       | CGBitmapInfo.byteOrder32Little.rawValue) {
                // Flip so overlays can be drawn in top-left coordinates.
                ctx.translateBy(x: 0, y: CGFloat(outH))
                ctx.scaleBy(x: 1, y: -1)

                let toOutX = { (px: Double) -> CGFloat in
                    CGFloat((px * scale - x0) * (Double(outW) / vw)) }
                let toOutY = { (py: Double) -> CGFloat in
                    CGFloat((py * scale - y0Top) * (Double(outH) / vh)) }
                let cursorScale = CGFloat(Double(outW) / vw) * scale

                if project.settings.clickHighlights {
                    for click in project.clicks where t >= click.t && t - click.t <= 0.5 {
                        drawRipple(ctx, at: CGPoint(x: toOutX(click.x), y: toOutY(click.y)),
                                   age: t - click.t, scale: cursorScale)
                    }
                }
                if project.settings.showCursor ?? true, let c = sampleCursor(cursor, at: t) {
                    drawCursor(ctx, at: CGPoint(x: toOutX(c.x), y: toOutY(c.y)),
                               scale: cursorScale)
                }
            }
            CVPixelBufferUnlockBaseAddress(dest, [])

            let pts = CMTime(value: CMTimeValue(k), timescale: CMTimeScale(plan.fps))
            while !videoIn.isReadyForMoreMediaData {
                if writer.status == .failed {
                    fail("video frame \(frame): writer failed: \(writer.error?.localizedDescription ?? "unknown")")
                }
                pumpAudio(upTo: pts.seconds + 1.0)
                usleep(2000)
            }
            guard adaptor.append(dest, withPresentationTime: pts) else {
                fail("video frame \(frame): append failed: \(writer.error?.localizedDescription ?? "unknown")")
            }

            frame += 1
            if frame % 30 == 0 { emit(["type": "progress", "frame": frame, "total": plan.frames.count]) }
            pumpAudio(upTo: pts.seconds + 1.0)
        }
        videoIn.markAsFinished()

        while !audioDone {
            waitForReady(writer, stage: "audio frame \(audioFrames)") { audioIn?.isReadyForMoreMediaData ?? true }
            pumpAudio(upTo: .infinity)
        }

        await writer.finishWriting()
        if writer.status == .failed {
            fail(writer.error?.localizedDescription ?? "write failed")
        }
        emit(["type": "done", "file": outPath, "frames": frame, "skippedFrames": skippedFrames])
        exit(0)
    }
}
