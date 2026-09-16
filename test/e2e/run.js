'use strict';
// End-to-end export tests (docs/EDITOR-V2.md section 10). Run with
//
//   npm run test:e2e                          the synthetic suite
//   electron test/e2e/run.js --real <folder>  export a copy of a real recording
//                                             [--resolution 1080p] [--at 3,7.5]
//
// The suite makes its own recordings with WebCodecs (lab.js): a colour-coded
// moving pattern with a still stretch, a 440 Hz tone with a silent gap, a
// cursor track, and a second recording in HEVC. It exports v2 projects built
// from them through the app's real export path (src/main/ipc/export.js and
// the hidden exporter window), decodes each export again and checks size,
// duration, frame count, which moment of which recording is on screen at
// known times, and the sound. PNG snapshots go to test/e2e/out/ to look at.

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const { createExportRunner, buildJob } = require('../../src/main/ipc/export');

const P = require('../../src/core/project.js');
const { buildTimeline } = require('../../src/core/timeline.js');
const C = require('../../src/core/compose.js');
const { parseCursorTrack, CURSOR_RECORD_BYTES } = require('../../src/core/cursor.js');

const FIXTURE = { width: 640, height: 400, fps: 30 };
const STILL = [6, 7];
const SILENCE = [3, 3.5];
const TONE = { freq: 440, amp: 0.5 };
const TONE_RMS = TONE.amp / Math.SQRT2;
// Palettes and grey coding as lab.js draws them.
let PALETTES = null;
let GREY = null;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function log(line) {
  process.stdout.write(`${line}\n`);
}

async function openLab() {
  ipcMain.handle('lab:save', (_e, name, bytes) => {
    if (typeof name !== 'string' || name.split(/[\\/]/).includes('..') || path.isAbsolute(name)) {
      throw new Error(`bad name ${name}`);
    }
    const file = path.join(OUT, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  });
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'lab-preload.js'), sandbox: true, contextIsolation: true,
      backgroundThrottling: false
    }
  });
  win.webContents.on('console-message', (e) => log(`  [lab] ${e.message}`));
  await win.loadFile(path.join(__dirname, 'lab.html'));
  for (let i = 0; i < 200; i++) {
    if (await win.webContents.executeJavaScript('window.labReady === true')) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const call = (fn, ...args) => win.webContents.executeJavaScript(
    `window.lab.${fn}(...${JSON.stringify(args)})`);
  PALETTES = await win.webContents.executeJavaScript('window.lab.PALETTES');
  GREY = await win.webContents.executeJavaScript('({ low: window.lab.GREY_LOW, span: window.lab.GREY_SPAN })');
  return { win, call };
}

// ------------------------------------------------------------- fixtures

function writeCursor(file, duration) {
  // A cursor drifting around the right-hand side of the screen, 60 samples/s.
  const n = Math.round(duration * 60);
  const buf = Buffer.alloc(n * CURSOR_RECORD_BYTES);
  for (let i = 0; i < n; i++) {
    const t = i / 60;
    buf.writeFloatLE(t, i * 16);
    buf.writeFloatLE(500 + 80 * Math.sin(t), i * 16 + 4);
    buf.writeFloatLE(200 + 150 * Math.sin(t * 0.7), i * 16 + 8);
  }
  fs.writeFileSync(file, buf);
}

async function makeFixtures(lab) {
  const a = path.join(OUT, 'fixtures', 'a');
  const b = path.join(OUT, 'fixtures', 'b');
  const ra = await lab.call('makeRecording', {
    name: 'fixtures/a/raw.mp4', ...FIXTURE, duration: 8, codec: 'avc', palette: 'a',
    still: STILL, sound: { ...TONE, silence: SILENCE }
  });
  writeCursor(path.join(a, 'cursor.bin'), 8);
  // The Mac recorder writes HEVC in a .mov; mp4box reads both the same way.
  const rb = await lab.call('makeRecording', {
    name: 'fixtures/b/raw.mov', ...FIXTURE, duration: 3, codec: 'hevc', palette: 'b'
  });
  writeCursor(path.join(b, 'cursor.bin'), 3);
  log(`# fixtures: a ${ra.frames} frames (H.264 + AAC), b ${rb.frames} frames (HEVC)`);
  return { a, b };
}

