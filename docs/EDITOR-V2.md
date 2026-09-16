# Loupe editor v2 — architecture and build plan

This is the shared contract for the "professional editor" work: trim/cut/split,
editable zooms, backgrounds and aspect ratios, cursor and keystroke effects,
annotations and transitions, webcam, system audio, audio clean-up, music,
voiceover, captions, GIF/WebM export, sharing, library, presets, undo/redo,
shortcuts, updates, settings and crash reporting.

Everyone working on it follows this document. If something here turns out to
be wrong, fix the document in the same commit as the code.

## 0. Principles

- **Anyone can use it.** Plain words, sensible defaults, nothing required
  before the first export. Every feature works with zero configuration and is
  discoverable from the editor's sidebar or a right-click. No jargon ("LUFS",
  "RNNoise", "keyframe") in the UI.
- **One picture, everywhere.** The editor preview and every export are drawn
  by the same compositor (`src/core/compose.js`). What you see is what you get.
- **One export engine for both platforms.** Export runs in Chromium (WebCodecs
  + canvas) inside Electron, not in the Swift/C# `render` helpers. Native
  helpers only capture (screen, system audio, input).
- **Nothing leaves the computer** unless the user presses Share.
- **Non-destructive.** The recording files are never modified. All edits live
  in `project.json` and can be undone.
- **Match the code around you**: comment density, naming, the "why, not what"
  comments. No mention of any AI assistant anywhere (code, comments, commits,
  UI, site).
- **Verify, don't assume.** Every feature ships with automated tests (unit for
  pure logic; Electron-driven for UI and export) and was actually exercised.

## 1. Verified platform facts (Electron 44 on macOS, 2026-09-16)

- WebCodecs is available on `file://` pages (secure context). Supported:
  decode HEVC and H.264; encode H.264 (hardware), HEVC, VP9, AV1; AudioEncoder
  AAC (`mp4a.40.2`) and Opus. OffscreenCanvas + WebGL2 available.
- `<script type="module">` and module Workers load over `file://`.
- Node is 26 locally: `require()` of an ES module works, so CommonJS main code
  and `node --test` can load the ESM core.
- `bin/capture` records from this shell (Screen Recording is granted), so
  real captures can be used in tests on this Mac.
- Windows is verified in CI (`.github/workflows/release.yml`, build-only run
  via `gh workflow run release.yml --ref <branch>`).

## 2. Layout

```
src/core/              ES modules (package.json "type":"module"), pure, no DOM
                       or Node APIs unless noted; used by main, editor, exporter, tests
  project.js           schema v2 defaults, migrate(v1 -> v2), edit operations
  timeline.js          clips + speed -> output time <-> source time, frame plan
  camera.js            zoom segments + cursor -> camera track (port of src/main/camera.js)
  history.js           undo/redo stack of project snapshots
  compose.js           draw one output frame onto a 2D canvas context
  layers/              one file per visual layer used by compose.js
  audio/               wsola.js, mix.js, denoise.js, level.js, duck.js
  captions/            transcript model, SRT/VTT, line breaking
src/renderer/editor/   the editor window (ESM): player, timeline, sidebar panels
  panels/              one file per sidebar panel
src/renderer/exporter/ hidden window: demux, decode, compose, encode, mux
src/renderer/library/  recordings library window
src/renderer/settings/ settings window
src/renderer/camera/   webcam bubble window (records webcam.webm)
src/main/ipc/          one module per IPC area, registered from main.js
src/vendor/            vendored third-party browser builds + their LICENSE files
                       (the app keeps zero runtime npm dependencies)
test/                  node --test unit tests (*.test.js); ESM tests may be *.test.mjs
test/e2e/              Electron-driven tests: npm run test:e2e
```

Renderer pages are ESM and sandboxed; they reach the main process only through
`window.loupe` (preload). Add preload methods per feature; keep them narrow and
validate every payload in main (the renderer is not a trust boundary).

## 3. Project format v2 (`project.json`)

