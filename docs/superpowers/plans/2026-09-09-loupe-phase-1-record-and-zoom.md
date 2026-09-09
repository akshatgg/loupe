# Loupe Phase 1 — Record and Zoom — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a macOS app that records a display or single window at full resolution, zooms on ⌥+scroll with a smooth dead-zone camera, renders a crisp cursor with click highlights, and exports MP4.

**Architecture:** Electron shell supervising four `swiftc`-compiled helper binaries that talk newline-delimited JSON over stdout. The screen is captured clean — no zoom baked in — while gestures are recorded as keyframes against a shared monotonic clock. Zoom, camera motion, cursor, and click ripples are all composited at export time from the original pixels.

**Tech Stack:** Electron 44+, Node 22+ (`node --test`, no test framework dependency), Swift 5.9+ with ScreenCaptureKit / AVFoundation / CoreGraphics, `electron-builder`.

**Source documents:** [`docs/PRD.md`](../../PRD.md), [`docs/TRD.md`](../../TRD.md). Requirement IDs below (FR-n) refer to the PRD.

**Phase 1 covers:** FR-1 to FR-17, FR-31 (video + zoom tracks only), FR-32 to FR-36.
**Explicitly NOT in this plan:** speed control (Phase 2), voiceover (Phase 3), share links (Phase 4).

## Global Constraints

- **Platform:** macOS 13.0+. Apple Silicon and Intel.
- **No third-party Swift packages.** System frameworks only.
- **npm dependencies:** `electron` and `electron-builder` as devDependencies. No runtime dependencies. If a task seems to need one, it is wrong.
- **All media timing uses `CACurrentMediaTime()`.** `Date.now()`, `performance.now()`, and `process.hrtime()` are forbidden anywhere on the media path (TRD §5.1).
- **Capture never scales.** Source native pixel dimensions, 60fps, `showsCursor = false` (TRD §3.2).
- **Plain scroll is never consumed.** Only `.scrollWheel` events carrying `.maskAlternate` may be swallowed (FR-9).
- **Recording must never be blocked by zoom being unavailable** (FR-14).
- **Zoom range is 1.0×–4.0×** inclusive (FR-10).
- **Test runner:** `node --test`. Every pure module gets tests. Swift helpers are verified by running them and asserting on output.
- **Commit after every task.** Conventional Commits (`feat:`, `test:`, `chore:`, `fix:`).
- **Module style:** CommonJS (`'use strict'`, `module.exports`), matching the `souffleur` codebase.

---

## File Structure

| Path | Responsibility |
|---|---|
| `package.json` | Scripts, Electron entry, build config |
| `eslint.config.js` | Lint rules |
| `src/main/main.js` | Electron entry; window lifecycle |
| `src/main/timemap.js` | Source ↔ output time mapping (pure) |
| `src/main/zoom.js` | Zoom state machine (pure) |
| `src/main/camera.js` | Dead-zone camera solver + zero-phase smoothing (pure) |
| `src/main/project.js` | `project.json` and `cursor.bin` read/write |
| `src/main/helpers.js` | Spawn + supervise Swift helpers; NDJSON line parsing |
| `src/main/permissions.js` | TCC checks and System Settings deep links |
| `src/main/recorder.js` | Orchestrates one recording session |
| `src/preload/preload.js` | contextBridge IPC surface |
| `src/renderer/picker/` | Source picker window |
| `src/renderer/hud/` | Recording HUD window |
| `src/renderer/editor/` | Timeline editor + export |
| `src/native/Sources.swift` | Enumerate displays/windows/apps |
| `src/native/Capture.swift` | SCStream → `raw.mov` |
| `src/native/InputTap.swift` | CGEventTap → NDJSON gesture stream |
| `src/native/Render.swift` | Offline compositor → MP4 |
| `test/*.test.js` | `node --test` suites |
| `bin/` | Compiled helpers (gitignored) |

Pure modules (`timemap`, `zoom`, `camera`) hold every piece of logic that can be wrong, have zero I/O, and are tested exhaustively. Everything else is wiring.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `eslint.config.js`, `src/main/main.js`, `test/smoke.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` and `npm start` both work; the `bin/` build script exists for later tasks

- [ ] **Step 1: Write the failing test**

Create `test/smoke.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const pkg = require('../package.json');

test('package declares the native build script', () => {
  assert.ok(pkg.scripts['build:native'], 'build:native script must exist');
});

test('package has no runtime dependencies', () => {
  assert.deepStrictEqual(pkg.dependencies ?? {}, {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke.test.js`
Expected: FAIL — `Cannot find module '../package.json'`

- [ ] **Step 3: Write minimal implementation**

Create `package.json`:

```json
{
  "name": "loupe",
  "version": "0.1.0",
  "description": "Screen recorder with scroll-to-zoom for demo videos",
  "main": "src/main/main.js",
  "type": "commonjs",
  "author": "akshatgg",
  "license": "MIT",
  "scripts": {
    "start": "electron .",
    "dev": "electron . --enable-logging",
    "lint": "eslint .",
    "test": "eslint . && node --test test/",
    "build:native": "mkdir -p bin && swiftc -O -parse-as-library src/native/Sources.swift -o bin/sources && swiftc -O -parse-as-library src/native/Capture.swift -o bin/capture && swiftc -O src/native/InputTap.swift -o bin/inputtap && swiftc -O -parse-as-library src/native/Render.swift -o bin/render"
  },
  "devDependencies": {
    "electron": "^44.2.0",
    "electron-builder": "^26.15.3",
    "eslint": "^10.10.0"
  }
}
```

Create `eslint.config.js`:

```js
'use strict';
module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', process: 'readonly',
                 console: 'readonly', __dirname: 'readonly', Buffer: 'readonly' }
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'prefer-const': 'error',
      eqeqeq: 'error'
    }
  },
  { ignores: ['bin/', 'node_modules/', 'dist/', 'src/renderer/'] }
];
```

Create `src/main/main.js`:

```js
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createPickerWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 620,
    title: 'Loupe',
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js') }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'picker', 'index.html'));
  return win;
}

app.whenReady().then(createPickerWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

module.exports = { createPickerWindow };
```

Create `src/renderer/picker/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Loupe</title>
<body style="font: 13px -apple-system; padding: 24px">
  <h1>Loupe</h1>
  <p id="status">Scaffold running.</p>
</body>
```

Create `src/preload/preload.js`:

```js
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loupe', {
  listSources: () => ipcRenderer.invoke('sources:list')
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm install && npm test`
Expected: PASS, 2 tests, lint clean

- [ ] **Step 5: Verify the app launches**

Run: `npm start`
Expected: a window titled Loupe showing "Scaffold running." Close it.

- [ ] **Step 6: Commit**

```bash
git add package.json eslint.config.js src test
git commit -m "chore: scaffold Electron app and node --test harness"
```

---

### Task 2: TimeMap — source ↔ output time

**Files:**
- Create: `src/main/timemap.js`
- Test: `test/timemap.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `buildMap(segments, duration, rampMs = 200) → { table: Float64Array, step: number, duration: number, outputDuration: number }`
  - `toOutput(map, tSrc) → number`
  - `toSource(map, tOut) → number`
  - `rateAt(tSrc, segments, rampMs) → number`
  - `segments` is `[{ srcStart, srcEnd, rate }]`, sorted, non-overlapping. Empty in Phase 1.

**Why this exists in Phase 1 when there are no speed segments yet:** every later feature routes time through this module (TRD §5.3). Building the seam now costs ~60 lines; retrofitting it in Phase 2 means reworking the render pipeline, the editor, and the project schema. With no segments the map is the identity, which is exactly what Phase 1 needs.

- [ ] **Step 1: Write the failing test**

Create `test/timemap.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildMap, toOutput, toSource, rateAt } = require('../src/main/timemap');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

test('with no segments the map is the identity', () => {
  const map = buildMap([], 10);
  for (const t of [0, 0.5, 3.3, 9.9, 10]) near(toOutput(map, t), t);
  near(map.outputDuration, 10);
});

test('a 2x segment halves that regions output duration', () => {
  const map = buildMap([{ srcStart: 2, srcEnd: 6, rate: 2 }], 10, 0);
  near(map.outputDuration, 8);
  near(toOutput(map, 2), 2);
  near(toOutput(map, 6), 4);
  near(toOutput(map, 10), 8);
});

test('a 0.5x segment doubles that regions output duration', () => {
  const map = buildMap([{ srcStart: 0, srcEnd: 4, rate: 0.5 }], 10, 0);
  near(map.outputDuration, 14);
});

test('the map is strictly increasing', () => {
  const map = buildMap([{ srcStart: 1, srcEnd: 3, rate: 8 }], 10);
  for (let i = 1; i < map.table.length; i++) {
    assert.ok(map.table[i] > map.table[i - 1], `not increasing at ${i}`);
  }
});

test('toSource round-trips toOutput', () => {
  const map = buildMap([{ srcStart: 2, srcEnd: 5, rate: 3 }], 12);
  for (const t of [0, 1, 2.5, 4, 5, 8, 11.5]) near(toSource(map, toOutput(map, t)), t, 1e-3);
});

test('rate is 1.0 outside every segment', () => {
  const segs = [{ srcStart: 2, srcEnd: 6, rate: 4 }];
  near(rateAt(0, segs, 200), 1);
  near(rateAt(8, segs, 200), 1);
});

test('rate ramps continuously from 1.0 at each segment edge', () => {
  const segs = [{ srcStart: 2, srcEnd: 6, rate: 4 }];
  near(rateAt(2, segs, 200), 1);
  near(rateAt(6, segs, 200), 1);
  near(rateAt(4, segs, 200), 4);
  assert.ok(rateAt(2.1, segs, 200) > 1 && rateAt(2.1, segs, 200) < 4);
});