function baseProject(fx) {
  let p = P.createProject({
    main: {
      dir: fx.a, width: FIXTURE.width, height: FIXTURE.height, duration: 8, fps: FIXTURE.fps,
      video: 'raw.mp4', mic: true, cursor: 'cursor.bin'
    },
    createdAt: 0
  });
  p = P.setStyle(p, {
    padding: 0, radius: 0, shadow: 0, background: { type: 'none', value: null },
    cursor: { show: false }
  });
  return P.setAudio(p, { mic: { cleanUp: false, level: false } });
}

// ------------------------------------------------------------- checking

// The fixture frame on screen at recording time t: the newest one drawn at
// or before t, and during the still stretch only its first frame exists.
function fixtureFrameTime(source, t) {
  let f = Math.floor(t * FIXTURE.fps + 1e-6) / FIXTURE.fps;
  if (source === 'main' && f > STILL[0] && f < STILL[1]) f = STILL[0];
  return f;
}

const paletteOf = (source) => PALETTES[source === 'main' ? 'a' : 'b'];

function nearestColour(palette, rgb) {
  let best = -1;
  let dist = Infinity;
  palette.forEach((c, i) => {
    const d = Math.hypot(c[0] - rgb[0], c[1] - rgb[1], c[2] - rgb[2]);
    if (d < dist) { dist = d; best = i; }
  });
  return { index: best, dist };
}

// What a sampled pixel should be: top half -> colour of the second, bottom
// half -> grey fraction of the second.
function checkPixel(what, rgb, { source, t, half }) {
  const f = fixtureFrameTime(source, t);
  if (half === 'top') {
    const { index, dist } = nearestColour(paletteOf(source), rgb);
    assert.strictEqual(index, Math.floor(f) % 8, `${what}: colour ${rgb} is second ${index}, expected ${Math.floor(f)} of ${source} (t=${t.toFixed(3)})`);
    assert.ok(dist < 60, `${what}: colour ${rgb} is ${dist.toFixed(0)} away from the palette`);
  } else {
    const spread = Math.max(...rgb) - Math.min(...rgb);
    assert.ok(spread < 25, `${what}: ${rgb} should be grey`);
    const fraction = ((rgb[0] + rgb[1] + rgb[2]) / 3 - GREY.low) / GREY.span;
    const expected = f - Math.floor(f);
    assert.ok(Math.abs(fraction - expected) < 0.075,
      `${what}: grey says ${fraction.toFixed(3)} into the second, expected ${expected.toFixed(3)} (recording t=${t.toFixed(3)} on ${source})`);
  }
}

function frameTimes(inspection, fps, count) {
  assert.strictEqual(inspection.frames, count, `decoded ${inspection.frames} frames, expected ${count}`);
  inspection.timestamps.forEach((ts, k) => {
    assert.ok(Math.abs(ts - (k * 1e6) / fps) <= 1, `frame ${k} at ${ts}us, expected ${(k * 1e6) / fps}`);
  });
}

// Output time of frame k (sampling exactly on frames).
const frameAt = (t, fps = 60) => Math.round(t * fps) / fps;

async function exportCase(lab, runner, name, project, { resolution = '720p', codec, samples = [], snapshots = [], sound = [], onsetAfter } = {}) {
  const dir = path.join(OUT, 'cases', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2));
  const out = path.join(OUT, `${name}.mp4`);
  fs.rmSync(out, { force: true });
  const { job, project: loaded } = buildJob(dir, { resolution, codec }, { out });
  const started = Date.now();
  const result = await runner.start(job, out);
  const seconds = (Date.now() - started) / 1000;
  const tl = buildTimeline(loaded);
  const size = C.exportSize(loaded);
  const cursors = {};
  for (const [key, meta] of Object.entries(loaded.sources)) {
    cursors[key] = parseCursorTrack(fs.readFileSync(path.join(meta.dir, meta.cursor)));
  }
  // Each sample: an output time and points given as fractions of the
  // content area; resolved to pixels and to what they should show.
  const resolved = samples.map((s) => {
    const t = frameAt(s.t);
    const state = C.frameState({ project: loaded, tl, outT: t, size, assets: { cursors } });
    const points = s.points.map(([fx, fy]) => ({
      x: state.content.x + fx * state.content.w, y: state.content.y + fy * state.content.h
    }));
    return { ...s, t, state, points };
  });
  const inspection = await lab.call('inspect', pathToFileURL(out).href, {
    samples: resolved.map(({ t, points }) => ({ t, points })),
    snapshots: snapshots.map((t) => ({ t: frameAt(t), name: `${name}-${t}s.png` })),
    sound, onsetAfter
  });
  log(`  ${name}: ${result.width}x${result.height} ${result.codec}${result.hardware ? ' (hardware)' : ''}, ` +
      `${result.duration.toFixed(2)}s in ${seconds.toFixed(2)}s (${(result.duration / seconds).toFixed(1)}x)`);
  return { result, inspection, tl, size, resolved, project: loaded, out };
}

