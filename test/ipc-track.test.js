'use strict';
// src/main/ipc/track.js without Electron: what the editor may ask for, the
// job built from the project on disk, what the tracking page may send back,
// and the runner's handling of done, failure and cancel with a fake window.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  validateTrackRequest, buildTrackJob, cleanTrackResult, createTrackRunner, registerTrackIpc
} = require('../src/main/ipc/track');
const P = require('../src/core/project.js');
const { MAX_PATH_POINTS } = require('../src/core/track.js');

// A recording folder with a v2 project holding a hidden area and a box.
function recordingDir({ name = 'raw.mov' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-track-'));
  let p = P.createProject({ main: { width: 1440, height: 900, duration: 10 } });
  p = P.addAnnotation(p, { type: 'blur', start: 2, end: 6, x: 0.2, y: 0.3, w: 0.25, h: 0.1 });
  p = P.addAnnotation(p, { type: 'box', start: 1, end: 3 });
  const saved = JSON.parse(JSON.stringify(p));
  saved.sources.main.video = name;
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(saved));
  fs.writeFileSync(path.join(dir, 'raw.mov'), 'not really a video');
  return { dir, blur: p.annotations[0].id, box: p.annotations[1].id };
}

function fakeElectron() {
  const windows = [];
  class FakeWindow {
    constructor(opts) {
      this.opts = opts;
      this.destroyed = false;
      this.listeners = {};
      this.handlers = {};
      this.ipcListeners = {};
      this.webContents = {
        ipc: {
          handle: (ch, fn) => { this.handlers[ch] = fn; },
          on: (ch, fn) => { this.ipcListeners[ch] = fn; }
        },
        on: (evt, fn) => { this.listeners[`wc:${evt}`] = fn; }
      };
      windows.push(this);
    }
    on(evt, fn) { this.listeners[evt] = fn; }
    loadFile(page) { this.page = page; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.listeners.closed?.();
    }
  }
  return { windows, BrowserWindow: FakeWindow };
}

const JOB = { id: 'a1', video: 'file:///x/raw.mov', rotation: 0, start: 2, end: 6, rect: { x: 0.2, y: 0.3, w: 0.25, h: 0.1 } };
const PATH = [{ t: 2, x: 0.2, y: 0.3 }, { t: 4, x: 0.5, y: 0.3 }, { t: 6, x: 0.5, y: 0.6 }];

test('the editor may only name an annotation', () => {
  assert.deepStrictEqual(validateTrackRequest({ id: 'a1', video: '/etc/passwd' }), { id: 'a1' });
  for (const bad of [undefined, null, 'a1', [], {}, { id: 7 }, { id: '' }, { id: 'x'.repeat(65) }]) {
    assert.throws(() => validateTrackRequest(bad), /Invalid request/);
  }
});

