# Editor redesign, and the eleven features it makes room for

**Goal:** Loupe stays a screen-demo tool first — record, get a polished video
with little work — while gaining the editing depth people expect from an
editor. The redesign gives every new feature one obvious place, and keeps the
advanced ones out of a beginner's way.

**Source documents:** [`docs/PRD.md`](../../PRD.md),
[`docs/EDITOR-V2.md`](../../EDITOR-V2.md) §2 (layout), §3 (project shape),
[`2026-09-23-ai-voice-design.md`](2026-09-23-ai-voice-design.md).

## 1. What other apps do, and what Loupe takes from them

Fifteen apps were compared (Screen Studio, Cap, Tella, FocuSee, Camtasia,
Descript, ScreenFlow, Loom, CleanShot X, Clipchamp, CapCut, DaVinci Resolve,
Final Cut Pro, Premiere Pro, iMovie).

Every one puts the preview top-centre, the timeline full-width at the bottom,
properties on the right and Export top right. Loupe already does. The
recorder-plus-editor apps differ from general editors in the same four ways,
and Loupe follows them:

- **No media bin.** One recording is the project; stopping a recording opens
  the editor (Screen Studio, Cap, FocuSee, ScreenFlow).
- **The right panel follows the selection** (Premiere's Properties panel,
  CapCut's details panel, ScreenFlow's inspector).
- **Zooms are generated blocks you correct**, on their own row, with Disable
  kept apart from Remove (Screen Studio, Tella, FocuSee).
- **The transcript is a second place to edit** (Tella, Descript, Loom), and
  filler-word and silence removal are switches that can be turned back off
  (Loom).

Also taken: snapping and gap-closing as visible buttons on the timeline bar
(CapCut), auto-zoom strength presets with "remove all" (Tella), caption style
presets that style the spoken word apart from the rest (Descript), a Restart
button while recording (Cap, Loom).

Rejected: a CapCut-style three-pane layout with an asset bin (busier, and for
general editing), and a Descript-style transcript-first layout (weak for
silent demos and for timing zooms).

## 2. Sub-projects and order

Each gets its own implementation plan and is shippable on its own.

1. **Editor redesign** (§3–§6 below): selection list, inspector, toolbar,
   timeline rows, picker and recording bar. Everything later plugs into it.
2. **Editing basics** (§7): multi-select actions, copy / paste, keyframe
   easing, speed curves.
3. **Automatic features** (§8): auto-zoom on clicks, transcript editing with
   filler-word and silence removal, motion blur, AI voice, blur that follows.
4. **Styling and effects** (§9): word-by-word captions and caption styles,
   text fonts and animation, green screen, masks, blend modes, finer colour
   and audio tools.

## 3. Record-to-edit flow

The flow stays pick a source → record → the editor opens.

- **Picker** (`src/renderer/picker`): the option rows (microphone, computer
  sound, camera, keyboard shortcuts, countdown) become one strip of labelled
  toggle buttons under the source list, so the source and its preview fill
  the window. The zoom-shortcut choice moves to Settings → Recording, where
  the other recording choices already are; the picker's one-line hint about
  holding the key and scrolling stays.
- **New toggle, "Zoom in on my clicks"**, on by default, stored with the
  other recording settings (`src/main/recording-settings.js`). It decides
  only whether auto-zooms are made when the recording is first opened (§8.1);
  clicks are recorded either way, as now. It ships with auto-zoom
  (sub-project 3), not before, so it never sits there doing nothing.
- **Recording bar** (`src/renderer/bar`): a Restart button beside Pause and
  Stop. It asks once ("Start over? This recording is thrown away."), discards
  the recording in progress and starts a new one of the same source with the
  same options, countdown included when it is on.
- **After stop**, when auto-zooms were made, the editor shows a one-time card
  over the preview: "Loupe added 6 zooms where you clicked." with **Keep**,
  **Fewer** and **Remove all**. It reuses the first-run card
  (`first-run.js`) and goes away on any choice or edit.

## 4. Editor layout

```
+----------------------------------------------------------+
| < Recordings   Title      undo redo    Saved   [Export]  |
+-----------+--------------------------+-------------------+
| TRANSCRIPT|                          | INSPECTOR         |
| (can fold)|         PREVIEW          | video settings or |
|           |                          | the selected item |
+-----------+--------------------------+-------------------+
| > 0:04/0:30  Split Zoom Text Blur Voice Add  [snap][gaps]|
+----------------------------------------------------------+
| timeline rows                                            |
+----------------------------------------------------------+
```

### 4.1 Inspector (right)

One panel, two states.

- **Nothing selected — the video's settings.** Tabs along the top of the
  panel replace today's icon rail: **Look** (background, padding, corners,
  shadow, shape, motion blur), **Cursor** (cursor and click effects, keyboard
  badges), **Camera** (webcam bubble), **Captions**, **Audio** (microphone,
  computer sound, clean-up).
- **Something selected — that item's settings.** A header names it ("Zoom",
  "Clip 2", "Text", "Blur", "Song for the demo", "Overlay") with a back arrow
  that clears the selection. The body is the matching inspector: clip, zoom,
  text / arrow / box / blur, caption line, audio clip, overlay, marker.
