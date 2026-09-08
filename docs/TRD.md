# Loupe — Technical Requirements Document

| Field | Value |
|---|---|
| Product | Loupe |
| Version | 0.1 |
| Date | 2026-09-09 |
| Owner | Akshat Gupta |
| Target | macOS 13.0+ (Ventura), Apple Silicon + Intel |
| Companion doc | [PRD.md](./PRD.md) |

---

## 1. Stack

**Electron shell + Swift helper binaries**, mirroring the architecture already proven in `souffleur`: a JS/HTML front end with small `swiftc`-compiled binaries doing the native work.

**Why this and not the alternatives:**

- **vs. pure Swift/SwiftUI** — SwiftUI is technically the cleaner fit, since capture, the event tap, and the render pipeline are all Swift regardless; Electron only buys the UI layer. It loses on delivery: the timeline editor is a dense, iterative UI that is far faster to build in HTML/CSS, and the existing `electron-builder` signing, notarization, and Homebrew cask pipeline is reusable as-is. That pipeline is usually the part that eats weeks.
- **vs. Tauri** — smaller binary, but adds Rust as a third language in a stack that already needs JS and Swift, on a distribution setup with no prior art in this codebase.
- **vs. a web app** — ruled out outright. A web page cannot observe scroll events occurring in other applications, so the core zoom gesture would only function while recording a browser tab.

**Runtime:** Electron 44+, Node 22+, Swift 5.9+, no third-party Swift packages. Only `pdfjs`-free, minimal npm surface.

---

## 2. Process architecture

```
┌────────────────────────────────────────────────────────┐
│  Electron main  (Node)                                 │
│  · spawns + supervises helpers                         │
│  · owns the zoom state machine                         │
│  · owns project.json                                   │
└───┬────────────┬─────────────┬──────────────┬──────────┘
    │ spawn      │ spawn       │ spawn        │ IPC
    ▼            ▼             ▼              ▼
┌────────┐  ┌─────────┐  ┌──────────┐  ┌──────────────────┐
│sources │  │ capture │  │ inputtap │  │ Renderer windows │
│(Swift) │  │ (Swift) │  │ (Swift)  │  │ picker/HUD/editor│
└────────┘  └─────────┘  └──────────┘  └──────────────────┘
                              │
                         ┌─────────┐
                         │ render  │  (Swift, on export)
                         └─────────┘
```

Helpers communicate over **stdout with newline-delimited JSON**. No sockets, no shared memory. stderr is logged verbatim by main. Every helper exits non-zero with a JSON error object on stdout's last line.

---

## 3. Components

### 3.1 `bin/sources` (Swift)

Enumerates capture sources. Runs on demand, prints one JSON blob, exits.

- `SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)`
- Returns displays, windows (with `owningApplication`, `title`, `frame`, `windowID`), and applications.
- Thumbnails: one-shot `SCScreenshotManager.captureImage` per source, downscaled to 320px wide, emitted as base64 PNG.
- Excludes windows with zero area, no title, and Loupe's own windows.

### 3.2 `bin/capture` (Swift)

The recorder. Long-running; started when recording begins, terminated on stop.

- `SCStream` with an `SCContentFilter` built from the chosen display / window / application.
- **`filter.excludingWindows` must include the Loupe HUD window id** (PRD FR-5). This is the mechanism preventing the HUD leaking into the output.
- `SCStreamConfiguration`:
  - `width` / `height` = source native pixel size (Retina, unscaled)
  - `minimumFrameInterval` = 1/60s
  - `pixelFormat` = `kCVPixelFormatType_32BGRA`
  - **`showsCursor = false`** — the cursor is drawn at render time (PRD FR-15)
  - `capturesAudio = false` — mic is handled separately; system audio is a non-goal
- Writes via `AVAssetWriter` to `raw.mov`, HEVC, quality-priority.
- Mic (only when enabled): `AVCaptureDevice` default audio input → separate AAC track in the same file.
- **On first frame, prints `{"type":"started","clock":<CACurrentMediaTime>,"pts":0}`.** This single line is what makes everything else line up (see §5).
- Emits `{"type":"progress","frames":N,"bytes":M}` once per second for the HUD and for disk-space monitoring.
- On `SIGTERM`: finalizes the asset writer cleanly, prints `{"type":"stopped","duration":D}`, exits 0.

