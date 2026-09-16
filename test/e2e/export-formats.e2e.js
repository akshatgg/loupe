'use strict';
// End-to-end checks of the export formats and size limits (docs/EDITOR-V2.md
// section 6):
//
//   npm run test:e2e:export        (electron test/e2e/export-formats.e2e.js [--only <text>])
//
// Makes fixture recordings with WebCodecs (lab.js's colour-coded pattern with
// a tone, and a noise recording that is hard to compress), exports them
// through the app's real export path, then takes every file apart from the
// outside (media-parse.mjs, VideoDecoder/AudioDecoder, ImageDecoder) and
// checks size, duration, frame count and timing, which moment is on screen,
// the sound, and that a size limit was honoured. Also exports through the
// preload + IPC as the editor does, checks "Recent exports", and on macOS puts
// the exported GIF on the real clipboard and reads it back as Finder would.
// PNG snapshots go to test/e2e/out/formats-*.png.

const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const { createExportRunner, buildJob, registerExportIpc } = require('../../src/main/ipc/export');
const { registerFileActionsIpc } = require('../../src/main/ipc/fileActions');
const P = require('../../src/core/project.js');
const { buildTimeline } = require('../../src/core/timeline.js');
const E = require('../../src/core/export-plan.js');

const FIXTURE = { width: 640, height: 400, fps: 30 };
const STILL = [6, 7];
const SILENCE = [3, 3.5];
const TONE = { freq: 440, amp: 0.5 };
const TONE_RMS = TONE.amp / Math.SQRT2;
let PALETTES = null;
let GREY = null;

const log = (line) => process.stdout.write(`${line}\n`);
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

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
      preload: path.join(__dirname, 'lab-preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false
    }
  });
  win.webContents.on('console-message', (e) => log(`  [lab] ${e.message}`));
  await win.loadFile(path.join(__dirname, 'export-lab.html'));
  for (let i = 0; i < 400; i++) {
    if (await win.webContents.executeJavaScript('Boolean(window.lab && window.exportLab)')) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const call = (obj, fn, ...args) => win.webContents.executeJavaScript(`window.${obj}.${fn}(...${JSON.stringify(args)})`);
  PALETTES = await win.webContents.executeJavaScript('window.lab.PALETTES');
  GREY = await win.webContents.executeJavaScript('({ low: window.lab.GREY_LOW, span: window.lab.GREY_SPAN })');
  return {
    lab: (fn, ...args) => call('lab', fn, ...args),
    fx: (fn, ...args) => call('exportLab', fn, ...args)
  };
}

function writeCursor(file, duration) {
  const n = Math.round(duration * 60);
  const buf = Buffer.alloc(n * 16);
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(i / 60, i * 16);
    buf.writeFloatLE(500, i * 16 + 4);
    buf.writeFloatLE(200, i * 16 + 8);
  }
  fs.writeFileSync(file, buf);
}

async function makeFixtures(lab) {
  const a = path.join(OUT, 'formats', 'fixtures', 'a');
  const noise = path.join(OUT, 'formats', 'fixtures', 'noise');
  const ra = await lab.lab('makeRecording', {
    name: 'formats/fixtures/a/raw.mp4', ...FIXTURE, duration: 8, codec: 'avc', palette: 'a',
    still: STILL, sound: { ...TONE, silence: SILENCE }
  });
  writeCursor(path.join(a, 'cursor.bin'), 8);
  const rn = await lab.fx('makeBusyRecording', { name: 'formats/fixtures/noise/raw.mp4', width: 1280, height: 720, duration: 10, fps: 30 });
  writeCursor(path.join(noise, 'cursor.bin'), 10);
  log(`# fixtures: pattern ${ra.frames} frames with a tone; busy scroll ${rn.frames} frames (${(rn.bytes / 1e6).toFixed(1)} MB)`);
  return { a, noise };
}

