'use strict';
// src/main/ipc/camera.js with a fake window and IPC: the file it writes, the
// start moment it reports for alignment, and that only the bubble's own page
// is listened to.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCameraBubble, cameraAccess } = require('../src/main/ipc/camera');
const { readSize } = require('../src/main/webm');

function fakes() {
  const handlers = {};
  const windows = [];
  class Win {
    constructor(opts) {
      this.opts = opts; this.sent = []; this.listeners = {}; this.closed = false; this.hidden = false;
      this.webContents = { send: (channel, data) => this.sent.push({ channel, data }) };
      windows.push(this);
    }
    once(evt, cb) { (this.listeners[evt] ||= []).push(cb); }
    loadFile(f) { this.file = f; }
    setVisibleOnAllWorkspaces() {}
    setAlwaysOnTop() {}
    showInactive() {}
    hide() { this.hidden = true; }
    getMediaSourceId() { return 'window:4242:0'; }
    isDestroyed() { return this.closed; }
    close() {
      if (this.closed) return;
      this.closed = true;
      for (const cb of this.listeners.closed ?? []) cb();
    }
  }
  const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; } };
  return { handlers, windows, BrowserWindow: Win, ipcMain };
}

// A first chunk shaped like MediaRecorder's (see webm.test.js for the layout).
function firstChunk() {
  const hex = [
    '1a45dfa3', '8b', '4286', '81', '01', '4282', '84', '7765626d',   // EBML header: DocType webm
    '18538067', '01ffffffffffffff',                                  // Segment, unknown size
    '1549a966', '8e', '2ad7b1', '83', '0f4240', '4d80', '84', '43687231', // Info: 1ms scale, "Chr1"
    '1f43b675', '85', 'e7', '81', '00', 'a3', '80'                    // Cluster
  ].join('');
  return Buffer.from(hex, 'hex');
}