### 3.3 `bin/inputtap` (Swift)

The gesture hook. Long-running, lives for the duration of a recording.

- `CGEvent.tapCreate` at `.cgSessionEventTap`, placed `.headInsertEventTap`, `.defaultTap` (i.e. **able to modify and swallow events**).
- Events observed: `.scrollWheel`, `.leftMouseDown`, `.rightMouseDown`, `.mouseMoved`, `.leftMouseDragged`.
- **Swallow rule — the crux of PRD FR-9:**
  ```
  if event is scrollWheel and event.flags contains .maskAlternate:
      emit zoom event
      return nil                 // consumed; the app underneath never sees it
  else:
      return Unmanaged.passUnretained(event)   // untouched, zero added latency
  ```
- Cursor position sampled on every mouse-move event, throttled to 120Hz.
- Every emitted line carries `"clock": CACurrentMediaTime()` — the same clock `capture` reports.
- **Tap-disable recovery (§7.3)** is implemented here.

Output lines:
```json
{"type":"zoom",  "clock":1234.567, "dy":-3.0, "x":1420, "y":880}
{"type":"click", "clock":1234.901, "button":"left", "x":1420, "y":880}
{"type":"cursor","clock":1234.910, "x":1421, "y":881, "shape":"arrow"}
```

### 3.4 `bin/render` (Swift)

Offline compositor. Invoked on export with a project directory; prints progress; exits.

Detailed in §6.

### 3.5 Electron main (Node)

- Spawns and supervises the four helpers; restarts nothing automatically (a crash mid-record ends the recording cleanly — see §7.4).
- Consumes the `inputtap` stream and runs the **zoom state machine** (§4.1).
- Owns `project.json` (§8) — the only writer.
- Deep-links to System Settings panes for permissions (§7.1).

### 3.6 Electron renderer

Three windows:

| Window | Notes |
|---|---|
| **Picker** | Source grid with live thumbnails, mic toggle, Record button |
| **HUD** | Transparent, always-on-top, click-through except on controls, `setContentProtection` irrelevant — exclusion is done via `SCContentFilter` (§3.2) |
| **Editor** | Timeline with four tracks (zoom, speed, original audio, voiceover), preview canvas, export controls |

---

## 4. Zoom and camera

All of this is **pure computation over the event stream** — no I/O, no framework calls — so it is directly unit-testable. This is where the logic that can actually be wrong lives.

### 4.1 Zoom state machine (live, in Electron main)

```
SENS      = 0.0025      // per scroll unit
ZOOM_MIN  = 1.0
ZOOM_MAX  = 4.0

on zoom event {dy, x, y, clock}:
    target = clamp(target * exp(-dy * SENS), ZOOM_MIN, ZOOM_MAX)
    keyframes.push({ t: clock - captureStartClock, zoom: target, cx: x, cy: y })
```

Exponential rather than linear, so one notch of the wheel feels like the same amount of zoom at 1.2× as it does at 3.5×.

The HUD renders `target` immediately (PRD success criterion: under 50ms). The *actual* animated zoom is solved offline.

### 4.2 Eased zoom curve (offline)

Keyframes are step changes. Before rendering, the zoom track is resampled at 120Hz and eased toward each target with a **critically damped spring**, τ ≈ 400ms — no overshoot, no oscillation, reaches ~95% in 400ms.

### 4.3 Dead-zone camera solver (offline)

Per sample `i` at time `t`, given screen `W×H`, zoom `z`, and cursor `(mx,my)`:

```
vw, vh   = W/z, H/z                    // visible rect size
dw, dh   = vw*0.5, vh*0.5              // dead zone: inner 50%

// camera center carries over from the previous sample
if mx < cx - dw/2:  cx = mx + dw/2
if mx > cx + dw/2:  cx = mx - dw/2
if my < cy - dh/2:  cy = my + dh/2
if my > cy + dh/2:  cy = my - dh/2

// never let the frame run off the screen
cx = clamp(cx, vw/2, W - vw/2)
cy = clamp(cy, vh/2, H - vh/2)
```