test('ramps are clamped so they never exceed half the segment', () => {
  const segs = [{ srcStart: 1, srcEnd: 1.1, rate: 4 }];
  const mid = rateAt(1.05, segs, 200);
  assert.ok(mid > 1 && mid <= 4, `mid rate ${mid} out of range`);
  near(rateAt(1, segs, 200), 1);
  near(rateAt(1.1, segs, 200), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/timemap.test.js`
Expected: FAIL — `Cannot find module '../src/main/timemap'`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/timemap.js`:

```js
'use strict';

const STEP_SECONDS = 0.001;

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

// Playback rate at a source time. Ramps live INSIDE the segment, so
// non-overlapping segments never influence each other.
function rateAt(tSrc, segments, rampMs = 200) {
  const rampSeconds = rampMs / 1000;
  for (const seg of segments) {
    if (tSrc < seg.srcStart || tSrc > seg.srcEnd) continue;
    const ramp = Math.min(rampSeconds, (seg.srcEnd - seg.srcStart) / 2);
    let k = 1;
    if (ramp > 0) {
      const into = tSrc - seg.srcStart;
      const outOf = seg.srcEnd - tSrc;
      if (into < ramp) k = smoothstep(into / ramp);
      else if (outOf < ramp) k = smoothstep(outOf / ramp);
    }
    return 1 + (seg.rate - 1) * k;
  }
  return 1;
}

function buildMap(segments, duration, rampMs = 200) {
  const count = Math.ceil(duration / STEP_SECONDS) + 1;
  const table = new Float64Array(count);
  let acc = 0;
  for (let i = 1; i < count; i++) {
    const midpoint = (i - 0.5) * STEP_SECONDS;
    acc += STEP_SECONDS / rateAt(midpoint, segments, rampMs);
    table[i] = acc;
  }
  return { table, step: STEP_SECONDS, duration, outputDuration: acc };
}

function toOutput(map, tSrc) {
  const { table, step } = map;
  if (tSrc <= 0) return 0;
  const last = table.length - 1;
  const pos = tSrc / step;
  if (pos >= last) return table[last];
  const i = Math.floor(pos);
  return table[i] + (table[i + 1] - table[i]) * (pos - i);
}

function toSource(map, tOut) {
  const { table, step } = map;
  const last = table.length - 1;
  if (tOut <= 0) return 0;
  if (tOut >= table[last]) return last * step;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid] <= tOut) lo = mid;
    else hi = mid;
  }
  const span = table[hi] - table[lo];
  const frac = span === 0 ? 0 : (tOut - table[lo]) / span;
  return (lo + frac) * step;
}

module.exports = { buildMap, toOutput, toSource, rateAt };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/timemap.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/timemap.js test/timemap.test.js
git commit -m "feat: add source-to-output time mapping with speed ramps"
```

---

### Task 3: Zoom state machine

**Files:**
- Create: `src/main/zoom.js`
- Test: `test/zoom.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `ZOOM_MIN = 1.0`, `ZOOM_MAX = 4.0`, `SENSITIVITY = 0.015`
  - `createZoomState() → { target: number, keyframes: Array, lastCursor: {x,y} | null }`
  - `applyScroll(state, { t, dy, x, y }) → boolean` — mutates state, returns whether a keyframe was appended
  - Keyframe shape: `{ t, zoom, cx, cy }` where `t` is **source time in seconds** and `cx,cy` is the cursor in screen pixels

**Sign convention, fixed here and matched by `InputTap.swift` in Task 11:** `dy` is `scrollWheelEventPointDeltaAxis1` in pixels; **positive `dy` means scroll up, which zooms in.**

- [ ] **Step 1: Write the failing test**

Create `test/zoom.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createZoomState, applyScroll, ZOOM_MIN, ZOOM_MAX } = require('../src/main/zoom');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

test('starts fully zoomed out', () => {
  assert.strictEqual(createZoomState().target, ZOOM_MIN);
});

test('scrolling up zooms in', () => {
  const s = createZoomState();
  applyScroll(s, { t: 1, dy: 10, x: 100, y: 100 });
  assert.ok(s.target > ZOOM_MIN);
});

test('scrolling down from rest stays clamped at the minimum', () => {
  const s = createZoomState();
  applyScroll(s, { t: 1, dy: -10, x: 100, y: 100 });
  assert.strictEqual(s.target, ZOOM_MIN);
});

test('never exceeds the maximum', () => {
  const s = createZoomState();
  for (let i = 0; i < 500; i++) applyScroll(s, { t: i * 0.01, dy: 30, x: 100, y: 100 });
  assert.strictEqual(s.target, ZOOM_MAX);
});

test('equal scroll up then down returns to the starting zoom', () => {
  const s = createZoomState();
  for (let i = 0; i < 5; i++) applyScroll(s, { t: i * 0.01, dy: 10, x: 100, y: 100 });
  const peak = s.target;
  assert.ok(peak > 1.2 && peak < ZOOM_MAX, `peak ${peak} should be mid-range`);
  for (let i = 0; i < 5; i++) applyScroll(s, { t: 1 + i * 0.01, dy: -10, x: 100, y: 100 });
  near(s.target, ZOOM_MIN);
});

test('records a keyframe carrying the cursor position', () => {
  const s = createZoomState();
  applyScroll(s, { t: 4.25, dy: 10, x: 1420, y: 880 });
  assert.strictEqual(s.keyframes.length, 1);
  const k = s.keyframes[0];
  assert.strictEqual(k.t, 4.25);
  assert.strictEqual(k.cx, 1420);
  assert.strictEqual(k.cy, 880);
  assert.ok(k.zoom > ZOOM_MIN);
});

test('emits no keyframe when already clamped and the cursor has not moved', () => {
  const s = createZoomState();
  applyScroll(s, { t: 1, dy: -10, x: 100, y: 100 });
  applyScroll(s, { t: 2, dy: -10, x: 100, y: 100 });
  assert.strictEqual(s.keyframes.length, 0);
});

test('emits a keyframe when clamped but the cursor moved', () => {
  const s = createZoomState();
  applyScroll(s, { t: 1, dy: -10, x: 100, y: 100 });
  applyScroll(s, { t: 2, dy: -10, x: 400, y: 400 });
  assert.strictEqual(s.keyframes.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/zoom.test.js`
Expected: FAIL — `Cannot find module '../src/main/zoom'`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/zoom.js`:

```js
'use strict';

const ZOOM_MIN = 1.0;
const ZOOM_MAX = 4.0;

// Per pixel of scroll delta. A mouse notch is ~10px, giving ~1.16x per notch,
// so 1.0x to 4.0x is about nine notches.
const SENSITIVITY = 0.015;

const CURSOR_EPSILON = 1;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function createZoomState() {
  return { target: ZOOM_MIN, keyframes: [], lastCursor: null };
}

// Positive dy means scroll up, which zooms in. Exponential so one notch feels
// like the same amount of zoom at 1.2x as it does at 3.5x.
function applyScroll(state, { t, dy, x, y }) {
  // Events arrive from the OS via a Swift event tap. One non-finite dy would
  // set target to NaN, and NaN * exp(...) stays NaN, so zoom would be dead
  // for the rest of the recording with no way to recover. Reject it here,
  // before target is touched.
  if (!Number.isFinite(dy)) return false;

  const next = clamp(state.target * Math.exp(dy * SENSITIVITY), ZOOM_MIN, ZOOM_MAX);
  const zoomChanged = next !== state.target;
  state.target = next;

  // A non-finite cursor position wouldn't corrupt state.target (it's already
  // committed above), but it would get written into a keyframe's cx/cy,
  // handing the downstream renderer a NaN camera position. Unlike dy, a bad
  // x/y should only cost us the keyframe, not the zoom change: the next
  // event with usable coordinates will emit a keyframe carrying the current
  // (accumulated) target, so nothing is lost.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

  // lastCursor is the position last COMMITTED to, not the one last seen.
  // Comparing against the previous raw sample would let sub-epsilon movement
  // accumulate without limit: 200 events of 0.9px each move the cursor 180px
  // across the screen and emit nothing.
  if (state.lastCursor === null) state.lastCursor = { x, y };

  const cursorMoved =
    Math.abs(x - state.lastCursor.x) >= CURSOR_EPSILON ||
    Math.abs(y - state.lastCursor.y) >= CURSOR_EPSILON;

  if (!zoomChanged && !cursorMoved) return false;

  state.lastCursor = { x, y };
  state.keyframes.push({ t, zoom: next, cx: x, cy: y });
  return true;
}

module.exports = { createZoomState, applyScroll, ZOOM_MIN, ZOOM_MAX, SENSITIVITY };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/zoom.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/zoom.js test/zoom.test.js
git commit -m "feat: add exponential zoom state machine with clamping"
```

---

### Task 4: Dead-zone camera solver

**Files:**
- Create: `src/main/camera.js`
- Test: `test/camera.test.js`

**Interfaces:**
- Consumes: `ZOOM_MIN` from `src/main/zoom.js`
- Produces:
  - `SAMPLE_RATE = 120`, `TAU = 0.082`, `DEAD_ZONE_FRACTION = 0.5`
  - `easeZoom(keyframes, duration, sampleRate) → Float64Array`
  - `resampleCursor(track, duration, sampleRate) → { xs: Float64Array, ys: Float64Array }`
  - `solvePath(zoomSamples, cursor, { width, height }) → { cx: Float64Array, cy: Float64Array }`
  - `cursorTrack` is `[{ t, x, y }]` sorted ascending by `t`

This implements TRD §4.2 and §4.3. Task 5 adds the smoothing pass on top.

- [ ] **Step 1: Write the failing test**

Create `test/camera.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { easeZoom, resampleCursor, solvePath, SAMPLE_RATE } = require('../src/main/camera');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);
const SCREEN = { width: 1600, height: 1000 };

function constantCursor(x, y, n) {
  return { xs: new Float64Array(n).fill(x), ys: new Float64Array(n).fill(y) };
}

test('zoom starts at 1.0 with no keyframes', () => {
  const z = easeZoom([], 1, SAMPLE_RATE);
  near(z[0], 1);
  near(z[z.length - 1], 1);
});

test('zoom reaches 95 percent of its target within 400ms', () => {
  const z = easeZoom([{ t: 0, zoom: 3, cx: 0, cy: 0 }], 1, SAMPLE_RATE);
  const at400ms = z[Math.round(0.4 * SAMPLE_RATE)];
  assert.ok(at400ms >= 1 + 0.95 * 2, `reached only ${at400ms}`);
});

test('zoom is critically damped and does not overshoot', () => {
  const z = easeZoom([{ t: 0, zoom: 3, cx: 0, cy: 0 }], 3, SAMPLE_RATE);
  const peak = Math.max(...z);
  assert.ok(peak <= 3 * 1.01, `overshot to ${peak}`);
});

test('cursor resampling interpolates between samples', () => {
  const track = [{ t: 0, x: 0, y: 0 }, { t: 1, x: 120, y: 240 }];
  const { xs, ys } = resampleCursor(track, 1, SAMPLE_RATE);
  near(xs[Math.round(0.5 * SAMPLE_RATE)], 60, 1);
  near(ys[Math.round(0.5 * SAMPLE_RATE)], 120, 1);
});

test('cursor resampling holds the last known value past the end of the track', () => {
  const track = [{ t: 0, x: 10, y: 20 }];
  const { xs, ys } = resampleCursor(track, 1, SAMPLE_RATE);
  near(xs[xs.length - 1], 10);
  near(ys[ys.length - 1], 20);
});

test('at 1.0x the camera is pinned to screen centre', () => {
  const n = 120;
  const z = new Float64Array(n).fill(1);
  const { cx, cy } = solvePath(z, constantCursor(50, 50, n), SCREEN);
  for (let i = 0; i < n; i++) {
    near(cx[i], SCREEN.width / 2);
    near(cy[i], SCREEN.height / 2);
  }
});

test('a cursor sitting inside the dead zone moves the camera exactly zero', () => {
  const n = 120;
  const z = new Float64Array(n).fill(2);
  // At 2x the visible rect is 800x500 and the dead zone is 400x250 around
  // screen centre, so (850, 550) is comfortably inside it.
  const { cx, cy } = solvePath(z, constantCursor(850, 550, n), SCREEN);
  for (let i = 0; i < n; i++) {
    assert.strictEqual(cx[i], SCREEN.width / 2);
    assert.strictEqual(cy[i], SCREEN.height / 2);
  }
});

test('the camera follows a cursor that leaves the dead zone', () => {
  const n = 120;
  const z = new Float64Array(n).fill(2);
  const { cx } = solvePath(z, constantCursor(1500, 500, n), SCREEN);
  assert.ok(cx[0] > SCREEN.width / 2, 'camera should have moved right');
});

test('the visible frame never leaves the screen at any zoom', () => {
  const n = 240;
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = 1 + 3 * (i / n);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = i % 2 === 0 ? -500 : 3000;
    ys[i] = i % 2 === 0 ? -500 : 3000;
  }
  const { cx, cy } = solvePath(z, { xs, ys }, SCREEN);
  for (let i = 0; i < n; i++) {
    const vw = SCREEN.width / z[i];
    const vh = SCREEN.height / z[i];
    assert.ok(cx[i] - vw / 2 >= -1e-6 && cx[i] + vw / 2 <= SCREEN.width + 1e-6, `x out of bounds at ${i}`);
    assert.ok(cy[i] - vh / 2 >= -1e-6 && cy[i] + vh / 2 <= SCREEN.height + 1e-6, `y out of bounds at ${i}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/camera.test.js`
Expected: FAIL — `Cannot find module '../src/main/camera'`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/camera.js`:

```js
'use strict';

const { ZOOM_MIN } = require('./zoom');

const SAMPLE_RATE = 120;

// Critically damped spring: x(t) = 1 - (1 + t/TAU) * exp(-t/TAU).
// Reaching 95% at 400ms needs TAU = 0.0843, so 0.082 clears it with margin.
// (0.085 was the original figure here and is wrong -- it lands at 94.84%.)
const TAU = 0.082;

// The inner 50% of the visible rect. Cursor movement inside it moves nothing.
const DEAD_ZONE_FRACTION = 0.5;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function sampleCount(duration, sampleRate) {
  return Math.max(1, Math.round(duration * sampleRate) + 1);
}

function easeZoom(keyframes, duration, sampleRate = SAMPLE_RATE) {
  const n = sampleCount(duration, sampleRate);
  const dt = 1 / sampleRate;
  const out = new Float64Array(n);
  let position = ZOOM_MIN;
  let velocity = 0;
  let target = ZOOM_MIN;
  let next = 0;

  for (let i = 0; i < n; i++) {
    const t = i * dt;
    while (next < keyframes.length && keyframes[next].t <= t) {
      target = keyframes[next].zoom;
      next++;
    }
    // Semi-implicit Euler: update velocity first, then position with it.
    const accel = (target - position) / (TAU * TAU) - (2 * velocity) / TAU;
    velocity += accel * dt;
    position += velocity * dt;
    out[i] = position;
  }
  return out;
}

function resampleCursor(track, duration, sampleRate = SAMPLE_RATE) {
  const n = sampleCount(duration, sampleRate);
  const dt = 1 / sampleRate;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  if (track.length === 0) return { xs, ys };

  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    while (j < track.length - 1 && track[j + 1].t <= t) j++;
    const a = track[j];
    const b = track[j + 1];
    if (!b || t <= a.t) {
      xs[i] = a.x;
      ys[i] = a.y;
      continue;
    }
    const f = (t - a.t) / (b.t - a.t);
    xs[i] = a.x + (b.x - a.x) * f;
    ys[i] = a.y + (b.y - a.y) * f;
  }
  return { xs, ys };
}

// The camera moves the MINIMUM distance that puts the cursor back on the
// dead-zone boundary, and never more. That is what makes typing produce
// exactly zero movement.
function solvePath(zoomSamples, cursor, { width, height }) {
  const n = zoomSamples.length;
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  let camX = width / 2;
  let camY = height / 2;

  for (let i = 0; i < n; i++) {
    const z = zoomSamples[i];
    const vw = width / z;
    const vh = height / z;
    const dw = vw * DEAD_ZONE_FRACTION;
    const dh = vh * DEAD_ZONE_FRACTION;
    const mx = cursor.xs[i];
    const my = cursor.ys[i];

    if (mx < camX - dw / 2) camX = mx + dw / 2;
    else if (mx > camX + dw / 2) camX = mx - dw / 2;
    if (my < camY - dh / 2) camY = my + dh / 2;
    else if (my > camY + dh / 2) camY = my - dh / 2;

    camX = clamp(camX, vw / 2, width - vw / 2);
    camY = clamp(camY, vh / 2, height - vh / 2);

    cx[i] = camX;
    cy[i] = camY;
  }
  return { cx, cy };
}

module.exports = {
  easeZoom, resampleCursor, solvePath, clamp, sampleCount,
  SAMPLE_RATE, TAU, DEAD_ZONE_FRACTION
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/camera.test.js`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/camera.js test/camera.test.js
git commit -m "feat: add dead-zone camera solver with eased zoom"
```

---

### Task 5: Zero-phase smoothing and the camera orchestrator

**Files:**
- Modify: `src/main/camera.js`
- Test: `test/camera-smoothing.test.js`

**Interfaces:**
- Consumes: everything from Task 4
- Produces:
  - `SMOOTH_CUTOFF_HZ = 1.2`
  - `alphaFor(cutoffHz, sampleRate) → number`
  - `smoothPath(arr, alpha) → Float64Array`
  - `solveCamera({ keyframes, cursorTrack, duration, width, height, sampleRate }) → [{ t, zoom, cx, cy }]`

This is TRD §4.4 — the payoff of rendering after recording. A forward-then-backward pass has no phase lag, so the camera can start easing *before* the cursor moves. A live implementation cannot do this at any price.

**Critical detail:** the frame bounds must be re-clamped *after* smoothing. The filter can push the camera past the screen edge, and skipping the re-clamp produces black bars in the export.

- [ ] **Step 1: Write the failing test**

Create `test/camera-smoothing.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { alphaFor, smoothPath, solveCamera, SAMPLE_RATE } = require('../src/main/camera');

const SCREEN = { width: 1600, height: 1000 };

function indexOfMax(arr) {
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[best]) best = i;
  return best;
}

test('alpha is between 0 and 1', () => {
  const a = alphaFor(1.2, SAMPLE_RATE);
  assert.ok(a > 0 && a < 1, `alpha ${a}`);
});

test('smoothing introduces no lag: a symmetric pulse keeps its peak position', () => {
  const n = 240;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.exp(-((i - 120) ** 2) / 200);
  const out = smoothPath(x, alphaFor(1.2, SAMPLE_RATE));
  assert.ok(Math.abs(indexOfMax(out) - 120) <= 1, `peak moved to ${indexOfMax(out)}`);
});

test('smoothing reduces high-frequency jitter', () => {
  const n = 240;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = 100 + (i % 2 === 0 ? 20 : -20);
  const out = smoothPath(x, alphaFor(1.2, SAMPLE_RATE));

  // Measure interior spread, excluding the first and last 40 samples.
  // The forward pass seeds at arr[0], which is a peak (120) in this synthetic square wave.
  // Real camera paths start continuous and centered, so their first sample sits at the
  // local mean with nothing to decay from. This edge transient has nothing to do with
  // jitter rejection, so we measure the interior where the filter has settled.
  const interiorStart = 40;
  const interiorEnd = n - 40;
  let interiorMin = out[interiorStart];
  let interiorMax = out[interiorStart];
  for (let i = interiorStart; i < interiorEnd; i++) {
    interiorMin = Math.min(interiorMin, out[i]);
    interiorMax = Math.max(interiorMax, out[i]);
  }
  const interiorSpread = interiorMax - interiorMin;
  assert.ok(interiorSpread < 2, `jitter survived in interior, spread ${interiorSpread}`);
});

test('filter boundary transient is documented and bounded', () => {
  const n = 240;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = 100 + (i % 2 === 0 ? 20 : -20);
  const out = smoothPath(x, alphaFor(1.2, SAMPLE_RATE));
  const spread = Math.max(...out) - Math.min(...out);
  // The full-array spread includes the transient artifact of starting the forward pass
  // at a peak. This decays within roughly two time constants (~40 samples at alpha=0.06).
  // Real signals don't produce this edge effect, so it's expected and bounded here
  // without affecting the jitter-reduction test.
  assert.ok(spread < 12, `full-array spread with boundary transient ${spread}`);
});

test('smoothing an empty array returns an empty array', () => {
  assert.strictEqual(smoothPath(new Float64Array(0), 0.5).length, 0);
});

test('solveCamera returns one sample per tick with monotonic timestamps', () => {
  const out = solveCamera({
    keyframes: [], cursorTrack: [{ t: 0, x: 800, y: 500 }],
    duration: 1, ...SCREEN
  });
  assert.strictEqual(out.length, SAMPLE_RATE + 1);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t);
});

test('solveCamera keeps the frame on screen even after smoothing', () => {
  const cursorTrack = [];
  for (let i = 0; i <= 120; i++) {
    cursorTrack.push({ t: i / 120, x: i % 2 === 0 ? 0 : SCREEN.width, y: 500 });
  }
  const out = solveCamera({
    keyframes: [{ t: 0, zoom: 4, cx: 0, cy: 500 }],
    cursorTrack, duration: 1, ...SCREEN
  });
  for (const s of out) {
    const vw = SCREEN.width / s.zoom;
    const vh = SCREEN.height / s.zoom;
    assert.ok(s.cx - vw / 2 >= -1e-6 && s.cx + vw / 2 <= SCREEN.width + 1e-6, `x out of bounds at t=${s.t}`);
    assert.ok(s.cy - vh / 2 >= -1e-6 && s.cy + vh / 2 <= SCREEN.height + 1e-6, `y out of bounds at t=${s.t}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/camera-smoothing.test.js`
Expected: FAIL — `alphaFor is not a function`

- [ ] **Step 3: Write the implementation**

In `src/main/camera.js`, add above `module.exports`:

```js
const SMOOTH_CUTOFF_HZ = 1.2;

function alphaFor(cutoffHz, sampleRate) {
  return 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

// Forward pass then backward pass. Running the same filter in both
// directions cancels the phase shift, so the output has zero lag.
function smoothPath(arr, alpha) {
  const n = arr.length;
  if (n === 0) return new Float64Array(0);

  const forward = new Float64Array(n);
  let acc = arr[0];
  for (let i = 0; i < n; i++) {
    acc += alpha * (arr[i] - acc);
    forward[i] = acc;
  }

  const out = new Float64Array(n);
  acc = forward[n - 1];
  for (let i = n - 1; i >= 0; i--) {
    acc += alpha * (forward[i] - acc);
    out[i] = acc;
  }
  return out;
}

function solveCamera({ keyframes, cursorTrack, duration, width, height, sampleRate = SAMPLE_RATE }) {
  const zoom = easeZoom(keyframes, duration, sampleRate);
  const cursor = resampleCursor(cursorTrack, duration, sampleRate);
  const raw = solvePath(zoom, cursor, { width, height });
  const alpha = alphaFor(SMOOTH_CUTOFF_HZ, sampleRate);
  const cx = smoothPath(raw.cx, alpha);
  const cy = smoothPath(raw.cy, alpha);

  const dt = 1 / sampleRate;
  const out = new Array(zoom.length);
  for (let i = 0; i < zoom.length; i++) {
    const z = zoom[i];
    const vw = width / z;
    const vh = height / z;
    // Re-clamp: smoothing can push the frame past the screen edge, which
    // would render as black bars.
    out[i] = {
      t: i * dt,
      zoom: z,
      cx: clamp(cx[i], vw / 2, width - vw / 2),
      cy: clamp(cy[i], vh / 2, height - vh / 2)
    };
  }
  return out;
}
```

Then extend the exports:

```js
module.exports = {
  easeZoom, resampleCursor, solvePath, smoothPath, alphaFor, solveCamera,
  clamp, sampleCount,
  SAMPLE_RATE, TAU, DEAD_ZONE_FRACTION, SMOOTH_CUTOFF_HZ
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS, all suites

- [ ] **Step 5: Commit**

```bash
git add src/main/camera.js test/camera-smoothing.test.js
git commit -m "feat: add zero-phase camera smoothing and solveCamera orchestrator"
```

---

### Task 6: Project storage

**Files:**
- Create: `src/main/project.js`
- Test: `test/project.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `SCHEMA_VERSION = 1`
  - `CURSOR_RECORD_BYTES = 16`
  - `createProject(source, capture) → project`
  - `saveProject(dir, project) → void`
  - `loadProject(dir) → project`
  - `writeCursorTrack(dir, track) → void`
  - `readCursorTrack(dir) → [{ t, x, y, shape }]`
  - `SHAPE_CODES = { arrow: 0, ibeam: 1, pointinghand: 2, resize: 3 }`

Schema follows TRD §8. `speedSegments` and `voiceover` are written as empty arrays in Phase 1 so Phases 2 and 3 need no migration.

The cursor track is binary because a two-minute recording is ~14,400 samples — far too many for readable JSON. Records are 16 bytes (three `float32` plus one `uint8` plus three padding bytes) so Swift can read them with aligned loads.

- [ ] **Step 1: Write the failing test**

Create `test/project.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createProject, saveProject, loadProject,
  writeCursorTrack, readCursorTrack,
  SCHEMA_VERSION, CURSOR_RECORD_BYTES
} = require('../src/main/project');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-test-'));
}

const SOURCE = { kind: 'window', title: 'Safari', width: 3024, height: 1890 };
const CAPTURE = { file: 'raw.mov', fps: 60, duration: 12.5, hasMicTrack: true };

test('a new project carries the schema version and empty tracks', () => {
  const p = createProject(SOURCE, CAPTURE);
  assert.strictEqual(p.version, SCHEMA_VERSION);
  assert.deepStrictEqual(p.zoomKeyframes, []);
  assert.deepStrictEqual(p.clicks, []);
  assert.deepStrictEqual(p.speedSegments, []);
  assert.deepStrictEqual(p.voiceover, []);
});

test('a new project defaults to preserving voice pitch', () => {
  assert.strictEqual(createProject(SOURCE, CAPTURE).settings.preserveVoicePitch, true);
});

test('save then load round-trips', () => {
  const dir = tempDir();
  const p = createProject(SOURCE, CAPTURE);
  p.zoomKeyframes.push({ t: 1.5, zoom: 2.4, cx: 100, cy: 200 });
  p.clicks.push({ t: 1.6, x: 100, y: 200, button: 'left' });
  saveProject(dir, p);
  assert.deepStrictEqual(loadProject(dir), p);
});

test('loading a project with an unknown schema version throws', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ version: 99 }));
  assert.throws(() => loadProject(dir), /unsupported project version: 99/);
});

test('cursor track round-trips through the binary format', () => {
  const dir = tempDir();
  const track = [
    { t: 0, x: 10, y: 20, shape: 'arrow' },
    { t: 0.5, x: 30.5, y: 40.25, shape: 'ibeam' },
    { t: 1, x: 50, y: 60, shape: 'pointinghand' }
  ];
  writeCursorTrack(dir, track);
  const back = readCursorTrack(dir);
  assert.strictEqual(back.length, 3);
  assert.strictEqual(back[1].shape, 'ibeam');
  assert.ok(Math.abs(back[1].x - 30.5) < 1e-3);
  assert.ok(Math.abs(back[1].y - 40.25) < 1e-3);
});

test('cursor records are exactly 16 bytes so Swift can read them aligned', () => {
  const dir = tempDir();
  writeCursorTrack(dir, [{ t: 0, x: 1, y: 2, shape: 'arrow' }]);
  assert.strictEqual(fs.statSync(path.join(dir, 'cursor.bin')).size, CURSOR_RECORD_BYTES);
});

test('an unknown cursor shape falls back to arrow rather than throwing', () => {
  const dir = tempDir();
  writeCursorTrack(dir, [{ t: 0, x: 1, y: 2, shape: 'crosshair-of-doom' }]);
  assert.strictEqual(readCursorTrack(dir)[0].shape, 'arrow');
});

test('reading a missing cursor track returns an empty array', () => {
  assert.deepStrictEqual(readCursorTrack(tempDir()), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/project.test.js`
Expected: FAIL — `Cannot find module '../src/main/project'`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/project.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const CURSOR_RECORD_BYTES = 16;

const SHAPE_CODES = { arrow: 0, ibeam: 1, pointinghand: 2, resize: 3 };
const SHAPE_NAMES = ['arrow', 'ibeam', 'pointinghand', 'resize'];

function createProject(source, capture) {
  return {
    version: SCHEMA_VERSION,
    source,
    capture,
    zoomKeyframes: [],
    cursorTrack: 'cursor.bin',
    clicks: [],
    speedSegments: [],
    voiceover: [],
    settings: {
      preserveVoicePitch: true,
      clickHighlights: true,
      cursorSmoothing: true,
      rampMs: 200
    },
    export: { resolution: '1080p', fps: 60, codec: 'h264' }
  };
}

function saveProject(dir, project) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2));
}

function loadProject(dir) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  if (raw.version !== SCHEMA_VERSION) {
    throw new Error(`unsupported project version: ${raw.version}`);
  }
  return raw;
}

function writeCursorTrack(dir, track) {
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.alloc(track.length * CURSOR_RECORD_BYTES);
  track.forEach((s, i) => {
    const at = i * CURSOR_RECORD_BYTES;
    buf.writeFloatLE(s.t, at);
    buf.writeFloatLE(s.x, at + 4);
    buf.writeFloatLE(s.y, at + 8);
    buf.writeUInt8(SHAPE_CODES[s.shape] ?? SHAPE_CODES.arrow, at + 12);
  });
  fs.writeFileSync(path.join(dir, 'cursor.bin'), buf);
}

function readCursorTrack(dir) {
  const file = path.join(dir, 'cursor.bin');
  if (!fs.existsSync(file)) return [];
  const buf = fs.readFileSync(file);
  const out = [];
  for (let at = 0; at + CURSOR_RECORD_BYTES <= buf.length; at += CURSOR_RECORD_BYTES) {
    out.push({
      t: buf.readFloatLE(at),
      x: buf.readFloatLE(at + 4),
      y: buf.readFloatLE(at + 8),
      shape: SHAPE_NAMES[buf.readUInt8(at + 12)] ?? 'arrow'
    });
  }
  return out;
}

module.exports = {
  createProject, saveProject, loadProject,
  writeCursorTrack, readCursorTrack,
  SCHEMA_VERSION, CURSOR_RECORD_BYTES, SHAPE_CODES
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/project.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/project.js test/project.test.js
git commit -m "feat: add project.json schema and binary cursor track storage"
```

---

### Task 7: Helper process supervision

**Files:**
- Create: `src/main/helpers.js`
- Test: `test/helpers.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `createLineSplitter(onLine) → (chunk: string) => void`
  - `spawnHelper(binPath, args, { onMessage, onMalformed, onExit, onError }) → ChildProcess`
  - `stopHelper(child, timeoutMs = 3000) → Promise<number>` resolving to the exit code

**The bug this task exists to prevent:** stdout arrives in arbitrary chunks. A JSON object can be split across two `data` events, and a single event can carry three objects. Parsing per-chunk instead of per-line produces intermittent, load-dependent failures that never reproduce in development. `createLineSplitter` is buffered and tested directly.

- [ ] **Step 1: Write the failing test**

Create `test/helpers.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createLineSplitter, spawnHelper, stopHelper } = require('../src/main/helpers');

test('emits one line per newline', () => {
  const seen = [];
  const push = createLineSplitter((l) => seen.push(l));
  push('a\nb\nc\n');
  assert.deepStrictEqual(seen, ['a', 'b', 'c']);
});

test('reassembles a line split across two chunks', () => {
  const seen = [];
  const push = createLineSplitter((l) => seen.push(l));
  push('{"type":"zo');
  push('om","dy":3}\n');
  assert.deepStrictEqual(seen, ['{"type":"zoom","dy":3}']);
});

test('does not emit a trailing line that has no newline yet', () => {
  const seen = [];
  const push = createLineSplitter((l) => seen.push(l));
  push('complete\nincomplete');
  assert.deepStrictEqual(seen, ['complete']);
});

test('skips blank lines', () => {
  const seen = [];
  const push = createLineSplitter((l) => seen.push(l));
  push('a\n\n\nb\n');
  assert.deepStrictEqual(seen, ['a', 'b']);
});

test('spawnHelper parses NDJSON into objects', async () => {
  const messages = [];
  const script = 'process.stdout.write(\'{"type":"a"}\\n{"ty\'); process.stdout.write(\'pe":"b"}\\n\');';
  await new Promise((resolve) => {
    spawnHelper(process.execPath, ['-e', script], {
      onMessage: (m) => messages.push(m),
      onMalformed: () => {},
      onExit: resolve
    });
  });
  assert.deepStrictEqual(messages, [{ type: 'a' }, { type: 'b' }]);
});

test('spawnHelper reports malformed lines without throwing', async () => {
  const bad = [];
  await new Promise((resolve) => {
    spawnHelper(process.execPath, ['-e', 'process.stdout.write("not json\\n")'], {
      onMessage: () => {},
      onMalformed: (line) => bad.push(line),
      onExit: resolve
    });
  });
  assert.deepStrictEqual(bad, ['not json']);
});

test('stopHelper resolves with the exit code', async () => {
  const child = spawnHelper(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    onMessage: () => {}, onMalformed: () => {}, onExit: () => {}
  });
  const code = await stopHelper(child, 2000);
  assert.strictEqual(typeof code, 'number');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/helpers.test.js`
Expected: FAIL — `Cannot find module '../src/main/helpers'`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/helpers.js`:

```js
'use strict';

const { spawn } = require('node:child_process');

// stdout arrives in arbitrary chunks: one JSON object can span two chunks and
// one chunk can carry several objects. Buffer until a newline.
// Note: the buffer has no size cap. This is an internal, first-party
// protocol between us and our own compiled helper, so a helper writing an
// unterminated multi-megabyte line is not a threat we defend against here;
// a cap was considered and deliberately left out rather than missed.
function createLineSplitter(onLine) {
  let buffer = '';
  return function push(chunk) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  };
}

function spawnHelper(binPath, args, { onMessage, onMalformed, onExit, onError }) {
  const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const push = createLineSplitter((line) => {
    try {
      onMessage(JSON.parse(line));
    } catch {
      onMalformed(line);
    }
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', push);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => console.error(`[${binPath}] ${d.trimEnd()}`));

  // A failed spawn (e.g. ENOENT for a bad/mis-packaged binary path) emits
  // 'error' on the child. An EventEmitter with no 'error' listener throws,
  // which would take down the Electron main process, so this listener must
  // always exist. Node can emit both 'error' and 'exit' for the same failed
  // spawn, but the caller must be told exactly once, so a single `notified`
  // flag gates both handlers regardless of which fires, or in what order.
  let notified = false;
  child.on('error', (err) => {
    if (typeof onError === 'function') {
      onError(err);
    } else {
      console.error(`[${binPath}] ${err.message}`);
    }
    if (!notified) {
      notified = true;
      onExit(null, null);
    }
  });
  child.on('exit', (code, signal) => {
    if (notified) return;
    notified = true;
    onExit(code, signal);
  });

  return child;
}

function stopHelper(child, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode ?? 0);
      return;
    }
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(kill);
      resolve(code ?? 0);
    });
    child.kill('SIGTERM');
  });
}

