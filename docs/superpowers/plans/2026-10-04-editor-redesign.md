# Editor Redesign (sub-project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The editor's right panel follows the selection, several things can be selected and deleted at once, zooms can be disabled, deleting can leave a gap, speed lives on the clip, and the toolbar, transcript panel, picker and recording bar match the design in `docs/superpowers/specs/2026-10-04-editor-redesign-design.md` §3–§6.

**Architecture:** Rules live as pure functions in `src/core` (project edits) and small pure modules beside the editor (`selection.js`), each with `node --test` unit tests. The editor window wires them to the DOM; the existing panel modules keep their `{ id, title, icon, mount(container, editor) -> { update(what) } }` shape and are regrouped by a new `inspector.js`. The real editor is then driven end to end with the existing Electron harness (`test/e2e/editor-harness.js`).

**Tech Stack:** Electron 44, plain ES modules, no runtime npm dependencies, `node --test`, ESLint.

## Global Constraints

- Project format stays `version: 2`; every new field is optional with a default, so older projects load unchanged.
- No new runtime npm dependencies.
- Every edit is a pure `(project, ...args) -> project` function in `src/core/project.js` that throws a plain-worded `Error`.
- All text goes into the DOM as text nodes through `h()` (`src/renderer/editor/ui.js`), never markup.
- Wording is plain and addresses the person ("Zoom", "Close gaps"), matching existing strings.
- `editor.showPanel(id)` and `store.selection` keep working for existing callers and tests.
- Commit messages carry no attribution lines.
- `npm test` passes after every task; `npm run test:e2e:editor` passes after every editor-window task.

## File structure

| File | Responsibility |
|---|---|
| `src/renderer/editor/selection.js` (new) | Pure selection-list rules: same, has, toggle, alive, box hits |
| `src/renderer/editor/store.js` | Holds `selected` list; `selection` getter; `select(sel, { add, toggle })`, `selectMany(list)` |
| `src/core/project.js` | `removeItems`, zoom `disabled` / `auto`, `deleteClip(..., { leaveGap })`, gap clips |
| `src/core/camera.js` | Disabled zooms have no effect |
| `src/core/compose.js` | A gap clip draws black |
| `src/renderer/editor/inspector.js` (new) | Which panel the right side shows, its header, back arrow, video tabs |
| `src/renderer/editor/panels/index.js` | `VIDEO_TABS`, `INSPECTORS`, `PANELS`, `panelById` |
| `src/renderer/editor/panels/cursor.js` (new) | Cursor tab, split out of `style.js` |
| `src/renderer/editor/panels/multi.js` (new) | "3 items" inspector: Delete |
| `src/renderer/editor/toolbar.js` (new) | Text / Voice / Add menus, Snap and Close-gaps toggles |
| `src/renderer/editor/transcript-panel.js` (new) | Left panel: read-only transcript, click a word to go there |
| `src/renderer/editor/timeline-view.js` | Multi-select clicks, box select, zoom context menu, speed badge, row order, no Speed row |
| `src/renderer/picker/*` | Option rows become a toggle strip; zoom shortcuts move to Settings |
| `src/renderer/bar/*`, `src/main/main.js` | Restart button |

---

### Task 1: Selection list

**Files:** Create `src/renderer/editor/selection.js`, `test/editor-selection.test.mjs`. Modify `src/renderer/editor/store.js`.

**Interfaces — produces:**
- `sameItem(a, b) -> boolean` (speed stretches compare `source`, `start`, `end`; everything else `kind` + `id`)
- `hasItem(list, item) -> boolean`
- `toggleItem(list, item) -> list`
- `aliveItems(project, list) -> list` (drops items the project no longer has)
- `store.selected` (array, never null), `store.selection` (the item when exactly one, else null)
- `store.select(sel | null, { add = false, toggle = false } = {})`, `store.selectMany(list)`

- [ ] **Step 1: failing test** (`test/editor-selection.test.mjs`)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sameItem, hasItem, toggleItem, aliveItems } from '../src/renderer/editor/selection.js';
import { createStore } from '../src/renderer/editor/store.js';
import { createProject, addZoom } from '../src/core/project.js';