`version: 2`. `loadProject` migrates v1 in memory (and saves v2 on the next
write). Times are seconds. Unless stated otherwise a time is **source time**
(seconds into that source's recording), so edits elsewhere never shift what an
item is attached to.

```js
{
  version: 2,
  title: "Recording 16 Sep 2026, 19:24",   // editable in the library/editor
  createdAt: 1789...,                       // ms
  sources: {
    main: {
      dir: ".",                  // relative to this project's folder, or absolute
      kind, id, title, width, height, originX, originY,  // as v1 `source` (points/DIPs)
      video: "raw.mov",          // raw.mp4 on Windows
      duration, fps: 60,
      mic: true,                 // mic track inside the video file
      systemAudio: "system.m4a", // "system.wav" on Windows (16-bit PCM), or null
      webcam: { file: "webcam.webm", offset: 0.12, width, height } | null,
                                 // offset = source time at which webcam.webm starts
                                 // (negative when the camera started before the capture)
      cursor: "cursor.bin",
      keys: "keys.json" | null,  // [{t, label: "⌘K"}] shortcut presses
      clicks: [{t,x,y,button}],
      pauses: [{start, end}]     // paused while recording (also removed from clips)
    },
    // appended recordings: "src2": { dir: "/abs/path/other", ... }
  },
  clips: [{ id, source: "main", start, end }],   // play in this order; trims/cuts/splits edit these
  speed: [{ source, start, end, rate }],          // 0.25..8, source time
  zooms: [{ id, source, start, end, level, follow: true, x, y, recorded: bool }],
                                 // follow=false pins the view at x,y (source points)
                                 // a migrated zoom also keeps `keyframes: [{t, zoom}]`, the
                                 // v1 in/out it replays; editing its time or level drops them
  style: {
    background: { type: "none"|"color"|"gradient"|"image", value },
    padding: 0.06,               // fraction of the output's short side
    radius: 12, shadow: 0.5,     // px at 1080p, 0..1
    aspect: "source"|"16:9"|"9:16"|"1:1"|"4:5",
    cursor: { show: true, size: 1, hideWhenIdle: false, smooth: true,
              highlight: "none"|"spotlight"|"ring", clicks: true },
    keystrokes: { show: false, position: "bottom" },
    webcam: { show: true, shape: "circle"|"rounded", size: 0.22, corner: "bottom-right" }
  },
  annotations: [{ id, type: "text"|"title"|"arrow"|"box"|"blur", source, start, end,
                  x, y, w, h, x2, y2, text, color, size }],   // x..h are 0..1 of the content area
  transitions: [{ after: clipId, type: "fade"|"crossfade"|"dip", duration: 0.5 }],
  audio: {
    mic:    { volume: 1, muted: false, cleanUp: true, level: true },
    system: { volume: 0.8, muted: false },
    music:  { file, volume: 0.3, duck: true } | null,     // file copied into the project folder
    voiceover: [{ id, file, source, t, volume: 1 }]       // anchored to a source moment
  },
  captions: { show: false, language: "auto", segments: [{ id, source, start, end, text }],
              style: { size: 1, position: "bottom" } },
  export: { format: "mp4"|"webm"|"gif", resolution: "1080p", quality: "balanced", fps: 60,
            codec: "h264"|"hevc" }
}
```

Migration from v1: `source`+`capture` become `sources.main`; one clip covering
the whole recording; `speedSegments` -> `speed`; recorded `zoomKeyframes` ->
`zooms` (a zoom starts where level rises above ~1.05 and ends where it returns;
`recorded: true`, `follow: true`, level = the max in that stretch);
`settings.showCursor/clickHighlights` -> `style.cursor`; defaults elsewhere
(`style.background.type = "none"`, `padding = 0`, `aspect = "source"`, so a
migrated project exports exactly as before).

## 4. Time model (`core/timeline.js`)

Output timeline = the clips in order, each clip's source range played at the
speed of the `speed` segments inside it (ramps as `src/main/speed.js` does
today), minus nothing else. Required API (pure, fully unit-tested):

- `buildTimeline(project) -> tl`
- `tl.duration`
- `tl.toSource(outT) -> { clipIndex, source, t }`
- `tl.toOutput(source, t) -> outT | null` (null when cut out)
- `tl.framePlan(fps) -> [{ source, t, clipIndex }]`
- `tl.audioPlan() -> [{ source, srcStart, srcEnd, outStart, rate }]`
- `tl.clipBounds() -> [{ clipIndex, outStart, outEnd }]`

Edit operations in `core/project.js` (pure, return a new project): `trimStart`,
`trimEnd`, `cutRange(outStart, outEnd)`, `splitAt(outT)`, `moveClip(from, to)`,
`deleteClip`, `appendRecording(sourceKey, sourceMeta)`, `addZoom`, `updateZoom`,
`removeZoom`, `paintSpeed`, `add/update/removeAnnotation`, `setStyle(patch)`, …
Each is one undo step.

## 5. Picture (`core/compose.js`)

`drawFrame(ctx, { project, tl, outT, frames, size, assets })` where `frames`
holds decoded images for the sources needed at `outT` (VideoFrame,
ImageBitmap or HTMLVideoElement — anything `drawImage` accepts) and `assets`
holds loaded images (background image, etc). Draw order:

1. background (none = black; color; gradient; image cover-fit)
2. shadow + rounded-rect clip of the content area (aspect + padding)
3. the source frame cropped by the camera (zoom/follow) into the content area;
   for an aspect narrower/wider than the source, the camera also pans to keep
   the action (cursor) in view
4. click effects, cursor (size, idle hide, smoothing, highlight/spotlight)
5. annotations (text, title card, arrow, box, blur region)
6. keystroke badges
7. webcam bubble
8. captions
9. transition blend at clip boundaries

With `aspect: "source"` the recording is fitted, centred, inside the padded
area (never cropped); with a chosen aspect it fills the padded area and the
camera pans. Sizes scale with the output's short side (reference 1080p) so 1080p/4K/9:16 look
alike. Layers live in `core/layers/*.js` and are registered in order in
`compose.js`.

### The editor window (wave 2)

`src/renderer/editor/` (ES modules, sandboxed page). `editor.js` holds the
project in `store.js` (core `history.js` undo; a drag passes a `gesture` key
so it is one undo step) and sends every change to main with
`window.loupe.saveProject(project)`. `src/main/ipc/project.js` replaces v1's
per-action handlers with two calls: `project:load` (v1 migrated in memory;
returns `{ project, sources: { [key]: { video, cursor, systemAudio, missing } }
as file:// URLs, migrated }`) and `project:save` (validated, `sources` always
kept as loaded so the page can't point the exporter at other files, written
~400 ms later to a temporary file renamed over project.json). `export:start`
flushes a pending save first; closing the editor and quitting flush too.
`export:reveal` shows the last exported file only.

- `player.js`: the output time is the clock; one muted `<video>` per source
  kept at the right moment and `playbackRate` (nudged when it drifts, seeked
  on a jump or when far off), each frame drawn with `drawFrame` on a HiDPI
  canvas. `audio-preview.js` plays mic and system audio on the same clock
  (`createAudioPreview({ sources }) -> { sync, stop }`; the audio work
  replaces it behind that interface).
- `timeline-view.js` + `timeline-math.js` (pure, unit-tested): clips, zoom
  and speed tracks in output time; zooms and speed are drawn once per clip
  they overlap. Drags edit from the project as it was when they began.
- `panels/index.js`: the sidebar, one module per panel exporting
  `{ id, title, icon, mount(container, editor) -> { update(what) } }`.
  Style and Zoom are real; `audio.js`, `captions.js`, `annotations.js` are
  placeholders their features replace.
- `shortcuts.js` (pure): Space, ←/→ (⇧ 1 s), Home/End, S, Z, Delete, ⌘/Ctrl+Z,
  ⇧⌘Z / Ctrl+Y, ⌘/Ctrl+E, ⌘/Ctrl+= / − / 0, ?; `export-dialog.js`.
- `window.__editor` exposes the store, player and timeline for
  `test/e2e/editor.js` (`npm run test:e2e:editor`), which drives the real
  page with real mouse and key events.

## 6. Export (`src/renderer/exporter/`)

A hidden BrowserWindow, opened per export, reports progress through main to the
editor. Pipeline: read source files (`fetch(file://)`), demux (vendored
mp4box.js for .mov/.mp4; the webcam .webm is decoded through a `<video>`
element or a WebM demuxer), `VideoDecoder`, `drawFrame` on an OffscreenCanvas,
`VideoEncoder`, mux (vendored mp4-muxer / webm-muxer), stream chunks to main,
which writes the file. Audio: decode each track (`AudioContext.decodeAudioData`
or `AudioDecoder`), apply clean-up/levelling, follow `tl.audioPlan()` with WSOLA
(pitch kept), mix mic + system + voiceover + music (with ducking), encode AAC
(MP4) or Opus (WebM). GIF: vendored gifenc, at most 15 fps and 960px wide by
default.

How it is wired (wave 1): `src/main/ipc/export.js` builds the job (project
loaded and migrated, every file as a `file://` URL), opens
`src/renderer/exporter/index.html` in a hidden sandboxed window with
`src/preload/exporter.js`, and writes the positioned byte ranges the page
sends to `<out>.part`, renamed when done; failure, cancel, closing the editor
and quitting remove it. The editor calls `window.loupe.exportVideo(opts)`
(`export:start`, resolves `{ file, frames, seconds, ... }`),
`cancelExport()` and `onExportProgress` (`{ phase: 'reading'|'sound'|'video',
frame, total }`). The page: `demux.js` (mp4box), `video-source.js` (newest
frame at or before t, VFR-safe, resets the decoder on jumps), `audio.js`,
`encode.js` (H.264 High/Main/Baseline, hardware then software; HEVC Main),
`pipeline.js`. The sound of each recording is placed by `core/audio/tracks.js`
(mic + system audio through `follow.js`/`wsola.js`, then `mix.js`, the one
mixer the audio features also use: `mixTracks(tracks, { duration, sampleRate })`
with per-track gain curves). Windows' `system.wav` is read by
`core/audio/wav.js` (WebCodecs has no WAV decoder); everything else goes
through mp4box + `AudioDecoder`. Clean-up, levelling, music and voiceover
exist as core modules (`denoise.js`, `level.js`, `music.js`, `voiceover.js`,
`duck.js`) and IPC, but the exporter does not apply them yet
(`exportMix(..., { extraTracks })` is where they plug in).

Two things WebCodecs does that the pipeline corrects (both covered by e2e):
Chromium's `AudioDecoder` starts its output timestamps at 0 whatever the first
packet's time, so decoded sound is placed from the first packet's
(edit-list-adjusted) time; and AAC encoders prepend priming samples while
mp4-muxer writes no edit list, so the encoder's delay is measured once per
export (a noise burst round trip) and that many samples are skipped.

Formats and quality: MP4 (H.264; HEVC optional), WebM (VP9 + Opus), GIF.
Quality `high | balanced | small`, plus "Fit a size limit" (for Slack/email:
25 MB, 10 MB, or custom) which picks the bitrate from the duration.

After export: Show in Finder/Explorer, Copy (file to clipboard), drag the file
out of the editor (`webContents.startDrag`), Share link.

## 7. Recording additions (native helpers + recorder)

- **System audio**: macOS `SCStreamConfiguration.capturesAudio` into
  `system.m4a`; Windows WASAPI loopback into `system.wav` (16-bit PCM,
  `native-win/SystemAudio.cs` + `WavFile.cs`). `capture --system-audio 1`.
  Same clock alignment as the video.
- **Keystrokes**: `inputtap --keys 1` emits `{"type":"key","clock","label"}`
  only for shortcuts (a key pressed with ⌘/⌃/⌥/Win/Ctrl, or Esc/Tab/Return/
  arrows/function keys) — never plain typing, so passwords are not recorded.
- **Pause/resume** on the bar, or the shortcut ⌃⌥P (Ctrl+Alt+P on Windows),
  held only while recording: capture keeps running; paused ranges
  (`src/main/pauses.js`) are saved in `sources.main.pauses` and removed from
  the clips at stop; the bar timer leaves paused time out.
- **Countdown** 3-2-1 on the bar before capture starts (setting, default on).
- **Webcam**: a small always-on-top bubble window (the user sees themselves; it
  is excluded from the screen capture) records `webcam.webm` with
  MediaRecorder; its start is aligned to the capture clock via the main
  process's high-resolution clock (same base as the helpers' clocks).