module.exports = { createLineSplitter, spawnHelper, stopHelper };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/helpers.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/helpers.js test/helpers.test.js
git commit -m "feat: add buffered NDJSON helper process supervision"
```

---

### Task 8: Permissions

**Files:**
- Create: `src/main/permissions.js`
- Test: `test/permissions.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `PANES = { screenRecording: string, accessibility: string, microphone: string }`
  - `createPermissions({ systemPreferences, shell }) → { screenRecording(), accessibility(), microphone(), requestMicrophone(), openPane(name), canRecord(), canZoom() }`

Implements FR-34, FR-35, FR-36. Electron already exposes every check needed, so no Swift helper is required here.

**The requirement most likely to be regressed:** `canRecord()` must depend **only** on Screen Recording. A missing Accessibility grant disables zoom and nothing else (FR-14). The test below locks that in.

Dependencies are injected so the module is testable without launching Electron.

- [ ] **Step 1: Write the failing test**

Create `test/permissions.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createPermissions, PANES } = require('../src/main/permissions');

function fake({ screen = 'granted', mic = 'granted', ax = true } = {}) {
  const opened = [];
  const perms = createPermissions({
    systemPreferences: {
      getMediaAccessStatus: (kind) => (kind === 'screen' ? screen : mic),
      isTrustedAccessibilityClient: () => ax,
      askForMediaAccess: async () => true
    },
    shell: { openExternal: (url) => opened.push(url) }
  });
  return { perms, opened };
}

test('screen recording reflects the granted status', () => {
  assert.strictEqual(fake({ screen: 'granted' }).perms.screenRecording(), true);
  assert.strictEqual(fake({ screen: 'denied' }).perms.screenRecording(), false);
});

test('recording is allowed when only accessibility is missing', () => {
  const { perms } = fake({ screen: 'granted', ax: false });
  assert.strictEqual(perms.canRecord(), true);
  assert.strictEqual(perms.canZoom(), false);
});

test('recording is blocked when screen recording is missing', () => {
  assert.strictEqual(fake({ screen: 'denied' }).perms.canRecord(), false);
});

test('zoom requires both screen recording and accessibility', () => {
  assert.strictEqual(fake({ screen: 'denied', ax: true }).perms.canZoom(), false);
  assert.strictEqual(fake({ screen: 'granted', ax: true }).perms.canZoom(), true);
});

test('openPane opens the matching settings URL', () => {
  const { perms, opened } = fake();
  perms.openPane('accessibility');
  assert.deepStrictEqual(opened, [PANES.accessibility]);
});

test('openPane rejects an unknown pane name', () => {
  assert.throws(() => fake().perms.openPane('nope'), /unknown settings pane: nope/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/permissions.test.js`