const project = () => {
  let p = createProject({ main: { width: 1920, height: 1080, duration: 20 }, createdAt: 0 });
  p = addZoom(p, { start: 1, end: 3 });
  return addZoom(p, { start: 5, end: 7 });
};

test('items are the same by kind and id; speed by its range', () => {
  assert.ok(sameItem({ kind: 'zoom', id: 'z1' }, { kind: 'zoom', id: 'z1' }));
  assert.ok(!sameItem({ kind: 'zoom', id: 'z1' }, { kind: 'clip', id: 'z1' }));
  assert.ok(sameItem({ kind: 'speed', source: 'main', start: 1, end: 2 }, { kind: 'speed', source: 'main', start: 1, end: 2 }));
  assert.ok(!sameItem({ kind: 'speed', source: 'main', start: 1, end: 2 }, { kind: 'speed', source: 'main', start: 1, end: 3 }));
});

test('toggle adds, then removes', () => {
  const a = { kind: 'zoom', id: 'z1' };
  const once = toggleItem([], a);
  assert.ok(hasItem(once, a));
  assert.deepEqual(toggleItem(once, a), []);
});

test('aliveItems drops what the project no longer has', () => {
  const p = project();
  assert.deepEqual(aliveItems(p, [{ kind: 'zoom', id: 'z1' }, { kind: 'zoom', id: 'gone' }]), [{ kind: 'zoom', id: 'z1' }]);
});

test('the store selects one, adds, toggles and reports one selection only when one', () => {
  const store = createStore(project());
  store.select({ kind: 'zoom', id: 'z1' });
  assert.deepEqual(store.selection, { kind: 'zoom', id: 'z1' });
  store.select({ kind: 'zoom', id: 'z2' }, { add: true });
  assert.equal(store.selected.length, 2);
  assert.equal(store.selection, null);
  store.select({ kind: 'zoom', id: 'z2' }, { toggle: true });
  assert.deepEqual(store.selected, [{ kind: 'zoom', id: 'z1' }]);
  store.select(null);
  assert.deepEqual(store.selected, []);
});
```

- [ ] **Step 2:** `node --test test/editor-selection.test.mjs` → fails (module not found).
- [ ] **Step 3: implement** `selection.js` (the `alive` table moves here out of `store.js`'s `checkSelection`), and in `store.js` replace `selection` with `let selected = []`; `checkSelection` becomes `selected = aliveItems(history.present, selected)`; `select(sel, { add, toggle })` — `null` clears, `toggle` uses `toggleItem`, `add` appends when absent, otherwise replaces with `[sel]`; `selectMany(list)` sets the list; both emit `'selection'`. `get selection() { return selected.length === 1 ? selected[0] : null; }`.
- [ ] **Step 4:** test passes; `npm test` passes.
- [ ] **Step 5:** commit `feat(editor): select several things at once`.

### Task 2: Delete several, disable a zoom, leave a gap (core)

**Files:** Modify `src/core/project.js`, `src/core/camera.js`, `src/core/compose.js`. Test `test/core-selection-edits.test.mjs`.

**Interfaces — produces:**
- `removeItems(project, items) -> project` — items as Task 1's; clips are removed with `deleteClip` (refusing to remove every clip: "A video needs at least one clip"); speed is painted back to 1×; unknown kinds throw.
- Zoom fields `disabled?: boolean`, `auto?: boolean`; both accepted by `updateZoom`'s patch.
- `deleteClip(project, clipId, { leaveGap = false } = {})` — with `leaveGap` the clip is replaced by `{ id, source, start, end: start, hold: <its output length>, gap: true }`.
- `isGap(clip) -> boolean`.

- [ ] **Step 1: failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import { cameraTrack } from '../src/core/camera.js';

const base = () => {
  let p = P.createProject({ main: { width: 1920, height: 1080, duration: 20 }, createdAt: 0 });
  p = P.splitAt(p, 5);
  p = P.splitAt(p, 10);
  p = P.addZoom(p, { start: 1, end: 3 });
  return P.addZoom(p, { start: 6, end: 8 });
};

test('removeItems removes a mix in one edit', () => {
  const p = base();
  const next = P.removeItems(p, [{ kind: 'zoom', id: 'z1' }, { kind: 'zoom', id: 'z2' }, { kind: 'clip', id: p.clips[1].id }]);
  assert.equal(next.zooms.length, 0);
  assert.equal(next.clips.length, 2);
});

test('removeItems refuses to remove every clip', () => {
  const p = base();
  assert.throws(() => P.removeItems(p, p.clips.map((c) => ({ kind: 'clip', id: c.id }))), /at least one clip/);
});

test('a disabled zoom validates and round-trips', () => {
  const p = P.updateZoom(base(), 'z1', { disabled: true });
  assert.equal(p.zooms[0].disabled, true);
  assert.equal(P.validateProject(p).zooms[0].disabled, true);
});

test('deleting with leaveGap keeps the video the same length', () => {
  const p = base();
  const before = buildTimeline(p).duration;
  const next = P.deleteClip(p, p.clips[1].id, { leaveGap: true });
  assert.equal(next.clips.length, 3);
  assert.ok(P.isGap(next.clips[1]));
  assert.ok(Math.abs(buildTimeline(next).duration - before) < 1e-9);
});
```