How it is wired: `src/main/ipc/recording.js` (`registerRecordingExtras`,
called from main.js) owns the countdown (`countdown.js`), the pause shortcut,
the camera bubble (`ipc/camera.js`, page `src/renderer/camera/`) and the
picker's `recordingSettings:get/set`; `recording-v2.js` writes the v2
`project.json` at stop (`clock-sync.js` aligns the webcam, `webm.js` reads
its length). The bar's phases are in `bar-state.js`
(armed → counting → recording ⇄ paused). The choices live in `settings.json`
(below); `recording-settings.js` translates them to the picker's flat shape
(`countdown, systemAudio, recordKeys ← showKeystrokes, camera ← recordCamera,
cameraDeviceId ← camera.id`), so the picker and the Settings window always
agree. A settings problem never stops a recording: the defaults apply.
Checks: `npm run test:e2e:recording` (bar UI, camera bubble, the real helpers,
and the whole app recording with every addition on).

## 8. App shell

- **Library** window: recent recordings (thumbnail, title, date, length),
  open, rename, duplicate, reveal, move to Trash/Recycle Bin, "New recording".
- **Settings** (`src/main/settings.js`, one `settings.json` in userData via
  `settings-store.js`; forgiving to read, strict to write; `settings:changed`
  goes to every window). Keys: `zoomTriggers, recordingsFolder, countdown,
  openAtLogin, microphone, camera ({id,label}|null), recordCamera,
  systemAudio, showKeystrokes, exportDefaults {format,resolution,quality},
  checkForUpdates, saveCrashReports, presets [{id,name,style}],
  defaultPresetId` (+ `lastUpdateCheck`, `lastNotifiedVersion`, main-only).
  `recordingsFolder` and presets are not writable through `settings:set`.
