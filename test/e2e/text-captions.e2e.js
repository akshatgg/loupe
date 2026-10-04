'use strict';
// End-to-end test of caption styles and text styling, in real Electron:
//
//   npm run test:e2e:text      (electron test/e2e/text-captions.e2e.js)
//
// A plain-coloured recording is opened in the real editor with the app's
// preload. Captions with word timings are put in the project (writing them
// from speech is captions-editor.e2e.js's job), and from there everything is
// done as a person would: the preset tiles, the font and colour controls, the
// text settings and the toolbar's Text menu, with the real mouse. The checks
// are on project.json, on the preview's pixels, and on frames of the exported
// video taken with ffmpeg:
//
//   - Karaoke shows the spoken word in the spoken-word colour, and a
//     different word a moment later
//   - Typewriter shows fewer words early in a caption than late
//   - a font change changes the pixels, of captions and of text
//   - a ready-made text style from the Text menu, restyled from its settings
//   - text with a fade in is fainter at its start than a moment later
//
// Screenshots go to test/e2e/out/editor/text-*.png to look at.

const { app, ipcMain, dialog, BrowserWindow, nativeImage } = require('electron');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CACHE = process.env.LOUPE_E2E_CACHE || path.join(os.tmpdir(), 'loupe-e2e-cache');
app.setPath('userData', path.join(CACHE, 'userData'));

const { registerCaptionsIpc } = require('../../src/main/ipc/captions');
const { registerPresetsIpc } = require('../../src/main/ipc/presets');
const { createSpeechModels } = require('../../src/main/speech-models');
const { openEditor, readProject, waitFor, sleep, log, OUT } = require('./editor-harness');
const v1 = require('../../src/main/project');

const MOD = process.platform === 'darwin' ? 'meta' : 'control';
const DURATION = 8;
const BACKGROUND = [64, 96, 128];
const SPOKEN = '#ff2020';
// One caption, four words, a second each.
const CAPTION = {
  id: 'c1', source: 'main', start: 1, end: 5, text: 'Alpha bravo charlie delta',
  words: [
    { text: ' Alpha', start: 1, end: 2 }, { text: ' bravo', start: 2, end: 3 },
    { text: ' charlie', start: 3, end: 4 }, { text: ' delta', start: 4, end: 5 }
  ]
};

// ------------------------------------------------------------- the recording

