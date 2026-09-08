# Loupe — Product Requirements Document

| Field | Value |
|---|---|
| Product | Loupe — a screen recorder for demo videos |
| Version | 0.1 |
| Date | 2026-09-09 |
| Owner | Akshat Gupta |
| Platform | macOS 13+ (Apple Silicon and Intel) |
| Status | Approved for planning |
| Companion doc | [TRD.md](./TRD.md) |

---

## 1. Summary

Loupe records your screen for demo videos and lets you direct the viewer's attention while you record.

Hold **⌥ and roll the mouse wheel** and the video zooms into whatever is under the cursor. Roll the other way and it zooms back out. You record a whole display, or just one window, and the zoom follows your cursor smoothly while you work.

The zoom is never burned into the footage. The screen is captured clean at full resolution, your scroll gestures are stored as keyframes, and the zoom is rendered afterwards from the original pixels — so a 3× close-up is genuinely sharp instead of an upscaled blur, and any zoom you got wrong can be fixed without re-recording.

After recording, a timeline editor lets you speed up or slow down any stretch of the video, and record voiceover onto any point of it. Export is MP4.

---

## 2. Problem

A screencast made with QuickTime is hard to watch. The UI is too small to read on a phone, nothing tells the viewer where to look, dead time is left in, and the narration has to be delivered live and correct on the first take — so a two-minute demo costs an hour of retakes.

The tools that fix this (Screen Studio, Focusee) are paid, macOS-only, and none of them offer a direct "roll the wheel to zoom right now" gesture at the moment of recording. They infer zooms from clicks, or make you place every zoom by hand afterwards.

**The gap Loupe fills:** you decide what deserves a close-up *while you are demoing it*, with a gesture as immediate as zooming a map — and you still get post-production quality and post-production editability.

---

## 3. Goals

| # | Goal | Why it matters |
|---|---|---|
| G1 | Zoom into any screen region during recording with one gesture, no mode switching | The whole premise. If the gesture has friction, people stop using it mid-demo. |
| G2 | Zoomed footage stays visually sharp | An upscaled blur defeats the purpose of zooming in to show detail. |
| G3 | Camera motion looks deliberate, not handheld | Jittery auto-zoom is worse than no zoom; it makes viewers queasy and looks amateur. |
| G4 | Record a single window as easily as a whole display | Most demos are one app. Full-screen capture leaks notifications, other windows, and a messy desktop. |
| G5 | Nothing is destructive until export | Every zoom, speed change, and voice clip must be adjustable or removable after the fact. |
| G6 | Narration is decoupled from recording | Talking and demoing simultaneously, perfectly, on take one is the single biggest cause of retakes. |
| G7 | Skip or dwell on any stretch of time | Builds, installs, and form-filling are dead air; a subtle interaction deserves slow motion. |

---

## 4. Non-goals for v1

Deliberately out of scope, so the first version ships:

- **System / application audio capture** — mic only in v1.
- **Webcam overlay** — no face bubble.
- **Recording multiple displays at once.**
- **GIF, WebM, or ProRes export** — MP4/H.264 and HEVC only.
- **Accounts, teams, or a persistent cloud video library.** Ephemeral share links are Phase 4 (§6.9). Permanent hosting is not planned — Loupe is a local tool that can throw a temporary link, not a video host.
- **Windows or Linux.**
- **Native per-tab capture of a browser** — see §6.2 for how this is handled instead.
- **Transitions, titles, text overlays, background wallpapers, or rounded-corner framing.**
- **Multi-clip editing** — one recording produces one project.

---

## 5. Users and use cases

**Primary user:** a founder, developer, or product person recording a product demo, a bug report, a feature walkthrough, or a tutorial — someone who publishes to a landing page, a changelog, a Loom-style share, or social.

**Three flows Loupe is built around:**

1. **Narrate live.** Mic on, record the screen, zoom in with ⌥+scroll as you talk through the product. Stop, glance over the zooms, export. Fastest path.
2. **Record silent, narrate after.** Mic off, capture a clean silent walkthrough with no pressure to speak. Then in the editor, speed up the boring parts, park the playhead, and record voiceover in pieces until it sounds right. Highest quality result, and the one that eliminates retakes.
3. **Bug report.** Record one window, zoom into the broken control, stop, export. Under thirty seconds end to end.

---

## 6. Functional requirements

### 6.1 Recording

**FR-1 — Source picker.** Before recording, show a picker with live thumbnails listing every connected **display**, every open **window**, and every running **application**. The user selects exactly one.