- **Settings** window: General (recordings folder, countdown, open at login
  off by default), Recording (zoom shortcuts, microphone, system audio, webcam
  device, show keystrokes), Export defaults, Updates, Privacy (crash reports),
  About.
- **Presets**: save the current style as a named preset; choose a default
  preset for new recordings.
- **Undo/redo** for every editor action (⌘Z/⇧⌘Z, Ctrl+Z/Ctrl+Y).
- **Keyboard shortcuts** throughout the editor with a "?" cheat sheet.
- **App menus** (macOS menu bar / Windows window menus) with the usual items.
- **Updates**: check GitHub Releases on launch (daily at most). Windows: download
  the new installer, verify its sha512 from `latest.yml`, install on quit.
  macOS: the app is not signed, so self-update is not possible; show the new
  version with "brew upgrade --cask loupe" (Homebrew installs) or a Download
  button. The release workflow publishes `latest.yml`.
- Wiring: `src/main/app-shell.js` (`createAppShell`) builds the Library
  (`ipc/library.js`), Settings (`ipc/settings.js`), presets (`ipc/presets.js`),
  updates (`ipc/updates.js`), About/help (`ipc/about.js`) and menus; those
  windows use `src/preload/shell.js`. Checks: `electron test/e2e/shell.e2e.js`.