function makeRecording() {
  const dir = path.join(OUT, 'cases', 'text-captions');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const hex = BACKGROUND.map((c) => c.toString(16).padStart(2, '0')).join('');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=640x400:r=30:d=${DURATION}`,
    '-c:v', 'h264_videotoolbox', '-b:v', '2M', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(dir, 'raw.mov')]);
  const project = v1.createProject({ kind: 'display', id: 'display:1', title: 'Display', width: 640, height: 400 },
    { file: 'raw.mov', fps: 30, duration: DURATION, hasMicTrack: false });
  v1.saveProject(dir, project);
  return dir;
}

// ------------------------------------------------------------- picture checks

// What stands out in a picture (rows y0..y1 as fractions of its height):
// how many pixels are the spoken-word red and where they sit across the width
// (0 left .. 1 right), how many are near-white, and how far the picture is
// from the plain background on average.
function measure(data, width, height, { bgr = false, y0 = 0, y1 = 1 } = {}) {
  let red = 0;
  let redX = 0;
  let light = 0;
  let away = 0;
  let total = 0;
  for (let y = Math.round(height * y0); y < Math.round(height * y1); y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[bgr ? i + 2 : i];
      const g = data[i + 1];
      const b = data[bgr ? i : i + 2];
      if (r > 150 && g < 110 && b < 110) { red++; redX += x; }
      if (r > 190 && g > 190 && b > 190) light++;
      away += Math.abs(r - BACKGROUND[0]) + Math.abs(g - BACKGROUND[1]) + Math.abs(b - BACKGROUND[2]);
      total++;
    }
  }
  return { red, redX: red ? redX / red / width : null, light, away: away / total };
}

// One frame of an exported video, at time t, measured.
function exportedFrame(file, t, name, band) {
  const png = path.join(OUT, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', png]);
  const img = nativeImage.createFromPath(png);
  const { width, height } = img.getSize();
  assert.ok(width > 0, `a frame at ${t} s of ${file}`);
  return measure(img.toBitmap(), width, height, { bgr: true, ...band });
}

const MEASURE_IN_PAGE = `(${measure.toString()})`;

// The preview canvas, measured the same way.
async function previewPicture(ed, band = {}) {
  return ed.js(`(() => { const BACKGROUND = ${JSON.stringify(BACKGROUND)}; const c = document.getElementById('preview');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return ${MEASURE_IN_PAGE}(d, c.width, c.height, ${JSON.stringify(band)}); })()`);
}

// The preview's pixels as one number per row band, to tell two pictures apart.
async function previewPixels(ed) {
  return ed.js(`(() => { const c = document.getElementById('preview');
    return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data); })()`);
}

const differing = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 60) n++;
  return n;
};

// ------------------------------------------------------------- helpers

async function seek(ed, t) {
  await ed.js(`window.__editor.player.seek(${t})`);
  await waitFor(() => ed.js(`(() => { const p = window.__editor.player; const at = window.__editor.store.tl.toSource(p.time);
    const v = p.videos[at.source]; return v.readyState >= 2 && !v.seeking && Math.abs(v.currentTime - at.t) < 0.02; })()`), 'the preview frame');
  await sleep(200);
}

// A project edit made with the editor's own store and core, as one undo step.
const apply = (ed, fn) => ed.js(`import('../../core/project.js').then((P) => { window.__editor.store.apply((p) => (${fn})(P, p)); })`);

// Sets a form control's value the way typing or picking does.
const setControl = (ed, id, value, events = ['input', 'change']) => ed.js(`(() => { const el = document.getElementById(${JSON.stringify(id)});
  el.value = ${JSON.stringify(value)}; for (const e of ${JSON.stringify(events)}) el.dispatchEvent(new Event(e, { bubbles: true })); })()`);

async function exportVideo(ed, shot) {
  await ed.clickOn('#exportBtn');
  await waitFor(() => ed.js('window.__editor.exportDialog.isOpen'), 'the export dialog');
  await ed.clickOn('#exportFormat .seg-btn[data-value="mp4"]');
  await ed.clickOn('#exportResolution .seg-btn[data-value="720p"]');
  assert.strictEqual(await ed.js('document.getElementById("exportBurnCaptions").checked'), true, 'captions are burned in');
  await ed.clickOn('#exportStart');
  await waitFor(() => ed.js('window.__editor.exportDialog.state !== "running"'), 'the export', 120000);
  assert.strictEqual(await ed.js('window.__editor.exportDialog.state'), 'done', await ed.js('document.getElementById("exportError")?.textContent ?? ""'));
  const file = await ed.js('document.querySelector(".export-dialog").dataset.file');
  if (shot) await ed.shot(shot);
  await ed.clickOn('.export-dialog .btn.primary');
  await sleep(200);
  return file;
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    log(`ok - ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    log(`not ok - ${name}\n  ${String(err.stack ?? err).split('\n').slice(0, 5).join('\n  ')}`);
    throw err;
  }
}

// The bottom of the frame, where the captions are.
const CAPTIONS = { y0: 0.6, y1: 1 };