test('the job is the hidden area as saved on disk: its recording, box and stretch of time', () => {
  const { dir, blur, box } = recordingDir();
  const job = buildTrackJob(dir, { id: blur });
  assert.deepStrictEqual(job, {
    id: blur, video: pathToFileURL(path.join(dir, 'raw.mov')).href, rotation: 0, start: 2, end: 6,
    rect: { x: 0.2, y: 0.3, w: 0.25, h: 0.1 }
  });
  assert.throws(() => buildTrackJob(dir, { id: box }), /no longer in the video/, 'only a hidden area follows');
  assert.throws(() => buildTrackJob(dir, { id: 'nope' }), /no longer in the video/);
  fs.rmSync(path.join(dir, 'raw.mov'));
  assert.throws(() => buildTrackJob(dir, { id: blur }), /video file is missing/);
  fs.rmSync(path.join(dir, 'project.json'));
  assert.throws(() => buildTrackJob(dir, { id: blur }), /Couldn't read/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a project naming a video outside its folder is refused', () => {
  const { dir, blur } = recordingDir({ name: '../raw.mov' });
  assert.throws(() => buildTrackJob(dir, { id: blur }), /invalid video file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('what the page sends back is checked: a path in time order, on the picture, inside the stretch asked for', () => {
  assert.deepStrictEqual(cleanTrackResult({ path: PATH, lostAt: null, frames: 120, seconds: 0.5, extra: 'x' }, JOB),
    { path: PATH, lostAt: null, frames: 120, seconds: 0.5 });
  const extra = cleanTrackResult({ path: PATH.map((p) => ({ ...p, score: 1 })), lostAt: 5.5, frames: 'many' }, JOB);
  assert.deepStrictEqual(extra, { path: PATH, lostAt: 5.5, frames: 0, seconds: 0 }, 'only t, x and y are kept');
  const bad = (raw, why) => assert.throws(() => cleanTrackResult(raw, JOB), /usable path/, why);
  bad(null, 'nothing');
  bad({ path: 'x' }, 'not a list');
  bad({ path: [PATH[0]] }, 'a single point');
  bad({ path: [PATH[1], PATH[0]] }, 'out of order');
  bad({ path: [PATH[0], { t: 3, x: NaN, y: 0 }] }, 'not a number');
  bad({ path: [PATH[0], { t: 3, x: 9, y: 0 }] }, 'far off the picture');
  bad({ path: [PATH[0], { t: 8, x: 0.2, y: 0.2 }] }, 'after the stretch');
  bad({ path: [{ t: 1, x: 0.2, y: 0.2 }, PATH[1]] }, 'before the stretch');
  bad({ path: [PATH[0], null] }, 'not a point');
  bad({ path: PATH, lostAt: 99 }, 'lost outside the stretch');
  bad({ path: PATH, lostAt: 'soon' }, 'lost at no time');
  bad({ path: Array.from({ length: MAX_PATH_POINTS + 1 }, (_, i) => ({ t: 2 + i / 1000, x: 0, y: 0 })) }, 'too many points');
});

test('the runner hands the page its job and resolves with the checked path', async () => {
  const { windows, BrowserWindow } = fakeElectron();
  const runner = createTrackRunner({ BrowserWindow, preload: '/p.js', page: '/track.html' });
  const progress = [];
  const done = runner.start(JOB, { onProgress: (p) => progress.push(p) });
  assert.ok(runner.busy());
  await assert.rejects(runner.start(JOB), /already being followed/);
  const win = windows[0];
  assert.strictEqual(win.page, '/track.html');
  const prefs = win.opts.webPreferences;
  assert.deepStrictEqual(
    { sandbox: prefs.sandbox, isolated: prefs.contextIsolation, node: prefs.nodeIntegration, show: win.opts.show },
    { sandbox: true, isolated: true, node: false, show: false });
  assert.deepStrictEqual(win.handlers['tracker:job'](), JOB);
  win.ipcListeners['tracker:progress']({}, { frame: 3, total: 120, evil: { a: 1 }, text: 'x' });
  win.ipcListeners['tracker:progress']({}, 'nonsense');
  assert.deepStrictEqual(progress, [{ frame: 3, total: 120 }, {}]);
  win.ipcListeners['tracker:done']({}, { path: PATH, lostAt: 5, frames: 90, seconds: 1 });
  assert.deepStrictEqual(await done, { path: PATH, lostAt: 5, frames: 90, seconds: 1 });
  assert.ok(win.destroyed && !runner.busy());
});

test('a failure, a bad result or a crash rejects in words; cancelling resolves as cancelled', async () => {
  const { windows, BrowserWindow } = fakeElectron();
  const runner = createTrackRunner({ BrowserWindow, preload: '/p.js', page: '/track.html' });
  let done = runner.start(JOB);
  windows.at(-1).ipcListeners['tracker:fail']({}, 'There is nothing under the box to follow.');
  await assert.rejects(done, /nothing under the box/);
  assert.ok(!runner.busy());

  done = runner.start(JOB);
  windows.at(-1).ipcListeners['tracker:fail']({}, { not: 'text' });
  await assert.rejects(done, /Following the hidden area failed/);

  done = runner.start(JOB);
  windows.at(-1).ipcListeners['tracker:done']({}, { path: [{ t: 2, x: 'left', y: 0 }] });
  await assert.rejects(done, /usable path/);
  assert.ok(windows.at(-1).destroyed);

  done = runner.start(JOB);
  windows.at(-1).listeners['wc:render-process-gone']();
  await assert.rejects(done, /stopped unexpectedly/);

  done = runner.start(JOB);
  assert.strictEqual(await runner.cancel(), true);
  assert.deepStrictEqual(await done, { cancelled: true });
  assert.ok(windows.at(-1).destroyed && !runner.busy());
  // A result arriving after the cancel changes nothing.
  windows.at(-1).ipcListeners['tracker:done']({}, { path: PATH });
  assert.strictEqual(await runner.cancel(), false);

  // The window going away on its own is a cancel too.
  done = runner.start(JOB);
  windows.at(-1).destroy();
  assert.deepStrictEqual(await done, { cancelled: true });
});

test('track:start follows the open recording\'s hidden area after flushing the pending save', async () => {
  const { dir, blur } = recordingDir();
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const order = [];
  let outcome = { path: PATH, lostAt: null, frames: 120, seconds: 1 };
  const runner = {
    busy: () => false,
    start: (job, { onProgress }) => { order.push(['start', job.id]); onProgress({ frame: 1, total: 2 }); return Promise.resolve(outcome); },
    cancel: () => Promise.resolve(false)
  };
  let open = null;
  registerTrackIpc({ ipcMain, runner, projectDir: () => open, beforeStart: () => order.push(['flush']) });
  const sent = [];
  const sender = { send: (ch, p) => sent.push([ch, p]), isDestroyed: () => false };
  await assert.rejects(handlers['track:start']({ sender }, { id: blur }), /no recording open/);
  open = dir;
  await assert.rejects(handlers['track:start']({ sender }, { path: '/etc/passwd' }), /Invalid request/);
  await assert.rejects(handlers['track:start']({ sender }, { id: 'gone' }), /no longer in the video/);
  order.length = 0;
  const result = await handlers['track:start']({ sender }, { id: blur });
  assert.deepStrictEqual(order, [['flush'], ['start', blur]]);
  assert.deepStrictEqual(result, { ...outcome, id: blur, start: 2, rect: { x: 0.2, y: 0.3, w: 0.25, h: 0.1 } });
  assert.deepStrictEqual(sent, [['track:progress', { frame: 1, total: 2 }]]);
  outcome = { cancelled: true };
  assert.deepStrictEqual(await handlers['track:start']({ sender }, { id: blur }), { cancelled: true });
  assert.strictEqual(await handlers['track:cancel'](), false);
  // Nothing on disk was changed by any of it.
  assert.ok(!('path' in JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).annotations[0]));
  fs.rmSync(dir, { recursive: true, force: true });
});