The camera moves the **minimum** distance that brings the cursor back to the dead-zone boundary — never more. This is what makes typing produce exactly zero movement (PRD FR-11 acceptance).

### 4.4 Zero-lag smoothing (offline, and the reason post-rendering wins)

The camera path from §4.3 is then filtered with a **zero-phase second-order low-pass, applied forward then backward** (`filtfilt`), cutoff ≈ 1.2Hz.

Because the entire path is known before rendering, this filter has **no phase lag** — the camera can begin easing *before* the cursor moves. A live implementation cannot do this at any price; it can only ever react. This is the concrete technical payoff of the record-clean-render-later decision, and the difference between a camera that "follows you" and one that "was already there."

---

## 5. The clock, and the two time domains

> Get this section wrong and every feature is subtly broken. Get it right and the rest is arithmetic.

### 5.1 One clock

`capture` and `inputtap` are separate processes. They both timestamp with **`CACurrentMediaTime()`** — a monotonic, system-wide, suspend-aware clock, identical across processes. `capture` prints its first-frame value once (§3.2); every gesture keyframe is then simply:

```
t_source = event.clock - capture.started.clock
```

No drift, no NTP, no cross-process handshake. `Date.now()` and `process.hrtime()` are **not** valid substitutes and must not be used for anything on the media path.

### 5.2 Source time vs. output time

Speed segments (PRD FR-18) mean a frame's position in the raw recording is **not** its position in the exported video. Two domains exist:

- **`t_src`** — position in `raw.mov`. Zoom keyframes, cursor samples, and clicks live here.
- **`t_out`** — position in the exported file. Voiceover clips live here, and so does the playhead the user sees.

Speed segments define the map between them:

```
rate(t_src) = 1.0 outside every segment
            = segment.rate inside, with a smoothstep ramp of RAMP_MS at each edge

t_out(T) = ∫₀ᵀ  dτ / rate(τ)
```

### 5.3 `TimeMap` module

Implemented once, in JS, with a Swift mirror in `render`. **Every feature added from here on goes through it**, so it gets its own module and its own test suite.

```
buildMap(segments, duration) → monotonic table sampled at 1ms
  toOutput(t_src) → t_out     // linear interpolation
  toSource(t_out) → t_src     // binary search; safe because the map is strictly increasing
```

**Consequences that fall straight out of this:**

- **PRD FR-24** — zoom keyframes are stored in `t_src` and never rewritten. Speed edits change only the map, so zooms stay glued to their frames automatically.
- **PRD FR-30** — voiceover clips are stored in `t_out`. When a speed segment *earlier* than a clip changes, total duration before that clip shifts by `Δ`; every affected clip's `t_out` is shifted by the same `Δ`, keeping narration on the moment it describes.

---

## 6. Render pipeline

### 6.1 Video

`AVMutableComposition` + a custom `AVVideoCompositing` implementation. Per **output** frame:

```
t_out = frameTime
t_src = timeMap.toSource(t_out)
z, cx, cy = sample(cameraTrack, t_src)          // §4.3–4.4, precomputed
srcRect   = (cx - W/2z, cy - H/2z, W/z, H/z)
```

1. Crop `srcRect` from the source pixel buffer and scale to the output size — Metal, Lanczos resampling.
2. Draw the cursor at `transform(cursorPos(t_src))`, using the tracked shape, scaled by `sqrt(z)` so it stays visible without ballooning.
3. Draw any click ripple whose age at `t_src` is under 500ms — expanding radius, fading alpha.

Written with `AVAssetWriter`: HEVC or H.264, per the export preset.

**Speed via `scaleTimeRange`:** `AVMutableCompositionTrack.scaleTimeRange` takes a *constant* rate per range, but §5.2 ramps are continuous. Each ramp is subdivided into **10 constant-rate slices**, which approximates the smoothstep closely enough to be invisible at 60fps while staying inside the AVFoundation model.