function checkSamples(c, expectations) {
  c.resolved.forEach((s, i) => {
    const got = c.inspection.colours[i];
    assert.ok(got?.colours, `no frame decoded at ${s.t}`);
    assert.ok(Math.abs(got.found - s.t * 1e6) < 1000, `sampled ${got.found}us for ${s.t}s`);
    expectations[i](got.colours, s);
  });
}

function basics(c, { width, height, duration, audio = true }) {
  const { inspection } = c;
  assert.strictEqual(inspection.width, width);
  assert.strictEqual(inspection.height, height);
  const count = Math.max(1, Math.ceil(duration * 60 - 1e-6));
  frameTimes(inspection, 60, count);
  assert.ok(Math.abs(inspection.duration - count / 60) < 0.02, `video lasts ${inspection.duration}s, expected ${count / 60}`);
  assert.strictEqual(inspection.hasAudio, audio, audio ? 'expected a sound track' : 'expected no sound track');
  if (audio) {
    assert.strictEqual(inspection.audio.sampleRate, 48000);
    assert.strictEqual(inspection.audio.channels, 2);
    // AAC comes in 1024-sample packets, so the sound may run a packet or two past.
    assert.ok(Math.abs(inspection.audio.duration - duration) < 0.1, `sound lasts ${inspection.audio.duration}s, expected ${duration}`);
  }
}

// Top and bottom sample points of the content area, as fractions.
const TOP = [0.25, 0.2];
const BOTTOM = [0.25, 0.8];

// Expect the plain picture: top/bottom of the source shown at output time.
function plainAt(tl) {
  return (colours, s) => {
    const at = tl.toSource(s.t);
    checkPixel(`top at ${s.t}`, colours[0], { source: at.source, t: at.t, half: 'top' });
    checkPixel(`bottom at ${s.t}`, colours[1], { source: at.source, t: at.t, half: 'bottom' });
  };
}

function checkTone(window, what, { rms = TONE_RMS, freq = TONE.freq } = {}) {
  assert.ok(Math.abs(window.rms - rms) < 0.05, `${what}: RMS ${window.rms.toFixed(3)}, expected ${rms.toFixed(3)}`);
  assert.ok(Math.abs(window.rmsRight - rms) < 0.05, `${what}: right RMS ${window.rmsRight.toFixed(3)}`);
  assert.ok(Math.abs(window.frequency - freq) < 4, `${what}: ${window.frequency.toFixed(1)} Hz, expected ${freq}`);
}

function checkSilence(window, what) {
  assert.ok(window.rms < 0.01, `${what}: RMS ${window.rms.toFixed(4)}, expected silence`);
}

// ------------------------------------------------------------- the cases

