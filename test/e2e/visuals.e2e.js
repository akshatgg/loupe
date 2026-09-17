'use strict';
// End-to-end export tests of the visual features (docs/EDITOR-V2.md section
// 5): annotations, keystroke badges, the webcam bubble, transitions and
// background pictures. Run with
//
//   npm run test:e2e:visuals        [--only <words in a case title>]
//
// Like run.js it makes its own recordings (lab.js: a colour per second on
// top, a grey ramp within each second below), exports projects through the
// app's real export path and decodes the videos again, checking pixels where
// each feature draws. The webcam fixture is recorded with MediaRecorder, as
// the webcam bubble records it. Snapshots go to test/e2e/out/visuals/.

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out', 'visuals');
const { createExportRunner, buildJob } = require('../../src/main/ipc/export');
const { reserveDuration, durationElement } = require('../../src/main/webm');
const P = require('../../src/core/project.js');
const { buildTimeline } = require('../../src/core/timeline.js');
const C = require('../../src/core/compose.js');
const A = require('../../src/core/layers/annotations.js');
const W = require('../../src/core/layers/webcam.js');
const { BADGE_PX } = require('../../src/core/layers/keystrokes.js');
const { CURSOR_RECORD_BYTES, parseCursorTrack } = require('../../src/core/cursor.js');

const FIXTURE = { width: 640, height: 400, fps: 30, duration: 8 };
const WEBCAM_OFFSET = 1;

const log = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function safeName(name) {
  if (typeof name !== 'string' || name.split(/[\\/]/).includes('..') || path.isAbsolute(name)) {
    throw new Error(`bad name ${name}`);
  }
  return path.join(OUT, name);
}

async function openLab() {
  ipcMain.handle('lab:save', (_e, name, bytes) => {
    const file = safeName(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  });
  // As ipc/camera.js writes webcam.webm: room for a Duration in the first
  // chunk, filled in at the end.
  ipcMain.handle('lab:saveChunks', (_e, name, chunks, durationMs) => {
    const file = safeName(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const first = reserveDuration(Buffer.from(chunks[0]));
    fs.writeFileSync(file, Buffer.concat([first.chunk, ...chunks.slice(1).map((c) => Buffer.from(c))]));
    if (first.durationOffset !== null) {
      const fd = fs.openSync(file, 'r+');
      fs.writeSync(fd, durationElement(durationMs, first.timecodeScale), 0, 11, first.durationOffset);
      fs.closeSync(fd);
    }
  });
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'visuals-lab-preload.js'), sandbox: true, contextIsolation: true,
      backgroundThrottling: false
    }
  });
  win.webContents.on('console-message', (e) => { if (e.level === 'error') log(`  [lab] ${e.message}`); });
  await win.loadFile(path.join(__dirname, 'visuals-lab.html'));
  for (let i = 0; i < 400; i++) {
    if (await win.webContents.executeJavaScript('window.labReady === true && window.visualsLabReady === true')) break;
    await sleep(25);
  }
  const js = (code) => win.webContents.executeJavaScript(code);
  const call = (fn, ...args) => js(`window.lab.${fn}(...${JSON.stringify(args)})`);
  const vcall = (fn, ...args) => js(`window.visualsLab.${fn}(...${JSON.stringify(args)})`);
  return {
    call, vcall,
    palettes: await js('window.lab.PALETTES'),
    grey: await js('({ low: window.lab.GREY_LOW, span: window.lab.GREY_SPAN })'),
    webcamColours: await js('window.visualsLab.WEBCAM_COLOURS')
  };
}

function writeCursor(file, duration) {
  const n = Math.round(duration * 60);
  const buf = Buffer.alloc(n * CURSOR_RECORD_BYTES);
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(i / 60, i * 16);
    buf.writeFloatLE(600, i * 16 + 4);
    buf.writeFloatLE(380, i * 16 + 8);
  }
  fs.writeFileSync(file, buf);
}