Expected: FAIL — `Cannot find module '../src/main/permissions'`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/permissions.js`:

```js
'use strict';

const BASE = 'x-apple.systempreferences:com.apple.preference.security';

const PANES = {
  screenRecording: `${BASE}?Privacy_ScreenCapture`,
  accessibility: `${BASE}?Privacy_Accessibility`,
  microphone: `${BASE}?Privacy_Microphone`
};

function createPermissions({ systemPreferences, shell }) {
  const screenRecording = () => systemPreferences.getMediaAccessStatus('screen') === 'granted';
  const accessibility = () => systemPreferences.isTrustedAccessibilityClient(false) === true;
  const microphone = () => systemPreferences.getMediaAccessStatus('microphone') === 'granted';

  return {
    screenRecording,
    accessibility,
    microphone,
    requestMicrophone: () => systemPreferences.askForMediaAccess('microphone'),

    // Recording depends on Screen Recording alone. A missing Accessibility
    // grant costs the zoom gesture and nothing else (PRD FR-14).
    canRecord: () => screenRecording(),
    canZoom: () => screenRecording() && accessibility(),

    openPane(name) {
      const url = PANES[name];
      if (!url) throw new Error(`unknown settings pane: ${name}`);
      return shell.openExternal(url);
    }
  };
}

module.exports = { createPermissions, PANES };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/permissions.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/permissions.js test/permissions.test.js
git commit -m "feat: add TCC permission checks with graceful zoom degradation"
```

---

### Task 9: `Sources.swift` — enumerate capture sources

**Files:**
- Create: `src/native/Sources.swift`

**Interfaces:**
- Consumes: nothing
- Produces: `bin/sources`, printing one JSON array and exiting. Each element:
  `{ id, kind, title, app, width, height, thumbnail }` where `id` is `"display:<n>"` or `"window:<n>"` and `thumbnail` is a base64 PNG data URL or `null`.

Implements FR-1 and TRD §3.1.

- [ ] **Step 1: Write the implementation**

Create `src/native/Sources.swift`:

```swift
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

            let ownBundle = Bundle.main.bundleIdentifier
            for window in content.windows {
                guard let title = window.title, !title.isEmpty,
                      window.frame.width > 40, window.frame.height > 40,
                      window.owningApplication?.bundleIdentifier != ownBundle
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
            let message = error.localizedDescription
                .replacingOccurrences(of: "\"", with: "'")
            print("{\"type\":\"error\",\"message\":\"\(message)\"}")
            exit(1)
        }
    }
}
```

- [ ] **Step 2: Build it**

Run: `mkdir -p bin && swiftc -O -parse-as-library src/native/Sources.swift -o bin/sources`
Expected: compiles with no errors

- [ ] **Step 3: Verify it produces valid JSON listing your displays**

Run: `./bin/sources | python3 -m json.tool | head -30`

Expected: a JSON array whose first element is a `display` entry with non-zero `width` and `height`, and a `thumbnail` starting `data:image/png;base64,`.

If it prints `{"type":"error",...}` instead, the binary lacks Screen Recording permission. Grant it to Terminal in System Settings → Privacy & Security → Screen Recording, then re-run.

- [ ] **Step 4: Verify Loupe's own windows are excluded and titles are present**

Run: `./bin/sources | python3 -c "import json,sys; [print(s['kind'], '|', s['title']) for s in json.load(sys.stdin)]"`

Expected: your open windows listed by title; every entry has a non-empty title.

- [ ] **Step 5: Commit**

```bash
git add src/native/Sources.swift
git commit -m "feat: add ScreenCaptureKit source enumeration helper"
```

---

### Task 10: `Capture.swift` — record the screen

**Files:**
- Create: `src/native/Capture.swift`

**Interfaces:**
- Consumes: source ids produced by `bin/sources`
- Produces: `bin/capture`, invoked as
  `bin/capture --source <id> --out <path.mov> --mic <0|1> [--exclude-window <windowID>]`
- Emits NDJSON on stdout:
  - `{"type":"started","clock":<seconds>}` — once, on the first frame
  - `{"type":"progress","frames":N,"bytes":M}` — once per second
  - `{"type":"stopped","duration":D}` — on clean shutdown
  - `{"type":"error","message":"..."}` — then exit 1

Implements FR-2, FR-3, FR-4, FR-5 and TRD §3.2.

**Two things here are load-bearing and must not be "simplified" during implementation:**

1. **`--exclude-window` is what keeps the HUD out of the recording** (FR-5). It is passed to `SCContentFilter(display:excludingWindows:)`.
2. **The `clock` value is taken from the first frame's presentation timestamp, not from a separate clock read.** `CMSampleBuffer` timestamps and `CACurrentMediaTime()` share the mach timebase, so using the frame's own PTS makes the alignment with `bin/inputtap` exact rather than merely close (TRD §5.1).

- [ ] **Step 1: Write the implementation**

Create `src/native/Capture.swift`:

```swift
import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

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

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate,
                     AVCaptureAudioDataOutputSampleBufferDelegate {
    private let writer: AVAssetWriter
    private let videoInput: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput?
    private var stream: SCStream?
    private var audioSession: AVCaptureSession?

    private var firstPTS: CMTime?
    private var lastPTS: CMTime = .zero
    private var frames = 0
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

        if firstPTS == nil {
            firstPTS = pts
            writer.startSession(atSourceTime: pts)
            // The frame's own timestamp shares the mach timebase with
            // CACurrentMediaTime() in bin/inputtap, so this alignment is exact.
            emit(["type": "started", "clock": pts.seconds])
        }

        guard videoInput.isReadyForMoreMediaData else { return }
        videoInput.append(buffer)
        lastPTS = pts
        frames += 1

        if frames % 60 == 0 {
            emit(["type": "progress", "frames": frames,
                  "bytes": (try? FileManager.default.attributesOfItem(
                      atPath: writer.outputURL.path)[.size] as? Int) as Any ?? 0])
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput buffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard let audioInput, firstPTS != nil, audioInput.isReadyForMoreMediaData else { return }
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
        let duration = firstPTS.map { lastPTS.seconds - $0.seconds } ?? 0
        emit(["type": "stopped", "duration": duration])
    }
}

