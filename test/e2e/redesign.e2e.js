'use strict';
// The redesigned editor, in the real app with the real mouse and keys: the
// right side follows what is selected and its back arrow returns to the
// video's tabs; a modifier-click selects several things and Delete removes
// them as one undo step; a box drawn across the timeline selects what it
// touches; a zoom switched off from its right-click menu leaves the export
// unzoomed; a clip deleted with Close gaps off leaves black of the same
// length in the export; Alt-drag puts a speed badge on the clip; the Text
// menu and Blur add annotations; the transcript beside the preview lists the
// words and a click goes to one. Screenshots go to test/e2e/out/redesign/.
//
//   node_modules/.bin/electron test/e2e/redesign.e2e.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const electron = require('electron');

const { app, BrowserWindow } = electron;
const VIDEOS = path.join(__dirname, '..', 'fixtures', 'videos');
const OUT = path.join(__dirname, 'out', 'redesign');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOD = process.platform === 'darwin' ? 'meta' : 'control';

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-redesign-')));
const home = path.join(work, 'home');
const userData = path.join(work, 'userData');
fs.mkdirSync(home);
fs.mkdirSync(userData);
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', userData);
os.homedir = () => home;
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ countdown: false, systemAudio: false, recordCamera: false }));

let nextChoice = null;
electron.dialog.showOpenDialog = async () => {
  const files = nextChoice === null ? [] : [].concat(nextChoice);
  return { canceled: !files.length, filePaths: files };
};

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

async function waitFor(what, fn, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const pageOf = (name) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() &&
  w.webContents.getURL().includes(`/renderer/${name}/`));
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

// One frame at `at` seconds as 16x16 grey pixels (for comparing moments).
function tinyFrame(file, at) {
  return execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-vf', 'scale=16:16,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
}
const meanDiff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const lengthOf = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());