const CASES = [
  ['plain export: size, frames, picture at known times, a still stretch, sound', async (lab, runner, fx) => {
    const p = baseProject(fx);
    const times = [0.5, 2.25, 4.75, 6.5, 7.9];
    const c = await exportCase(lab, runner, 'plain', p, {
      samples: times.map((t) => ({ t, points: [TOP, BOTTOM] })),
      snapshots: [2.25, 6.5],
      sound: [{ from: 1, to: 2.9 }, { from: SILENCE[0] + 0.1, to: SILENCE[1] - 0.1 }, { from: 4, to: 7.5 }],
      onsetAfter: SILENCE[0] + 0.25
    });
    basics(c, { width: 1152, height: 720, duration: 8 });
    checkSamples(c, times.map(() => plainAt(c.tl)));
    // The still stretch shows its only frame, not a later moment.
    const still = c.inspection.colours[3].colours[1];
    checkPixel('still stretch', still, { source: 'main', t: 6.0, half: 'bottom' });
    const [tone, gap, later] = c.inspection.audio.windows;
    checkTone(tone, 'tone');
    checkSilence(gap, 'the silent gap');
    checkTone(later, 'tone after the gap');
    const onset = c.inspection.audio.onset;
    assert.ok(Math.abs(onset - SILENCE[1]) < 0.03, `the tone comes back at ${onset}s, expected ${SILENCE[1]}s`);
    log(`    sound comes back at ${onset.toFixed(4)}s (recorded at ${SILENCE[1]}s)`);
  }],

  ['a cut removes its stretch from picture and sound', async (lab, runner, fx) => {
    const p = P.cutRange(baseProject(fx), 2, 4);
    const times = [1.5, 2.5, 3.75, 5.5];
    const c = await exportCase(lab, runner, 'cut', p, {
      samples: times.map((t) => ({ t, points: [TOP, BOTTOM] })),
      snapshots: [2.5],
      sound: [{ from: 0.2, to: 1.9 }, { from: 2.05, to: 3.9 }]
    });
    basics(c, { width: 1152, height: 720, duration: 6 });
    assert.ok(Math.abs(c.tl.toSource(2.5).t - 4.5) < 1e-9);
    checkSamples(c, times.map(() => plainAt(c.tl)));
    // Output 2.5s is recording 4.5s: colour of second 4.
    const { index } = nearestColour(PALETTES.a, c.inspection.colours[1].colours[0]);
    assert.strictEqual(index, 4);
    c.inspection.audio.windows.forEach((w, i) => checkTone(w, `tone ${i}`));
  }],

  ['reordered clips play in their new order', async (lab, runner, fx) => {
    let p = P.splitAt(baseProject(fx), 4);
    p = P.moveClip(p, 1, 0);
    const times = [0.5, 3.5, 4.5, 7.5];
    const c = await exportCase(lab, runner, 'reorder', p, {
      samples: times.map((t) => ({ t, points: [TOP, BOTTOM] })),
      snapshots: [0.5, 4.5]
    });
    basics(c, { width: 1152, height: 720, duration: 8 });
    checkSamples(c, times.map(() => plainAt(c.tl)));
    assert.strictEqual(nearestColour(PALETTES.a, c.inspection.colours[0].colours[0]).index, 4, 'starts at recording 4.5s');
    assert.strictEqual(nearestColour(PALETTES.a, c.inspection.colours[2].colours[0]).index, 0, 'then recording 0.5s');
  }],

  ['2x speed: shorter, right frames, and the tone keeps its pitch', async (lab, runner, fx) => {
    const p = P.paintSpeed(baseProject(fx), { start: 1, end: 7, rate: 2 });
    const tl = buildTimeline(p);
    const fast = [tl.toOutput('main', 4), tl.toOutput('main', 5.8)];
    const times = [0.5, tl.toOutput('main', 2.3), tl.toOutput('main', 4.9), tl.duration - 0.5];
    const c = await exportCase(lab, runner, 'speed', p, {
      samples: times.map((t) => ({ t, points: [TOP, BOTTOM] })),
      snapshots: [2],
      sound: [{ from: fast[0], to: fast[1] }, { from: 0.1, to: 0.9 }]
    });
    basics(c, { width: 1152, height: 720, duration: tl.duration });
    assert.ok(tl.duration > 4.9 && tl.duration < 5.2, `2x over 6s of 8s: ${tl.duration}`);
    checkSamples(c, times.map(() => plainAt(c.tl)));
    checkTone(c.inspection.audio.windows[0], 'tone at 2x');
    checkTone(c.inspection.audio.windows[1], 'tone at 1x');
  }],

  ['a zoom magnifies the pinned spot', async (lab, runner, fx) => {
    // 2x on the middle of the top half: the whole view is top-half colour.
    const p = P.addZoom(baseProject(fx), { start: 2, end: 6, level: 2, follow: false, x: 320, y: 100 });
    const times = [1.25, 4.5];
    const c = await exportCase(lab, runner, 'zoom', p, {
      samples: times.map((t) => ({ t, points: [TOP, BOTTOM, [0.5, 0.5]] })),
      snapshots: [1.25, 4.5]
    });
    basics(c, { width: 1152, height: 720, duration: 8 });
    checkSamples(c, [
      plainAt(c.tl),
      (colours, s) => {
        assert.ok(Math.abs(s.state.camera.zoom - 2) < 0.01, `zoom at 4.5s is ${s.state.camera.zoom}`);
        const t = c.tl.toSource(s.t).t;
        checkPixel('zoomed bottom', colours[1], { source: 'main', t, half: 'top' });
        checkPixel('zoomed centre', colours[2], { source: 'main', t, half: 'top' });
      }
    ]);
  }],

  ['9:16 with padding and a background colour', async (lab, runner, fx) => {
    let p = baseProject(fx);
    p = P.setStyle(p, {
      aspect: '9:16', padding: 0.08, radius: 24, shadow: 0.5,
      background: { type: 'color', value: '#2050e0' }, cursor: { show: true, highlight: 'ring' }
    });
    const times = [2.5, 5.5];
    const c = await exportCase(lab, runner, 'portrait', p, {
      samples: times.map((t) => ({ t, points: [TOP, BOTTOM, [0.75, 0.2], [0.75, 0.8]] })),
      snapshots: [2.5, 5.5]
    });
    basics(c, { width: 720, height: 1280, duration: 8 });
    const bgSamples = await lab.call('inspect', pathToFileURL(c.out).href, {
      samples: [{ t: frameAt(2.5), points: [{ x: 8, y: 8 }, { x: 711, y: 1270 }, { x: 360, y: 30 }] }]
    });
    for (const rgb of bgSamples.colours[0].colours) {
      assert.ok(Math.hypot(rgb[0] - 0x20, rgb[1] - 0x50, rgb[2] - 0xe0) < 30, `background ${rgb}`);
    }
    const { content } = c.resolved[0].state;
    assert.strictEqual(content.x, Math.round(0.08 * 720));
    checkSamples(c, times.map(() => (colours, s) => {
      const at = c.tl.toSource(s.t);
      // Use whichever side of the content the cursor isn't on.
      const cur = s.state.toCanvas(...cursorPoint(c, at));
      const left = Math.abs(cur.x - s.points[0].x) > Math.abs(cur.x - s.points[2].x);
      const [top, bottom] = left ? [colours[0], colours[1]] : [colours[2], colours[3]];
      checkPixel(`portrait top at ${s.t}`, top, { source: at.source, t: at.t, half: 'top' });
      checkPixel(`portrait bottom at ${s.t}`, bottom, { source: at.source, t: at.t, half: 'bottom' });
    }));
  }],

  ['a second recording (HEVC .mov, no sound) appended after the first', async (lab, runner, fx) => {
    const p = P.appendRecording(baseProject(fx), 'src2', {
      dir: fx.b, width: FIXTURE.width, height: FIXTURE.height, duration: 3, fps: FIXTURE.fps,
      video: 'raw.mov', mic: false, cursor: 'cursor.bin'
    });
    const times = [7.5, 8.5, 10.25];
    const c = await exportCase(lab, runner, 'append', p, {
      samples: times.map((t) => ({ t, points: [TOP, BOTTOM] })),
      snapshots: [8.5],
      sound: [{ from: 4, to: 7.9 }, { from: 8.1, to: 10.9 }]
    });
    basics(c, { width: 1152, height: 720, duration: 11 });
    checkSamples(c, times.map(() => plainAt(c.tl)));
    assert.strictEqual(c.tl.toSource(frameAt(8.5)).source, 'src2');
    checkTone(c.inspection.audio.windows[0], 'first recording');
    checkSilence(c.inspection.audio.windows[1], 'second recording has no sound');
  }],

  ['no microphone means no sound track; HEVC output at 1080p', async (lab, runner, fx) => {
    let p = baseProject(fx);
    p = { ...p, sources: { ...p.sources, main: { ...p.sources.main, mic: false } } };
    p = P.cutRange(p, 2, 7);
    const c = await exportCase(lab, runner, 'silent-hevc', p, {
      resolution: '1080p', codec: 'hevc',
      samples: [{ t: 1.5, points: [TOP, BOTTOM] }, { t: 2.5, points: [TOP, BOTTOM] }]
    });
    assert.match(c.inspection.codec, /^hvc1/);
    basics(c, { width: 1728, height: 1080, duration: 3, audio: false });
    checkSamples(c, [plainAt(c.tl), plainAt(c.tl)]);
  }],

  ['4K export', async (lab, runner, fx) => {
    const p = P.cutRange(baseProject(fx), 1.5, 8);
    const c = await exportCase(lab, runner, '4k', p, {
      resolution: '4k', samples: [{ t: 0.75, points: [TOP, BOTTOM] }], snapshots: [0.75]
    });
    basics(c, { width: 3456, height: 2160, duration: 1.5 });
    checkSamples(c, [plainAt(c.tl)]);
  }]
];

