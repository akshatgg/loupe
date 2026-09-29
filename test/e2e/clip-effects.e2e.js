'use strict';
// A clip's effects, checked in exported pixels, in the real app: a freeze
// frame (⇧F) holds one moment and the video carries on after it; "Play
// backwards" in the Clip panel shows the recording's moments from the end;
// the transitions between a solid red and a solid blue clip (wipe, slide,
// circle, zoom, dip to white, crossfade) put each colour where they should
// -- and the live preview draws a wipe the same way. Screenshots go to
// test/e2e/out/clip-effects/.
//
//   node_modules/.bin/electron test/e2e/clip-effects.e2e.js
// Needs ffmpeg on the PATH.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const electron = require('electron');

const { app, BrowserWindow, Menu } = electron;
const VIDEOS = path.join(__dirname, '..', 'fixtures', 'videos');
const OUT = path.join(__dirname, 'out', 'clip-effects');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-fx-')));
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

// One frame at `at` seconds as 16x16 grey pixels (for comparing moments).
function tinyFrame(file, at) {
  return execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-vf', 'scale=16:16,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
}
const meanDiff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

// One frame at `at` seconds as a cols x rows grid of { r, g, b }.
function grid(file, at, cols = 20, rows = 1) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-vf', `scale=${cols}:${rows}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
  const px = [];
  for (let i = 0; i < raw.length; i += 3) px.push({ r: raw[i], g: raw[i + 1], b: raw[i + 2] });
  return px;
}
const colour = ({ r, g, b }) => (r > 200 && g > 200 && b > 200 ? 'white' : r > b + 60 ? 'red' : b > r + 60 ? 'blue' : 'mix');

async function openEditor(previous = null) {
  const editor = await waitFor('the editor', () => {
    const e = pageOf('editor');
    return e && e !== previous ? e : null;
  }, 30000);
  await waitFor('the editor to load', () => editor.webContents.executeJavaScript('document.body.dataset.ready === "true"'), 30000);
  // Playback runs on animation frames, which Chromium pauses in a window
  // hidden behind others (a busy desktop): not while this test watches it.
  editor.webContents.setBackgroundThrottling(false);
  return editor;
}