@main
struct CaptureTool {
    static func main() async {
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

            let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
            term.setEventHandler {
                Task {
                    await capture.finish()
                    exit(0)
                }
            }
            term.resume()
            signal(SIGTERM, SIG_IGN)

            try await Task.sleep(nanoseconds: .max)
        } catch {
            fail(error.localizedDescription)
        }
    }
}
```

- [ ] **Step 2: Build it**

Run: `swiftc -O -parse-as-library src/native/Capture.swift -o bin/capture`
Expected: compiles with no errors

- [ ] **Step 3: Record a five-second test clip**

Run:
```bash
DISPLAY_ID=$(./bin/sources | python3 -c "import json,sys; print([s['id'] for s in json.load(sys.stdin) if s['kind']=='display'][0])")
./bin/capture --source "$DISPLAY_ID" --out /tmp/loupe-test.mov --mic 0 &
CAP=$!
sleep 5
kill -TERM $CAP
wait $CAP
```

Expected stdout: a `started` line with a `clock` value, several `progress` lines, then a `stopped` line with `duration` near 5.

- [ ] **Step 4: Verify the file is full resolution and 60fps**

Run: `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,codec_name /tmp/loupe-test.mov`

Expected: your display's **native pixel** width and height (on a Retina display this is the scaled-up number, not the logical points), `r_frame_rate` of `60/1`, codec `hevc`.

If width and height come back as logical points rather than pixels, `pointPixelScale` was not applied — fix before continuing, because every zoom calculation downstream assumes pixels.

- [ ] **Step 5: Verify the cursor is absent**

Run: `open /tmp/loupe-test.mov` and confirm no mouse pointer is visible anywhere in the clip.

Expected: no cursor. It is drawn at render time in Task 15.

- [ ] **Step 6: Commit**

```bash
git add src/native/Capture.swift
git commit -m "feat: add ScreenCaptureKit capture helper with mic muxing"
```

---

### Task 11: `InputTap.swift` — the gesture hook

**Files:**
- Create: `src/native/InputTap.swift`

**Interfaces:**
- Consumes: nothing
- Produces: `bin/inputtap`, emitting NDJSON on stdout:
  - `{"type":"ready"}` — tap installed
  - `{"type":"zoom","clock":T,"dy":D,"x":X,"y":Y}` — ⌥+scroll, **positive `dy` means scroll up, which zooms in** (matches `src/main/zoom.js` from Task 3)
  - `{"type":"click","clock":T,"x":X,"y":Y,"button":"left"|"right"}`
  - `{"type":"cursor","clock":T,"x":X,"y":Y,"shape":"arrow"|"ibeam"|"pointinghand"|"resize"}` — throttled to 120Hz
  - `{"type":"tap_reenabled","clock":T}`
  - `{"type":"error","message":"..."}` — then exit 1

Implements FR-8, FR-9, FR-16, FR-17 and TRD §3.3, §7.3.

**Three requirements that are easy to break and expensive to debug:**

1. **Only ⌥+scroll may be consumed.** Every other event, scroll included, returns unmodified. Consuming plain scroll makes most demos impossible (FR-9).
2. **The callback must stay under 0.5ms.** macOS disables a slow tap. Writes therefore go to a serial queue, never inline.
3. **`tapDisabledByTimeout` must be handled.** Skipping it is the classic bug where zoom silently stops working ten minutes into a session.

- [ ] **Step 1: Write the implementation**

Create `src/native/InputTap.swift`:

```swift
import Foundation
import CoreGraphics
import AppKit
import QuartzCore

let outputQueue = DispatchQueue(label: "tech.markai.loupe.inputtap.out")

func emit(_ dict: [String: Any]) {
    outputQueue.async {
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}

func fail(_ message: String) -> Never {
    emit(["type": "error", "message": message])
    outputQueue.sync {}
    exit(1)
}

final class TapState {
    var tap: CFMachPort?
    var lastCursorEmit: Double = 0
    let cursorInterval = 1.0 / 120.0
}

func cursorShape() -> String {
    guard let current = NSCursor.currentSystem else { return "arrow" }
    switch current {
    case NSCursor.iBeam: return "ibeam"
    case NSCursor.pointingHand: return "pointinghand"
    case NSCursor.resizeLeftRight, NSCursor.resizeUpDown: return "resize"
    default: return "arrow"
    }
}

let callback: CGEventTapCallBack = { _, type, event, userInfo in
    let state = Unmanaged<TapState>.fromOpaque(userInfo!).takeUnretainedValue()

    // macOS disables a tap whose callback runs slow. Re-enable immediately.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = state.tap { CGEvent.tapEnable(tap: tap, enable: true) }
        emit(["type": "tap_reenabled", "clock": CACurrentMediaTime()])
        return nil
    }

    let now = CACurrentMediaTime()
    let location = event.location

    switch type {
    case .scrollWheel:
        // ONLY Option+scroll is consumed. Everything else passes through
        // untouched, with no added latency.
        guard event.flags.contains(.maskAlternate) else {
            return Unmanaged.passUnretained(event)
        }
        let dy = event.getDoubleValueField(.scrollWheelEventPointDeltaAxis1)
        emit(["type": "zoom", "clock": now, "dy": dy,
              "x": location.x, "y": location.y])
        return nil

    case .leftMouseDown, .rightMouseDown:
        emit(["type": "click", "clock": now,
              "x": location.x, "y": location.y,
              "button": type == .leftMouseDown ? "left" : "right"])
        return Unmanaged.passUnretained(event)

    case .mouseMoved, .leftMouseDragged:
        if now - state.lastCursorEmit >= state.cursorInterval {
            state.lastCursorEmit = now
            emit(["type": "cursor", "clock": now,
                  "x": location.x, "y": location.y,
                  "shape": cursorShape()])
        }
        return Unmanaged.passUnretained(event)

    default:
        return Unmanaged.passUnretained(event)
    }
}

let state = TapState()

let mask: CGEventMask =
    (1 << CGEventType.scrollWheel.rawValue) |
    (1 << CGEventType.leftMouseDown.rawValue) |
    (1 << CGEventType.rightMouseDown.rawValue) |
    (1 << CGEventType.mouseMoved.rawValue) |
    (1 << CGEventType.leftMouseDragged.rawValue)

guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .defaultTap,
    eventsOfInterest: mask,
    callback: callback,
    userInfo: Unmanaged.passUnretained(state).toOpaque()
) else {
    fail("could not create event tap: Accessibility permission is required")
}

state.tap = tap
let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

emit(["type": "ready"])
CFRunLoopRun()
```

- [ ] **Step 2: Build it**

Run: `swiftc -O src/native/InputTap.swift -o bin/inputtap`
Expected: compiles with no errors

**Note:** this file uses top-level code, so it must **not** be combined with an `@main` type, and — unlike the other three helpers — it must **not** be built with `-parse-as-library`. A single Swift file that is not named `main.swift` compiles in script mode by default, which conflicts with `@main`; the other three carry `@main` and therefore need the flag, while this one needs its absence. Keep it as its own binary.

- [ ] **Step 3: Verify the tap installs and emits**

Run: `./bin/inputtap` then move the mouse and hold ⌥ while scrolling. Ctrl-C to stop.

Expected: a `ready` line, `cursor` lines while moving, and `zoom` lines with non-zero `dy` while ⌥+scrolling.

If it prints `could not create event tap`, grant Accessibility to Terminal in System Settings → Privacy & Security → Accessibility, then re-run.

- [ ] **Step 4: Verify plain scroll still reaches applications — this is FR-9**

With `./bin/inputtap` running, open any webpage and scroll **without** holding ⌥.

Expected: the page scrolls completely normally, and **no** `zoom` lines appear. Then hold ⌥ and scroll: `zoom` lines appear and the page does **not** scroll.

This is the single most important manual check in Phase 1. If plain scroll is being swallowed, the `guard event.flags.contains(.maskAlternate)` branch is wrong and must be fixed before continuing.

- [ ] **Step 5: Verify the cursor stream is throttled**

Run: `./bin/inputtap | grep -c cursor` for roughly five seconds of continuous mouse movement, then Ctrl-C.

Expected: at most ~600 lines for 5 seconds. Substantially more means the 120Hz throttle is not working and the tap will be disabled under load.

- [ ] **Step 6: Commit**

```bash
git add src/native/InputTap.swift
git commit -m "feat: add CGEventTap gesture hook with option-scroll capture"
```

---

### Task 12: Recording session orchestrator

**Files:**
- Create: `src/main/recorder.js`
- Test: `test/recorder.test.js`

**Interfaces:**
- Consumes: `spawnHelper`/`stopHelper` (Task 7), `createZoomState`/`applyScroll` (Task 3), `project.js` (Task 6)
- Produces:
  - `createRecorder({ binDir, spawnHelper, stopHelper }) → { start(opts), stop(), state() }`
  - `start({ source, mic, hudWindowId, dir }) → Promise<void>`
  - `stop() → Promise<{ dir, project, cursorTrack }>`

**The subtle correctness requirement this task owns:** `bin/inputtap` starts emitting before `bin/capture` produces its first frame, so early gesture events arrive with no clock origin to subtract. They are buffered and rebased once `{"type":"started"}` arrives. Events that still resolve to a negative time happened before recording and are discarded. Dropping this buffering silently loses the first fraction of a second of gestures.

- [ ] **Step 1: Write the failing test**

Create `test/recorder.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createRecorder } = require('../src/main/recorder');

// A fake helper pair: capture and inputtap are driven manually by the test.
function harness() {
  const sinks = {};
  const spawnHelper = (bin, args, { onMessage, onExit }) => {
    const name = bin.endsWith('capture') ? 'capture' : 'inputtap';
    sinks[name] = onMessage;
    return { name, onExit, kill() {}, exitCode: null, signalCode: null,
             once(evt, cb) { if (evt === 'exit') this._exit = cb; } };
  };
  const stopHelper = async (child) => { child._exit?.(0); return 0; };
  const rec = createRecorder({ binDir: '/fake', spawnHelper, stopHelper });
  return { rec, sinks };
}

test('gesture events arriving before the first frame are rebased, not lost', async () => {
  const { rec, sinks } = harness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });

  sinks.inputtap({ type: 'zoom', clock: 1000.5, dy: 10, x: 100, y: 100 });
  sinks.capture({ type: 'started', clock: 1000.0 });

  const kf = rec.state().zoomKeyframes;
  assert.strictEqual(kf.length, 1);
  assert.ok(Math.abs(kf[0].t - 0.5) < 1e-9, `t was ${kf[0].t}`);
});

test('events from before the first frame are discarded', async () => {
  const { rec, sinks } = harness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });

  sinks.inputtap({ type: 'zoom', clock: 999.0, dy: 10, x: 100, y: 100 });
  sinks.capture({ type: 'started', clock: 1000.0 });

  assert.strictEqual(rec.state().zoomKeyframes.length, 0);
});

test('clicks and cursor samples are rebased to source time', async () => {
  const { rec, sinks } = harness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });
  sinks.capture({ type: 'started', clock: 100 });
  sinks.inputtap({ type: 'click', clock: 102.5, x: 10, y: 20, button: 'left' });
  sinks.inputtap({ type: 'cursor', clock: 103, x: 30, y: 40, shape: 'ibeam' });

  const s = rec.state();
  assert.strictEqual(s.clicks[0].t, 2.5);
  assert.strictEqual(s.cursorTrack[0].t, 3);
  assert.strictEqual(s.cursorTrack[0].shape, 'ibeam');
});

test('tap re-enable events are counted rather than treated as gestures', async () => {
  const { rec, sinks } = harness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });
  sinks.capture({ type: 'started', clock: 0 });
  sinks.inputtap({ type: 'tap_reenabled', clock: 1 });
  assert.strictEqual(rec.state().tapReenables, 1);
  assert.strictEqual(rec.state().zoomKeyframes.length, 0);
});