async function main() {
  let settings = { presets: [], defaultPresetId: null };
  registerPresetsIpc({ ipcMain, store: { get: () => settings, patch: (p) => { settings = { ...settings, ...p }; } } });
  registerCaptionsIpc({
    ipcMain, app, dialog, BrowserWindow,
    models: createSpeechModels({ root: () => path.join(app.getPath('userData'), 'speech-models') })
  });
  for (const f of fs.existsSync(OUT) ? fs.readdirSync(OUT) : []) if (/^text-.*\.png$/.test(f)) fs.rmSync(path.join(OUT, f));
  const dir = makeRecording();
  log(`# recording: ${dir}`);
  const ed = await openEditor(dir);
  const style = async () => (await ed.project()).captions.style;

  try {
    await waitFor(() => ed.js('Object.values(window.__editor.player.videos).every((v) => v.readyState >= 2)'), 'the video');
    // Nothing but the recording's plain colour behind the words.
    await apply(ed, `(P, p) => P.setStyle(p, { padding: 0, radius: 0, shadow: 0, background: { type: 'none', value: null }, cursor: { show: false } })`);
    await apply(ed, `(P, p) => P.setCaptions(p, { show: true, segments: [${JSON.stringify(CAPTION)}], style: { size: 1.5 } })`);
    await ed.clickOn('#tabs [data-panel="captions"]');

    await step('the Captions tab offers five styles, each a drawn preview', async () => {
      await waitFor(() => ed.js('document.getElementById("captionPresets")?.offsetParent !== null'), 'the style tiles');
      const ids = await ed.js('Array.from(document.querySelectorAll(".cap-preset")).map((b) => b.id)');
      assert.deepStrictEqual(ids, ['classic', 'outline', 'karaoke', 'pop', 'typewriter'].map((n) => `captionPreset-${n}`));
      await sleep(300);
      // Each tile has a caption drawn on it: near-white words, or the dark box
      // behind them (a tile may be between words at this moment).
      const drawn = await ed.js(`Array.from(document.querySelectorAll('.cap-preset canvas')).map((c) => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let light = 0; let dark = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) light++;
          if (d[i] < 45 && d[i + 1] < 45 && d[i + 2] < 60) dark++;
        }
        return { light, dark }; })`);
      for (const [i, n] of drawn.entries()) assert.ok(n.light > 60 || n.dark > 500, `tile ${ids[i]} is drawn (${JSON.stringify(n)})`);
      assert.strictEqual(await ed.js('document.getElementById("captionPreset-classic").getAttribute("aria-pressed")'), 'true');
      assert.strictEqual((await style()).preset, 'classic');
      await ed.shot('text-01-caption-styles');
    });

    await step('the style tiles are drawn by the layer itself: the Karaoke tile changes as its words are spoken', async () => {
      const lit = () => ed.js(`(() => { const c = document.querySelector('#captionPreset-karaoke canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, sx = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 170 && d[i + 2] < 90) { n++; sx += (i / 4) % c.width; }
        return n ? sx / n / c.width : null; })()`);
      const seen = new Set();
      for (let i = 0; i < 40 && seen.size < 3; i++) {
        const x = await lit();
        if (x !== null) seen.add(Math.round(x * 8));
        await sleep(90);
      }
      assert.ok(seen.size >= 3, `the lit word moves along the tile (${[...seen]})`);
    });

    await step('picking Karaoke sets the style, and a new spoken-word colour is one undo step', async () => {
      await ed.clickOn('#captionPreset-karaoke');
      let s = await style();
      assert.strictEqual(s.preset, 'karaoke');
      assert.strictEqual(s.animation, 'highlight');
      assert.strictEqual(s.size, 1.5, 'size is left alone');
      assert.strictEqual(await ed.js('document.getElementById("captionPreset-karaoke").getAttribute("aria-pressed")'), 'true');
      assert.strictEqual(await ed.js('document.getElementById("captionActiveColor").value'), '#ffd60a');
      // Dragging about in the colour picker, then letting go.
      await setControl(ed, 'captionActiveColor', '#ff8080', ['input']);
      await setControl(ed, 'captionActiveColor', '#ff4040', ['input']);
      await setControl(ed, 'captionActiveColor', SPOKEN, ['input', 'change']);
      s = await style();
      assert.strictEqual(s.activeColor, SPOKEN);
      assert.strictEqual(s.preset, 'custom', 'no longer exactly Karaoke');
      assert.strictEqual(await ed.js('document.querySelectorAll(".cap-preset[aria-pressed=true]").length'), 0);
      await ed.js('document.activeElement?.blur()');
      await ed.key('z', [MOD]);
      assert.strictEqual((await style()).activeColor, '#ffd60a', 'one undo takes the whole colour change back');
      assert.strictEqual((await style()).preset, 'karaoke');
      await ed.key('z', [MOD, 'shift']);
      assert.strictEqual((await style()).activeColor, SPOKEN);
      await ed.settle();
      assert.strictEqual(readProject(dir).captions.style.activeColor, SPOKEN, 'saved to project.json');
      assert.strictEqual(readProject(dir).captions.style.animation, 'highlight');
    });

    await step('karaoke in the preview: the spoken word is red, and it is a later word later on', async () => {
      await seek(ed, 1.5);
      const first = await previewPicture(ed, CAPTIONS);
      await ed.shot('text-02-karaoke-first-word');
      await seek(ed, 4.5);
      const last = await previewPicture(ed, CAPTIONS);
      await ed.shot('text-03-karaoke-last-word');
      log(`# preview karaoke: at 1.5 s ${JSON.stringify(first)}, at 4.5 s ${JSON.stringify(last)}`);
      assert.ok(first.red > 80 && last.red > 80, 'a red word both times');
      assert.ok(first.redX < 0.42, `the first word, on the left (${first.redX})`);
      assert.ok(last.redX > 0.58, `the last word, on the right (${last.redX})`);
      // Words already spoken are bright, words to come are dim.
      assert.ok(last.light > first.light * 2, `more bright words late (${last.light}) than early (${first.light})`);
      // Outside the caption nothing is drawn.
      await seek(ed, 6.5);
      const none = await previewPicture(ed, CAPTIONS);
      assert.strictEqual(none.red, 0);
      assert.strictEqual(none.light, 0);
    });

    let karaokeFile;
    let exported;
    await step('karaoke in the export: the same words at the same moments', async () => {
      karaokeFile = await exportVideo(ed, 'text-04-export-done');
      const first = exportedFrame(karaokeFile, 1.5, 'text-export-karaoke-1.png', CAPTIONS);
      const last = exportedFrame(karaokeFile, 4.5, 'text-export-karaoke-2.png', CAPTIONS);
      const none = exportedFrame(karaokeFile, 6.5, 'text-export-karaoke-3.png', CAPTIONS);
      log(`# export karaoke: at 1.5 s ${JSON.stringify(first)}, at 4.5 s ${JSON.stringify(last)}, at 6.5 s ${JSON.stringify(none)}`);
      assert.ok(first.red > 80 && last.red > 80, 'a red word both times');
      assert.ok(first.redX < 0.42, `the first word, on the left (${first.redX})`);
      assert.ok(last.redX > 0.58, `the last word, on the right (${last.redX})`);
      assert.ok(last.light > first.light * 2, `more bright words late (${last.light}) than early (${first.light})`);
      assert.ok(none.red === 0 && none.light === 0, 'nothing after the caption');
    });

    await step('typewriter in the preview: words appear as they are spoken', async () => {
      await ed.clickOn('#captionPreset-typewriter');
      const s = await style();
      assert.strictEqual(s.preset, 'typewriter');
      assert.strictEqual(s.animation, 'typewriter');
      assert.strictEqual(s.font, 'mono');
      assert.strictEqual(await ed.js('document.getElementById("captionFont").value'), 'mono');
      await seek(ed, 1.5);
      const early = await previewPicture(ed, CAPTIONS);
      await ed.shot('text-05-typewriter-early');
      await seek(ed, 4.5);
      const late = await previewPicture(ed, CAPTIONS);
      await ed.shot('text-06-typewriter-late');
      log(`# preview typewriter: early ${JSON.stringify(early)}, late ${JSON.stringify(late)}`);
      assert.ok(early.light > 40, 'the first word is there');
      assert.ok(late.light > early.light * 2.5, `more words late (${late.light}) than early (${early.light})`);
      assert.strictEqual(late.red, 0, 'no spoken-word colour in this style');
    });

    await step('a font change changes the drawn pixels', async () => {
      await ed.clickOn('#captionPreset-classic');
      assert.strictEqual((await style()).font, 'system');
      await seek(ed, 2.5);
      const system = await previewPixels(ed);
      await setControl(ed, 'captionFont', 'serif', ['change']);
      assert.strictEqual((await style()).font, 'serif');
      assert.strictEqual((await style()).preset, 'custom');
      await sleep(250);
      const serif = await previewPixels(ed);
      await ed.shot('text-07-serif');
      const changed = differing(system, serif);
      log(`# font change: ${changed} pixels differ`);
      assert.ok(changed > 150, `the words are drawn differently (${changed} pixels)`);
      // And the colour of the words.
      await setControl(ed, 'captionColor', '#ff2020');
      await sleep(250);
      assert.ok((await previewPicture(ed, CAPTIONS)).red > 150, 'red words');
      await ed.key('z', [MOD]);
      assert.strictEqual((await style()).color, '#ffffff');
    });

    // ---- text styling: a ready-made style from the Text menu, then its settings
    let note;
    const annotation = async () => (await ed.project()).annotations.find((q) => q.id === note.id);

    await step('the Text menu offers three ready-made styles, and picking one adds styled text', async () => {
      await seek(ed, 5.2);
      await ed.clickOn('#textBtn');
      const offered = await ed.js('Array.from(document.querySelectorAll(".tool-menu-item")).filter((b) => b.offsetParent).map((b) => b.id)');
      assert.deepStrictEqual(offered.slice(0, 4), ['addText', 'addTitle', 'addArrow', 'addBox'], 'the four that were there, first');
      assert.deepStrictEqual(offered.slice(4), ['addLowerThird-name', 'addLowerThird-chapter', 'addLowerThird-callout']);
      await ed.shot('text-08-text-menu');
      await ed.clickOn('#addLowerThird-callout');
      await ed.settle();
      note = (await ed.project()).annotations.at(-1);
      assert.strictEqual(note.type, 'text');
      assert.deepStrictEqual([note.font, note.weight, note.background, note.animateIn], ['rounded', 'bold', '#ffd60a', 'pop']);
      assert.ok(note.y > 0.7, 'placed low on the picture');
      assert.ok(note.start >= 5 - 1e-6, `after the caption (${note.start})`);
      assert.deepStrictEqual(await ed.js('window.__editor.store.selection'), { kind: 'annotation', id: note.id });
      // Its settings show what it has.
      assert.strictEqual(await ed.js('document.getElementById("annoFont").value'), 'rounded');
      assert.strictEqual(await ed.js('document.getElementById("annoIn").value'), 'pop');
      assert.strictEqual(await ed.js('document.querySelector("#annoWeight .seg-btn[aria-pressed=true]").dataset.value'), 'bold');
      assert.strictEqual(await ed.js('document.querySelector("#annoBackground .swatch[aria-pressed=true]").dataset.background'), '#ffd60a');
      assert.deepStrictEqual(readProject(dir).annotations.at(-1), note, 'saved to project.json');
      await seek(ed, note.start + 1.5);
      await ed.shot('text-09-callout');
    });

    await step('weight, alignment, outline and background are set from the text\'s settings', async () => {
      await ed.clickOn('#annoWeight .seg-btn[data-value="regular"]');
      await ed.clickOn('#annoAlign .seg-btn[data-value="left"]');
      await ed.clickOn('#annoBackground .swatch[data-background="default"]');
      let a = await annotation();
      assert.deepStrictEqual([a.weight, a.align, a.background], ['regular', 'left', null]);
      // The outline slider, dragged: one undo step.
      await setControl(ed, 'annoOutline', '0.2', ['input']);
      await setControl(ed, 'annoOutline', '0.45', ['input']);
      await setControl(ed, 'annoOutline', '0.6', ['input', 'change']);
      assert.strictEqual((await annotation()).outline, 0.6);
      await ed.js('document.activeElement?.blur()');
      await ed.key('z', [MOD]);
      a = await annotation();
      assert.strictEqual(a.outline, 0, 'one undo takes the whole drag back');
      assert.strictEqual(a.background, null, 'and nothing before it');
      await ed.key('z', [MOD, 'shift']);
      assert.strictEqual((await annotation()).outline, 0.6);
      await ed.clickOn('#annoBackground .swatch[data-background="#ffd60a"]');
      await ed.settle();
      assert.strictEqual(readProject(dir).annotations.at(-1).background, '#ffd60a');
    });

    await step('a font change changes the text\'s pixels', async () => {
      await seek(ed, note.start + 1.5);
      const before = await previewPixels(ed);
      await setControl(ed, 'annoFont', 'serif', ['change']);
      assert.strictEqual((await annotation()).font, 'serif');
      await sleep(250);
      const changed = differing(before, await previewPixels(ed));
      log(`# text font change: ${changed} pixels differ`);
      assert.ok(changed > 100, `the words are drawn differently (${changed} pixels)`);
    });

    await step('fade in: fainter at its start than a moment later, in the preview', async () => {
      await setControl(ed, 'annoIn', 'fade', ['change']);
      await setControl(ed, 'annoAnimateSeconds', '0.5', ['input']);
      await setControl(ed, 'annoAnimateSeconds', '1', ['input', 'change']);
      const a = await annotation();
      assert.deepStrictEqual([a.animateIn, a.animateSeconds], ['fade', 1]);
      await ed.settle();
      assert.strictEqual(readProject(dir).annotations.at(-1).animateSeconds, 1);
      // Nothing selected, so no handles are drawn over the picture.
      await ed.js('window.__editor.store.select(null)');
      await seek(ed, a.start + 0.2);
      const early = await previewPicture(ed, CAPTIONS);
      await ed.shot('text-10-fade-early');
      await seek(ed, a.start + 1.5);
      const late = await previewPicture(ed, CAPTIONS);
      await ed.shot('text-11-fade-late');
      log(`# preview fade: early ${early.away.toFixed(2)}, late ${late.away.toFixed(2)}`);
      assert.ok(early.away > 0.3, 'already showing a little');
      assert.ok(early.away < late.away * 0.5, `fainter at its start (${early.away}) than later (${late.away})`);
    });

    await step('typewriter in the export: fewer words early than late', async () => {
      await ed.clickOn('#tabs [data-panel="captions"]');
      await ed.clickOn('#captionPreset-typewriter');
      const file = await exportVideo(ed);
      assert.notStrictEqual(file, karaokeFile);
      const early = exportedFrame(file, 1.5, 'text-export-typewriter-1.png', CAPTIONS);
      const late = exportedFrame(file, 4.5, 'text-export-typewriter-2.png', CAPTIONS);
      log(`# export typewriter: early ${JSON.stringify(early)}, late ${JSON.stringify(late)}`);
      assert.ok(early.light > 40, 'the first word is there');
      assert.ok(late.light > early.light * 2.5, `more words late (${late.light}) than early (${early.light})`);
      exported = file;
    });

    await step('fade in, in the export: fainter at its start than a moment later', async () => {
      const a = await annotation();
      const early = exportedFrame(exported, a.start + 0.2, 'text-export-fade-1.png', CAPTIONS);
      const late = exportedFrame(exported, a.start + 1.5, 'text-export-fade-2.png', CAPTIONS);
      // The same part of the picture with nothing on it, from the first export
      // (made before the text was added): what "not there" measures as.
      const empty = exportedFrame(karaokeFile, a.start + 1.5, 'text-export-fade-0.png', CAPTIONS).away;
      log(`# export fade: early ${(early.away - empty).toFixed(2)}, late ${(late.away - empty).toFixed(2)} above the empty picture's ${empty.toFixed(2)}`);
      assert.ok(early.away - empty > 0.3, 'already showing a little');
      assert.ok(early.away - empty < (late.away - empty) * 0.5, `fainter at its start (${early.away - empty}) than later (${late.away - empty})`);
    });

    const errors = ed.errors.filter((e) => !/Electron Security Warning|willReadFrequently/.test(e));
    assert.deepStrictEqual(errors, [], 'no errors in the editor console');
  } finally {
    if (ed.errors.length) log(`# console: ${ed.errors.join(' | ')}`);
    ed.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  log(`\n${results.length - failed}/${results.length} passed; screenshots in test/e2e/out/editor/text-*.png`);
  return failed ? 1 : 0;
}

app.whenReady().then(main).then(
  (code) => app.exit(code),
  (err) => { log(`not ok - ${err.stack ?? err}`); app.exit(1); }
);