function patternProject(fx) {
  let p = P.createProject({
    main: {
      dir: fx.a, width: FIXTURE.width, height: FIXTURE.height, duration: 8, fps: FIXTURE.fps,
      video: 'raw.mp4', mic: true, cursor: 'cursor.bin'
    },
    createdAt: 0
  });
  p = P.setStyle(p, { padding: 0, radius: 0, shadow: 0, background: { type: 'none', value: null }, cursor: { show: false } });
  return P.setAudio(p, { mic: { cleanUp: false, level: false } });
}

function noiseProject(fx) {
  let p = P.createProject({
    main: { dir: fx.noise, width: 1280, height: 720, duration: 10, fps: 30, video: 'raw.mp4', mic: false, cursor: 'cursor.bin' },
    createdAt: 0
  });
  p = P.setStyle(p, { padding: 0, radius: 0, shadow: 0, background: { type: 'none', value: null }, cursor: { show: false } });
  return p;
}

// ------------------------------------------------------------- checking

function fixtureFrameTime(t) {
  let f = Math.floor(t * FIXTURE.fps + 1e-6) / FIXTURE.fps;
  if (f > STILL[0] && f < STILL[1]) f = STILL[0];
  return f;
}

function nearestColour(palette, rgb) {
  let best = -1;
  let dist = Infinity;
  palette.forEach((c, i) => {
    const d = Math.hypot(c[0] - rgb[0], c[1] - rgb[1], c[2] - rgb[2]);
    if (d < dist) { dist = d; best = i; }
  });
  return { index: best, dist };
}

// Top of the picture: the colour of the recording's second; bottom: grey
// rising through the second. `slack` in fixture frames, for GIF frame timing.
function checkPattern(what, [top, bottom], t, { greyTolerance = 0.075, slack = 0 } = {}) {
  const candidates = [];
  for (let d = -slack; d <= slack; d++) candidates.push(fixtureFrameTime(Math.max(0, t + d / FIXTURE.fps)));
  const { index, dist } = nearestColour(PALETTES.a, top);
  assert.ok(candidates.some((f) => Math.floor(f) % 8 === index), `${what}: colour ${top} is second ${index} (t=${t.toFixed(3)})`);
  assert.ok(dist < 60, `${what}: colour ${top} is ${dist.toFixed(0)} away from the palette`);
  const spread = Math.max(...bottom) - Math.min(...bottom);
  assert.ok(spread < 30, `${what}: ${bottom} should be grey`);
  const fraction = ((bottom[0] + bottom[1] + bottom[2]) / 3 - GREY.low) / GREY.span;
  const ok = candidates.some((f) => Math.abs(fraction - (f - Math.floor(f))) < greyTolerance);
  assert.ok(ok, `${what}: grey says ${fraction.toFixed(3)} into the second (t=${t.toFixed(3)})`);
}

function checkTone(w, what) {
  assert.ok(Math.abs(w.rms - TONE_RMS) < 0.05, `${what}: RMS ${w.rms.toFixed(3)}, expected ${TONE_RMS.toFixed(3)}`);
  assert.ok(Math.abs(w.rmsRight - TONE_RMS) < 0.05, `${what}: right RMS ${w.rmsRight.toFixed(3)}`);
  assert.ok(Math.abs(w.frequency - TONE.freq) < 4, `${what}: ${w.frequency.toFixed(1)} Hz`);
}

async function exportTo(runner, name, project, options) {
  const dir = path.join(OUT, 'formats', 'cases', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2));
  const { job, project: loaded, out } = buildJob(dir, options);
  const started = Date.now();
  const result = await runner.start(job, out);
  const seconds = (Date.now() - started) / 1000;
  const bytes = fs.statSync(out).size;
  log(`  ${name}: ${path.basename(out)} ${result.width}x${result.height} ${result.codec}, ${(bytes / 1e6).toFixed(2)} MB, ` +
      `${result.duration.toFixed(2)}s in ${seconds.toFixed(1)}s${result.passes > 1 ? `, ${result.passes} passes` : ''}`);
  assert.strictEqual(result.bytes, bytes, 'the file is exactly as long as the exporter says');
  return { result, out, bytes, project: loaded, tl: buildTimeline(loaded), dir };
}

