'use strict';
// Drives the bar's countdown and the recording settings through main.js with
// 'electron' replaced by an in-memory mock (the same approach as
// main-editor.test.js). Only paths that never spawn a capture helper are
// exercised here: the countdown's cancel paths and the settings IPC.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const electronPath = require.resolve('electron');
const mainPath = require.resolve('../src/main/main');

function installElectronMock(userData) {
  const windows = [];
  const ipcHandlers = {};
  const shortcuts = new Map();

  class FakeBrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this._closed = false;
      this._listeners = {};
      this.sent = [];
      this.webContents = { send: (channel, data) => this.sent.push({ channel, data }) };
      windows.push(this);
    }
    on(evt, cb) { (this._listeners[evt] ||= []).push(cb); return this; }
    once(evt, cb) { return this.on(evt, cb); }
    loadFile(file) { this.file = file; }
    show() {}
    showInactive() {}
    hide() {}
    setVisibleOnAllWorkspaces() {}
    setAlwaysOnTop() {}
    setIgnoreMouseEvents() {}
    setContentProtection() {}
    getMediaSourceId() { return `window:${windows.indexOf(this) + 100}:0`; }
    isDestroyed() { return this._closed; }
    close() {
      if (this._closed) return;
      this._closed = true;
      setImmediate(() => { for (const cb of this._listeners.closed || []) cb(); });
    }
  }

  const mock = {
    app: {
      isPackaged: false,
      whenReady: () => new Promise(() => {}),
      on: () => {},
      quit: () => {},
      getPath: () => userData
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: { handle: (channel, fn) => { ipcHandlers[channel] = fn; } },
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      isTrustedAccessibilityClient: () => true,
      askForMediaAccess: async () => true
    },
    shell: {},
    dialog: { showErrorBox: () => {} },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1470, height: 956 } }) },
    globalShortcut: {
      register: (accel, cb) => { shortcuts.set(accel, cb); return true; },
      unregister: (accel) => { shortcuts.delete(accel); },
      unregisterAll: () => { shortcuts.clear(); }
    }
  };
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: mock };
  return { windows, ipcHandlers, shortcuts };
}

function freshMain() {
  delete require.cache[mainPath];
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-userdata-'));
  const harness = installElectronMock(userData);
  const main = require(mainPath);
  return { main, userData, ...harness };
}

const SOURCE = { source: 'display:1', width: 1470, height: 956, x: 0, y: 0 };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('recording choices are saved through IPC and checked', async () => {
  const { ipcHandlers, userData } = freshMain();
  const initial = await ipcHandlers['recordingSettings:get']();
  assert.strictEqual(initial.countdown, true);
  const saved = await ipcHandlers['recordingSettings:set']({}, { systemAudio: true, camera: true });
  assert.strictEqual(saved.systemAudio, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(userData, 'recording.json'), 'utf8')).camera, true);
  await assert.rejects(async () => ipcHandlers['recordingSettings:set']({}, { camera: 'on' }));
  fs.rmSync(userData, { recursive: true, force: true });
});

test('the countdown shows 3, 2, 1 on the bar and Esc goes back to armed without recording', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ipcHandlers, windows, shortcuts, userData } = freshMain();
  ipcHandlers['bar:arm']({}, SOURCE);
  const bar = windows.at(-1);

  const started = ipcHandlers['bar:start']();
  await tick();
  const counts = () => bar.sent.filter((m) => m.data?.state === 'countdown').map((m) => m.data.count);
  assert.deepStrictEqual(counts(), [3]);
  t.mock.timers.tick(1000);
  assert.deepStrictEqual(counts(), [3, 2]);
  assert.ok(shortcuts.has('Escape'), 'Esc cancels the countdown');

  shortcuts.get('Escape')();
  assert.deepStrictEqual(await started, { cancelled: true });
  assert.ok(!shortcuts.has('Escape'), 'Esc is handed back');
  assert.strictEqual(bar.sent.at(-1).data.state, 'armed');
  assert.ok(!bar.isDestroyed(), 'the bar stays, ready to start again');
  assert.strictEqual(windows.length, 1, 'no shot frame or other window opened');
  fs.rmSync(userData, { recursive: true, force: true });
});

test('Esc during the countdown gives Escape back to the area overlay afterwards', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ipcHandlers, shortcuts, userData } = freshMain();
  ipcHandlers['bar:arm']({}, SOURCE);
  ipcHandlers['bar:setAreaMode']({}, 'rect');
  const overlayEscape = shortcuts.get('Escape');

  const started = ipcHandlers['bar:start']();
  await tick();
  const countdownEscape = shortcuts.get('Escape');
  assert.notStrictEqual(countdownEscape, overlayEscape, 'the countdown holds Escape while it runs');
  countdownEscape();
  await started;
  assert.ok(shortcuts.has('Escape'), 'the overlay has its Escape (Back) again');
  fs.rmSync(userData, { recursive: true, force: true });
});

test('the bar Cancel button cancels the countdown too', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ipcHandlers, userData } = freshMain();
  ipcHandlers['bar:arm']({}, SOURCE);
  const started = ipcHandlers['bar:start']();
  await tick();
  assert.strictEqual(await ipcHandlers['bar:cancelCountdown'](), true);
  assert.deepStrictEqual(await started, { cancelled: true });
  assert.strictEqual(await ipcHandlers['bar:cancelCountdown'](), false, 'nothing left to cancel');
  fs.rmSync(userData, { recursive: true, force: true });
});

test('Stop during the countdown closes the bar and nothing starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ipcHandlers, windows, shortcuts, userData } = freshMain();
  ipcHandlers['bar:arm']({}, SOURCE);
  const bar = windows.at(-1);
  const started = ipcHandlers['bar:start']();
  await tick();

  assert.strictEqual(await ipcHandlers['record:stop'](), null, 'nothing was recorded');
  assert.deepStrictEqual(await started, { cancelled: true });
  assert.ok(bar.isDestroyed());
  assert.ok(!shortcuts.has('Escape'));
  t.mock.timers.tick(5000);
  assert.strictEqual(windows.length, 1, 'no capture-time windows appeared later');
  fs.rmSync(userData, { recursive: true, force: true });
});

test('pause and resume are ignored when nothing is recording', async () => {
  const { ipcHandlers, windows, userData } = freshMain();
  ipcHandlers['bar:arm']({}, SOURCE);
  const bar = windows.at(-1);
  const before = bar.sent.length;
  await ipcHandlers['bar:pause']();
  await ipcHandlers['bar:resume']();
  assert.strictEqual(bar.sent.length, before);
  fs.rmSync(userData, { recursive: true, force: true });
});

test('with the camera chosen, arming opens the bubble, kept out of the capture', async () => {
  const { ipcHandlers, windows, userData } = freshMain();
  await ipcHandlers['recordingSettings:set']({}, { camera: true, cameraDeviceId: 'cam-1' });
  ipcHandlers['bar:arm']({}, SOURCE);
  const bubble = windows.find((w) => w.file?.endsWith(path.join('camera', 'index.html')));
  assert.ok(bubble, 'the camera bubble opened');
  assert.strictEqual(bubble.opts.focusable, false);
  assert.ok(bubble.opts.x > 1000 && bubble.opts.y > 600, 'bottom-right of the screen');

  // Back closes it with the bar.
  await ipcHandlers['record:stop']();
  assert.ok(bubble.isDestroyed());
  fs.rmSync(userData, { recursive: true, force: true });
});