async function run() {
  require('../../src/main/main');
  const picker = await waitFor('the picker', () => pageOf('picker'));
  await waitFor('the picker to load', () => !picker.webContents.isLoading());
  nextChoice = path.join(VIDEOS, 'video6.mp4');
  await picker.webContents.executeJavaScript('document.getElementById("importVideo").click()');
  const editor = await waitFor('the editor', () => pageOf('editor'), 30000);
  await waitFor('the editor to load', () => editor.webContents.executeJavaScript('document.body.dataset.ready === "true"'), 30000);
  editor.webContents.setBackgroundThrottling(false);
  const js = (code) => editor.webContents.executeJavaScript(code);
  const send = (e) => editor.webContents.sendInputEvent(e);
  const shot = async (name) => {
    await sleep(250);
    fs.writeFileSync(path.join(OUT, `${name}.png`), (await editor.webContents.capturePage()).toPNG());
  };
  async function key(keyCode, modifiers = []) {
    await js('document.activeElement?.blur()');
    send({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1) send({ type: 'char', keyCode, modifiers });
    send({ type: 'keyUp', keyCode, modifiers });
    await sleep(120);
  }
  async function click(x, y, { modifiers = [], button = 'left' } = {}) {
    send({ type: 'mouseMove', x, y, modifiers });
    send({ type: 'mouseDown', x, y, button, clickCount: 1, modifiers });
    send({ type: 'mouseUp', x, y, button, clickCount: 1, modifiers });
    await sleep(120);
  }
  async function drag(x0, y0, x1, y1, { modifiers = [] } = {}) {
    send({ type: 'mouseMove', x: x0, y: y0, modifiers });
    send({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1, modifiers });
    for (let i = 1; i <= 12; i++) {
      send({
        type: 'mouseMove', x: Math.round(x0 + ((x1 - x0) * i) / 12), y: Math.round(y0 + ((y1 - y0) * i) / 12),
        modifiers: ['leftButtonDown', ...modifiers]
      });
      await sleep(16);
    }
    send({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1, modifiers });
    await sleep(150);
  }
  const box = async (selector) => {
    const r = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
      el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    assert.ok(r && r.w > 0, `no visible element ${selector}`);
    return r;
  };
  const centre = async (selector) => {
    const r = await box(selector);
    return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
  };
  const clickOn = async (selector, opts) => { const c = await centre(selector); await click(c.x, c.y, opts); };
  const tx = (t) => js(`Math.round(window.__editor.timeline.clientX(${t}))`);
  const project = () => js('window.__editor.store.project');
  const selected = () => js('window.__editor.store.selected');
  const sidebar = () => js('({ ...document.getElementById("sidebar").dataset })');
  const seek = (t) => js(`window.__editor.player.seek(${t})`);
  const exportFile = async () => {
    await js('window.__editor.saver.flush()');
    return (await js('window.loupe.exportVideo({ resolution: "720p" })')).file;
  };
  await js('document.querySelector(".first-run .btn")?.click()');
  const reference = await exportFile();
  const fullLength = lengthOf(reference);

  await check('nothing selected: the video’s five tabs, Look first', async () => {
    assert.deepStrictEqual(await js('[...document.querySelectorAll("#tabs .tab")].map((t) => t.textContent)'),
      ['Look', 'Cursor', 'Camera', 'Captions', 'Audio']);
    assert.deepStrictEqual(await sidebar(), { panel: 'style', mode: 'video' });
    assert.strictEqual(await js('document.getElementById("inspectorBack").hidden'), true);
    await clickOn('#tabs .tab[data-panel=audio]');
    assert.strictEqual((await sidebar()).panel, 'audio');
    await shot('01-video-tabs');
  });

  let zoomY;
  await check('selecting a zoom shows its settings under its name; the back arrow and Esc return to the tab that was open', async () => {
    await seek(1);
    await key('z');
    await seek(3.5);
    await key('z');
    assert.strictEqual((await project()).zooms.length, 2);
    assert.deepStrictEqual(await sidebar(), { panel: 'zoom', mode: 'item' });
    assert.strictEqual(await js('document.getElementById("panelTitle").textContent'), 'Zoom');
    assert.strictEqual(await js('document.getElementById("tabs").hidden'), true);
    await shot('02-zoom-inspector');
    await clickOn('#inspectorBack');
    assert.deepStrictEqual(await sidebar(), { panel: 'audio', mode: 'video' }, 'back to the tab that was open');
    zoomY = (await centre('.tl-zooms .zoom')).y;
    await clickOn('.tl-zooms .zoom');
    assert.strictEqual((await sidebar()).panel, 'zoom');
    await key('Escape');
    assert.deepStrictEqual(await sidebar(), { panel: 'audio', mode: 'video' });
  });

  await check('a modifier-click selects two zooms; Delete removes both as one undo step', async () => {
    const [a, b] = (await project()).zooms;
    await clickOn(`.zoom[data-id="${a.id}"]`);
    await clickOn(`.zoom[data-id="${b.id}"]`, { modifiers: [MOD] });
    assert.deepStrictEqual((await selected()).map((s) => s.id), [a.id, b.id]);
    assert.deepStrictEqual(await sidebar(), { panel: 'multi', mode: 'item' });
    assert.strictEqual(await js('document.getElementById("panelTitle").textContent'), '2 items selected');
    assert.strictEqual(await js('document.getElementById("multiWhat").textContent'), '2 zooms');
    assert.strictEqual(await js('document.querySelectorAll(".zoom.selected").length'), 2);
    await shot('03-two-selected');
    // The same click again takes one back out.
    await clickOn(`.zoom[data-id="${b.id}"]`, { modifiers: ['shift'] });
    assert.deepStrictEqual((await selected()).map((s) => s.id), [a.id]);
    await clickOn(`.zoom[data-id="${b.id}"]`, { modifiers: ['shift'] });
    await key('Backspace');
    assert.strictEqual((await project()).zooms.length, 0);
    assert.match(await js('document.getElementById("toast").textContent'), /Deleted 2 items/);
    await key('z', [MOD]);
    assert.strictEqual((await project()).zooms.length, 2, 'one undo brings both back');
  });

  await check('a box drawn from empty space selects what it touches; ⌘A selects everything', async () => {
    await key('Escape');
    const sound = await box('.tl-audio');
    // From below the rows, up across the zoom row, over both zooms.
    await drag(await tx(0.2), Math.round(sound.y + sound.h - 2), await tx(5.5), zoomY);
    const got = await selected();
    assert.strictEqual(got.filter((s) => s.kind === 'zoom').length, 2, `the box took both zooms: ${JSON.stringify(got)}`);
    assert.strictEqual(await js('document.querySelector(".tl-box").hidden'), true, 'the box goes when the drag ends');
    await key('Escape');
    assert.strictEqual((await selected()).length, 0);
    await key('a', [MOD]);
    const all = await selected();
    assert.ok(all.some((s) => s.kind === 'clip') && all.filter((s) => s.kind === 'zoom').length === 2, JSON.stringify(all));
    await key('Escape');
  });

  await check('a zoom switched off from its right-click menu stays on the timeline and leaves the export unzoomed', async () => {
    const [a] = (await project()).zooms;
    // Make it a strong zoom on a corner, so its effect is plain in pixels.
    await js(`window.__editor.store.apply((p) => window.__editor.editor.core.updateZoom(p, ${JSON.stringify(a.id)}, { level: 3, follow: false, x: 20, y: 15 }))`);
    const at = (a.start + a.end) / 2;
    const zoomed = await exportFile();
    assert.ok(meanDiff(tinyFrame(zoomed, at), tinyFrame(reference, at)) > 5, 'the zoom changes the exported picture');
    await clickOn(`.zoom[data-id="${a.id}"]`, { button: 'right' });
    assert.strictEqual(await js('document.querySelector(".ctx-menu").hidden'), false, 'the menu opens');
    await shot('04-zoom-menu');
    await clickOn('#zoomToggle');
    assert.strictEqual((await project()).zooms.find((z) => z.id === a.id).disabled, true);
    assert.strictEqual(await js(`document.querySelector('.zoom[data-id="${a.id}"]').classList.contains('disabled')`), true);
    const off = await exportFile();
    assert.ok(meanDiff(tinyFrame(off, at), tinyFrame(reference, at)) < 3, 'switched off: the export is as the recording');
    await shot('05-zoom-off');
    // And back on.
    await clickOn(`.zoom[data-id="${a.id}"]`, { button: 'right' });
    assert.strictEqual(await js('document.getElementById("zoomToggle").textContent'), 'Switch on');
    await clickOn('#zoomToggle');
    assert.strictEqual((await project()).zooms.find((z) => z.id === a.id).disabled, false);
    await js('window.__editor.store.apply((p) => ({ ...p, zooms: [] }))');
  });

  await check('Close gaps off: a deleted clip leaves black of the same length; on: the video closes up', async () => {
    await seek(2);
    await key('s');
    await seek(4);
    await key('s');
    assert.strictEqual((await project()).clips.length, 3);
    assert.strictEqual(await js('document.getElementById("gapsBtn").getAttribute("aria-pressed")'), 'true', 'Close gaps starts on');
    await clickOn('#gapsBtn');
    const middle = (await project()).clips[1];
    await clickOn(`.clip[data-id="${middle.id}"] .clip-label`);
    await key('Backspace');
    const p = await project();
    assert.strictEqual(p.clips.length, 3);
    assert.strictEqual(p.clips[1].gap, true);
    assert.strictEqual(await js('document.querySelector(".clip.gap .clip-name").textContent'), 'Gap');
    near(await js('window.__editor.store.tl.duration'), 6, 0.01, 'the video keeps its length');
    await shot('06-gap');
    const gapped = await exportFile();
    near(lengthOf(gapped), fullLength, 0.1, 'the export keeps its length');
    assert.ok(mean(tinyFrame(gapped, 3)) < 12, `the gap is black in the export: ${mean(tinyFrame(gapped, 3))}`);
    assert.ok(meanDiff(tinyFrame(gapped, 5), tinyFrame(reference, 5)) < 3, 'after the gap the video is where it was');
    // The gap selected: the inspector names it; deleting it closes up.
    await clickOn('.clip.gap .clip-label');
    assert.strictEqual(await js('document.getElementById("panelTitle").textContent'), 'Gap');
    await clickOn('#gapsBtn');
    await key('Backspace');
    assert.strictEqual((await project()).clips.length, 2);
    near(await js('window.__editor.store.tl.duration'), 4, 0.01, 'closed up');
    await key('z', [MOD]);
    await key('z', [MOD]);
    assert.strictEqual((await project()).clips.every((c) => !c.gap), true, 'undo brings the clip back');
  });

  await check('Alt-drag across a clip sets a speed, shown as a badge on it; the Clip inspector sets the whole clip', async () => {
    const y = (await centre('.tl-clips .clip')).y;
    await drag(await tx(0.4), y, await tx(1.4), y, { modifiers: ['alt'] });
    assert.strictEqual(await js('!document.querySelector(".speed-menu").hidden'), true, 'the speed menu opens');
    await clickOn('.speed-menu button[data-rate="2"]');
    assert.strictEqual((await project()).speed.length, 1);
    assert.strictEqual(await js('document.querySelector(".tl-clips .speed").textContent'), '2×');
    assert.strictEqual(await js('document.querySelector(".tl-speed")'), null, 'no Speed row');
    await shot('07-speed-badge');
    const first = (await project()).clips[0];
    await key('Escape');
    await clickOn(`.clip[data-id="${first.id}"] .clip-label`);
    assert.deepStrictEqual(await sidebar(), { panel: 'clip', mode: 'item' });
    await js('document.querySelector("#clipSpeeds [data-rate=\\"1\\"]").click()');
    assert.deepStrictEqual((await project()).speed, [], 'Normal over the whole clip takes the speed away');
    await key('Escape');
  });

  await check('Text menu and Blur add at the playhead and show that thing’s settings; the Text row appears', async () => {
    assert.strictEqual(await js('document.querySelector(".tl-annotations").hidden'), true, 'no Text row while there is none');
    await seek(1);
    await clickOn('#textBtn');
    assert.strictEqual(await js('document.getElementById("textBtn").getAttribute("aria-expanded")'), 'true');
    await shot('08-text-menu');
    await clickOn('#addTitle');
    assert.strictEqual((await project()).annotations.at(-1).type, 'title');
    assert.strictEqual(await js('document.getElementById("panelTitle").textContent'), 'Title card');
    assert.strictEqual(await js('document.querySelector(".tl-annotations").hidden'), false);
    assert.strictEqual(await js('document.querySelector(".lbl-annotations").textContent'), 'Text');
    await key('Escape');
    await seek(4);
    await key('b');
    assert.strictEqual((await project()).annotations.at(-1).type, 'blur');
    assert.strictEqual(await js('document.getElementById("panelTitle").textContent'), 'Blur');
    await key('Escape');
    await key('t');
    assert.strictEqual((await project()).annotations.at(-1).type, 'text');
    await key('Escape');
  });

  await check('the transcript opens beside the preview, lists the words in order, and a click goes to one', async () => {
    assert.strictEqual(await js('document.getElementById("transcript").hidden'), true, 'folded until asked for');
    await clickOn('#transcriptBtn');
    assert.strictEqual(await js('document.getElementById("transcript").hidden'), false);
    assert.strictEqual(await js('!!document.getElementById("transcriptWrite").offsetParent'), true, 'no captions yet: a way to write them');
    const main = (await project()).clips[0].source;
    await js(`window.__editor.store.apply((p) => window.__editor.editor.core.setCaptions(p, { segments: [
      { id: 's1', source: ${JSON.stringify(main)}, start: 0.5, end: 2, text: 'Hello there world',
        words: [{ text: 'Hello', start: 0.5, end: 0.9 }, { text: 'there', start: 1.0, end: 1.4 }, { text: 'world', start: 1.5, end: 2 }] },
      { id: 's2', source: ${JSON.stringify(main)}, start: 3, end: 4, text: 'Second line' }] }))`);
    assert.deepStrictEqual(await js('[...document.querySelectorAll("#transcriptBody .tw")].map((w) => w.textContent)'),
      ['Hello', 'there', 'world', 'Second line']);
    assert.strictEqual(await js('document.querySelectorAll("#transcriptBody .transcript-line").length'), 2);
    await clickOn('#transcriptBody .tw[data-i="2"]');
    near(await js('window.__editor.player.time'), 1.5, 0.05, 'the playhead goes to the word');
    assert.strictEqual(await js('document.querySelector("#transcriptBody .tw.now").textContent'), 'world');
    await shot('09-transcript');
    // The preview still fits beside it.
    const stage = await box('#stage');
    const preview = await box('#preview');
    assert.ok(preview.x >= stage.x && preview.x + preview.w <= stage.x + stage.w + 1, 'the preview stays inside its space');
    await clickOn('#transcriptClose');
    assert.strictEqual(await js('document.getElementById("transcript").hidden'), true);
    assert.strictEqual(await js('document.getElementById("transcriptBtn").getAttribute("aria-pressed")'), 'false');
  });

  await check('Snap off: a zoom dragged near the playhead no longer jumps to it', async () => {
    await js('window.__editor.store.apply((p) => ({ ...p, annotations: [], captions: { ...p.captions, segments: [] } }))');
    await seek(2);
    const y = zoomY;
    const startX = (await tx(2)) + 5;
    await drag(startX, y, await tx(3.2), y);
    let z = (await project()).zooms.at(-1);
    near(z.start, 2, 1e-6, 'with Snap on the new zoom starts exactly at the playhead');
    await js('window.__editor.store.undo()');
    await clickOn('#snapBtn');
    assert.strictEqual(await js('window.__editor.timeline.snap'), false);
    await drag(startX, y, await tx(3.2), y);
    z = (await project()).zooms.at(-1);
    assert.ok(z.start > 2.001, `with Snap off it starts where the drag did: ${z.start}`);
    await clickOn('#snapBtn');
  });

  console.log(`\n${passed} passed. Screenshots: ${OUT}`);
  await js('window.__editor.saver.flush()');
  editor.close();
  await waitFor('the editor to close', () => editor.isDestroyed(), 5000).catch(() => {});
  await sleep(300);
  fs.rmSync(work, { recursive: true, force: true });
}

app.whenReady().then(run).then(() => app.exit(0), (err) => {
  console.error(err);
  app.exit(1);
});