- **Crash reporting**: Electron crashReporter and error logs stored locally in
  userData/logs; Help > Report a problem opens a pre-filled GitHub issue with
  version, OS and recent log lines the user can review first. Nothing is
  uploaded automatically.
- **Signing**: needs the owner's Apple Developer ID and a Windows code-signing
  certificate; the build already signs when those secrets exist (documented in
  README). Not something code can supply.

### Captions (wired so far)

- `src/core/captions/` (index.js re-exports): model (`defaultCaptions`,
  `normalizeCaptions`, `segmentsAt`; segments may carry `words`), lines,
  edit operations, `captionsToOutput(segments, tl)` (source → output cues,
  split by cuts), SRT/VTT `format.js`, `chunks.js`, `languages.js`,
  `mp4-audio.js` (reads the mic track for transcription).
- `src/core/layers/captions.js`: layer 8; `draw(ctx, state)` shows
  `project.captions` at `outT` over the whole frame when `show` is on
  (cues cached per segments array + timeline); `drawCaptions`/`layoutCaptions`
  for the editor's hit-testing.
- `src/renderer/captions/` (client.js → module worker.js, vendored
  `src/vendor/transformers/`): on-device speech to text, WebGPU or wasm.
- `src/main/ipc/captions.js` + `speech-models.js`: model download to
  userData/speech-models and saving .srt/.vtt; preload `window.loupe.captions.
  { models, ensureModel, cancelModel, removeModel, onModelProgress,
  saveSubtitles }`. Check: `npm run test:e2e:captions`.