function setup({ now = () => 100 } = {}) {
  const f = fakes();
  const excluded = [];
  const bubble = createCameraBubble({
    BrowserWindow: f.BrowserWindow, ipcMain: f.ipcMain, preload: '/p.js', page: '/camera/index.html',
    excludeFromCapture: (w) => excluded.push(w), now,
    getWorkArea: () => ({ x: 0, y: 0, width: 1000, height: 800 })
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-cam-'));
  return { ...f, bubble, dir, excluded };
}

test('open shows a small unfocusable bubble, excluded from capture, with an id for --exclude-window', async () => {
  const { bubble, windows, excluded, handlers, dir } = setup();
  const win = bubble.open({ deviceId: 'cam-1' });
  assert.strictEqual(windows.length, 1);
  assert.strictEqual(win.opts.focusable, false);
  assert.deepStrictEqual(excluded, [win]);
  assert.strictEqual(bubble.windowId(), '4242');
  assert.strictEqual(bubble.open({}), win, 'opening twice reuses the window');
  assert.deepStrictEqual(await handlers['camera:init']({ sender: win.webContents }), { deviceId: null });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a recording writes webcam.webm in order, gives it a duration, and reports its start', async () => {
  let local = 500;
  const { bubble, handlers, dir } = setup({ now: () => local });
  const win = bubble.open({ deviceId: 'cam-1' });
  const from = { sender: win.webContents };
  assert.deepStrictEqual(await handlers['camera:init'](from), { deviceId: 'cam-1' });

  assert.strictEqual(bubble.start(dir), true);
  assert.deepStrictEqual(win.sent.at(-1), { channel: 'camera:command', data: { action: 'start' } });

  // The page says recording started 40 ms ago (on its clock); it arrives at 500.
  await handlers['camera:started'](from, { startedAgoMs: 40, width: 1280, height: 720 });
  await handlers['camera:chunk'](from, new Uint8Array(firstChunk()));
  await handlers['camera:chunk'](from, Buffer.from([1, 2, 3]));

  local = 510;
  const finished = bubble.finish();
  assert.ok(win.hidden, 'the bubble leaves the screen at once');
  assert.deepStrictEqual(win.sent.at(-1).data, { action: 'stop' });
  await handlers['camera:chunk'](from, Buffer.from([4, 5]));
  await handlers['camera:stopped'](from, { durationMs: 9876 });
  const result = await finished;

  assert.strictEqual(result.file, 'webcam.webm');
  assert.ok(Math.abs(result.startLocal - 499.96) < 1e-9, `startLocal ${result.startLocal}`);
  assert.strictEqual(result.width, 1280);
  assert.strictEqual(result.height, 720);
  assert.ok(win.isDestroyed());

  const file = fs.readFileSync(path.join(dir, 'webcam.webm'));
  assert.deepStrictEqual([...file.subarray(-5)], [1, 2, 3, 4, 5], 'later chunks follow in order');
  // Duration element (44 89 88 + float64) is now inside Info.
  const at = file.indexOf(Buffer.from('448988', 'hex'));
  assert.ok(at > 0, 'a Duration element was written');
  assert.strictEqual(file.readDoubleBE(at + 3), 9876);
  const infoAt = file.indexOf(Buffer.from('1549a966', 'hex'));
  assert.strictEqual(readSize(file, infoAt + 4).length, 8, "Info's size was widened");
  fs.rmSync(dir, { recursive: true, force: true });
});

// main.js starts finish() and then tears the armed state down, which calls
// close(): the page must still be heard until its last chunk is in.
test('close() while finishing leaves the window to finish, so the last chunk and duration land', async () => {
  const { bubble, handlers, dir } = setup();
  const win = bubble.open({});
  const from = { sender: win.webContents };
  bubble.start(dir);
  await handlers['camera:started'](from, { startedAgoMs: 0, width: 640, height: 480 });
  await handlers['camera:chunk'](from, new Uint8Array(firstChunk()));

  const finished = bubble.finish();
  bubble.close();
  assert.ok(!win.isDestroyed(), 'not closed under the page while it finishes');
  await handlers['camera:chunk'](from, Buffer.from([7, 8]));
  await handlers['camera:stopped'](from, { durationMs: 1234 });
  const result = await finished;

  assert.strictEqual(result.file, 'webcam.webm');
  assert.ok(win.isDestroyed(), 'closed once finished');
  const file = fs.readFileSync(path.join(dir, 'webcam.webm'));
  assert.deepStrictEqual([...file.subarray(-2)], [7, 8], 'the last chunk was kept');
  const at = file.indexOf(Buffer.from('448988', 'hex'));
  assert.strictEqual(file.readDoubleBE(at + 3), 1234);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('messages from any other page are ignored', async () => {
  const { bubble, handlers, dir } = setup();
  bubble.open({});
  bubble.start(dir);
  const stranger = { sender: {} };
  assert.strictEqual(await handlers['camera:init'](stranger), null);
  await handlers['camera:started'](stranger, { startedAgoMs: 1, width: 1, height: 1 });
  await handlers['camera:chunk'](stranger, Buffer.from([9]));
  await handlers['camera:error'](stranger, { message: 'x' });
  assert.strictEqual(bubble.isOpen(), true);
  assert.strictEqual(bubble.isRecording(), false);
  bubble.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bad values from the page are refused', async () => {
  const { bubble, handlers, dir } = setup();
  const win = bubble.open({});
  const from = { sender: win.webContents };
  bubble.start(dir);
  await handlers['camera:started'](from, { startedAgoMs: -5, width: 10, height: 10 });
  assert.strictEqual(bubble.isRecording(), false, 'a negative delay is not a start');
  await handlers['camera:started'](from, { startedAgoMs: 5, width: 1e9, height: 'x' });
  assert.strictEqual(bubble.isRecording(), true);
  await handlers['camera:chunk'](from, 'not bytes');
  await handlers['camera:chunk'](from, { length: 3 });
  const finished = bubble.finish();
  await handlers['camera:stopped'](from, {});
  assert.strictEqual(await finished, null, 'no bytes, no webcam file');
  assert.ok(!fs.existsSync(path.join(dir, 'webcam.webm')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no camera: the page reports it, the bubble closes, and the error is kept for the bar', async () => {
  const changes = [];
  const f = fakes();
  const bubble = createCameraBubble({
    BrowserWindow: f.BrowserWindow, ipcMain: f.ipcMain, preload: '', page: '', now: () => 0,
    onChange: () => changes.push(bubble.error())
  });
  const win = bubble.open({});
  await f.handlers['camera:error']({ sender: win.webContents }, { message: 'No camera found' });
  assert.ok(win.isDestroyed());
  assert.strictEqual(bubble.isOpen(), false);
  assert.strictEqual(bubble.error(), 'No camera found');
  assert.deepStrictEqual(changes, ['No camera found']);
  assert.strictEqual(bubble.start('/nowhere'), false, 'nothing to record with');
  assert.strictEqual(await bubble.finish(), null);
});

test('a page that never answers Stop does not hold up the recording forever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { bubble, handlers, dir } = setup();
  const win = bubble.open({});
  const from = { sender: win.webContents };
  bubble.start(dir);
  await handlers['camera:started'](from, { startedAgoMs: 0, width: 2, height: 2 });
  await handlers['camera:chunk'](from, firstChunk());
  const finished = bubble.finish();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5000);
  const result = await finished;
  assert.strictEqual(result.file, 'webcam.webm', 'what arrived is kept');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('closing mid-recording (Back, quit) drops the unfinished file', async () => {
  const { bubble, handlers, dir } = setup();
  const win = bubble.open({});
  bubble.start(dir);
  await handlers['camera:chunk']({ sender: win.webContents }, firstChunk());
  bubble.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!fs.existsSync(path.join(dir, 'webcam.webm')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('camera permission: macOS asks, Windows only has an off switch', async () => {
  let status = 'not-determined';
  const prefs = { getMediaAccessStatus: () => status, askForMediaAccess: async () => { status = 'granted'; return true; } };
  const mac = cameraAccess(prefs, 'darwin');
  assert.strictEqual(mac.granted(), false);
  assert.strictEqual(await mac.request(), true);
  assert.strictEqual(mac.granted(), true);

  const win = cameraAccess({ getMediaAccessStatus: () => 'not-determined' }, 'win32');
  assert.strictEqual(win.granted(), true);
  const off = cameraAccess({ getMediaAccessStatus: () => 'denied' }, 'win32');
  assert.strictEqual(off.granted(), false);
  assert.strictEqual(await off.request(), false);
});