### 6.2 Audio

Rendered offline through `AVAudioEngine` in manual-rendering mode, segment by segment, into one PCM buffer:

| Case | Node |
|---|---|
| Keep pitch natural (default, PRD FR-23) | `AVAudioUnitTimePitch`, `rate` = segment rate, `pitch` = 0 |
| Natural pitch off | `AVAudioUnitVarispeed`, `rate` = segment rate |
| Rate == 1.0 | passthrough, no node |

Then:

1. Original mic track, time-scaled as above, laid at its mapped offsets.
2. Voiceover clips mixed in at their `t_out` positions, unscaled (they were recorded against output time).
3. Sum, soft-limit at −1dBFS, encode AAC 256kbps, mux.

If the recording was silent (PRD FR-4 off), step 1 is skipped and voiceover is the only source — no empty track is written.

### 6.3 Budget

Target **≥ 2× realtime** for 1080p60 on Apple Silicon (PRD: 2-minute export under 60s). Progress is reported per 30 frames; `SIGTERM` cancels and deletes the partial file.

---

## 7. Permissions and failure handling

### 7.1 Permissions

| Permission | Needed for | Check | If missing |
|---|---|---|---|
| Screen Recording | All capture | `CGPreflightScreenCaptureAccess()` | Explain, deep-link `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`, re-check on app focus |
| Accessibility | Zoom gesture only | `AXIsProcessTrusted()` | **Record anyway**, zoom disabled, HUD banner explains why (PRD FR-14) |
| Microphone | Mic toggle on, or voiceover | `AVCaptureDevice.authorizationStatus` | Requested only at the moment it is needed, never upfront (PRD FR-36) |

### 7.2 Recording is never blocked by zoom

Restating because it is easy to regress: a missing Accessibility grant degrades the product, it does not disable it. Capture proceeds; only the gesture is off.

### 7.3 Event tap disabled by the system

macOS disables an event tap whose callback runs slow, delivering `kCGEventTapDisabledByTimeout`. **Not handling this is the classic bug where zoom silently stops working ten minutes into a session.**

```
case .tapDisabledByTimeout, .tapDisabledByUserInput:
    CGEvent.tapEnable(tap: tap, enable: true)
    emit {"type":"tap_reenabled","clock":...}
```

Main logs it and flashes the HUD indicator. The callback itself must stay **under 0.5ms** — it does arithmetic and a buffered write, nothing else. No allocation, no JSON encoding on the hot path for pass-through events.

### 7.4 Helper crash mid-recording

Main detects the non-zero exit, sends `SIGTERM` to the remaining helpers, and finalizes whatever `raw.mov` exists. The user is told the recording ended early **and that the footage is intact**. Partial footage is never discarded (PRD FR-33).

### 7.5 Disk

Free space is checked before arming; recording refuses to start below 2GB. During recording, `capture`'s per-second byte count is monitored and the recording auto-stops cleanly at 500MB remaining.

---

## 8. `project.json`

One directory per project under `~/Movies/Loupe/<timestamp>/`, containing `raw.mov`, `voiceover/*.m4a`, and:

```json
{
  "version": 1,
  "source": { "kind": "window", "title": "GitHub — Chrome", "width": 3024, "height": 1890 },
  "capture": { "file": "raw.mov", "fps": 60, "duration": 184.2, "hasMicTrack": true },
  "zoomKeyframes": [
    { "t": 12.40, "zoom": 2.2, "cx": 1420, "cy": 880 },
    { "t": 19.85, "zoom": 1.0, "cx": 1420, "cy": 880 }
  ],
  "cursorTrack": "cursor.bin",
  "clicks": [ { "t": 13.10, "x": 1420, "y": 880, "button": "left" } ],
  "speedSegments": [
    { "srcStart": 40.0, "srcEnd": 95.0, "rate": 4.0 },
    { "srcStart": 120.0, "srcEnd": 124.0, "rate": 0.5 }
  ],
  "voiceover": [
    { "id": "vo1", "outStart": 8.2, "duration": 14.6, "file": "voiceover/vo1.m4a" }
  ],
  "settings": {
    "preserveVoicePitch": true,
    "clickHighlights": true,
    "cursorSmoothing": true,
    "rampMs": 200
  },
  "export": { "resolution": "1080p", "fps": 60, "codec": "h264" }
}
```