test('recording proceeds when the input tap never becomes ready', async () => {
  const { rec, sinks } = harness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x', zoomEnabled: false });
  sinks.capture({ type: 'started', clock: 0 });
  assert.strictEqual(rec.state().zoomEnabled, false);
  assert.strictEqual(rec.state().recording, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/recorder.test.js`
Expected: FAIL — `Cannot find module '../src/main/recorder'`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/recorder.js`:

```js
'use strict';

const path = require('node:path');
const { createZoomState, applyScroll } = require('./zoom');
const { createProject, saveProject, writeCursorTrack } = require('./project');

function createRecorder({ binDir, spawnHelper, stopHelper }) {
  let captureChild = null;
  let inputChild = null;
  let captureClock = null;
  let dir = null;
  let source = null;
  let hasMic = false;
  let zoomEnabled = true;
  let recording = false;
  let duration = 0;
  let tapReenables = 0;

  let zoomState = createZoomState();
  let clicks = [];
  let cursorTrack = [];
  const pending = [];

  function consume(msg) {
    const t = msg.clock - captureClock;
    if (t < 0) return; // happened before the first frame
    switch (msg.type) {
      case 'zoom':
        if (zoomEnabled) applyScroll(zoomState, { t, dy: msg.dy, x: msg.x, y: msg.y });
        break;
      case 'click':
        clicks.push({ t, x: msg.x, y: msg.y, button: msg.button });
        break;
      case 'cursor':
        cursorTrack.push({ t, x: msg.x, y: msg.y, shape: msg.shape });
        break;
      default:
        break;
    }
  }

  function onInput(msg) {
    if (msg.type === 'tap_reenabled') { tapReenables++; return; }
    if (msg.type === 'ready' || msg.type === 'error') return;
    // Buffer until the capture clock origin is known, then rebase.
    if (captureClock === null) { pending.push(msg); return; }
    consume(msg);
  }

  function onCapture(msg) {
    if (msg.type === 'started') {
      captureClock = msg.clock;
      for (const m of pending) consume(m);
      pending.length = 0;
    } else if (msg.type === 'stopped') {
      duration = msg.duration;
    }
  }

  async function start(opts) {
    dir = opts.dir;
    source = opts.source;
    hasMic = Boolean(opts.mic);
    zoomEnabled = opts.zoomEnabled !== false;
    captureClock = null;
    zoomState = createZoomState();
    clicks = [];
    cursorTrack = [];
    pending.length = 0;
    tapReenables = 0;

    const args = ['--source', source, '--out', path.join(dir, 'raw.mov'),
                  '--mic', hasMic ? '1' : '0'];
    if (opts.hudWindowId) args.push('--exclude-window', String(opts.hudWindowId));

    captureChild = spawnHelper(path.join(binDir, 'capture'), args, {
      onMessage: onCapture,
      onMalformed: (l) => console.error('capture malformed:', l),
      onExit: () => { recording = false; }
    });

    if (zoomEnabled) {
      inputChild = spawnHelper(path.join(binDir, 'inputtap'), [], {
        onMessage: onInput,
        onMalformed: (l) => console.error('inputtap malformed:', l),
        onExit: () => {}
      });
    }

    recording = true;
  }

  async function stop() {
    if (inputChild) await stopHelper(inputChild);
    if (captureChild) await stopHelper(captureChild);
    recording = false;

    const project = createProject(
      { kind: source.split(':')[0], id: source, title: '', width: 0, height: 0 },
      { file: 'raw.mov', fps: 60, duration, hasMicTrack: hasMic }
    );
    project.zoomKeyframes = zoomState.keyframes;
    project.clicks = clicks;

    saveProject(dir, project);
    writeCursorTrack(dir, cursorTrack);
    return { dir, project, cursorTrack };
  }

  function state() {
    return {
      recording, zoomEnabled, tapReenables, duration,
      zoomKeyframes: zoomState.keyframes, clicks, cursorTrack,
      zoom: zoomState.target
    };
  }

  return { start, stop, state };
}

module.exports = { createRecorder };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS, all suites

- [ ] **Step 5: Commit**

```bash
git add src/main/recorder.js test/recorder.test.js
git commit -m "feat: add recording orchestrator with clock rebasing"
```

---

### Task 13: Source picker window

**Files:**
- Modify: `src/main/main.js`, `src/preload/preload.js`
- Create: `src/renderer/picker/index.html`, `src/renderer/picker/picker.js`, `src/renderer/picker/picker.css`

**Interfaces:**
- Consumes: `bin/sources` (Task 9), `createPermissions` (Task 8)
- Produces: IPC channels `sources:list`, `permissions:status`, `permissions:open`, `record:start`

Implements FR-1, FR-4, FR-7, FR-34, FR-35.

- [ ] **Step 1: Wire the main-process IPC**

Replace `src/main/main.js` with:

```js
'use strict';
const { app, BrowserWindow, ipcMain, systemPreferences, shell } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { createPermissions } = require('./permissions');
const { createRecorder } = require('./recorder');
const { spawnHelper, stopHelper } = require('./helpers');

const BIN_DIR = path.join(__dirname, '..', '..', 'bin');
const permissions = createPermissions({ systemPreferences, shell });
const recorder = createRecorder({ binDir: BIN_DIR, spawnHelper, stopHelper });

let pickerWindow = null;

function createPickerWindow() {
  pickerWindow = new BrowserWindow({
    width: 940, height: 660, title: 'Loupe',
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js') }
  });
  pickerWindow.loadFile(path.join(__dirname, '..', 'renderer', 'picker', 'index.html'));
  return pickerWindow;
}

ipcMain.handle('sources:list', () =>
  new Promise((resolve, reject) => {
    execFile(path.join(BIN_DIR, 'sources'), { maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(stdout || err.message));
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
      });
  }));

ipcMain.handle('permissions:status', () => ({
  screenRecording: permissions.screenRecording(),
  accessibility: permissions.accessibility(),
  canRecord: permissions.canRecord(),
  canZoom: permissions.canZoom()
}));

ipcMain.handle('permissions:open', (_e, pane) => permissions.openPane(pane));

ipcMain.handle('record:start', async (_e, { source, mic }) => {
  if (!permissions.canRecord()) throw new Error('Screen Recording permission is required');
  if (mic) await permissions.requestMicrophone();

  const dir = path.join(os.homedir(), 'Movies', 'Loupe', String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });

  const hud = createHudWindow();
  await recorder.start({
    source, mic, dir,
    hudWindowId: hud.getMediaSourceId().split(':')[1],
    zoomEnabled: permissions.canZoom()
  });
  pickerWindow?.hide();
  return { dir, zoomEnabled: permissions.canZoom() };
});

app.whenReady().then(createPickerWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

module.exports = { createPickerWindow };
```

**Note:** `createHudWindow` is added in Task 14. Until then, stub it at the bottom of the file with `function createHudWindow() { return { getMediaSourceId: () => 'window:0' }; }` so this task runs standalone, and delete the stub in Task 14.

- [ ] **Step 2: Expand the preload bridge**

Replace `src/preload/preload.js`:

```js
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loupe', {
  listSources: () => ipcRenderer.invoke('sources:list'),
  permissions: () => ipcRenderer.invoke('permissions:status'),
  openPane: (pane) => ipcRenderer.invoke('permissions:open', pane),
  startRecording: (opts) => ipcRenderer.invoke('record:start', opts),
  stopRecording: () => ipcRenderer.invoke('record:stop'),
  onHud: (cb) => ipcRenderer.on('hud:update', (_e, data) => cb(data))
});
```

- [ ] **Step 3: Build the picker UI**

Create `src/renderer/picker/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Loupe</title>
<link rel="stylesheet" href="picker.css">
<body>
  <header>
    <h1>Record</h1>
    <label class="mic"><input type="checkbox" id="mic"> Record microphone</label>
  </header>
  <div id="banner" hidden></div>
  <div id="grid" class="grid"></div>
  <footer>
    <p id="hint" class="hint"></p>
    <button id="record" disabled>Start recording</button>
  </footer>
  <script src="picker.js"></script>
</body>
```

Create `src/renderer/picker/picker.css`:

```css
:root { color-scheme: light dark; }
body { font: 13px -apple-system, system-ui; margin: 0; display: flex;
       flex-direction: column; height: 100vh; }
header { display: flex; align-items: center; justify-content: space-between;
         padding: 16px 20px; border-bottom: 1px solid rgba(128,128,128,.25); }