// Pixel points (top and bottom of the left quarter) for an output size.
const pointsFor = ({ width, height }) => [{ x: width * 0.25, y: height * 0.2 }, { x: width * 0.25, y: height * 0.8 }];

// ------------------------------------------------------------- the cases

const CASES = [
  ['WebM: VP9 + Opus, size, every frame on time, picture and sound', async (lab, runner, fx) => {
    const c = await exportTo(runner, 'webm', patternProject(fx), { format: 'webm', resolution: '720p' });
    assert.ok(c.out.endsWith('export-1152x720.webm'));
    const times = [0.5, 2.25, 4.75, 6.5, 7.9].map((t) => Math.round(t * 60) / 60);
    const size = { width: 1152, height: 720 };
    const w = await lab.fx('inspectWebm', pathToFileURL(c.out).href, {
      samples: times.map((t) => ({ t, points: pointsFor(size) })),
      snapshots: [{ t: 2.25, name: 'formats-webm-2.25s.png' }],
      sound: [{ from: 1, to: 2.9 }, { from: SILENCE[0] + 0.1, to: SILENCE[1] - 0.1 }, { from: 4, to: 7.5 }],
      onsetAfter: SILENCE[0] + 0.25
    });
    assert.strictEqual(w.videoCodec, 'V_VP9');
    assert.strictEqual(w.audioCodec, 'A_OPUS');
    assert.strictEqual(w.width, 1152);
    assert.strictEqual(w.height, 720);
    const count = 8 * 60;
    assert.strictEqual(w.blocks, count, `${w.blocks} video blocks`);
    assert.strictEqual(w.frames, count, `decoded ${w.frames} frames`);
    w.blockTimes.forEach((t, k) => assert.ok(Math.abs(t - k / 60) <= 0.0011, `frame ${k} at ${t}s`));
    assert.ok(Math.abs(w.duration - 8) < 0.05, `WebM says it lasts ${w.duration}s`);
    assert.ok(w.keyframes >= 4, `${w.keyframes} keyframes (seekable)`);
    assert.strictEqual(w.colours.length, times.length);
    w.colours.forEach((s) => checkPattern(`webm at ${s.t}`, s.colours, s.t));
    assert.strictEqual(w.audio.sampleRate, 48000);
    assert.strictEqual(w.audio.channels, 2);
    assert.ok(Math.abs(w.audio.duration - 8) < 0.1, `sound lasts ${w.audio.duration}s`);
    checkTone(w.audio.windows[0], 'tone');
    assert.ok(w.audio.windows[1].rms < 0.01, `silent gap RMS ${w.audio.windows[1].rms}`);
    checkTone(w.audio.windows[2], 'tone after the gap');
    assert.ok(Math.abs(w.audio.onset - SILENCE[1]) < 0.03, `the tone comes back at ${w.audio.onset}s, expected ${SILENCE[1]}s`);
    log(`    sound comes back at ${w.audio.onset.toFixed(4)}s (pre-skip ${w.audio.preSkip}); ${w.keyframes} keyframes`);
  }],

  ['GIF: 960 wide at 15 fps by default, exact length, still stretch merged, right picture', async (lab, runner, fx) => {
    const p = P.setExport(patternProject(fx), { format: 'gif' });
    const c = await exportTo(runner, 'gif', p, {});
    const size = E.outputSize(c.project);
    assert.deepStrictEqual(size, { width: 960, height: 600 });
    assert.ok(c.out.endsWith('export-960x600.gif'));
    assert.strictEqual(c.result.fps, 15);
    assert.strictEqual(c.result.audio, false);
    const times = [0.5, 2.2, 4.8, 6.5, 7.8];
    const g = await lab.fx('inspectGif', pathToFileURL(c.out).href, {
      samples: times.map((t) => ({ t, points: pointsFor(size) })),
      snapshots: [{ t: 2.2, name: 'formats-gif-2.2s.png' }]
    });
    assert.strictEqual(g.width, 960);
    assert.strictEqual(g.height, 600);
    assert.strictEqual(g.loops, 0, 'loops forever');
    assert.strictEqual(g.decodedFrames, g.frames, 'Chromium decodes every frame');
    assert.strictEqual(g.delays.reduce((a, b) => a + b, 0), 800, 'delays add up to 8 s');
    assert.strictEqual(c.result.frames, 120, '15 fps x 8 s drawn');
    assert.strictEqual(g.frames, c.result.encoded);
    assert.ok(g.frames < 120 && g.frames > 90, `${g.frames} frames after merging`);
    assert.ok(Math.max(...g.delays) >= 90, `the one-second still stretch is one long frame (${Math.max(...g.delays)} cs)`);
    // 256 colours, dithered: grey is only approximately right.
    g.colours.forEach((s) => checkPattern(`gif at ${s.t}`, s.colours, s.t, { greyTolerance: 0.1, slack: 2 }));
    const estimate = E.estimateBytes(c.project.export, { ...size, fps: 15, duration: 8 });
    log(`    ${g.frames} frames, ${c.result.palettes} palette(s), ${g.localPalettes} local; estimate ${(estimate / 1e6).toFixed(2)} MB`);
  }],

  ['GIF: 480 wide, 10 fps, no dithering, after a cut', async (lab, runner, fx) => {
    let p = P.cutRange(patternProject(fx), 2, 4);
    p = P.setExport(p, { format: 'gif', gifWidth: 480, gifFps: 10, dither: false });
    const c = await exportTo(runner, 'gif-small', p, {});
    const g = await lab.fx('inspectGif', pathToFileURL(c.out).href, {
      samples: [1.5, 2.5].map((t) => ({ t, points: pointsFor({ width: 480, height: 300 }) }))
    });
    assert.strictEqual(g.width, 480);
    assert.strictEqual(g.height, 300);
    assert.strictEqual(c.result.frames, 60);
    assert.strictEqual(g.delays.reduce((a, b) => a + b, 0), 600);
    // Output 2.5 s is recording 4.5 s.
    const at = c.tl.toSource(2.5).t;
    checkPattern('after the cut', g.colours[1].colours, at, { greyTolerance: 0.12, slack: 3 });
    assert.strictEqual(nearestColour(PALETTES.a, g.colours[1].colours[0]).index, 4);
  }],

  ['MP4 fit to 2 MB: a busy 10 s scroll that needs far more is squeezed under the limit', async (lab, runner, fx) => {
    const big = await exportTo(runner, 'busy-high', noiseProject(fx), { format: 'mp4', resolution: '1080p', quality: 'high' });
    assert.ok(big.bytes > 5e6, `without a limit the scroll needs ${big.bytes} bytes`);
    fs.rmSync(big.out);
    const c = await exportTo(runner, 'busy-2mb', P.setExport(noiseProject(fx), { sizeLimit: 2 }), { format: 'mp4', resolution: '1080p', quality: 'high' });
    assert.ok(c.bytes <= 2e6, `${c.bytes} bytes is over 2 MB`);
    assert.ok(c.bytes > 1e6, `${c.bytes} bytes: most of the budget is used`);
    const inspection = await lab.lab('inspect', pathToFileURL(c.out).href, {
      snapshots: [{ t: 5, name: 'formats-busy-2mb-5s.png' }]
    });
    assert.strictEqual(inspection.width, c.result.width);
    assert.strictEqual(inspection.height, c.result.height);
    assert.strictEqual(inspection.frames, 10 * c.result.fps);
    assert.ok(Math.abs(inspection.duration - 10) < 0.05, `lasts ${inspection.duration}s`);
    log(`    ${c.result.passes} pass(es), made at ${c.result.width}x${c.result.height} ${c.result.fps} fps, ${(c.result.bitrate / 1000).toFixed(0)} kb/s`);
  }],

  ['WebM fit to 1 MB', async (lab, runner, fx) => {
    const c = await exportTo(runner, 'busy-webm-1mb', P.setExport(noiseProject(fx), { sizeLimit: 1 }), { format: 'webm', resolution: '720p' });
    assert.ok(c.bytes <= 1e6, `${c.bytes} bytes is over 1 MB`);
    const w = await lab.fx('inspectWebm', pathToFileURL(c.out).href, { snapshots: [{ t: 5, name: 'formats-busy-webm-1mb-5s.png' }] });
    assert.strictEqual(w.frames, 10 * c.result.fps);
    assert.strictEqual(w.width, c.result.width);
    assert.strictEqual(w.hasAudio, false);
    assert.ok(Math.abs(w.duration - 10) < 0.05);
    log(`    ${c.result.passes} pass(es), made at ${c.result.width}x${c.result.height} ${c.result.fps} fps, ${(c.result.bitrate / 1000).toFixed(0)} kb/s`);
  }],

  ['through the preload and IPC: export a GIF, Recent exports, copy the file to the clipboard', async (lab, runner, fx) => {
    const dir = path.join(OUT, 'formats', 'cases', 'ipc');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(fx.a, 'raw.mp4'), path.join(dir, 'raw.mp4'));
    fs.copyFileSync(path.join(fx.a, 'cursor.bin'), path.join(dir, 'cursor.bin'));
    const p = patternProject({ a: '.' });
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ ...p, sources: { main: { ...p.sources.main, dir: '.' } } }));
    registerExportIpc({ ipcMain, runner, projectDir: () => dir });
    registerFileActionsIpc(ipcMain);
    const win = new BrowserWindow({
      show: false, webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'preload.js'), backgroundThrottling: false }
    });
    await win.loadFile(path.join(__dirname, 'lab.html'));
    const js = (code) => win.webContents.executeJavaScript(code);
    try {
      assert.deepStrictEqual(await js('window.loupe.recentExports()'), []);
      const mp4 = await js(`window.loupe.exportVideo({ format: 'mp4', resolution: '720p' })`);
      const gif = await js(`window.loupe.exportVideo({ format: 'gif', gifWidth: 480 })`);
      assert.strictEqual(gif.file, path.join(dir, 'export-480x300.gif'));
      assert.strictEqual(gif.format, 'gif');
      const recent = await js('window.loupe.recentExports()');
      assert.deepStrictEqual(recent.map((r) => r.name), ['export-480x300.gif', 'export-1152x720.mp4']);
      assert.strictEqual(recent[0].file, gif.file);
      assert.strictEqual(recent[0].bytes, fs.statSync(gif.file).size);
      assert.strictEqual(recent[1].width, 1152);
      // A deleted export drops out of the list.
      fs.rmSync(mp4.file);
      assert.deepStrictEqual((await js('window.loupe.recentExports()')).map((r) => r.format), ['gif']);

      if (process.platform === 'darwin') {
        const previous = await clipboard.readText().catch(() => '');
        try {
          const copied = await js(`window.loupe.copyFile(${JSON.stringify(gif.file)})`);
          assert.deepStrictEqual(copied, { ok: true });
          const furl = execFileSync('osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)']).toString().trim();
          assert.strictEqual(furl, gif.file, 'Finder would paste the exported GIF');
          log(`    clipboard holds ${furl}`);
        } finally {
          await clipboard.writeText(previous || '').catch(() => {});
        }
      } else {
        log('    clipboard check is macOS only');
      }
    } finally {
      win.destroy();
    }
  }]
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (f.startsWith('formats-') && f.endsWith('.png')) fs.rmSync(path.join(OUT, f));
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
  log(`# ${n - failed}/${n} passed; snapshots in ${path.relative(ROOT, OUT)}/formats-*.png`);
  return failed ? 1 : 0;
}

app.whenReady().then(main).then(
  (code) => app.exit(code),
  (err) => { log(`not ok - ${err.stack ?? err}`); app.exit(1); }
);