*Acceptance:* thumbnails refresh while the picker is open; windows are grouped under their app with the window title shown; minimized windows are excluded.

**FR-2 — Recording a single window.** When a window is selected, only that window's pixels are recorded. Anything overlapping it — notifications, other windows, the Dock — must not appear in the output.

*Acceptance:* deliberately drag another window over the target during a test recording; the output shows no trace of it.

**FR-3 — Full-resolution capture.** Capture at the source's native resolution, including Retina scaling, at 60fps. No downscaling at capture time under any circumstance.

**FR-4 — Microphone toggle.** A clearly visible on/off control in the picker decides whether the mic is recorded.

- **On** — mic is captured and muxed into the recording.
- **Off** — no audio is captured at all. The recording is silent video only. No microphone permission is requested, and no mic indicator appears in the macOS menu bar.

*Acceptance:* with the mic off, the exported file contains no audio track, and macOS shows no recording-indicator for the microphone.

**FR-5 — Recording HUD.** A small floating overlay during recording shows elapsed time, current zoom level, mic state, and a Stop control.

*Acceptance:* **the HUD must never appear in the recorded output**, including when recording the display it sits on.

**FR-6 — Global hotkey to stop.** Stop recording from anywhere without hunting for the HUD.

### 6.2 Recording one browser tab

**FR-7 — Single-tab recording.** The user must be able to record just one Chrome tab rather than the whole screen.

**The constraint, stated plainly:** macOS exposes displays, windows, and applications to screen capture. It does not expose browser tabs — every tab of a Chrome window shares one window, and the operating system has no separate handle on them. No native macOS app can select a tab directly.

**How Loupe resolves it:** the tab is dragged out into its own window (a one-second drag on the tab), at which point it *is* a window and appears in the picker by its page title. The resulting recording is pixel-identical to a native tab capture.

*Acceptance:* the picker shows a short inline hint next to Chrome windows — "recording one tab? drag it out into its own window first" — so the user is never left guessing why they can't find their tab.

*Future:* a companion Chrome extension using `chrome.tabCapture` could list tabs by name without the drag. Explicitly deferred; it is a second codebase to sign and maintain, and only ever helps one browser.

### 6.3 Zoom

**FR-8 — Zoom gesture.** Holding **⌥ (Option)** and scrolling zooms the recording. Scroll one way zooms in on the point under the cursor; scroll the reverse direction zooms back out.

**FR-9 — Plain scroll is never intercepted.** Scrolling *without* the modifier passes straight through to the application underneath and behaves completely normally. Only ⌥+scroll is consumed by Loupe.

*Rationale:* most demos involve scrolling a page, a document, or a code file. A recorder that swallows scroll makes those demos impossible. This requirement is non-negotiable.

*Acceptance:* during a recording, scrolling a webpage scrolls it at normal speed with no stutter or dropped events.

**FR-10 — Zoom range and feel.** Zoom is continuous from 1.0× to 4.0×, clamped at both ends. The zoom animates toward its target over roughly 400ms rather than snapping, so the footage reads as a camera move.

**FR-11 — Camera follows the cursor with a dead zone.** While zoomed in, the visible frame holds still as long as the cursor stays near the middle of it, and glides to follow only once the cursor pushes toward the edge.

*Rationale:* this is the single biggest factor in whether the result looks professional. Typing and small hand movements must not move the shot; crossing the screen must bring the camera along.

*Acceptance:* type a paragraph while zoomed to 2× — the frame does not move at all. Move the cursor from one side of the screen to the other — the camera follows smoothly and never overshoots past the screen edge.

**FR-12 — Zoom is not baked into the capture.** Gestures are recorded as keyframes against the clean full-resolution source and applied at render time.

*Acceptance:* a 3× zoom in the exported file is visibly sharper than the same region upscaled 3× from a 1× recording.

**FR-13 — Zooms are editable after recording.** Every zoom appears on the timeline as an adjustable segment that can be retimed, re-leveled, or deleted before export.

**FR-14 — Zoom degrades safely.** If Accessibility permission has not been granted, recording still works normally, with zoom disabled and an on-screen explanation of why. Recording must never be blocked by the zoom feature being unavailable.

### 6.4 Cursor and clicks

**FR-15 — Rendered cursor.** The cursor is excluded from the raw capture, its position tracked at high frequency, and drawn during render.

*Rationale:* a captured cursor viewed at 3× zoom is a 3×-upscaled blurry arrow, which undoes the point of capturing clean. Drawing it in post keeps it crisp at every zoom level and lets it scale sensibly as the camera moves.