- **Several selected:** the header says "3 items"; the body offers what
  applies to all of them (Delete, Duplicate, and shared fields when they are
  one kind, e.g. level for several zooms).
- **Advanced.** Each inspector may end with a folded "Advanced" section.
  Whether it is open is remembered per inspector in the app's settings, not
  in the project. Easing, speed curves, masks, blend modes, colour curves and
  the equalizer go there and nowhere else.

Structure: `panels/index.js` exports two lists instead of one — `VIDEO_TABS`
and `INSPECTORS` (by selection kind) — and a new `inspector.js` decides which
to mount from `store.selection`. The existing panel modules keep their
`{ id, title, icon, mount(container, editor) -> { update(what) } }` shape and
are regrouped: `style.js` + `style-extras.js` → Look and Cursor; `webcam.js`
→ Camera; `captions.js` → Captions; `audio.js` splits into the video's Audio
tab and the audio-clip inspector; `clip.js`, `zoom.js` and `annotations.js`
split into "add / list" parts (which move to the toolbar and timeline) and
the per-item inspector.

### 4.2 Transcript (left)

Folded by default; a button at the left edge of the toolbar opens it. Its
width is remembered. With no transcript yet it shows one button, "Write the
transcript", which runs the existing on-device transcription. Its editing
behaviour is §8.2; in sub-project 1 it shows the transcript read-only, and
clicking a word moves the playhead there.

### 4.3 Toolbar (between preview and timeline)

Left: play, time, sound meter (as now). Middle: **Split**, **Zoom**, **Text**
(menu: text, title card, arrow, box), **Blur**, **Voice** (menu: record a
voiceover; type a line to be spoken — §8.4), **Add** (menu: another
recording, a video file, audio, a picture or video overlay), **Delete**.
Right: **Snap** and **Close gaps** toggles, then the timeline zoom buttons.

- **Snap** (on by default): today's snapping, now switchable. Holding ⌘ /
  Ctrl while dragging turns it the other way for that drag.
- **Close gaps** (on by default): today's behaviour — deleting a clip pulls
  later clips left. Off: the deleted clip leaves a gap of black for its
  length: a freeze-frame clip marked `gap: true`, drawn black. Freeze
  frames are already silent and already handled by the timeline, the player
  and the exporter, so a gap needs nothing new from them.

### 4.4 Timeline rows

