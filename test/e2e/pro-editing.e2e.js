'use strict';
// Editing the way a video editor does it, in the real app with real keys and
// mouse: I and O mark a part and Delete removes it (the gap closes); the Cut
// box starts from the marks; J/K/L play backward, stop and forward, faster
// on each press; M drops markers that ⇧M jumps between, that drag along the
// ruler, get a name and colour from a double-click, and are saved with the
// project. Screenshots go to test/e2e/out/pro-editing/.
//
//   node_modules/.bin/electron test/e2e/pro-editing.e2e.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');

const { app, BrowserWindow } = electron;
const VIDEOS = path.join(__dirname, '..', 'fixtures', 'videos');
const OUT = path.join(__dirname, 'out', 'pro-editing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-pro-')));
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

async function run() {
  require('../../src/main/main');
  const picker = await waitFor('the picker', () => pageOf('picker'));
  await waitFor('the picker to load', () => !picker.webContents.isLoading());
  nextChoice = path.join(VIDEOS, 'video6.mp4');
  await picker.webContents.executeJavaScript('document.getElementById("importVideo").click()');
  const editor = await waitFor('the editor', () => pageOf('editor'), 30000);
  await waitFor('the editor to load', () => editor.webContents.executeJavaScript('document.body.dataset.ready === "true"'), 30000);
  // Playback runs on animation frames, which Chromium pauses in a window
  // hidden behind others (a busy desktop): not while this test watches it.
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
  const time = () => js('window.__editor.player.time');
  const seek = (t) => js(`window.__editor.player.seek(${t})`);
  const duration = () => js('window.__editor.store.tl.duration');
  await js('document.querySelector(".first-run .btn")?.click()');

  await check('I and O mark a part, shaded on the timeline; Delete removes it and closes the gap; undo brings it back', async () => {
    await seek(1);
    await key('i');
    await seek(2.5);
    await key('o');
    assert.deepStrictEqual(await js('window.__editor.timeline.marks'), { in: 1, out: 2.5 });
    assert.strictEqual(await js('!document.querySelector(".tl-marks").hidden'), true, 'the part is shaded');
    assert.strictEqual(await js('document.getElementById("deleteBtn").disabled'), false, 'Delete is ready');
    await shot('01-marked');
    await key('Delete');
    near(await duration(), 4.5, 0.02, 'a second and a half removed');
    assert.deepStrictEqual(await js('window.__editor.timeline.marks'), { in: null, out: null }, 'the marks are done with');
    near(await time(), 1, 0.01, 'the playhead where the part was');
    await key('z', ['meta']);
    near(await duration(), 6, 0.02, 'undo');
  });

  await check('the Cut box (X) starts from the In and Out; ⌥X clears them', async () => {
    await seek(0.5);
    await key('i');
    await seek(1);
    await key('o');
    await key('x');
    await waitFor('the Cut box', () => js('document.querySelector(".cut-dialog").open'));
    assert.deepStrictEqual(await js('[document.getElementById("cutFrom").value, document.getElementById("cutTo").value]'), ['0:00.5', '0:01.0']);
    await js('document.querySelector(".cut-dialog").close()');
    await key('x', ['alt']);
    assert.deepStrictEqual(await js('window.__editor.timeline.marks'), { in: null, out: null });
  });

  await check('J/K/L: L plays forward and faster on each press, J the same backward, K stops', async () => {
    await seek(1);
    await key('l');
    assert.strictEqual(await js('window.__editor.player.speed'), 1);
    let t0 = await time();
    await sleep(500);
    near((await time()) - t0, 0.5, 0.2, 'forward at 1x');
    await key('l');
    assert.strictEqual(await js('window.__editor.player.speed'), 2);
    t0 = await time();
    await sleep(500);
    near((await time()) - t0, 1, 0.3, 'forward at 2x');
    await key('k');
    assert.strictEqual(await js('window.__editor.player.playing'), false, 'K stops');
    const stopped = await time();
    await key('j');
    assert.strictEqual(await js('window.__editor.player.speed'), -1);
    await sleep(400);
    near(stopped - (await time()), 0.4, 0.2, 'backward at 1x');
    await key('j');
    assert.strictEqual(await js('window.__editor.player.speed'), -2);
    await key('k');
    assert.strictEqual(await js('window.__editor.player.playing'), false);
  });

  await check('M drops markers; ⇧M jumps to the next; a marker drags along the ruler; double-click names and colours it; Delete removes it', async () => {
    for (const t of [1, 3]) {
      await seek(t);
      await key('m');
    }
    let markers = await js('window.__editor.store.project.markers');
    assert.deepStrictEqual(markers.map((m) => m.t), [1, 3]);
    assert.strictEqual(await js('document.querySelectorAll(".marker-flag").length'), 2, 'flags on the ruler');
    await seek(0);
    await key('m', ['shift']);
    near(await time(), 1, 1e-6, '⇧M to the first');
    await key('m', ['shift']);
    near(await time(), 3, 1e-6, 'and the next');
    // Drag the second along the ruler to 4 s.
    const flag = async (id) => js(`(() => { const r = document.querySelector('.marker-flag[data-id="${id}"]').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    const f = await flag(markers[1].id);
    const x4 = await js('Math.round(window.__editor.timeline.clientX(4))');
    send({ type: 'mouseMove', x: f.x, y: f.y });
    send({ type: 'mouseDown', x: f.x, y: f.y, button: 'left', clickCount: 1 });
    for (let k = 1; k <= 10; k++) {
      send({ type: 'mouseMove', x: Math.round(f.x + ((x4 - f.x) * k) / 10), y: f.y, modifiers: ['leftButtonDown'] });
      await sleep(16);
    }
    send({ type: 'mouseUp', x: x4, y: f.y, button: 'left', clickCount: 1 });
    await sleep(600);
    markers = await js('window.__editor.store.project.markers');
    near(markers[1].t, 4, 0.05, 'dragged to 4 s');
    // Double-click: name it and make it red.
    const g = await flag(markers[1].id);
    for (const c of [1, 2]) {
      send({ type: 'mouseDown', x: g.x, y: g.y, button: 'left', clickCount: c });
      send({ type: 'mouseUp', x: g.x, y: g.y, button: 'left', clickCount: c });
    }
    await waitFor('the marker dialog', () => js('document.querySelector(".marker-dialog").open'));
    await js(`(() => { const n = document.getElementById('markerName'); n.value = 'The good bit'; n.dispatchEvent(new Event('change')); })()`);
    await js('document.querySelector(".marker-swatch[data-color=red]").click()');
    await shot('02-marker-dialog');
    await js('document.querySelector(".marker-dialog .btn.primary").click()');
    markers = await js('window.__editor.store.project.markers');
    assert.deepStrictEqual([markers[1].label, markers[1].color], ['The good bit', 'red']);
    assert.strictEqual(await js('document.querySelector(".marker-label").textContent'), 'The good bit', 'named on the ruler');
    await shot('03-markers');
    // Saved with the project.
    await js('window.__editor.saver.flush()');
    const dir = path.join(home, 'Movies', 'Loupe', fs.readdirSync(path.join(home, 'Movies', 'Loupe')).find((n) => !n.startsWith('.')));
    await waitFor('project.json with the markers', () => JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).markers?.length === 2);
    // Select the first and delete it.
    await js(`window.__editor.editor.select({ kind: 'marker', id: '${markers[0].id}' })`);
    await key('Delete');
    assert.strictEqual((await js('window.__editor.store.project.markers')).length, 1, 'deleted');
    await key('z', ['meta']);
    assert.strictEqual((await js('window.__editor.store.project.markers')).length, 2, 'undo');
  });

  console.log(`\n${passed} passed. Screenshots: ${OUT}`);
  // Written before the folder goes, so no save is left racing the clean-up.
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