`cursorTrack` is a flat binary of `(float32 t, float32 x, float32 y, uint8 shape)` at 120Hz — a two-minute recording is ~14400 samples, far too many for readable JSON.

`version` is present from day one so Phase 2 and 3 can migrate old projects rather than reject them.

---

## 9. Testing

### 9.1 Unit — `node --test`, matching the existing `souffleur` setup

The valuable tests, because this is where the real logic sits:

- **`TimeMap`** — identity map with no segments; monotonicity; `toSource(toOutput(t)) ≈ t` across randomized segment sets; ramp continuity; boundary conditions at t=0 and t=duration.
- **Zoom state machine** — clamping at both ends; exponential symmetry (n notches in then n notches out returns to 1.0×).
- **Dead-zone solver** — cursor inside the dead zone produces **exactly zero** camera movement; cursor at a frame edge produces the minimum correcting move; camera never exits screen bounds at any zoom level.
- **Smoothing** — zero-phase property: a symmetric input produces a symmetric output.
- **Voiceover shift (FR-30)** — editing a speed segment shifts only clips positioned after it, by exactly Δ.

### 9.2 Integration

- `render` against a fixture `raw.mov` + fixture `project.json`: assert output duration, dimensions, and frame checksums at known timestamps.
- Audio: assert exported duration matches `timeMap.toOutput(captureDuration)` within one frame.

### 9.3 Manual

Permission flows, HUD exclusion from capture (§3.2), tap-disable recovery, and the plain-scroll passthrough check (PRD FR-9) — none of which can be meaningfully automated.

---

## 10. Repository layout

```
loupe/
├── docs/               PRD.md, TRD.md
├── src/
│   ├── main/           Electron main, helper supervision
│   │   ├── zoom.js         state machine  (§4.1)
│   │   ├── camera.js       solver + smoothing (§4.3–4.4)
│   │   ├── timemap.js      source ↔ output (§5.3)
│   │   └── project.js      project.json I/O
│   ├── renderer/       picker / hud / editor
│   └── native/         Sources.swift, Capture.swift, InputTap.swift, Render.swift
├── bin/                compiled helpers (gitignored)
├── test/               node --test suites
└── packaging/          electron-builder, notarization, cask
```

Build: `npm run build:native` compiles all four helpers with `swiftc -O`, matching the existing `build:audio` pattern.

---

## 11. Distribution

`electron-builder`, hardened runtime, notarized, Homebrew cask — reusing the `souffleur` packaging scripts.

**Entitlements required:** `com.apple.security.device.audio-input` for the mic. Screen Recording and Accessibility are TCC grants, not entitlements, and cannot be pre-authorized.

**Signing note:** the Swift helpers in `bin/` must be signed and included in the hardened runtime, or the event tap is refused at runtime on a notarized build — a failure that does not reproduce in development.

---

## 12. Performance budgets

| Path | Budget |
|---|---|
| `inputtap` callback, pass-through event | < 0.5ms — anything slower gets the tap disabled by macOS (§7.3) |
| Scroll → HUD zoom indicator | < 50ms |
| `capture` CPU, 1080p60 | < 15% of one core |
| `capture` CPU, 4K60 | < 40% of one core |
| Dropped frames in the recorded app | zero visible |
| Export, 1080p60 | ≥ 2× realtime on Apple Silicon |
| Idle memory | < 200MB |

---

## 13. Share links (Phase 4)

Implements PRD §6.9. Design constraint: temporary sharing, no accounts, no database.

### 13.1 Why there is no database

Expiry is derived from the asset's own `created_at` and a TTL tag written at upload. A scheduled job deletes by age. Nothing else needs persisting, so nothing else is persisted.

A DB only becomes necessary for view counts, a cross-device list of active links, or team ownership. All three are out of scope. **Firebase is not used in this design** — it would be a dependency carrying no data.