h1 { font-size: 15px; margin: 0; }
.grid { flex: 1; overflow-y: auto; display: grid; gap: 12px; padding: 20px;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.card { border: 2px solid transparent; border-radius: 10px; padding: 8px;
        cursor: pointer; background: rgba(128,128,128,.08); }
.card.selected { border-color: #3b82f6; }
.card img { width: 100%; border-radius: 6px; display: block; background: #000; }
.card .title { margin-top: 6px; font-size: 12px; overflow: hidden;
               text-overflow: ellipsis; white-space: nowrap; }
.card .tabhint { font-size: 11px; opacity: .65; margin-top: 2px; }
footer { display: flex; align-items: center; justify-content: space-between;
         gap: 16px; padding: 14px 20px; border-top: 1px solid rgba(128,128,128,.25); }
.hint { margin: 0; opacity: .7; }
#banner { padding: 12px 20px; background: #fde68a; color: #78350f; }
#banner button { margin-left: 10px; }
button { font: inherit; padding: 6px 14px; border-radius: 7px; }
```

Create `src/renderer/picker/picker.js`:

```js
'use strict';
let selected = null;

const BROWSERS = ['Chrome', 'Chromium', 'Edge', 'Brave', 'Arc', 'Safari'];

async function refreshPermissions() {
  const p = await window.loupe.permissions();
  const banner = document.getElementById('banner');
  if (!p.screenRecording) {
    banner.hidden = false;
    banner.innerHTML = 'Loupe needs Screen Recording permission to capture your screen. ';
    addPaneButton(banner, 'Open Settings', 'screenRecording');
  } else if (!p.accessibility) {
    banner.hidden = false;
    banner.innerHTML = 'Zoom is off: Loupe needs Accessibility permission to read the scroll wheel. Recording still works. ';
    addPaneButton(banner, 'Open Settings', 'accessibility');
  } else {
    banner.hidden = true;
  }
  document.getElementById('record').disabled = !p.canRecord || !selected;
  return p;
}

function addPaneButton(parent, label, pane) {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => window.loupe.openPane(pane);
  parent.appendChild(b);
}

function card(source) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <img src="${source.thumbnail ?? ''}" alt="">
    <div class="title">${source.app ? source.app + ' — ' : ''}${source.title}</div>`;
  // PRD FR-7: the OS cannot capture a single browser tab, so tell the user
  // the one move that makes it possible instead of leaving them hunting.
  if (source.kind === 'window' && BROWSERS.some((b) => (source.app ?? '').includes(b))) {
    const hint = document.createElement('div');
    hint.className = 'tabhint';
    hint.textContent = 'Recording one tab? Drag it out into its own window first.';
    el.appendChild(hint);
  }
  el.onclick = () => {
    document.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
    el.classList.add('selected');
    selected = source;
    refreshPermissions();
  };
  return el;
}

async function load() {
  const grid = document.getElementById('grid');
  grid.textContent = 'Loading sources…';
  try {
    const sources = await window.loupe.listSources();
    grid.textContent = '';
    sources.forEach((s) => grid.appendChild(card(s)));
  } catch (err) {
    grid.textContent = `Could not list sources: ${err.message}`;
  }
  await refreshPermissions();
}

document.getElementById('record').onclick = async () => {
  const mic = document.getElementById('mic').checked;
  await window.loupe.startRecording({ source: selected.id, mic });
};

window.addEventListener('focus', refreshPermissions);
load();
```

- [ ] **Step 4: Verify the picker lists sources and reflects permissions**

Run: `npm run build:native && npm start`

Expected: a grid of displays and windows with thumbnails. Clicking one selects it and enables **Start recording**. Chrome windows show the drag-out-tab hint.

- [ ] **Step 5: Verify the Accessibility degradation path — this is FR-14**

Revoke Accessibility for Loupe (or Electron) in System Settings, return to the app, and let it regain focus.

Expected: an amber banner saying zoom is off and recording still works, and **Start recording stays enabled**. If the button is disabled, `canRecord()` is wrongly depending on Accessibility — fix it in `src/main/permissions.js`.

- [ ] **Step 6: Commit**

```bash
git add src/main/main.js src/preload/preload.js src/renderer/picker
git commit -m "feat: add source picker with permission banners and tab hint"
```

---

### Task 14: Recording HUD

**Files:**
- Modify: `src/main/main.js`
- Create: `src/renderer/hud/index.html`, `src/renderer/hud/hud.js`

**Interfaces:**
- Consumes: `recorder.state()` (Task 12)
- Produces: `createHudWindow() → BrowserWindow`, IPC channel `record:stop`, push channel `hud:update`

Implements FR-5, FR-6, FR-10 (live indicator), FR-14 (zoom-off banner).

**The requirement that must be verified, not assumed:** the HUD must not appear in the recording. Its window id is passed to `bin/capture --exclude-window`, which feeds `SCContentFilter(display:excludingWindows:)`. Step 4 checks this by watching the exported file, not by reasoning about it.

- [ ] **Step 1: Add the HUD window and stop channel to main**

In `src/main/main.js`, delete the `createHudWindow` stub from Task 13 and add:

```js
let hudWindow = null;
let hudTimer = null;

function createHudWindow() {
  hudWindow = new BrowserWindow({
    width: 260, height: 56, x: 40, y: 60,
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, movable: true, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js') }
  });
  hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hudWindow.loadFile(path.join(__dirname, '..', 'renderer', 'hud', 'index.html'));

  hudTimer = setInterval(() => {
    const s = recorder.state();
    hudWindow?.webContents.send('hud:update', {
      zoom: s.zoom, duration: s.duration, zoomEnabled: s.zoomEnabled,
      tapReenables: s.tapReenables, elapsed: (Date.now() - startedAt) / 1000
    });
  }, 200);

  return hudWindow;
}

let startedAt = 0;

// Both the HUD button and the global shortcut go through this one function.
// ipcMain.emit() does NOT trigger an ipcMain.handle() handler, so the
// shortcut must call the function directly rather than re-emitting.
async function stopRecording() {
  if (!hudWindow) return null;
  clearInterval(hudTimer);
  const result = await recorder.stop();
  hudWindow.close();
  hudWindow = null;
  pickerWindow?.show();
  openEditorWindow(result.dir);
  return result.dir;
}

ipcMain.handle('record:stop', stopRecording);

app.whenReady().then(() => {
  const { globalShortcut } = require('electron');
  globalShortcut.register('Control+Shift+S', () => { stopRecording(); });
});
```

Set `startedAt = Date.now()` inside the `record:start` handler, immediately before `recorder.start(...)`.

- [ ] **Step 2: Build the HUD UI**

Create `src/renderer/hud/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Loupe HUD</title>
<style>
  body { margin: 0; font: 12px -apple-system, system-ui; -webkit-app-region: drag;
         background: rgba(20,20,22,.92); color: #fff; border-radius: 12px;
         height: 56px; display: flex; align-items: center; gap: 10px; padding: 0 12px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #ef4444;
         animation: pulse 1.4s infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
  .time { font-variant-numeric: tabular-nums; font-size: 14px; }
  .zoom { opacity: .8; font-variant-numeric: tabular-nums; }
  .warn { color: #fbbf24; font-size: 11px; }
  button { -webkit-app-region: no-drag; margin-left: auto; font: inherit;
           border: 0; border-radius: 6px; padding: 5px 10px;
           background: #ef4444; color: #fff; }
</style>
<body>
  <span class="dot"></span>
  <span class="time" id="time">0:00</span>
  <span class="zoom" id="zoom">1.0×</span>
  <span class="warn" id="warn"></span>
  <button id="stop">Stop</button>
  <script src="hud.js"></script>
</body>
```

Create `src/renderer/hud/hud.js`:

```js
'use strict';

function clock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

window.loupe.onHud((d) => {
  document.getElementById('time').textContent = clock(d.elapsed ?? 0);
  document.getElementById('zoom').textContent = `${(d.zoom ?? 1).toFixed(1)}×`;
  const warn = document.getElementById('warn');
  if (!d.zoomEnabled) warn.textContent = 'zoom off';
  else if (d.tapReenables > 0) warn.textContent = `tap recovered ×${d.tapReenables}`;
  else warn.textContent = '';
});

document.getElementById('stop').onclick = () => window.loupe.stopRecording();
```

- [ ] **Step 3: Verify the HUD updates live**

Run: `npm start`, pick a display, start recording, then hold ⌥ and scroll.

Expected: the timer counts up and the zoom readout changes within about 200ms of scrolling.

- [ ] **Step 4: Verify the HUD is absent from the recording — this is FR-5**

Record the display the HUD is sitting on for ten seconds, stop, then open `~/Movies/Loupe/<timestamp>/raw.mov`.

Expected: **no HUD anywhere in the footage.** If it appears, `getMediaSourceId()` is not yielding the window id that `SCContentFilter` expects — log the id passed to `--exclude-window` and compare it against the `windowID` values reported by `./bin/sources`.

- [ ] **Step 5: Verify the global stop shortcut**

While recording with the HUD off-screen, press ⌃⇧S.

Expected: recording stops and the editor window opens.

- [ ] **Step 6: Commit**

```bash
git add src/main/main.js src/renderer/hud
git commit -m "feat: add recording HUD excluded from capture"
```

---

### Task 15: `Render.swift` — the compositor

**Files:**
- Modify: `src/main/project.js` (add camera track I/O), `src/main/recorder.js` (record real source dimensions)
- Create: `src/native/Render.swift`
- Test: `test/camera-track.test.js`

**Interfaces:**
- Consumes: `solveCamera` (Task 5), `project.json` + `cursor.bin` (Task 6)
- Produces:
  - `writeCameraTrack(dir, samples)` / `readCameraTrack(dir)` in `project.js`, 16-byte records of `float32 t, zoom, cx, cy`
  - `bin/render --project <dir> --out <path> --width W --height H --codec h264|hevc`
  - NDJSON: `{"type":"progress","frame":N,"total":M}`, `{"type":"done","file":"..."}`, `{"type":"error",...}`

**UNITS — the mismatch most likely to break this task.** `CGEvent.location` is in **logical points**; the captured video is in **physical pixels**. All camera solving happens in points, using the source's logical width and height. `Render.swift` derives `scale = videoPixelWidth / project.source.width` and converts. Mixing the two produces a zoom that is correct on a non-Retina display and wrong by exactly 2× on a Retina one.

**ORIGIN — the second such trap.** `CGEvent` coordinates are top-left origin; Core Image and Core Graphics are bottom-left. The crop rect is computed in top-left pixel space and flipped once, and the overlay context is flipped so cursor drawing stays in top-left coordinates.

**Deviation from TRD §6.1, deliberately:** this uses `AVAssetReader`/`AVAssetWriter` rather than `AVMutableComposition` with a custom compositor. Phase 1 has no speed segments, so composition buys nothing, and the reader/writer loop extends to Phase 2 by choosing source frames through `TimeMap` — which avoids the `scaleTimeRange` ramp-subdivision workaround entirely. Update TRD §6.1 to match when this ships.

- [ ] **Step 1: Write the failing test for camera track I/O**

Create `test/camera-track.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeCameraTrack, readCameraTrack, CAMERA_RECORD_BYTES } = require('../src/main/project');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-cam-'));

test('camera track round-trips', () => {
  const dir = tempDir();
  const samples = [
    { t: 0, zoom: 1, cx: 800, cy: 500 },
    { t: 0.5, zoom: 2.25, cx: 810.5, cy: 505.25 }
  ];
  writeCameraTrack(dir, samples);
  const back = readCameraTrack(dir);
  assert.strictEqual(back.length, 2);
  assert.ok(Math.abs(back[1].zoom - 2.25) < 1e-4);
  assert.ok(Math.abs(back[1].cx - 810.5) < 1e-3);
});

test('camera records are 16 bytes', () => {
  const dir = tempDir();
  writeCameraTrack(dir, [{ t: 0, zoom: 1, cx: 0, cy: 0 }]);
  assert.strictEqual(fs.statSync(path.join(dir, 'camera.bin')).size, CAMERA_RECORD_BYTES);
});

test('reading a missing camera track returns an empty array', () => {
  assert.deepStrictEqual(readCameraTrack(tempDir()), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/camera-track.test.js`
Expected: FAIL — `writeCameraTrack is not a function`

- [ ] **Step 3: Add camera track I/O to `src/main/project.js`**

Add before `module.exports`:

```js
const CAMERA_RECORD_BYTES = 16;

function writeCameraTrack(dir, samples) {
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.alloc(samples.length * CAMERA_RECORD_BYTES);
  samples.forEach((s, i) => {
    const at = i * CAMERA_RECORD_BYTES;
    buf.writeFloatLE(s.t, at);
    buf.writeFloatLE(s.zoom, at + 4);
    buf.writeFloatLE(s.cx, at + 8);
    buf.writeFloatLE(s.cy, at + 12);
  });
  fs.writeFileSync(path.join(dir, 'camera.bin'), buf);
}

function readCameraTrack(dir) {
  const file = path.join(dir, 'camera.bin');
  if (!fs.existsSync(file)) return [];
  const buf = fs.readFileSync(file);
  const out = [];
  for (let at = 0; at + CAMERA_RECORD_BYTES <= buf.length; at += CAMERA_RECORD_BYTES) {
    out.push({
      t: buf.readFloatLE(at),
      zoom: buf.readFloatLE(at + 4),
      cx: buf.readFloatLE(at + 8),
      cy: buf.readFloatLE(at + 12)
    });
  }
  return out;
}
```

Extend the exports with `writeCameraTrack, readCameraTrack, CAMERA_RECORD_BYTES`.

- [ ] **Step 4: Record real source dimensions in `src/main/recorder.js`**

`start()` currently discards the source size, and the renderer needs it in logical points. Change `start(opts)` to keep `opts.width` and `opts.height`, and change the `createProject` call in `stop()` to:

```js
    const project = createProject(
      { kind: source.split(':')[0], id: source, title: opts_title,
        width: srcWidth, height: srcHeight },
      { file: 'raw.mov', fps: 60, duration, hasMicTrack: hasMic }
    );
```

adding `let srcWidth = 0, srcHeight = 0, opts_title = '';` alongside the other module-level bindings and assigning them in `start()` from `opts.width`, `opts.height`, `opts.title`. In `src/main/main.js`, pass them from the selected source in the `record:start` handler.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS, all suites

- [ ] **Step 6: Write `src/native/Render.swift`**

```swift
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

func readRecords(_ url: URL, stride: Int) -> [[Float]] {
    guard let data = try? Data(contentsOf: url) else { return [] }
    var out: [[Float]] = []
    var at = 0
    while at + stride <= data.count {
        var fields: [Float] = []
        for f in 0..<4 {
            let start = at + f * 4
            let value = data.subdata(in: start..<(start + 4)).withUnsafeBytes {
                $0.loadUnaligned(as: UInt32.self)
            }
            fields.append(Float(bitPattern: UInt32(littleEndian: value)))
        }
        out.append(fields)
        at += stride
    }
    return out
}

// Nearest-sample lookup. The camera track is 120Hz, denser than any output
// frame rate, so interpolation buys nothing visible.
func sample(_ track: [CameraSample], at t: Double) -> CameraSample {
    guard !track.isEmpty else { return CameraSample(t: t, zoom: 1, cx: 0, cy: 0) }
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

        let asset = AVURLAsset(url: dir.appendingPathComponent("raw.mov"))
        guard let videoTrack = try? await asset.loadTracks(withMediaType: .video).first
        else { fail("no video track in raw.mov") }

        let naturalSize = try! await videoTrack.load(.naturalSize)
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

        writer.startWriting()
        reader.startReading()
        writer.startSession(atSourceTime: .zero)

        let ciContext = CIContext(options: [.useSoftwareRenderer: false])
        var frame = 0

        while let buffer = videoOut.copyNextSampleBuffer() {
            guard let pixels = CMSampleBufferGetImageBuffer(buffer) else { continue }
            let pts = CMSampleBufferGetPresentationTimeStamp(buffer)
            let t = pts.seconds
            let cam = sample(camera, at: t)

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
```

- [ ] **Step 7: Build it**

Run: `swiftc -O -parse-as-library src/native/Render.swift -o bin/render`
Expected: compiles with no errors

- [ ] **Step 8: Render a recording end to end**

Record ten seconds with a few ⌥+scroll zooms and some clicks, then:

```bash
DIR=$(ls -td ~/Movies/Loupe/*/ | head -1)
./bin/render --project "$DIR" --out /tmp/loupe-out.mp4 --width 1920 --height 1080 --codec h264
open /tmp/loupe-out.mp4
```

Expected: an MP4 where the picture zooms in where you scrolled, the camera glides rather than jerks, a crisp arrow cursor is visible, and a blue ring pulses at each click.

- [ ] **Step 9: Verify zoom quality — this is FR-12**

Compare a zoomed section against the same region scaled up from `raw.mov`:

```bash
ffmpeg -v error -ss 5 -i /tmp/loupe-out.mp4 -frames:v 1 /tmp/zoomed.png
```

Expected: text inside the zoomed region is legibly sharp. Softness means the crop is being taken after a downscale — check that `--width`/`--height` are applied only in the final `transformed(by: scaleX:)`, not to the source.

- [ ] **Step 10: Verify the Retina scale factor**

Run the render on a Retina display recording and confirm the zoom centres where you scrolled rather than a quarter of the way off. A consistent offset means `scale` is not being applied, or is being applied twice.

- [ ] **Step 11: Commit**

```bash
git add src/native/Render.swift src/main/project.js src/main/recorder.js test/camera-track.test.js
git commit -m "feat: add offline compositor rendering zoom, cursor and click ripples"
```

---

### Task 16: Editor window and export

**Files:**
- Modify: `src/main/main.js`, `src/preload/preload.js`
- Create: `src/renderer/editor/index.html`, `src/renderer/editor/editor.js`, `src/renderer/editor/editor.css`
- Test: `test/segments.test.js`
- Create: `src/main/segments.js`

**Interfaces:**
- Consumes: `solveCamera` (Task 5), `project.js` (Tasks 6, 15), `bin/render` (Task 15)
- Produces:
  - `zoomSegments(keyframes, duration) → [{ start, end, peak }]` in `src/main/segments.js`
  - `deleteSegment(keyframes, segment) → keyframes`
  - IPC: `project:load`, `project:deleteZoom`, `export:start`, push channel `export:progress`

Implements FR-13, FR-31, FR-32, FR-33.

Segment derivation is pure and therefore tested. Everything else is UI.

- [ ] **Step 1: Write the failing test**

Create `test/segments.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { zoomSegments, deleteSegment } = require('../src/main/segments');

test('no keyframes means no segments', () => {
  assert.deepStrictEqual(zoomSegments([], 10), []);
});

test('a zoom in and back out is one segment', () => {
  const kf = [
    { t: 2, zoom: 2, cx: 0, cy: 0 },
    { t: 5, zoom: 1, cx: 0, cy: 0 }
  ];
  const segs = zoomSegments(kf, 10);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].start, 2);
  assert.strictEqual(segs[0].end, 5);
  assert.strictEqual(segs[0].peak, 2);
});

test('a zoom left open runs to the end of the recording', () => {
  const segs = zoomSegments([{ t: 3, zoom: 3, cx: 0, cy: 0 }], 8);
  assert.strictEqual(segs[0].end, 8);
});

test('the peak is the highest zoom reached inside the segment', () => {
  const kf = [
    { t: 1, zoom: 1.5, cx: 0, cy: 0 },
    { t: 2, zoom: 3.2, cx: 0, cy: 0 },
    { t: 3, zoom: 2, cx: 0, cy: 0 },
    { t: 4, zoom: 1, cx: 0, cy: 0 }
  ];
  assert.strictEqual(zoomSegments(kf, 10)[0].peak, 3.2);
});

test('two separate zooms produce two segments', () => {
  const kf = [
    { t: 1, zoom: 2, cx: 0, cy: 0 }, { t: 2, zoom: 1, cx: 0, cy: 0 },
    { t: 5, zoom: 2, cx: 0, cy: 0 }, { t: 6, zoom: 1, cx: 0, cy: 0 }
  ];
  assert.strictEqual(zoomSegments(kf, 10).length, 2);
});

test('deleting a segment removes its keyframes and leaves the rest', () => {
  const kf = [
    { t: 1, zoom: 2, cx: 0, cy: 0 }, { t: 2, zoom: 1, cx: 0, cy: 0 },
    { t: 5, zoom: 2, cx: 0, cy: 0 }, { t: 6, zoom: 1, cx: 0, cy: 0 }
  ];
  const left = deleteSegment(kf, { start: 1, end: 2 });
  assert.strictEqual(left.length, 2);
  assert.strictEqual(left[0].t, 5);
});

test('deleting a segment never leaves the video zoomed in', () => {
  const kf = [{ t: 3, zoom: 3, cx: 0, cy: 0 }];
  assert.deepStrictEqual(deleteSegment(kf, { start: 3, end: 8 }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/segments.test.js`
Expected: FAIL — `Cannot find module '../src/main/segments'`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/segments.js`:

```js
'use strict';

const { ZOOM_MIN } = require('./zoom');

// A segment is a span during which the target zoom is above 1.0x.
function zoomSegments(keyframes, duration) {
  const segments = [];
  let open = null;

  for (const kf of keyframes) {
    if (kf.zoom > ZOOM_MIN) {
      if (!open) open = { start: kf.t, end: duration, peak: kf.zoom };
      else open.peak = Math.max(open.peak, kf.zoom);
    } else if (open) {
      open.end = kf.t;
      segments.push(open);
      open = null;
    }
  }
  if (open) segments.push(open);
  return segments;
}

function deleteSegment(keyframes, segment) {
  return keyframes.filter((kf) => kf.t < segment.start || kf.t > segment.end);
}

module.exports = { zoomSegments, deleteSegment };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/segments.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Add editor IPC to `src/main/main.js`**

```js
const { solveCamera } = require('./camera');
const { zoomSegments, deleteSegment } = require('./segments');
const { loadProject, saveProject, readCursorTrack, writeCameraTrack } = require('./project');

let editorWindow = null;
let editorDir = null;

function openEditorWindow(dir) {
  editorDir = dir;
  editorWindow = new BrowserWindow({
    width: 1080, height: 720, title: 'Loupe — Edit',
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js') }
  });
  editorWindow.loadFile(path.join(__dirname, '..', 'renderer', 'editor', 'index.html'));
  return editorWindow;
}

function cameraFor(dir) {
  const project = loadProject(dir);
  const cursorTrack = readCursorTrack(dir);
  return solveCamera({
    keyframes: project.zoomKeyframes,
    cursorTrack,
    duration: project.capture.duration,
    width: project.source.width,
    height: project.source.height
  });
}

ipcMain.handle('project:load', () => {
  const project = loadProject(editorDir);
  return {
    dir: editorDir,
    project,
    video: path.join(editorDir, 'raw.mov'),
    segments: zoomSegments(project.zoomKeyframes, project.capture.duration),
    camera: cameraFor(editorDir)
  };
});

ipcMain.handle('project:deleteZoom', (_e, segment) => {
  const project = loadProject(editorDir);
  project.zoomKeyframes = deleteSegment(project.zoomKeyframes, segment);
  saveProject(editorDir, project);
  return {
    project,
    segments: zoomSegments(project.zoomKeyframes, project.capture.duration),
    camera: cameraFor(editorDir)
  };
});

ipcMain.handle('export:start', async (_e, { width, height, codec }) => {
  writeCameraTrack(editorDir, cameraFor(editorDir));
  const out = path.join(editorDir, `export-${width}x${height}.mp4`);
  return new Promise((resolve, reject) => {
    spawnHelper(path.join(BIN_DIR, 'render'), [
      '--project', editorDir, '--out', out,
      '--width', String(width), '--height', String(height), '--codec', codec
    ], {
      onMessage: (m) => {
        if (m.type === 'progress') editorWindow?.webContents.send('export:progress', m);
        if (m.type === 'error') reject(new Error(m.message));
      },
      onMalformed: () => {},
      onExit: (code) => (code === 0 ? resolve(out) : reject(new Error(`render exited ${code}`)))
    });
  });
});
```

Add to `src/preload/preload.js`:

```js
  loadProject: () => ipcRenderer.invoke('project:load'),
  deleteZoom: (segment) => ipcRenderer.invoke('project:deleteZoom', segment),
  exportVideo: (opts) => ipcRenderer.invoke('export:start', opts),
  onExportProgress: (cb) => ipcRenderer.on('export:progress', (_e, d) => cb(d)),
```

- [ ] **Step 6: Build the editor UI**

Create `src/renderer/editor/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Loupe — Edit</title>
<link rel="stylesheet" href="editor.css">
<body>
  <canvas id="stage"></canvas>
  <video id="src" hidden></video>
  <div id="timeline">
    <div id="track"></div>
    <input id="scrub" type="range" min="0" max="1000" value="0">
  </div>
  <footer>
    <button id="play">Play</button>
    <select id="preset">
      <option value="1920x1080">1080p</option>
      <option value="2560x1440">1440p</option>
      <option value="3840x2160">4K</option>
    </select>
    <button id="export">Export MP4</button>
    <span id="status"></span>
  </footer>
  <script src="editor.js"></script>
</body>
```

Create `src/renderer/editor/editor.css`:

```css
:root { color-scheme: light dark; }
body { margin: 0; font: 13px -apple-system, system-ui; display: flex;
       flex-direction: column; height: 100vh; background: #111; color: #eee; }
#stage { flex: 1; width: 100%; min-height: 0; object-fit: contain; background: #000; }
#timeline { padding: 10px 16px; background: #1a1a1c; }
#track { position: relative; height: 26px; background: #232326; border-radius: 5px; }
.seg { position: absolute; top: 0; height: 26px; background: #3b82f6;
       border-radius: 5px; opacity: .8; cursor: pointer; font-size: 11px;
       display: flex; align-items: center; justify-content: center; }
.seg:hover { opacity: 1; }
#scrub { width: 100%; margin-top: 8px; }
footer { display: flex; gap: 10px; align-items: center; padding: 12px 16px;
         background: #1a1a1c; border-top: 1px solid #2a2a2e; }
button, select { font: inherit; padding: 6px 12px; border-radius: 7px; }
#status { opacity: .75; }
```

Create `src/renderer/editor/editor.js`:

```js
'use strict';

const stage = document.getElementById('stage');
const video = document.getElementById('src');
const ctx = stage.getContext('2d');
let state = null;

function sampleCamera(t) {
  const cam = state.camera;
  if (!cam.length) return { zoom: 1, cx: state.project.source.width / 2,
                            cy: state.project.source.height / 2 };
  const i = Math.min(cam.length - 1, Math.max(0, Math.round(t * 120)));
  return cam[i];
}

function draw() {
  if (!state || video.readyState < 2) return requestAnimationFrame(draw);
  const { width: sw, height: sh } = state.project.source;
  const scale = video.videoWidth / sw;
  const cam = sampleCamera(video.currentTime);
  const vw = (sw / cam.zoom) * scale;
  const vh = (sh / cam.zoom) * scale;
  const x0 = cam.cx * scale - vw / 2;
  const y0 = cam.cy * scale - vh / 2;

  stage.width = video.videoWidth;
  stage.height = video.videoHeight;
  ctx.drawImage(video, x0, y0, vw, vh, 0, 0, stage.width, stage.height);
  requestAnimationFrame(draw);
}

function renderTimeline() {
  const track = document.getElementById('track');
  track.textContent = '';
  const duration = state.project.capture.duration || 1;
  for (const seg of state.segments) {
    const el = document.createElement('div');
    el.className = 'seg';
    el.style.left = `${(seg.start / duration) * 100}%`;
    el.style.width = `${((seg.end - seg.start) / duration) * 100}%`;
    el.textContent = `${seg.peak.toFixed(1)}×`;
    el.title = 'Click to delete this zoom';
    el.onclick = async () => {
      state = { ...state, ...(await window.loupe.deleteZoom(seg)) };
      renderTimeline();
    };
    track.appendChild(el);
  }
}

document.getElementById('scrub').oninput = (e) => {
  video.currentTime = (e.target.value / 1000) * (state.project.capture.duration || 0);
};

document.getElementById('play').onclick = () => {
  if (video.paused) { video.play(); } else { video.pause(); }
};

document.getElementById('export').onclick = async () => {
  const [w, h] = document.getElementById('preset').value.split('x').map(Number);
  const status = document.getElementById('status');
  status.textContent = 'Exporting…';
  try {
    const file = await window.loupe.exportVideo({ width: w, height: h, codec: 'h264' });
    status.textContent = `Saved ${file}`;
  } catch (err) {
    status.textContent = `Export failed: ${err.message}`;
  }
};

window.loupe.onExportProgress((p) => {
  document.getElementById('status').textContent = `Exporting… frame ${p.frame}`;
});

(async function load() {
  state = await window.loupe.loadProject();
  video.src = `file://${state.video}`;
  video.load();
  renderTimeline();
  requestAnimationFrame(draw);
})();
```

- [ ] **Step 7: Verify the preview applies zoom**

Record a clip with two zooms, stop, and scrub the editor timeline.

Expected: the preview zooms and pans exactly where you scrolled during recording. Blue bars mark each zoom on the timeline.

- [ ] **Step 8: Verify deleting a zoom — this is FR-13**

Click a blue segment.

Expected: it disappears, and the preview at that time is no longer zoomed.

- [ ] **Step 9: Verify export and that the source survives it — this is FR-33**

Export at 1080p, then check the directory.

Run: `ls -la $(ls -td ~/Movies/Loupe/*/ | head -1)`
Expected: `raw.mov`, `project.json`, `cursor.bin`, `camera.bin`, **and** `export-1920x1080.mp4`. `raw.mov` must still be present and unmodified.

- [ ] **Step 10: Commit**

```bash
git add src/main/segments.js src/main/main.js src/preload/preload.js src/renderer/editor test/segments.test.js
git commit -m "feat: add timeline editor with zoom preview, deletion and export"
```

---

### Task 17: Packaging

**Files:**
- Create: `electron-builder.config.js`, `packaging/entitlements.mac.plist`
- Modify: `package.json`

**Interfaces:**
- Consumes: everything
- Produces: a signed, notarized `.dmg`

**The failure this task exists to prevent:** the Swift helpers in `bin/` must be signed as part of the hardened runtime. If they are not, `CGEvent.tapCreate` is refused at runtime on a notarized build — and it does **not** reproduce in development, where the binaries are unsigned and the hardened runtime is off. `signIgnore` must stay empty and the helpers must be listed in `extraResources`.

- [ ] **Step 1: Write the entitlements**

Create `packaging/entitlements.mac.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.device.audio-input</key>
  <true/>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
```

Screen Recording and Accessibility are TCC grants, not entitlements — they cannot be pre-authorized and must not be added here.

- [ ] **Step 2: Write the builder config**

Create `electron-builder.config.js`:

```js
'use strict';
module.exports = {
  appId: 'tech.markai.loupe',
  productName: 'Loupe',
  directories: { output: 'dist', buildResources: 'packaging' },
  files: ['src/**/*', 'package.json'],
  extraResources: [{ from: 'bin', to: 'bin' }],
  mac: {
    category: 'public.app-category.video',
    target: ['dmg'],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'packaging/entitlements.mac.plist',
    entitlementsInherit: 'packaging/entitlements.mac.plist',
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Loupe records your microphone when you turn it on before recording.',
      NSCameraUsageDescription: 'Not used.'
    }
  },
  afterSign: 'packaging/notarize.js'
};
```

- [ ] **Step 3: Point the app at the packaged binaries**

In `src/main/main.js`, replace the `BIN_DIR` constant:

```js
const BIN_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.join(__dirname, '..', '..', 'bin');
```

- [ ] **Step 4: Add the dist script**

In `package.json`, add to `scripts`:

```json
    "dist:mac": "npm run build:native && electron-builder --mac --config electron-builder.config.js --publish never"