Plus one camera test, written against the export `core/camera.js` actually has for building the track from zooms (read the file first; assert the zoom level at t=2 is 1 when `z1.disabled`, and above 1 when not).

- [ ] **Step 2:** run → fails.
- [ ] **Step 3: implement.** `validateZoom`: `if (z.disabled !== undefined) bool(...)`, same for `auto`; add both to `ZOOM_PATCH_KEYS`. `validateClip`: `if (clip.gap !== undefined) bool(...)`, and a gap must have `hold`. `deleteClip` as above (length from `buildTimeline(project).clipBounds()[i]`). `removeItems` folds over the items, clips last. Camera: filter `z.disabled` out where zooms become targets. Compose: when the clip at this frame `isGap`, fill the frame area black instead of drawing the recording. Timeline's `audioPlan` already skips `hold` clips, so a gap is silent.
- [ ] **Step 4:** tests pass; `npm test` passes.
- [ ] **Step 5:** commit `feat(core): remove several items, disable a zoom, and delete leaving a gap`.

### Task 3: Inspector that follows the selection

**Files:** Create `src/renderer/editor/inspector.js`, `src/renderer/editor/panels/cursor.js`, `src/renderer/editor/panels/multi.js`. Modify `panels/index.js`, `panels/style.js`, `editor.js`, `index.html`, `editor.css`.

**Interfaces — produces:**
- `VIDEO_TABS = [look(style), cursor, camera(webcam), captions, audio]`; `INSPECTORS = { zoom, clip, overlay: clip, annotation: annotations, caption: captions, audio, speed: clip, marker: null }`; `PANELS` (all, for `panelById`).
- `createInspector({ tabsEl, titleEl, backEl, panelBox, editor, store }) -> { show(id, opts), current, update(what), mounted }`.
- Pure `panelFor(selected, lastTab) -> panel id` exported from `inspector.js`: `[] → lastTab`; one item → `INSPECTORS[kind] ?? lastTab`; several → `'multi'`.