Local state (`public_id`, expiry, revoke token) lives in `project.json`, which already exists.

### 13.2 The credential problem

> **Security requirement, stated without compression because getting it wrong is expensive.**
>
> The Cloudinary API secret must never be shipped inside the Electron application. An `.asar` archive is not encrypted and unpacks with a single command, so any secret inside it should be treated as public the moment the app is distributed. A leaked secret allows arbitrary uploads and deletions on the operator's account, billed to the operator, with the operator legally responsible for whatever gets stored there.
>
> All uploads are therefore signed by a server the operator controls. The application never holds a long-lived credential.

### 13.3 Architecture

```
Electron app                Cloudflare Worker              Cloudinary
     │                      (holds API secret)
     │  POST /sign  {bytes, ttl, deviceId}
     ├────────────────────────────►│
     │                             │ rate-limit check (KV)
     │  {signature, timestamp,     │
     │   public_id, apiKey}        │
     │◄────────────────────────────┤
     │
     │  POST upload (signed, direct, multipart)
     ├──────────────────────────────────────────────►│
     │                                               │
     │  {secure_url, public_id}                      │
     │◄──────────────────────────────────────────────┤
     │
     │  stored in project.json ── share URL to user
                                   │
                                   │ Cron Trigger, hourly
                                   ├──────────────────────►│
                                     Admin API: delete assets
                                     tagged loupe-share
                                     older than their TTL
```

**Why a Cloudflare Worker:** the signing endpoint and the cron job are the same tiny service, both free at this volume, and Cron Triggers are built in. It is the smallest thing that solves both halves.

### 13.4 Upload constraints

| Constraint | Value | Consequence |
|---|---|---|
| Cloudinary free-tier video file cap | ~100MB (**verify against current plan before building**) | 1080p60 H.264, 2 min ≈ 30–60MB fits; 4K does not |
| Share resolution ceiling | 1080p | PRD FR-38; 4K exports remain local-only |
| Free-tier credits | ~25/month, 1 credit ≈ 1GB storage or bandwidth | Per-device monthly cap enforced in Worker (FR-46) |
| Video transformations | Billed separately | **Not used.** The app already exports a finished MP4; Cloudinary is dumb storage here |

Every number in this table is a vendor figure that moves. Re-check at implementation time rather than trusting this document.

### 13.5 Worker endpoints

| Route | Behaviour |
|---|---|
| `POST /sign` | Validates `bytes` against the size cap, checks the device's rate limit and monthly quota in KV, returns Cloudinary signed upload params with `public_id = loupe/<nanoid>` and tags `loupe-share`, `ttl-<hours>` |
| `POST /revoke` | Verifies the device token, calls Admin API destroy (PRD FR-44) |
| `scheduled()` | Hourly. Lists by tag, deletes assets whose age exceeds their `ttl-*` tag (PRD FR-41) |

Rate limiting uses Workers KV keyed by an app-generated device id. The device id is an opaque random value stored locally — not a user identifier, not the machine serial, and not tied to any personal data.

### 13.6 Failure handling

- **Upload fails or is cancelled** — local export untouched (PRD FR-45). Retry offered. No partial asset is left behind; unfinished uploads are cleaned by the same cron sweep.
- **Cron misses a run** — assets simply live slightly longer. The next run catches them. Deletion is idempotent and driven by age, not by a queue, so a missed run can never orphan an asset permanently.
- **Worker unreachable** — Share is disabled with an explanatory message. Recording, editing, and export are entirely unaffected; the share path is never on the critical path of the product.

### 13.7 Testing

- `TimeMap`-style unit tests do not apply here; the logic worth testing is the Worker's.
- **Worker unit tests:** size cap rejection, rate-limit exhaustion, quota exhaustion, signature correctness against a known fixture.
- **Cron test:** given fixture assets with mixed ages and TTL tags, assert exactly the expired set is selected for deletion — and, critically, that a fresh asset is never selected.
- **Integration:** upload a small fixture, assert the asset exists, force the scheduled handler, assert it is gone from the Admin API.