function cursorPoint(c, at) {
  const meta = c.project.sources[at.source];
  const track = parseCursorTrack(fs.readFileSync(path.join(meta.dir, meta.cursor)));
  let best = track[0];
  for (const s of track) if (Math.abs(s.t - at.t) < Math.abs(best.t - at.t)) best = s;
  return [best.x, best.y];
}

// ------------------------------------------------------------- real recordings

async function exportReal(lab, runner, source) {
  const name = path.basename(source);
  const dir = path.join(OUT, 'real', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // A copy: the recording itself is never touched.
  for (const f of fs.readdirSync(source)) {
    if (/^(raw\.(mov|mp4)|cursor\.bin|project\.json|system\.m4a|keys\.json)$/.test(f)) {
      fs.copyFileSync(path.join(source, f), path.join(dir, f));
    }
  }
  const resolution = argValue('--resolution') ?? '1080p';
  const { job, project, out } = buildJob(dir, { resolution });
  const tl = buildTimeline(project);
  let times = argValue('--at')?.split(',').map(Number);
  if (!times) {
    times = [tl.duration * 0.15];
    // The middle of each zoom, once it has settled.
    for (const z of project.zooms) times.push(Math.min(z.end, z.start + 0.6));
  }
  log(`# real recording ${name}: ${project.sources.main.width}x${project.sources.main.height} points, ` +
      `${tl.duration.toFixed(2)}s, ${project.zooms.length} zooms, mic ${project.sources.main.mic}`);
  const started = Date.now();
  const result = await runner.start(job, out, {
    onProgress: (p) => { if (p.phase === 'video' && p.frame % 600 === 0) log(`  frame ${p.frame}/${p.total}`); }
  });
  const seconds = (Date.now() - started) / 1000;
  log(`  exported ${result.width}x${result.height} ${result.codec}${result.hardware ? ' (hardware)' : ''}, ` +
      `sound ${result.audio}: ${tl.duration.toFixed(2)}s of video in ${seconds.toFixed(2)}s = ${(tl.duration / seconds).toFixed(2)}x real time`);
  const inspection = await lab.call('inspect', pathToFileURL(out).href, {
    snapshots: times.map((t) => ({ t: frameAt(t), name: `real-${name}-${t.toFixed(2)}s.png` })),
    sound: [{ from: 0, to: tl.duration }]
  });
  log(`  decoded ${inspection.frames} frames (${inspection.width}x${inspection.height}), snapshots: ${inspection.snapshots.join(', ')}`);
  if (inspection.audio) log(`  sound RMS ${inspection.audio.windows[0].rms.toFixed(4)}`);
  assert.strictEqual(inspection.frames, Math.ceil(tl.duration * 60 - 1e-6));
}

// ------------------------------------------------------------- main

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // Snapshots from an earlier run would be mistaken for this one's.
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.rmSync(path.join(OUT, f));
  const runner = createExportRunner({
    BrowserWindow,
    preload: path.join(ROOT, 'src', 'preload', 'exporter.js'),
    page: path.join(ROOT, 'src', 'renderer', 'exporter', 'index.html')
  });
  const lab = await openLab();
  const real = argValue('--real');
  if (real) {
    await exportReal(lab, runner, path.resolve(real));
    return 0;
  }
  const fx = await makeFixtures(lab);
  const only = argValue('--only');
  let failed = 0;
  let n = 0;
  for (const [title, fn] of CASES) {
    if (only && !title.includes(only)) continue;
    n++;
    try {
      await fn(lab, runner, fx);
      log(`ok ${n} - ${title}`);
    } catch (err) {
      failed++;
      log(`not ok ${n} - ${title}\n  ${String(err.stack ?? err).split('\n').slice(0, 4).join('\n  ')}`);
    }
  }
  log(`# ${n - failed}/${n} passed; snapshots in ${path.relative(ROOT, OUT)}/`);
  return failed ? 1 : 0;
}

app.whenReady().then(main).then(
  (code) => app.exit(code),
  (err) => { log(`not ok - ${err.stack ?? err}`); app.exit(1); }
);