- [ ] **Step 1: failing test** `test/editor-inspector.test.mjs` for `panelFor`: nothing → `'style'`; a zoom → `'zoom'`; an overlay → `'clip'`; a marker → last tab; two items → `'multi'`.
- [ ] **Step 2:** run → fails.
- [ ] **Step 3: implement.**
  - `index.html`: `#tabs` moves above `.panel-wrap` as a horizontal tab row; add `<button id="inspectorBack">` beside `#panelTitle`.
  - `inspector.js`: owns what `editor.js`'s `showPanel`, `mounted`, `currentPanel` do today (move that code, unchanged in behaviour), and on every `'selection'` event shows `panelFor(store.selected, lastTab)`. With a selection the tab row is hidden and the header shows the item's name and the back arrow (`store.select(null)`); without, the tab row shows and clicking a tab sets `lastTab`.
  - `cursor.js`: the cursor, click-effect and keyboard-badge controls cut out of `style.js` / `style-extras.js` (move, don't rewrite).
  - `multi.js`: "N items selected" and a Delete button calling `removeItems`.
  - `editor.js`: `editor.select` loses its per-kind `showPanel` calls (the inspector does it) but keeps the seek behaviour; `editor.showPanel` delegates to the inspector.
  - Zoom / clip / annotations panels' "nothing selected" states stay as they are; they show only when a test or caller asks for that panel by id.
- [ ] **Step 4:** unit test passes; `npm run test:e2e:editor` and `npm run test:e2e:visuals` — fix the tests' tab lookups where the markup moved, without weakening what they check.
- [ ] **Step 5:** commit `feat(editor): the right panel shows the selected item, or the video's settings`.

### Task 4: Toolbar

**Files:** Create `src/renderer/editor/toolbar.js`. Modify `index.html`, `editor.js`, `editor.css`, `ui.js` (a `menuButton` helper), `shortcuts.js`.

**Interfaces — produces:** `createToolbar({ root, actions, store, settings }) -> { snap: boolean, closeGaps: boolean, onChange(fn) }`; both toggles default on and are remembered with `localStorage` keys `loupe.snap`, `loupe.closeGaps`.

- [ ] **Step 1: failing test** in `test/editor-shortcuts.test.mjs`: `commandFor({ key: 'a', metaKey: true }, 'darwin') === 'selectAll'`; `commandFor({ key: 't' }, 'darwin') === 'addText'`; `commandFor({ key: 'b' }, 'darwin') === 'addBlur'`; cheat sheet lists them.
- [ ] **Step 2:** run → fails.
- [ ] **Step 3: implement.** Toolbar middle group: Split, Zoom, **Text** (menu: Text, Title card, Arrow, Box → `editor.addAnnotation(type)`), **Blur** (`editor.addAnnotation('blur')`), **Voice** (menu: Record a voiceover → the audio panel's existing recorder), **Add** (menu: Another recording, Audio, Picture or video), Cut, Delete. Right group: Snap, Close gaps, timeline zoom. `deleteSelection` uses `removeItems(store.selected)` and passes `leaveGap: !toolbar.closeGaps` for a single clip. Menus close on Escape and outside click, and are keyboard reachable (`role="menu"`, arrow keys).
- [ ] **Step 4:** unit + `npm run test:e2e:editor` pass.
- [ ] **Step 5:** commit `feat(editor): Text, Blur, Voice and Add on the toolbar, with Snap and Close gaps`.

### Task 5: Timeline — multi-select, zoom menu, speed on the clip, row order

**Files:** Modify `timeline-view.js`, `timeline-math.js`, `timeline-visuals.js`, `timeline-music.js`, `timeline-overlays.js`, `captions-track.js`, `panels/clip.js`, `editor.css`. Test `test/editor-timeline-math.test.mjs`.

**Interfaces — produces:** `boxHits(rects, box) -> items` in `timeline-math.js` (`rects`: `[{ item, x0, x1, y0, y1 }]`, `box`: same shape; any overlap counts).

- [ ] **Step 1: failing tests** for `boxHits` (overlap, touching edges don't count, empty box → `[]`).
- [ ] **Step 2:** run → fails.
- [ ] **Step 3: implement.**
  - Every timeline item's press: ⇧ or ⌘/Ctrl held → `store.select(item, { toggle: true })` and no drag; otherwise as now. Selected styling reads `hasItem(store.selected, item)`.
  - A drag starting on empty track space (not the ruler, not the zoom row) draws a box and `store.selectMany(boxHits(...))`; a plain click there still scrubs.
  - `selectAll` action: every item on the rows that hold the current selection, or all rows when nothing is selected.
  - Zoom right-click menu: Disable / Enable, Make manual (`follow: false`, `auto: false`), Remove. Disabled zooms get class `disabled` (hollow); `auto` zooms show "Auto" before the level.
  - Speed row removed. Clips show a badge per speed stretch (`2×`); ⌥/Alt-drag across a clip opens today's speed menu for that range; the clip inspector gains a Speed section listing the clip's stretches with the same choices. `speedPieces` is reused for the badges.
  - Row order: Overlays, Clips, Zoom, Sound, Audio, Text, Captions. "Notes" label → "Text". Overlay, Audio and Text rows are hidden while empty.
- [ ] **Step 4:** `npm test`, `npm run test:e2e:editor`, `npm run test:e2e:pro`, `npm run test:e2e:audio-clips` pass (update the speed-row steps to the Alt-drag path).
- [ ] **Step 5:** commit `feat(editor): select with a box or modifier keys, zoom menu, and speed shown on the clip`.

### Task 6: Transcript panel (read-only)

**Files:** Create `src/renderer/editor/transcript-panel.js`, `test/editor-transcript.test.mjs`. Modify `index.html`, `editor.js`, `editor.css`.

**Interfaces — produces:** pure `transcriptWords(project, tl) -> [{ text, outStart, outEnd, segmentId }]` (words from `captions.segments[].words`, or the whole line as one entry when a line has none; words cut from the video are left out), and `wordAt(words, t) -> index | -1`.

- [ ] **Step 1: failing tests** for both, on a project with two caption lines, one with word timings and one without, and a cut over the second word.
- [ ] **Step 2–4:** implement; panel is a folded `<aside id="transcript">` left of the stage, opened by a toolbar button, width and open state in `localStorage`; with no captions it shows "Write the transcript" (calls the captions panel's existing start). The word under the playhead is highlighted; clicking a word seeks to it.
- [ ] **Step 5:** commit `feat(editor): a transcript beside the preview`.

### Task 7: Picker strip and Restart

**Files:** Modify `src/renderer/picker/{index.html,picker.js,picker.css}`, `src/renderer/settings/*` (zoom shortcut rows under Recording), `src/renderer/bar/{index.html,bar.js,bar.css}`, `src/main/main.js`, `src/main/bar-state.js`, `src/preload/preload.js`. Tests `test/bar-state.test.js`, `test/e2e/recording-ui.e2e.js`.

- [ ] **Step 1: failing test** in `test/bar-state.test.js`: from `recording` and `paused`, `restart` leads to `countdown` when the countdown is on, else `recording`; from `armed` it is refused.
- [ ] **Step 2–4:** implement the transition; `bar:restart` IPC stops the capture, deletes its folder, and starts the same source with the same options; the bar asks first ("Start over? This recording is thrown away." — Start over / Keep recording). Picker: the five switches become one row of labelled toggle buttons under the source list (`aria-pressed`); the zoom-shortcut choosers move to Settings → Recording unchanged.
- [ ] **Step 5:** commit `feat(recording): restart from the bar, and a tidier picker`.

### Task 8: Verify

- [ ] `npm test` — all pass.
- [ ] `npm run test:e2e`, `test:e2e:visuals`, `test:e2e:captions`, `test:e2e:audio`, `test:e2e:audio-clips`, `test:e2e:pro`, `test:e2e:export`, `test:e2e:app`, `test:e2e:import`, `test:e2e:recording` — all pass.
- [ ] New e2e `test/e2e/redesign.e2e.js` (script `test:e2e:redesign`): selecting a zoom shows the Zoom inspector and the back arrow returns to the tabs; ⌘-click selects two zooms and Delete removes both in one undo step; a disabled zoom leaves exported pixels unzoomed at its moment; deleting a middle clip with Close gaps off keeps the export's length and the gap's pixels are black; Alt-drag sets a speed and the badge shows; the transcript opens and a word click moves the playhead. Screenshots to `test/e2e/out/redesign/`.
- [ ] Look at the screenshots; fix what looks wrong.
- [ ] Update `docs/EDITOR-V2.md` §2 layout notes and `README.md`'s feature list.