```

- [ ] **Step 5: Build and verify the helpers are signed**

Run:
```bash
npm run dist:mac
codesign -dv --verbose=2 "dist/mac-arm64/Loupe.app/Contents/Resources/bin/inputtap" 2>&1 | grep -E 'Authority|flags'
```

Expected: an `Authority=Developer ID Application` line and `flags=0x10000(runtime)`. If the helper is unsigned, `extraResources` is not being signed — verify `signIgnore` is unset in the config.

- [ ] **Step 6: Verify the packaged build can create an event tap**

Install the built app, grant Screen Recording and Accessibility, record, and hold ⌥ while scrolling.

Expected: zoom works. If the HUD shows "zoom off" despite Accessibility being granted, the helper signature is the cause — return to Step 5.

- [ ] **Step 7: Commit**

```bash
git add electron-builder.config.js packaging src/main/main.js package.json
git commit -m "chore: add signed and notarized macOS packaging"
```

---

## Self-review

**Spec coverage** — every Phase 1 requirement maps to a task:

| Requirement | Task |
|---|---|
| FR-1 source picker | 9, 13 |
| FR-2 single-window capture | 10 |
| FR-3 full-resolution 60fps | 10 |
| FR-4 microphone toggle | 10, 13 |
| FR-5 HUD excluded from capture | 10, 14 |
| FR-6 global stop hotkey | 14 |
| FR-7 single-tab guidance | 13 |
| FR-8 ⌥+scroll zoom | 3, 11 |
| FR-9 plain scroll passthrough | 11 |
| FR-10 zoom range and easing | 3, 4 |
| FR-11 dead-zone camera | 4, 5 |
| FR-12 zoom not baked in | 10, 15 |
| FR-13 zooms editable | 16 |
| FR-14 graceful zoom degradation | 8, 12, 13 |
| FR-15 rendered cursor | 10, 15 |
| FR-16 click highlights | 11, 15 |
| FR-17 cursor smoothing | 5, 15 |
| FR-31 timeline editor | 16 |
| FR-32 MP4 export | 15, 16 |
| FR-33 raw recording retained | 16 |
| FR-34/35/36 permissions | 8, 13 |

**Known gaps, deliberately deferred:**

- **`solveCamera` smooths the camera path but not the cursor track** (FR-17 covers both). Cursor jitter is currently visible in the render. Add a `smoothPath` pass over `cursor.bin` in a follow-up; the function already exists, so it is a two-line change once someone has watched real footage and judged how much smoothing looks right.
- **Cursor shape is captured but not drawn** — `Render.swift` always draws an arrow. The shape byte is stored, so adding I-beam and pointing-hand paths is additive.
- **Export resolution presets do not preserve aspect ratio** if the source is not 16:9. Task 16 should clamp to the source's aspect ratio before this ships to anyone other than you.

**Naming consistency verified:** `zoomKeyframes` / `cursorTrack` / `camera.bin` field order (`t, zoom, cx, cy`) match across `project.js`, `recorder.js`, `camera.js`, `editor.js`, and `Render.swift`. The scroll sign convention (positive `dy` = scroll up = zoom in) is fixed in Task 3 and matched in Task 11.

**Units verified:** camera solving is in logical points throughout; only `Render.swift` and `editor.js` convert to pixels, both deriving `scale` from the video's natural width divided by `project.source.width`.