- Not yet: the editor's Captions panel is still the placeholder
  (`panels/captions.js`).

## 9. Share links

Wired: `src/main/ipc/share.js` (`share:status|upload|cancel`, progress on
`share:progress`) and `ipc/fileActions.js` (copy, reveal, drag-out, copy
text); checks in `test/e2e/share.e2e.js` and `file-actions.e2e.js`.

A Vercel Function in `web/api/` issues a one-time upload token for Vercel Blob;
the app uploads the exported MP4 and gets `https://loupeapp.vercel.app/v/<id>`
(a small player page). Links expire after 7 days; a daily cron deletes expired
blobs. The Share button is hidden unless the backend reports it is configured
(`GET /api/share/status`). Provisioning the Blob store is an account action the
owner confirms.

## 10. Testing

- `npm test`: lint + unit tests (all pure core modules, IPC validators).
- `npm run test:e2e`: launches Electron with `test/e2e/run.js`, which drives
  real windows with `webContents.executeJavaScript`, generates its own fixture
  recordings (an H.264/HEVC file encoded with WebCodecs plus a synthetic
  cursor track and tone audio), exports, and checks the output by decoding it
  (duration, frame count, dimensions, sampled pixel colours, audio RMS).
  Screenshots of key states go to `test/e2e/out/` for visual review.
  `electron test/e2e/run.js --real <recording folder>` exports a copy of a
  real recording and saves snapshots (at each zoom, or `--at 3,7.5`).
- Windows: CI build-only run.

## 11. Work plan

Waves; later waves build on committed earlier waves.

1. **Core** — `src/core` (project v2 + migration, timeline, camera, history,
   compose with background/aspect/cursor layers), exporter (MP4 with audio,
   WSOLA), e2e harness. The old native `render` path stays until the new
   export passes its e2e tests, then the app switches over.
2. **Editor** — new editor UI on the core: player, timeline with clips
   (trim/cut/split/move), zoom track (add/drag/resize/level/follow), speed
   track, sidebar shell with panels, undo/redo, shortcuts, export dialog.
3. **Features in parallel** (each owns its files; shared-file edits are
   small, additive, and at marked extension points):
   A recording (system audio, keystrokes, pause, countdown, webcam capture);
   B audio (clean-up, levelling, music + ducking, voiceover);
   C captions (on-device transcription, transcript editor, burn-in, SRT/VTT);
   D visuals (backgrounds, padding/corners/shadow, aspect, cursor effects,
   keystroke badges, webcam bubble, annotations, transitions, presets);
   E export & share (GIF, WebM, quality/size, copy, drag-out, share links);
   F app shell (library, settings, menus, updates, crash reports).
4. **Verify** — adversarial end-to-end review of every feature; fix.
5. **Landing page** — show the new features.
