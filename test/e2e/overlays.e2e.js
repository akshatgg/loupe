'use strict';
// A second video row: pictures and videos over the main video, and
// keyframes, checked in exported pixels in the real app. Over a solid red
// video: the Overlay button adds a green picture as a picture-in-picture in
// the bottom-right corner; the Clip panel moves it to the middle, sizes it,
// makes it see-through; its block drags along its row and trims; ◆
// keyframes grow it over time; a blue video overlay plays in its corner
// (preview too); and the main clip's own size animates with keyframes.
// Screenshots go to test/e2e/out/overlays/.
//
//   node_modules/.bin/electron test/e2e/overlays.e2e.js
// Needs ffmpeg on the PATH.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const electron = require('electron');

const { app, BrowserWindow } = electron;
const VIDEOS = path.join(__dirname, '..', 'fixtures', 'videos');
const OUT = path.join(__dirname, 'out', 'overlays');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-ovl-')));
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

// The frame at `at` seconds as a cols x rows grid of letters: r red,
// g green, b blue, . other.
function letters(file, at, cols = 32, rows = 18) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-vf', `scale=${cols}:${rows}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
  const out = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const i = 3 * (r * cols + c);
      const [R, G, B] = [raw[i], raw[i + 1], raw[i + 2]];
      line += G > 180 && R < 90 && B < 90 ? 'g' : B > 180 && R < 90 && G < 90 ? 'b' : R > 180 && G < 90 && B < 90 ? 'r' : '.';
    }
    out.push(line);
  }
  return out;
}
const count = (grid, ch) => grid.join('').split('').filter((c) => c === ch).length;
const box = (grid, ch) => {
  let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1;
  grid.forEach((line, y) => [...line].forEach((c, x) => { if (c === ch) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } }));
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
};