async function makeFixtures(lab) {
  const dir = path.join(OUT, 'fixture');
  fs.rmSync(dir, { recursive: true, force: true });
  await lab.call('makeRecording', {
    name: 'fixture/raw.mp4', width: FIXTURE.width, height: FIXTURE.height, duration: FIXTURE.duration,
    fps: FIXTURE.fps, codec: 'avc', palette: 'a'
  });
  writeCursor(path.join(dir, 'cursor.bin'), FIXTURE.duration);
  const cam = await lab.vcall('makeWebcam', { name: 'fixture/webcam.webm', seconds: 4.2, width: 320, height: 240 });
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify([{ t: 1, label: '⌘K' }, { t: 5, label: '⇧⌘Z' }]));
  log(`# fixtures: recording, webcam.webm (${cam.mimeType}, ${cam.chunks} chunks), keys.json`);
  return dir;
}

function baseProject(fixture, extra = {}) {
  let p = P.createProject({
    main: {
      dir: fixture, width: FIXTURE.width, height: FIXTURE.height, duration: FIXTURE.duration, fps: FIXTURE.fps,
      video: 'raw.mp4', mic: false, cursor: 'cursor.bin', ...extra
    },
    createdAt: 0
  });
  p = P.setStyle(p, { padding: 0, radius: 0, shadow: 0, background: { type: 'none', value: null }, cursor: { show: false } });
  return p;
}

const frameAt = (t) => Math.round(t * 60) / 60;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mix = (a, b, k) => a.map((v, i) => v * (1 - k) + b[i] * k);

// Exports `project` (saved into its own case folder) and samples pixels.
// samples: [{ t, points: [[x, y] in output pixels] }]
async function exportCase(lab, runner, name, project, { samples = [], snapshots = [], prepare } = {}) {
  const dir = path.join(OUT, 'cases', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  prepare?.(dir);
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2));
  const out = path.join(OUT, `${name}.mp4`);
  fs.rmSync(out, { force: true });
  const { job, project: loaded } = buildJob(dir, { resolution: '720p' }, { out });
  const result = await runner.start(job, out);
  const inspection = await lab.call('inspect', pathToFileURL(out).href, {
    samples: samples.map((s) => ({ t: frameAt(s.t), points: s.points.map(([x, y]) => ({ x, y })) })),
    snapshots: snapshots.map((t) => ({ t: frameAt(t), name: `${name}-${t}s.png` }))
  });
  const tl = buildTimeline(loaded);
  assert.strictEqual(inspection.frames, Math.ceil(tl.duration * 60 - 1e-6), 'every frame is there');
  log(`  ${name}: ${result.width}x${result.height}, ${tl.duration.toFixed(2)}s`);
  const colours = inspection.colours.map((c) => c.colours);
  return { job, loaded, tl, size: C.exportSize(loaded, '720p'), colours, out };
}

function paletteColour(lab, t) {
  return lab.palettes.a[Math.floor(t) % 8];
}

function near(what, got, want, tolerance = 40) {
  assert.ok(dist(got, want) < tolerance, `${what}: got ${got}, expected about ${want.map(Math.round)}`);
}

function far(what, got, want, tolerance = 60) {
  assert.ok(dist(got, want) >= tolerance, `${what}: got ${got}, which is too close to ${want.map(Math.round)}`);
}

// A small 2D context that only measures text, for annotation geometry in node.
const measure = { save() {}, restore() {}, font: '', measureText: (s) => ({ width: String(s).length * 20 }) };

// ------------------------------------------------------------- the cases