Top to bottom: **Overlays** (today's V2), **Clips**, **Zoom**, **Sound**
(the recording's own sound and voiceover), **Audio** rows A1–A6, **Text**
(today's "Notes"), **Captions**. Empty Overlays, Audio and Text rows are not
drawn until they hold something.

- The **Speed row goes away.** A clip stretch with a speed shows a badge
  ("2×") on the clip; dragging across a clip with ⌥ / Alt held, or the clip
  inspector's Speed section, sets it.
- **Zoom blocks** carry a small "Auto" mark when made from clicks.
  Right-click: Disable / Enable, Remove, Make manual. A disabled zoom is
  drawn hollow and has no effect on the picture.
- **Keyframes** of the selected item show as diamonds along it.

## 5. Selection

`store.selection` (one item or null) becomes `store.selected`, a list of
`{ kind, id }` (a speed stretch keeps `{ kind, source, start, end }`).
`store.selection` stays as a getter — the single item when exactly one is
selected, else null — so code that only handles one item keeps working
unchanged while it is moved over.

- Click selects one; ⇧-click and ⌘ / Ctrl-click add or remove; dragging on
  empty timeline draws a box that selects what it touches; ⌘A / Ctrl+A
  selects everything on the rows that hold the current selection (all rows
  when nothing is selected); Esc clears.
- Dragging one selected item moves all of them by the same amount; the move
  is refused as a whole when any one of them can't go there (sub-project 2,
  with the other multi-select actions).
- Delete removes all of them in one undo step.

## 6. Project format

Sub-project 1 adds only: `zooms[].disabled` (boolean, optional),
`zooms[].auto` (boolean, optional), and `clips[].gap` (boolean, optional, on
a freeze-frame clip). The version stays 2; older projects load
unchanged, and each later addition below is an optional field with a default
so no migration is needed.

## 7. Editing basics

- **Copy / cut / paste / duplicate** (⌘C ⌘X ⌘V ⌘D): for zooms, text and
  blur, overlays, audio clips, captions, markers and clips. The copy is held
  in the editor window (not the system clipboard). Paste puts the earliest
  copied item at the playhead and keeps the others' offsets from it; clips
  are inserted at the playhead, splitting the clip there. Pasting into
  another open recording is out of scope.
- **Keyframe easing:** `ease` grows from `linear` to `linear | smooth |
  ease-in | ease-out | hold` (`core/keyframes.js`); the diamond's right-click
  menu and the Advanced section set it. A zoom gets `easeIn` and `easeOut`
  seconds and a style (`smooth | snappy | gentle`) feeding
  `core/camera.js`.
- **Speed curves:** a speed stretch gets `ramp` seconds (0–2, default 0.2,
  today's fixed value) and presets in the clip inspector — Constant, Ease in,
  Ease out, Ease both — drawn as a small curve. `core/timeline.js` already
  integrates ramps numerically; the ramp length becomes per-stretch.

## 8. Automatic features

### 8.1 Auto-zoom on clicks

`core/auto-zoom.js`, pure: `autoZooms(source, { strength })` → zooms with
`auto: true, follow: true`. Clicks closer together than 2.5 s join one zoom;
a zoom starts 0.4 s before its first click and ends 1.2 s after its last;
zooms shorter than 1 s or overlapping a hand zoom are dropped. Strength sets
level and how many survive: **Subtle** 1.5× (clusters of 2+ clicks only),
**Moderate** 2× (default), **Intense** 2.5× (every click). Run once when a
new recording is first opened with the picker toggle on, and on demand from
the Zoom inspector ("Zoom on my clicks" with the three strengths, and "Remove
automatic zooms"), which replaces only `auto` zooms. Imported videos have no
clicks; the button is hidden for them.

### 8.2 Transcript editing

The Transcript panel shows words from `captions.segments[].words`. Selecting
words and pressing Delete calls the existing `cutRange` over their output
times (one undo step); cut words stay visible, struck through, and "Restore"
puts the range back by undo-independent means: the panel keeps
`project.transcript.cuts` — `[{ source, start, end }]` — and a cut is
restored by re-inserting that source range as a clip at its place.

- **Remove filler words:** a switch. On: every word matching the language's
  filler list (`core/captions/fillers.js`; English "um, uh, er, ah, hmm" and
  "you know / I mean / like" only when flanked by pauses) is cut, tagged
  `reason: 'filler'`. Off: those cuts are restored.
- **Shorten silences:** a switch with a length (default: gaps over 1.0 s
  shortened to 0.4 s), tagged `reason: 'silence'`, from word timings plus the
  sound level (`core/audio/level.js`) so a silent demo with no words is
  handled too.

### 8.3 Motion blur

One "Motion blur" slider in Look (0–1, default 0.3 for new recordings, 0 for
existing projects), with Advanced amounts for camera movement and cursor.
Drawn in `core/compose.js` by blending sub-frames of the camera position
between this frame and the previous one (4 samples; 8 when exporting), only
while the camera or cursor moves faster than a threshold, so still frames
cost nothing. Preview uses 2 samples to stay real-time.

### 8.4 AI voice

As designed in `2026-09-23-ai-voice-design.md`; its entry point becomes the
toolbar's Voice menu.

### 8.5 Blur that follows

A blur box gets "Follow what's under it". On: `core/track.js` matches the
picture under the box from frame to frame (block matching on a downscaled
luma patch, ±48 px search) and stores a path of keyframes on the annotation;
the box then moves along it. Tracking runs in the exporter's decoder in a
worker, with progress and Cancel; a lost match (score under a threshold)
stops the track there and tells the person where. The path is editable like
any keyframes.

## 9. Styling and effects

- **Captions:** style presets (Classic box, Outline, Karaoke, Pop, Typewriter)
  as a grid of live previews; `captions.style` gains `preset`, `font`,
  `color`, `activeColor`, `animation`. Word-by-word styles use the stored
  word timings; a line without them falls back to the whole line.
- **Text:** `font` (a short bundled list plus the system's fonts), `weight`,
  `align`, `outline`, `background`, `animateIn` / `animateOut`
  (`none | fade | slide | pop | typewriter`) with a duration, and lower-third
  templates that are saved text styles.
- **Overlays (Advanced):** `blend` (`normal | multiply | screen | overlay |
  soft-light | add`), `mask` (`none | rectangle | ellipse` with feather),
  `key` (green screen: colour, tolerance, softness; done in the WebGL path
  `layers/lut-gl.js` already uses).
- **Colour (Advanced, clip):** temperature, tint, highlights, shadows,
  vignette, sharpen, and an RGB curve; a histogram in the inspector.
- **Audio (Advanced, audio clip and the video's Audio tab):** pan, a 3-band
  equalizer, and a compressor, as nodes in `core/audio/mix.js`.

## 10. Errors

Every new edit is a pure function in `src/core/project.js` that throws a
plain-worded Error, shown as a toast, as existing edits do. Long work
(tracking, AI voice, transcription) shows progress with Cancel and leaves the
project untouched when cancelled or failed.

## 11. Tests

- Unit (`node --test`): selection list rules; gap clips in the timeline and
  export plan; zoom `disabled`; `autoZooms` on click fixtures; fillers and
  silence ranges; easing curves; ramp lengths; tracking on a synthetic moving
  patch; each new validator.
- e2e (`npm run test:e2e`): the inspector follows the selection; box-select
  and multi-delete; copy / paste; auto-zooms present after a recording
  fixture with clicks, and gone after "Remove all"; cutting words shortens
  the export; a disabled zoom leaves exported pixels unzoomed; motion blur
  changes pixels only while the camera moves.