**FR-16 — Click highlights.** Each mouse click renders a soft expanding ring at the click point. Subtle by default, and toggleable off.

**FR-17 — Cursor smoothing.** Cursor motion is lightly smoothed in the render to remove hand jitter, without introducing visible lag.

### 6.5 Speed control

**FR-18 — Per-segment speed.** The user selects any time range on the timeline and assigns it a speed. The rest of the video is unaffected.

*Rationale, in the user's words:* fast-forward one particular part only — not the whole video.

**FR-19 — Both directions.** Speed ranges from **0.25× (slow motion)** to **8× (fast-forward)**. Slowing down is as important as speeding up: subtle interactions deserve dwell time.

**FR-20 — Multiple independent segments.** Any number of non-overlapping speed segments per video, each with its own rate.

**FR-21 — Speed ramps.** Speed eases in and out across a segment boundary over roughly 200ms rather than cutting abruptly.

**FR-22 — Audio follows the video speed.** When a segment is sped up, the audio inside it speeds up with it. When slowed, it slows. Audio is never silently dropped or muted.

**FR-23 — Natural pitch toggle.** A *keep voice natural* setting, **on by default**, preserves vocal pitch while time-scaling, so a 2× section sounds like someone talking quickly rather than a chipmunk. Turning it off gives the raw tape-speed effect.

**FR-24 — Zooms survive speed edits.** A zoom keyframe stays glued to the frame it was recorded against, regardless of any speed segment applied over or before it.

### 6.6 Voiceover

**FR-25 — Record voiceover after the fact.** Once the video is cut, the user places the playhead anywhere on the timeline, presses record, and speaks. The captured audio is placed as a clip starting at that position.

*Rationale, in the user's words:* add the voice later, once the whole video is made, at whatever particular time or slot they want.

**FR-26 — Multiple clips at arbitrary positions.** Any number of voiceover clips anywhere on the timeline. They may not overlap each other.

**FR-27 — Playback while recording.** The video plays from the playhead while voiceover is being recorded, so the user narrates against what they are watching.

**FR-28 — Clips are editable.** Each clip can be dragged to a new position, re-recorded in place, or deleted. Nothing is committed until export.

**FR-29 — Mixing.** If the original mic track exists, voiceover is mixed over it. If the recording was silent (FR-4 off), voiceover is the only audio in the export.

**FR-30 — Voiceover stays glued to its moment.** If a speed segment earlier in the timeline is changed after voiceover is recorded, later clips shift by the same amount so the narration stays aligned with the content it describes.

### 6.7 Review and export

**FR-31 — Timeline editor.** After recording, a timeline showing: a video track with zoom segments, a speed track, the original audio track, and the voiceover track. Scrubbing shows a live preview with zoom and speed applied.

**FR-32 — Export.** Export to MP4 with presets for 4K, 1440p, and 1080p, at 30 or 60fps, H.264 or HEVC. Progress is shown and cancellable.

**FR-33 — The raw recording is never destroyed.** The clean source file is retained until the user explicitly discards the project, so a bad export or a crash can never cost footage.

### 6.8 Permissions

**FR-34 — Screen Recording permission.** Required. If absent, explain what it is for and deep-link to the correct System Settings pane; re-check automatically when the app regains focus.

**FR-35 — Accessibility permission.** Required for the zoom gesture only. If absent, recording still works with zoom disabled (FR-14).

**FR-36 — Microphone permission.** Requested only when the mic toggle is on, or when voiceover recording begins. Never requested for a silent recording.

---

### 6.9 Share links (Phase 4)

A recording can be thrown to a temporary URL for review — a bug report to a colleague, a demo to a teammate — without accounts, and without Loupe becoming a video host. The link dies on a timer.

**FR-37 — Sharing is explicit, per video, every time.** No automatic upload, no default-on setting, no background sync.

*Rationale, and the reason this is a requirement rather than a preference:* screen recordings routinely contain API keys, customer records, private messages, and internal dashboards. A recorder that uploads by default is a data-leak generator. The user presses Share, or nothing leaves the machine.

**FR-38 — Upload happens after export, on the exported file.** Never the raw capture. Share uploads are capped at 1080p; 4K stays local-only (see TRD §13.4 for the size ceiling that drives this).

**FR-39 — The local file is never deleted, moved, or altered by sharing.** The cloud copy is a convenience, never the storage. Nothing the expiry timer does can cost the user footage.

**FR-40 — Expiry is chosen at share time:** 1 hour, 12 hours, or 24 hours. Default 24 hours.