async function run() {
  require('../../src/main/main');
  const picker = await waitFor('the picker', () => pageOf('picker'));
  await waitFor('the picker to load', () => !picker.webContents.isLoading());
  nextChoice = path.join(VIDEOS, 'video6.mp4');
  await picker.webContents.executeJavaScript('document.getElementById("importVideo").click()');
  let editor = await openEditor();
  let js = (code) => editor.webContents.executeJavaScript(code);
  const shot = async (name) => {
    await sleep(250);
    fs.writeFileSync(path.join(OUT, `${name}.png`), (await editor.webContents.capturePage()).toPNG());
  };
  const key = async (keyCode, modifiers = []) => {
    await js('document.activeElement?.blur()');
    editor.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1) editor.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
    editor.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(120);
  };
  const exportFile = async () => {
    await js('window.__editor.saver.flush()');
    return (await js('window.loupe.exportVideo({ resolution: "720p" })')).file;
  };
  await js('document.querySelector(".first-run .btn")?.click()');

  // The untouched video through the same export: frames of the edits are
  // compared with this (the same encoder), not with the source file.
  const reference = await exportFile();
  const same = (a, b) => meanDiff(a, b) < 3;
  const apart = (a, b) => meanDiff(a, b) > 5;

  await check('⇧F freezes the frame at the playhead for 2 seconds; the export holds it, then carries on', async () => {
    await js('window.__editor.player.seek(2)');
    await key('F', ['shift']);
    const clips = await js('window.__editor.store.project.clips');
    assert.deepStrictEqual(clips.map((c) => c.hold ?? null), [null, 2, null]);
    assert.ok(Math.abs((await js('window.__editor.store.tl.duration')) - 8) < 1e-6, '2 seconds longer');
    assert.strictEqual(await js('document.querySelector(".clip.freeze .clip-name").textContent'), 'Freeze frame');
    assert.strictEqual(await js('document.querySelector("#tabs [aria-selected=true]").dataset.panel'), 'clip', 'the Clip panel shows it');
    assert.strictEqual(await js('document.getElementById("holdLength").value'), '0:02.0');
    await shot('01-freeze');
    const file = await exportFile();
    const held = tinyFrame(file, 2.2);
    const later = tinyFrame(file, 3.8);
    console.log(`    held frames differ by ${meanDiff(held, later).toFixed(2)}; from the video at 2 s by ${meanDiff(held, tinyFrame(reference, 2)).toFixed(2)}, at 3 s by ${meanDiff(held, tinyFrame(reference, 3)).toFixed(2)}`);
    assert.ok(meanDiff(held, later) < 1, 'the same picture all through the hold');
    assert.ok(same(held, tinyFrame(reference, 2)) && apart(held, tinyFrame(reference, 3)), 'the moment at 2 s, not later');
    assert.ok(same(tinyFrame(file, 5), tinyFrame(reference, 3)), 'then the video carries on from there');
    // Its length typed in the Clip panel.
    await js(`(() => { const i = document.getElementById('holdLength'); i.value = '1'; i.dispatchEvent(new Event('change')); })()`);
    assert.ok(Math.abs((await js('window.__editor.store.tl.duration')) - 7) < 1e-6, 'held for 1 second');
    await key('z', ['meta']);
    await key('z', ['meta']);
    assert.ok(Math.abs((await js('window.__editor.store.tl.duration')) - 6) < 1e-6, 'undo takes it all back');
  });

  await check('"Play backwards" in the Clip panel: the export shows the recording from its end', async () => {
    const id = await js('window.__editor.store.project.clips[0].id');
    await js(`window.__editor.editor.select({ kind: 'clip', id: '${id}' })`);
    await js('document.getElementById("clipReverse").click()');
    assert.strictEqual(await js('window.__editor.store.project.clips[0].reverse'), true);
    assert.strictEqual(await js('document.querySelector(".clip.reversed .clip-name").textContent'), '◀◀ Backwards');
    await shot('02-reversed');
    const file = await exportFile();
    for (const t of [0.5, 2.5, 5]) {
      const frame = tinyFrame(file, t);
      const mirrored = meanDiff(frame, tinyFrame(reference, 6 - t));
      const forward = meanDiff(frame, tinyFrame(reference, t));
      console.log(`    at ${t} s: like the video at ${6 - t} s (${mirrored.toFixed(2)}), not at ${t} s (${forward.toFixed(2)})`);
      assert.ok(mirrored < 3 && forward > 5, `backwards at ${t}`);
    }
    await js('document.getElementById("clipReverse").click()');
  });

  // A red clip, then a blue one.
  const library = () => pageOf('library');
  Menu.getApplicationMenu().getMenuItemById('open-recordings').click();
  await waitFor('the Library', () => library() && !library().webContents.isLoading());
  nextChoice = path.join(VIDEOS, 'red.mp4');
  const before = editor;
  await library().webContents.executeJavaScript('document.getElementById("importVideo").click()');
  editor = await openEditor(before);
  js = (code) => editor.webContents.executeJavaScript(code);
  await js('document.querySelector(".first-run .btn")?.click()');
  await js('window.__editor.addRecording.show()');
  nextChoice = path.join(VIDEOS, 'blue.mp4');
  await js('document.querySelector(".rec-file .btn").click()');
  await waitFor('the blue clip', () => js('window.__editor.store.project.clips.length === 2'));
  await js('document.querySelector("dialog.add-recording")?.close()');

  await check('transitions between red and blue: each colour where it should be, a quarter of the way in', async () => {
    const setType = (type) => js(`window.__editor.store.apply((p) => window.__editor.editor.core.setTransition(p, p.clips[0].id, '${type}', 1))`);
    const expect = {
      // a quarter through: 1.75 s (the join is at 2, the transition 1.5..2.5)
      'wipe-left': (px) => px.slice(0, 14).every((c) => colour(c) === 'red') && px.slice(16).every((c) => colour(c) === 'blue'),
      'wipe-right': (px) => px.slice(0, 4).every((c) => colour(c) === 'blue') && px.slice(6).every((c) => colour(c) === 'red'),
      'slide-left': (px) => px.slice(0, 14).every((c) => colour(c) === 'red') && px.slice(16).every((c) => colour(c) === 'blue'),
      // A quarter of blue through the red: both there, red stronger.
      crossfade: (px) => px.every((c) => c.b > 40 && c.r > c.b + 40),
      zoom: (px) => px.every((c) => c.b > 40 && c.r > c.b + 40)
    };
    for (const [type, ok] of Object.entries(expect)) {
      await setType(type);
      const file = await exportFile();
      const px = grid(file, 1.75);
      console.log(`    ${type}: ${px.map((c) => colour(c)[0]).join('')} (middle ${JSON.stringify(px[10])})`);
      assert.ok(ok(px), `${type} at 1.75 s: ${px.map((c) => colour(c)).join(' ')}`);
    }
    // A circle opens from the middle: blue there, red in the corners.
    await setType('circle');
    let file = await exportFile();
    const g = grid(file, 1.75, 9, 5);
    console.log(`    circle: ${[0, 1, 2, 3, 4].map((r) => g.slice(r * 9, r * 9 + 9).map((c) => colour(c)[0]).join('')).join(' / ')}`);
    assert.strictEqual(colour(g[2 * 9 + 4]), 'blue', 'the middle');
    assert.strictEqual(colour(g[0]), 'red', 'a corner');
    // Dip to white: white at the join.
    await setType('dip-white');
    file = await exportFile();
    assert.ok(grid(file, 2).every((c) => colour(c) === 'white'), 'white at the join');
  });

  await check('the live preview draws a wipe the same way', async () => {
    await js(`window.__editor.store.apply((p) => window.__editor.editor.core.setTransition(p, p.clips[0].id, 'wipe-left', 1))`);
    await js('window.__editor.player.seek(1.75)');
    await sleep(900);
    const row = await js(`(() => { const c = document.getElementById('preview'); const x = c.getContext('2d');
      const y = Math.round(c.height / 2); const out = [];
      for (let i = 0; i < 20; i++) { const d = x.getImageData(Math.round((i + 0.5) * c.width / 20), y, 1, 1).data; out.push({ r: d[0], g: d[1], b: d[2] }); }
      return out; })()`);
    console.log(`    preview: ${row.map((c) => colour(c)[0]).join('')}`);
    assert.ok(row.slice(0, 14).every((c) => colour(c) === 'red') && row.slice(16).every((c) => colour(c) === 'blue'), 'red, then the blue quarter');
    await shot('03-wipe-preview');
    // The transition menu, all its choices in reach.
    await js('document.querySelector(".tl-join").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); document.querySelector(".tl-join").click()');
    await waitFor('the transition menu', () => js('!document.querySelector(".join-menu").hidden'));
    const box = await js('(() => { const r = document.querySelector(".join-menu").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth }; })()');
    assert.ok(box.x >= 0 && box.x + box.w <= box.vw && box.y >= 0, `the menu fits the window: ${JSON.stringify(box)}`);
    assert.strictEqual(await js('document.querySelectorAll(".join-menu [data-transition]").length'), 14, 'None and 13 transitions');
    await shot('04-transition-menu');
    // It follows the project: the transition removed, "None" is chosen; Escape closes it.
    await js(`window.__editor.store.apply((p) => window.__editor.editor.core.setTransition(p, p.clips[0].id, null))`);
    assert.strictEqual(await js('document.querySelector(".join-menu .current")?.dataset.transition'), 'null', 'shows None now');
    await key('Escape');
    assert.strictEqual(await js('document.querySelector(".join-menu").hidden'), true, 'Escape closes it');
  });

  // ---- a clip's position, size, crop and colour, on the red clip
  const redId = await js('window.__editor.store.project.clips[0].id');
  await js(`window.__editor.store.apply((p) => window.__editor.editor.core.setTransition(p, '${redId}', null))`);
  await js(`window.__editor.editor.select({ kind: 'clip', id: '${redId}' })`);
  const slide = (id, v) => js(`(() => { const i = document.getElementById('${id}'); i.value = '${v}';
    i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  // The middle row of the export in 80 columns: 'r' red, '.' black.
  // (Nine rows, the middle one: a single row would average the whole height.)
  const row = async (at = 0.5) => grid(await exportFile(), at, 80, 9).slice(4 * 80, 5 * 80)
    .map((c) => (c.r > 150 && c.r > c.b + 60 ? 'r' : c.r + c.g + c.b < 90 ? '.' : '?')).join('');
  const runs = (r) => r.match(/(.)\1*/g).map((m) => `${m[0]}${m.length}`).join(' ');
  const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

  await check('position & size in the Clip panel: half size moved right, turned, cropped -- where the export shows it', async () => {
    await slide('clipScale', 0.5);
    await slide('clipX', 0.25);
    const look = await js('window.__editor.store.project.clips[0].transform');
    assert.deepStrictEqual([look.scale, look.x], [0.5, 0.25]);
    let r = await row();
    console.log(`    half size, a quarter right: ${runs(r)}`);
    near(r.indexOf('r'), 40, 1, 'starts at the middle');
    near(r.lastIndexOf('r'), 79, 1, 'reaches the right edge');
    await shot('05-moved');
    await js('document.getElementById("clipResetPlace").click()');
    await slide('clipRotate', 90);
    r = await row();
    console.log(`    turned a quarter: ${runs(r)}`);
    // 16:9 on its side: a band 9/16 of the width across, in the middle.
    near(r.split('').filter((c) => c === 'r').length, 45, 2, 'as wide as the picture was tall');
    near(r.indexOf('r'), 17.5, 1.5, 'centred');
    await js('document.getElementById("clipResetPlace").click()');
    await slide('clipCropLeft', 0.25);
    r = await row();
    console.log(`    a quarter cropped off the left: ${runs(r)}`);
    near(r.indexOf('r'), 20, 1, 'a quarter gone');
    near(r.lastIndexOf('r'), 79, 1, 'the rest there');
    // The live preview agrees.
    await js('window.__editor.player.seek(0.5)');
    await sleep(400);
    const live = await js(`(() => { const c = document.getElementById('preview'); const x = c.getContext('2d');
      const y = Math.round(c.height / 2); let s = '';
      for (let i = 0; i < 20; i++) { const d = x.getImageData(Math.round((i + 0.5) * c.width / 20), y, 1, 1).data;
        s += d[0] > d[2] + 60 && d[0] > 150 ? 'r' : d[0] + d[1] + d[2] < 60 ? '.' : '?'; }
      return s; })()`);
    console.log(`    preview: ${live}`);
    assert.strictEqual(live, '.....rrrrrrrrrrrrrrr');
    await js('document.getElementById("clipResetPlace").click()');
    assert.strictEqual(await js('window.__editor.store.project.clips[0].transform'), undefined, 'reset');
  });

  await check('colour in the Clip panel: B&W, brightness and warm change the exported colours', async () => {
    await js('document.querySelector(".filter-grid [data-value=bw]").click()');
    let px = grid(await exportFile(), 0.5)[10];
    console.log(`    B&W red: ${JSON.stringify(px)}`);
    assert.ok(Math.abs(px.r - px.g) < 12 && Math.abs(px.g - px.b) < 12, 'grey');
    await js('document.querySelector(".filter-grid [data-value=none]").click()');
    await slide('clipBrightness', -1);
    px = grid(await exportFile(), 0.5)[10];
    assert.ok(px.r + px.g + px.b < 30, `brightness all the way down: black ${JSON.stringify(px)}`);
    await js('document.getElementById("clipResetColour").click()');
    // Warm on a mid-tone (a soft-light tint leaves pure 0 and 255 alone,
    // as real footage never is): the red at half brightness, warmer.
    await slide('clipBrightness', -0.5);
    const plain = grid(await exportFile(), 0.5)[10];
    await js('document.querySelector(".filter-grid [data-value=warm]").click()');
    const warm = grid(await exportFile(), 0.5)[10];
    console.log(`    dim red ${JSON.stringify(plain)}, warm ${JSON.stringify(warm)}`);
    assert.ok(warm.r > plain.r + 20, 'more red in it');
    await js('document.querySelector(".filter-grid [data-value=cool]").click()');
    const cool = grid(await exportFile(), 0.5)[10];
    console.log(`    cool ${JSON.stringify(cool)}`);
    assert.ok(cool.r < warm.r - 20, 'cooler than warm');
    await shot('06-colour');
  });

  await check('a LUT (Load LUT… in the Clip panel) grades the clip: red through a red-blue swap is blue; half amount is half way', async () => {
    await js(`window.__editor.editor.select({ kind: 'clip', id: '${redId}' })`);
    await js('document.getElementById("clipResetColour").click()');
    nextChoice = path.join(VIDEOS, 'swap-rb.cube');
    await js('document.getElementById("clipLoadLut").click()');
    await waitFor('the LUT on the clip', () => js('window.__editor.store.project.clips[0].color?.lut'));
    const lut = await js('window.__editor.store.project.clips[0].color.lut');
    assert.match(lut, /^luts\/swap-rb\.cube$/);
    assert.strictEqual(await js('document.getElementById("clipLutName").textContent'), 'swap-rb');
    let px = grid(await exportFile(), 0.5)[10];
    console.log(`    red through the LUT: ${JSON.stringify(px)}`);
    assert.strictEqual(colour(px), 'blue');
    // The live preview grades it the same way.
    await js('window.__editor.player.seek(0.5)');
    await waitFor('the preview graded', () => js(`(() => { const c = document.getElementById('preview');
      const d = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data; return d[2] > d[0] + 60; })()`), 5000);
    await slide('clipLutMix', 0.5);
    px = grid(await exportFile(), 0.5)[10];
    console.log(`    at half amount: ${JSON.stringify(px)}`);
    assert.ok(Math.abs(px.r - px.b) < 40 && px.r > 90 && px.b > 90, 'half way between red and blue');
    await shot('07-lut');
    await js('document.getElementById("clipRemoveLut").click()');
    assert.strictEqual(await js('window.__editor.store.project.clips[0].color.lut'), null);
  });

  console.log(`\n${passed} passed. Screenshots: ${OUT}`);
  // The editor closed (its last save written) before its folder goes.
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