async function run() {
  require('../../src/main/main');
  const picker = await waitFor('the picker', () => pageOf('picker'));
  await waitFor('the picker to load', () => !picker.webContents.isLoading());
  nextChoice = path.join(VIDEOS, 'red.mp4');
  await picker.webContents.executeJavaScript('document.getElementById("importVideo").click()');
  const editor = await waitFor('the editor', () => pageOf('editor'), 30000);
  await waitFor('the editor to load', () => editor.webContents.executeJavaScript('document.body.dataset.ready === "true"'), 30000);
  // Playback runs on animation frames, which Chromium pauses in a window
  // hidden behind others (a busy desktop): not while this test watches it.
  editor.webContents.setBackgroundThrottling(false);
  const js = (code) => editor.webContents.executeJavaScript(code);
  const shot = async (name) => {
    await sleep(300);
    fs.writeFileSync(path.join(OUT, `${name}.png`), (await editor.webContents.capturePage()).toPNG());
  };
  const exportFile = async () => {
    await js('window.__editor.saver.flush()');
    return (await js('window.loupe.exportVideo({ resolution: "720p" })')).file;
  };
  const slide = (id, v) => js(`(() => { const i = document.getElementById('${id}'); i.value = '${v}';
    i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const overlays = () => js('window.__editor.store.project.overlays');
  await js('document.querySelector(".first-run .btn")?.click()');
  // The red video lasts 2 s; four more of it, so there is room to move things.
  await js('window.__editor.store.apply((p) => window.__editor.editor.core.freezeFrame(p, 2, 4))');

  await check('the Overlay button puts a picture over the video: a picture-in-picture in the bottom-right corner, on row V2', async () => {
    await js('window.__editor.player.seek(0.5)');
    nextChoice = path.join(VIDEOS, 'green.png');
    await js('document.getElementById("addOverlayBtn").click()');
    await waitFor('the overlay', async () => (await overlays()).length === 1);
    const [o] = await overlays();
    assert.deepStrictEqual([o.kind, o.file, o.start, o.length, o.lane], ['image', 'media/green.png', 0.5, 5, 0]);
    assert.deepStrictEqual(await js('window.__editor.store.selection'), { kind: 'overlay', id: o.id });
    assert.strictEqual(await js('!document.querySelector(".oclip").hidden && document.querySelector(".lbl-overlay").textContent'), 'V2');
    assert.strictEqual(await js('document.getElementById("sidebar").dataset.panel'), 'clip', 'its settings show');
    await shot('01-added');
    const g = letters(await exportFile(), 1);
    const b = box(g, 'g');
    console.log(`    green at columns ${b.x0}-${b.x1}, rows ${b.y0}-${b.y1} of 32x18`);
    assert.ok(b.x0 > 16 && b.y0 > 9, 'in the bottom-right quarter');
    near(b.h, Math.round(18 * 0.35), 1.5, 'a third of the height (a square fitted to the height, at 35%)');
    assert.strictEqual(count(letters(await exportFile(), 0.2), 'g'), 0, 'not before it starts');
  });

  await check('the Clip panel moves it to the middle, sizes it and makes it see-through', async () => {
    await slide('overlayX', 0);
    await slide('overlayY', 0);
    await slide('overlayScale', 0.5);
    const [o] = await overlays();
    assert.deepStrictEqual([o.x, o.y, o.scale], [0, 0, 0.5]);
    let g = letters(await exportFile(), 1);
    const b = box(g, 'g');
    near((b.x0 + b.x1) / 2, 15.5, 1, 'centred across');
    near((b.y0 + b.y1) / 2, 8.5, 1, 'and down');
    near(b.h, 9, 1, 'half the height');
    await slide('overlayOpacity', 0.5);
    g = letters(await exportFile(), 1);
    assert.strictEqual(count(g, 'g'), 0, 'no solid green at half opacity');
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', await exportFile(), '-frames:v', '1', '-vf', 'crop=8:8:636:356,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    console.log(`    the middle at half opacity: ${[...raw].join(', ')}`);
    assert.ok(raw[0] > 90 && raw[1] > 90, 'half red, half green');
    await slide('overlayOpacity', 1);
  });

  await check('its block drags along its row and trims at its end', async () => {
    const [o] = await overlays();
    const b = await js(`(() => { const r = document.querySelector('.oclip').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const px = (await js('window.__editor.timeline.clientX(1)')) - (await js('window.__editor.timeline.clientX(0)'));
    const send = (e) => editor.webContents.sendInputEvent(e);
    const drag = async (x0, y0, x1) => {
      send({ type: 'mouseMove', x: x0, y: y0 });
      send({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 });
      for (let k = 1; k <= 10; k++) {
        send({ type: 'mouseMove', x: Math.round(x0 + ((x1 - x0) * k) / 10), y: y0, modifiers: ['leftButtonDown'] });
        await sleep(16);
      }
      send({ type: 'mouseUp', x: x1, y: y0, button: 'left', clickCount: 1 });
      await sleep(150);
    };
    const y = Math.round(b.y + b.h / 2);
    await drag(Math.round(b.x + b.w / 2), y, Math.round(b.x + b.w / 2 - px * 0.5));
    near((await overlays())[0].start, o.start - 0.5, 0.06, 'half a second earlier');
    const b2 = await js(`(() => { const r = document.querySelector('.oclip').getBoundingClientRect(); return { x: r.x, w: r.width }; })()`);
    await drag(Math.round(b2.x + b2.w - 3), y, Math.round(b2.x + b2.w - 3 - px * 2));
    near((await overlays())[0].length, 3, 0.06, 'two seconds shorter');
    await shot('02-moved-trimmed');
  });

  await check('◆ keyframes grow the picture over time: small at its start, full size 2 s later', async () => {
    await js('window.__editor.store.apply((p) => window.__editor.editor.core.updateOverlay(p, p.overlays[0].id, { start: 0, length: 5, x: 0, y: 0 }))');
    await js('window.__editor.player.seek(0)');
    await sleep(100);
    await slide('overlayScale', 0.2);
    await js('document.getElementById("overlayScaleKey").click()');
    await js('window.__editor.player.seek(2)');
    await sleep(100);
    await slide('overlayScale', 1);
    const [o] = await overlays();
    assert.deepStrictEqual(o.keyframes.scale.map((k) => [k.t, k.v]), [[0, 0.2], [2, 1]], 'two keyframes, the second set by moving the slider');
    assert.strictEqual(await js('document.getElementById("overlayScaleKey").classList.contains("on")'), true, '◆ lit at a keyframe');
    assert.strictEqual(await js('document.querySelectorAll(".oclip .kf-diamond").length'), 2, 'diamonds on its block');
    await shot('03-keyframes');
    const file = await exportFile();
    const small = box(letters(file, 0.05), 'g');
    const mid = box(letters(file, 1), 'g');
    const full = box(letters(file, 3), 'g');
    console.log(`    heights: ${small.h} at the start, ${mid.h} halfway, ${full.h} after (of 18)`);
    near(small.h, 18 * 0.2, 1.2, 'a fifth of the height at the start');
    near(full.h, 18, 1, 'the full height from 2 s');
    assert.ok(mid.h > small.h + 3 && mid.h < full.h - 3, 'growing in between');
    // Previous / next keyframe jump the playhead.
    await js('window.__editor.player.seek(1)');
    await js('document.getElementById("nextKeyframe").click()');
    near(await js('window.__editor.player.time'), 2, 1e-6, 'next keyframe');
    await js('document.getElementById("prevKeyframe").click()');
    near(await js('window.__editor.player.time'), 0, 1e-6, 'previous keyframe');
    await js('window.__editor.store.apply((p) => window.__editor.editor.core.removeOverlay(p, p.overlays[0].id))');
  });

  await check('a video overlay plays in its corner, in the export and in the preview', async () => {
    await js('window.__editor.player.seek(0)');
    nextChoice = path.join(VIDEOS, 'blue.mp4');
    await js('document.getElementById("addOverlayBtn").click()');
    await waitFor('the video overlay', async () => (await overlays()).length === 1);
    const [o] = await overlays();
    assert.deepStrictEqual([o.kind, o.length], ['video', 2]);
    const b = box(letters(await exportFile(), 1), 'b');
    assert.ok(b && b.x0 > 16 && b.y0 > 9, `blue in the bottom-right corner: ${JSON.stringify(b)}`);
    await js('window.__editor.player.seek(1)');
    await waitFor('the preview to show it', () => js(`(() => { const c = document.getElementById('preview');
      const d = c.getContext('2d').getImageData(Math.round(c.width * 0.8), Math.round(c.height * 0.8), 1, 1).data;
      return d[2] > 180 && d[0] < 90; })()`), 8000);
    await shot('04-video-overlay');
    await js('window.__editor.store.apply((p) => window.__editor.editor.core.removeOverlay(p, p.overlays[0].id))');
  });

  await check('the main clip’s size animates with ◆ keyframes too', async () => {
    const id = await js('window.__editor.store.project.clips[0].id');
    await js(`window.__editor.editor.select({ kind: 'clip', id: '${id}' })`);
    await js('window.__editor.player.seek(0)');
    await sleep(100);
    await js('document.getElementById("clipScaleKey").click()');
    await js('window.__editor.player.seek(1.9)');
    await sleep(100);
    await slide('clipScale', 0.5);
    const clip = await js('window.__editor.store.project.clips[0]');
    assert.deepStrictEqual(clip.keyframes.scale.map((k) => [Math.round(k.t * 100) / 100, k.v]), [[0, 1], [1.9, 0.5]]);
    const file = await exportFile();
    const start = box(letters(file, 0.02), 'r');
    const end = box(letters(file, 1.9), 'r');
    console.log(`    the red clip: ${start.w}x${start.h} at the start, ${end.w}x${end.h} at 1.9 s`);
    assert.ok(start.w >= 31 && start.h >= 17, 'full size at the start');
    near(end.w, 16, 1.5, 'half as wide');
    near(end.h, 9, 1.5, 'half as tall');
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