const CASES = [
  ['annotations: title card, text, box and arrow, drawn where the editor puts them', async (lab, runner, fx) => {
    let p = P.setStyle(baseProject(fx), { padding: 0.08, background: { type: 'color', value: '#101418' } });
    p = P.addAnnotation(p, { type: 'title', start: 0, end: 2, text: 'Welcome\nA short tour', color: '#2050e0', size: 1 });
    p = P.addAnnotation(p, { type: 'box', start: 2.5, end: 7, x: 0.1, y: 0.1, w: 0.3, h: 0.25, color: '#00ff00', size: 3 });
    p = P.addAnnotation(p, { type: 'arrow', start: 2.5, end: 7, x: 0.55, y: 0.15, x2: 0.9, y2: 0.35, color: '#ff00ff', size: 3 });
    p = P.addAnnotation(p, { type: 'text', start: 2.5, end: 7, x: 0.5, y: 0.8, text: 'Click Save', color: '#ffffff', size: 1.5 });
    // A zoom while it shows: the box must stay on the same part of the screen.
    p = P.addZoom(p, { start: 4.5, end: 7.5, level: 2, follow: false, x: 180, y: 110 });
    const size = C.exportSize(p, '720p');
    const tl = buildTimeline(p);
    const cursors = { main: parseCursorTrack(fs.readFileSync(path.join(fx, 'cursor.bin'))) };
    const st = (t) => C.frameState({ project: p, tl, outT: frameAt(t), size, assets: { cursors } });
    const [, box, arrow, text] = p.annotations;
    const b1 = A.annotationGeometry(measure, st(3.5), box).box;
    const b2 = A.annotationGeometry(measure, st(6.5), box).box;
    const ar = A.annotationGeometry(measure, st(3.5), arrow);
    const tx = A.textLayout(measure, st(3.5), text);
    const samples = [
      // Title card: corners and a spot away from the words, all its colour.
      { t: 1, points: [[10, 10], [size.width - 10, size.height - 10], [size.width * 0.15, size.height * 0.5]] },
      // Box: its left edge, and just inside it (the recording).
      { t: 3.5, points: [[b1.x, b1.y + b1.h / 2], [b1.x + 20, b1.y + b1.h / 2],
        // Arrow: a third of the way along its line.
        [ar.x1 + (ar.x2 - ar.x1) / 3, ar.y1 + (ar.y2 - ar.y1) / 3],
        // Text: the dark backing left of the words.
        [tx.box.x + 6, tx.cy]] },
      // Zoomed: the box's left edge has moved with the picture.
      { t: 6.5, points: [[b2.x, b2.y + b2.h / 2], [b1.x, b1.y + b1.h / 2]] },
      // After: gone.
      { t: 7.5, points: [[b1.x, b1.y + b1.h / 2]] }
    ];
    const c = await exportCase(lab, runner, 'annotations', p, { samples, snapshots: [0.25, 1, 3.5, 6.5] });
    const [atTitle, atShow, atZoom, after] = c.colours;
    for (const [i, rgb] of atTitle.entries()) near(`title card ${i}`, rgb, [0x20, 0x50, 0xe0], 25);
    near('box edge', atShow[0], [0, 255, 0], 90);
    far('inside the box is the recording', atShow[1], [0, 255, 0]);
    near('arrow line', atShow[2], [255, 0, 255], 90);
    assert.ok(Math.max(...atShow[3]) < 70, `text backing is dark: ${atShow[3]}`);
    assert.ok(Math.abs(b2.w - 2 * b1.w) < 2, 'the zoom doubles the box');
    near('box edge under the zoom', atZoom[0], [0, 255, 0], 90);
    far('the old spot is no longer the box', atZoom[1], [0, 255, 0]);
    far('the box is gone after it ends', after[0], [0, 255, 0]);
  }],

  ['a hidden area pixelates what is under it for its whole duration', async (lab, runner, fx) => {
    let p = baseProject(fx);
    // Across the line between the colour (top) and the grey (bottom), with
    // blocks taller than the area: the colour just above the line is
    // averaged away with the grey.
    p = P.addAnnotation(p, { type: 'blur', start: 1, end: 6, x: 0.05, y: 0.44, w: 0.2, h: 0.1, size: 10 });
    const size = C.exportSize(p, '720p');
    const at = (fy) => [Math.round(size.width * 0.1), Math.round(size.height * fy)];
    const samples = [0.5, 1.02, 3.5, 5.95, 6.5].map((t) => ({ t, points: [at(0.46), at(0.3)] }));
    const c = await exportCase(lab, runner, 'blur', p, { samples, snapshots: [3.5] });
    c.colours.forEach(([inside, outside], i) => {
      const t = samples[i].t;
      near(`above the hidden area at ${t}s`, outside, paletteColour(lab, t));
      if (t >= 1 && t < 6) far(`hidden at ${t}s`, inside, paletteColour(lab, t), 35);
      else near(`not hidden at ${t}s`, inside, paletteColour(lab, t));
    });
  }],

  ['keystroke badges appear for a moment where the style puts them', async (lab, runner, fx) => {
    for (const position of ['bottom', 'top']) {
      let p = baseProject(fx, { keys: 'keys.json' });
      p = P.setStyle(p, { keystrokes: { show: true, position } });
      const size = C.exportSize(p, '720p');
      const unit = Math.min(size.width, size.height) / 1080;
      const h = BADGE_PX * unit * 1.8;
      const top = position === 'bottom' ? size.height - 36 * unit - h : 36 * unit;
      // Just inside the badge's top edge, above its letters.
      const point = [size.width / 2, top + 7];
      const c = await exportCase(lab, runner, `keys-${position}`, p, {
        samples: [1.5, 2.8, 5.5].map((t) => ({ t, points: [point] })), snapshots: [1.5]
      });
      assert.ok(Math.max(...c.colours[0][0]) < 60, `${position}: a dark badge at 1.5s, got ${c.colours[0][0]}`);
      far(`${position}: no badge at 2.8s`, c.colours[1][0], [26, 26, 29]);
      assert.ok(Math.max(...c.colours[2][0]) < 60, `${position}: the second shortcut at 5.5s, got ${c.colours[2][0]}`);
    }
  }],

  ['the webcam bubble shows webcam.webm in time with the recording', async (lab, runner, fx) => {
    const webcam = { file: 'webcam.webm', offset: WEBCAM_OFFSET, width: 320, height: 240 };
    let p = baseProject(fx, { webcam });
    p = P.setStyle(p, { padding: 0.06, background: { type: 'color', value: '#202020' }, webcam: { corner: 'bottom-right', size: 0.3 } });
    const size = C.exportSize(p, '720p');
    const tl = buildTimeline(p);
    const rect = W.bubbleRect(C.frameState({ project: p, tl, outT: 2, size }));
    const centre = [rect.x + rect.d / 2, rect.y + rect.d / 2];
    // Webcam colour k covers webcam seconds [k/2, (k+1)/2): sample mid-way.
    const times = [0.5, 1.75, 2.75, 3.75, 7];
    const c = await exportCase(lab, runner, 'webcam', p, {
      samples: times.map((t) => ({ t, points: [centre] })), snapshots: [2.75]
    });
    const recordingAt = (t) => {
      const s = C.frameState({ project: c.loaded, tl: c.tl, outT: t, size: c.size });
      const fy = (centre[1] - s.content.y) / s.content.h;
      return fy < 0.5 ? paletteColour(lab, t) : null;
    };
    c.colours.forEach(([rgb], i) => {
      const t = times[i];
      const wt = t - WEBCAM_OFFSET;
      if (wt < 0 || wt > 4.3) {
        // No camera then: the recording shows through (grey below the middle).
        const expected = recordingAt(t);
        if (expected) near(`no bubble at ${t}s`, rgb, expected);
        else assert.ok(Math.max(...rgb) - Math.min(...rgb) < 25, `no bubble at ${t}s: grey recording, got ${rgb}`);
      } else {
        near(`webcam at ${t}s`, rgb, lab.webcamColours[Math.floor(wt * 2)], 45);
      }
    });
    // Hidden: the recording, not the camera.
    const hidden = await exportCase(lab, runner, 'webcam-hidden', P.setStyle(p, { webcam: { show: false } }), {
      samples: [{ t: 2.75, points: [centre] }]
    });
    far('hidden bubble', hidden.colours[0][0], lab.webcamColours[3]);
  }],

  ['transitions: crossfade, dip to black and fade to the background at a cut', async (lab, runner, fx) => {
    const cut = P.cutRange(P.setStyle(baseProject(fx), { padding: 0.1, background: { type: 'color', value: '#2050e0' } }), 2, 4);
    const [first] = cut.clips;
    const size = C.exportSize(cut, '720p');
    const tl = buildTimeline(cut);
    const s = C.frameState({ project: cut, tl, outT: 1, size });
    const top = [s.content.x + s.content.w * 0.3, s.content.y + s.content.h * 0.2];
    const corner = [8, 8];
    const C1 = lab.palettes.a[1];
    const C4 = lab.palettes.a[4];

    const xf = await exportCase(lab, runner, 'crossfade', P.setTransition(cut, first.id, 'crossfade', 1), {
      samples: [1.4, 1.75, 2.25, 2.7].map((t) => ({ t, points: [top] })), snapshots: [1.75, 2.25]
    });
    near('before the crossfade', xf.colours[0][0], C1);
    near('a quarter in: mostly the first clip', xf.colours[1][0], mix(C1, C4, 0.25), 30);
    near('three quarters in: mostly the second clip', xf.colours[2][0], mix(C1, C4, 0.75), 30);
    near('after the crossfade', xf.colours[3][0], C4);

    const dip = await exportCase(lab, runner, 'dip', P.setTransition(cut, first.id, 'dip', 1), {
      samples: [{ t: 1.75, points: [top] }, { t: 2, points: [top, corner] }], snapshots: [2]
    });
    near('dip: half way down', dip.colours[0][0], mix(C1, [0, 0, 0], 0.5), 30);
    near('dip: black at the cut', dip.colours[1][0], [0, 0, 0], 20);
    near('dip: the background is black too', dip.colours[1][1], [0, 0, 0], 20);

    const fade = await exportCase(lab, runner, 'fade', P.setTransition(cut, first.id, 'fade', 1), {
      samples: [{ t: 2, points: [top, corner] }], snapshots: [2]
    });
    near('fade: the content shows the background at the cut', fade.colours[0][0], [0x20, 0x50, 0xe0], 25);
    near('fade: the background stays', fade.colours[0][1], [0x20, 0x50, 0xe0], 25);
  }],

  ['background pictures: a bundled wallpaper and a picture copied into the project', async (lab, runner, fx) => {
    const base = P.setStyle(baseProject(fx), { padding: 0.12 });
    const size = C.exportSize(base, '720p');
    const points = [[12, 12], [size.width - 14, size.height / 2]];
    const wp = await exportCase(lab, runner, 'wallpaper', P.setStyle(base, { background: { type: 'image', value: 'wallpaper:ocean' } }), {
      samples: [{ t: 1, points }], snapshots: [1]
    });
    assert.match(wp.job.background, /assets\/wallpapers\/ocean\.png$/);
    for (const [i, [x, y]] of points.entries()) {
      const want = await lab.vcall('coverPixel', wp.job.background, size.width, size.height, x, y);
      near(`wallpaper pixel ${i}`, wp.colours[0][i], want, 20);
    }
    // A picture of the user's, copied into background/.
    const picture = path.join(ROOT, 'src', 'assets', 'wallpapers', 'blush.png');
    const own = await exportCase(lab, runner, 'own-picture', P.setStyle(base, { background: { type: 'image', value: 'background/My picture.png' } }), {
      samples: [{ t: 1, points }],
      prepare: (dir) => {
        fs.mkdirSync(path.join(dir, 'background'));
        fs.copyFileSync(picture, path.join(dir, 'background', 'My picture.png'));
      }
    });
    for (const [i, [x, y]] of points.entries()) {
      const want = await lab.vcall('coverPixel', pathToFileURL(picture).href, size.width, size.height, x, y);
      near(`own picture pixel ${i}`, own.colours[0][i], want, 20);
    }
    // Anything else a project.json names is not read: black.
    const outside = await exportCase(lab, runner, 'outside-picture', P.setStyle(base, { background: { type: 'image', value: picture } }), {
      samples: [{ t: 1, points }]
    });
    assert.strictEqual(outside.job.background, null);
    near('an outside path draws no picture', outside.colours[0][0], [0, 0, 0], 12);
  }]
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.rmSync(path.join(OUT, f));
  const runner = createExportRunner({
    BrowserWindow,
    preload: path.join(ROOT, 'src', 'preload', 'exporter.js'),
    page: path.join(ROOT, 'src', 'renderer', 'exporter', 'index.html')
  });
  const lab = await openLab();
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
      log(`not ok ${n} - ${title}\n  ${String(err.stack ?? err).split('\n').slice(0, 5).join('\n  ')}`);
    }
  }
  log(`# ${n - failed}/${n} passed; snapshots in ${path.relative(ROOT, path.join(__dirname, 'out', 'visuals'))}/`);
  return failed ? 1 : 0;
}

app.whenReady().then(main).then(
  (code) => app.exit(code),
  (err) => { log(`not ok - ${err.stack ?? err}`); app.exit(1); }
);