**FR-41 — Expired assets are actually deleted**, by a scheduled job, not merely hidden behind a dead link.

*Acceptance:* after TTL elapses, the underlying asset is gone from storage — verified via the storage provider's API, not by the URL 404-ing.

**FR-42 — The recipient is told the link is temporary.** The share page shows the remaining time and offers a download button. Wording makes clear the copy is theirs to keep if they want it.

**FR-43 — The uploader sees the countdown too**, in a list of their active links, with the reassurance that their local copy is unaffected.

**FR-44 — Links can be revoked early.** A Delete now control removes the asset immediately, before its TTL.

**FR-45 — Upload is cancellable and failure is harmless.** Progress is shown, cancel is available, and a failed or cancelled upload leaves the local export untouched.

**FR-46 — Quota protection.** Per-device rate limits and monthly caps, enforced server-side.

*Rationale:* the signing endpoint is reachable by anyone who unpacks the app. Without server-side caps, one abuser exhausts the storage quota, and content uploaded to the operator's account is the operator's legal problem.

## 7. Delivery phases

Each phase is independently usable. Later phases add tracks to the same timeline rather than reworking earlier ones.

### Phase 1 — Record and zoom
FR-1 to FR-17, FR-31 (video + zoom tracks only), FR-32 to FR-36.

**Ships:** a recorder that captures a display or window at full resolution, zooms on ⌥+scroll with a smooth dead-zone camera, renders a crisp cursor with click highlights, and exports MP4. Genuinely useful on its own.

### Phase 2 — Speed control
FR-18 to FR-24, plus the speed track on the timeline.

**Ships:** select any stretch, speed it up or slow it down, with audio following and pitch preserved.

### Phase 3 — Voiceover
FR-25 to FR-30, plus the voiceover track and mixer.

**Ships:** the record-silent-narrate-later workflow end to end.

### Phase 4 — Share links
FR-37 to FR-46, plus the signing/cron backend (TRD §13).

**Ships:** press Share, get a URL that works for a day and then deletes itself. No accounts, no DB, no permanent hosting.

*Prerequisite:* Phase 1, since there is nothing to share until export exists.

---

## 8. Success criteria

| Criterion | Target |
|---|---|
| Zoom gesture feels immediate | Under 50ms from scroll to visible change in the HUD preview |
| Recording does not affect the machine | No visible frame drops in the recorded app at 60fps capture |
| Plain scroll is untouched | Scrolling a page while recording is indistinguishable from not recording |
| Camera looks intentional | Typing while zoomed to 2× produces zero frame movement |
| Zoom quality | 3× zoomed output is visibly sharper than a 3× upscale of a 1× recording |
| Export speed | A 2-minute 1080p60 export completes in under 60 seconds on Apple Silicon |
| Time to first video | A new user records and exports a usable demo within 3 minutes of launch |

---

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| macOS silently disables the event tap under load | Zoom stops working mid-recording with no error | Detect the disable event and re-enable immediately; surface it in the HUD (TRD §7.3) |
| Timing drift between the video and the gesture stream | Zooms land in the wrong place | Both capture and input use one shared monotonic clock (TRD §5) |
| Permission friction on first launch | User abandons before the first recording | Explain each permission in plain language at the moment it is needed, never as an upfront wall |
| Users expect to pick a Chrome tab directly | Confusion at the picker | Inline hint on Chrome windows (FR-7) |
| Scope creep from the editor | Phase 1 never ships | Phases are hard boundaries; non-goals in §4 are not revisited during Phase 1 |
| A user shares a recording containing secrets | Real-world data leak | Sharing is opt-in per video (FR-37); the share dialog states the video will be readable by anyone holding the link |
| Signing endpoint abused to host arbitrary content | Operator's quota drained, operator legally owns the content | Server-side size caps, per-device rate limits, short TTL (FR-46, TRD §13.5) |
| Storage free-tier exhausted by one popular link | Sharing breaks for everyone | Monthly per-device bandwidth cap; 1080p ceiling (FR-38) |

---

## 10. Open questions

None blocking. Deferred decisions, to be revisited after Phase 1 ships:

1. Should the zoom modifier be user-configurable (⌥ vs ⌃ vs Fn)? Assume ⌥, make it a setting later if it conflicts with anything common.
2. Should zoom auto-trigger on clicks, as Screen Studio does, in addition to the manual gesture? Deliberately not in v1 — manual control is the differentiator.
3. Chrome extension for native tab capture — only if the drag-out workaround proves annoying in practice.
