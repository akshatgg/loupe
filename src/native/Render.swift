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

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

struct CameraSample { var t: Double; var zoom: Double; var cx: Double; var cy: Double }
struct CursorSample { var t: Double; var x: Double; var y: Double }

struct Click: Decodable { let t: Double; let x: Double; let y: Double }
struct Settings: Decodable { let clickHighlights: Bool }
struct SourceInfo: Decodable { let width: Double; let height: Double }
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

        guard let reader = try? AVAssetReader(asset: asset) else { fail("cannot read raw.mov") }
        let videoOut = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ])
        reader.add(videoOut)

        var audioOut: AVAssetReaderTrackOutput?
        if let audioTrack = try? await asset.loadTracks(withMediaType: .audio).first {
            let out = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: nil)
            if reader.canAdd(out) { reader.add(out); audioOut = out }
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
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: nil)
            if writer.canAdd(input) { writer.add(input); audioIn = input }
        }

        guard reader.startReading() else {
            fail("reader failed to start: \(reader.error?.localizedDescription ?? "unknown")")
        }
        guard writer.startWriting() else {
            fail("writer failed to start: \(writer.error?.localizedDescription ?? "unknown")")
        }
        writer.startSession(atSourceTime: .zero)

        let ciContext = CIContext(options: [.useSoftwareRenderer: false])
        var frame = 0

        while let buffer = videoOut.copyNextSampleBuffer() {
            guard let pixels = CMSampleBufferGetImageBuffer(buffer) else { continue }
            let pts = CMSampleBufferGetPresentationTimeStamp(buffer)
            let t = pts.seconds
            let cam = sample(camera, at: t, default: noZoomDefault)

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
            CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &dest)
            guard let dest else { fail("could not allocate output frame") }

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
                if let c = sampleCursor(cursor, at: t) {
                    drawCursor(ctx, at: CGPoint(x: toOutX(c.x), y: toOutY(c.y)),
                               scale: cursorScale)
                }
            }
            CVPixelBufferUnlockBaseAddress(dest, [])

            while !videoIn.isReadyForMoreMediaData { usleep(2000) }
            adaptor.append(dest, withPresentationTime: pts)

            frame += 1
            if frame % 30 == 0 { emit(["type": "progress", "frame": frame]) }
        }
        videoIn.markAsFinished()

        if let audioIn, let audioOut {
            while let buffer = audioOut.copyNextSampleBuffer() {
                while !audioIn.isReadyForMoreMediaData { usleep(2000) }
                audioIn.append(buffer)
            }
            audioIn.markAsFinished()
        }

        await writer.finishWriting()
        if writer.status == .failed {
            fail(writer.error?.localizedDescription ?? "write failed")
        }
        emit(["type": "done", "file": outPath, "frames": frame])
        exit(0)
    }
}
