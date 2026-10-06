'use strict';
// Drives the bar's countdown and the recording settings through main.js with
// 'electron' replaced by an in-memory mock (the same approach as
// main-editor.test.js). The countdown's cancel paths and the settings IPC
// never spawn a capture helper; the Restart tests at the end run against
// small stand-in helpers (shell scripts) through LOUPE_BIN_DIR.
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

  FakeBrowserWindow.getAllWindows = () => windows;

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
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).recordCamera, true);
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
  // Back from the bar brings the picker back; nothing else may open.
  const others = windows.filter((w) => w !== bar && !w.file?.endsWith(path.join('picker', 'index.html')));
  assert.deepStrictEqual(others, [], 'no capture-time windows appeared later');
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

// ---- Restart ------------------------------------------------------------------
// The real main.js, recorder and helper plumbing, with stand-in helpers: a
// capture that says "started" and, when stopped, "stopped"; an inputtap that
// just waits. Capture logs its arguments once it is ready to be stopped, so
// a test can wait for it and compare two takes.

function fakeHelpers() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-fakebin-'));
  // inputtap reports the clicks a test writes to inputtap.click.
  fs.writeFileSync(path.join(bin, 'capture'), `#!/bin/sh
trap 'echo "{\\"type\\":\\"stopped\\",\\"duration\\":1,\\"now\\":2}"; exit 0' TERM
echo '{"type":"started","clock":1,"now":1}'
echo "$@" >> "$0.log"
while true; do sleep 0.02; done
`);
  fs.writeFileSync(path.join(bin, 'inputtap'), `#!/bin/sh
trap 'exit 0' TERM
while true; do
  if [ -f "$0.click" ]; then cat "$0.click"; rm -f "$0.click"; fi
  sleep 0.02
done
`);
  for (const name of ['capture', 'inputtap']) fs.chmodSync(path.join(bin, name), 0o755);
  return bin;
}

// Runs `fn` against main.js with the stand-in helpers and its recordings in a
// temporary folder; whatever happens, the bar is closed and the helpers
// stopped afterwards.
async function withRecordingMain(settings, fn) {
  const bin = fakeHelpers();
  const recordings = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-recordings-')));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-userdata-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ recordingsFolder: recordings, ...settings }));
  delete require.cache[mainPath];
  const previous = process.env.LOUPE_BIN_DIR;
  process.env.LOUPE_BIN_DIR = bin;
  const harness = installElectronMock(userData);
  try {
    require(mainPath);
  } finally {
    if (previous === undefined) delete process.env.LOUPE_BIN_DIR;
    else process.env.LOUPE_BIN_DIR = previous;
  }
  const captureArgs = () => {
    try {
      return fs.readFileSync(path.join(bin, 'capture.log'), 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  // Capture number `n` is up and can be stopped cleanly. setImmediate, so it
  // also works while a test has setTimeout mocked.
  const captureRunning = async (n) => { while (captureArgs().length < n) await tick(); };
  try {
    // Left clicks at these capture-clock times (capture starts at 1).
    const click = (...clocks) => fs.writeFileSync(path.join(bin, 'inputtap.click'),
      clocks.map((clock) => `${JSON.stringify({ type: 'click', clock, x: 300, y: 200, button: 'left' })}\n`).join(''));
    await fn({ ...harness, recordings, captureArgs, captureRunning, click });
  } finally {
    await harness.ipcHandlers['record:stop']().catch(() => {});
    for (const dir of [bin, recordings, userData]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

const unix = { skip: process.platform === 'win32' ? 'the stand-in helpers are shell scripts' : false };
const isPage = (name) => (w) => Boolean(w.file?.endsWith(path.join(name, 'index.html')));

test('Restart throws the take away and records the same source again, straight away with the countdown off', unix, () =>
  withRecordingMain({ countdown: false }, async ({ ipcHandlers, windows, recordings, captureArgs, captureRunning }) => {
    ipcHandlers['bar:arm']({}, { ...SOURCE, title: 'Display 1' });
    const bar = windows.find(isPage('bar'));

    const first = await ipcHandlers['bar:start']();
    await captureRunning(1);
    assert.deepStrictEqual(fs.readdirSync(recordings), [path.basename(first.dir)]);
    await ipcHandlers['bar:pause'](); // Restart works from paused too
    assert.strictEqual(bar.sent.at(-1).data.paused, true);

    const second = await ipcHandlers['bar:restart']({ sender: bar.webContents });
    assert.ok(second.dir && second.dir !== first.dir, 'a new recording folder');
    assert.ok(!fs.existsSync(first.dir), 'the thrown-away take is gone from disk');
    assert.deepStrictEqual(fs.readdirSync(recordings), [path.basename(second.dir)], 'nothing else for the Library to find');
    assert.ok(!bar.isDestroyed(), 'the same bar carries on');
    assert.strictEqual(bar.sent.at(-1).data.state, 'recording');
    assert.strictEqual(bar.sent.at(-1).data.paused, false);
    assert.ok(!windows.some(isPage('editor')), 'no editor opened for the thrown-away take');

    // The same source and options; only the folder differs (and the zoom
    // frame, the last window kept out of the capture, is a new one each take).
    await captureRunning(2);
    const [a, b] = captureArgs().map((line) => line.replace(/--out \S+/, '--out X').replace(/\d+$/, 'N'));
    assert.match(a, /^--source display:1 --out X --mic 0 --exclude-window 100 --exclude-window N$/);
    assert.strictEqual(b, a);

    // Stop saves the second take as usual.
    const result = await ipcHandlers['record:stop']();
    assert.strictEqual(result.dir, second.dir);
    assert.ok(fs.existsSync(path.join(second.dir, 'project.json')));
    assert.ok(bar.isDestroyed());
  }));

test('Restart is only for the bar, and only while something is recording', unix, () =>
  withRecordingMain({ countdown: false }, async ({ ipcHandlers, windows, recordings, captureRunning }) => {
    await assert.rejects(async () => ipcHandlers['bar:restart']({}), /Only the recording bar/);
    ipcHandlers['bar:arm']({}, SOURCE);
    const bar = windows.find(isPage('bar'));
    await assert.rejects(async () => ipcHandlers['bar:restart']({ sender: bar.webContents }), /no recording to start over/);

    const first = await ipcHandlers['bar:start']();
    await captureRunning(1);
    const picker = { sender: { send() {} } };
    await assert.rejects(async () => ipcHandlers['bar:restart'](picker), /Only the recording bar/);
    await assert.rejects(async () => ipcHandlers['bar:restart'](), /Only the recording bar/);
    assert.ok(fs.existsSync(first.dir), 'a refused Restart throws nothing away');
    assert.deepStrictEqual(fs.readdirSync(recordings), [path.basename(first.dir)]);
  }));

test('Restart counts down again when the countdown is on, and Esc then leaves the bar armed with nothing kept', unix, (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return withRecordingMain({ countdown: true }, async ({ ipcHandlers, windows, shortcuts, recordings, captureRunning }) => {
    ipcHandlers['bar:arm']({}, SOURCE);
    const bar = windows.find(isPage('bar'));
    const counts = () => bar.sent.filter((m) => m.data?.state === 'countdown').map((m) => m.data.count);

    const started = ipcHandlers['bar:start']();
    await tick();
    for (let i = 0; i < 3; i++) { t.mock.timers.tick(1000); await tick(); }
    const first = await started;
    assert.deepStrictEqual(counts(), [3, 2, 1]);
    await captureRunning(1);

    const restarted = ipcHandlers['bar:restart']({ sender: bar.webContents });
    // The old take stops first (a real process exiting), then 3-2-1 again.
    while (counts().length < 4) await tick();
    assert.deepStrictEqual(counts(), [3, 2, 1, 3]);
    assert.ok(!fs.existsSync(first.dir), 'the old take is already gone');
    await assert.rejects(async () => ipcHandlers['bar:start'](), /Cannot start recording right now/);

    shortcuts.get('Escape')();
    assert.deepStrictEqual(await restarted, { cancelled: true });
    assert.strictEqual(bar.sent.at(-1).data.state, 'armed');
    assert.ok(!bar.isDestroyed(), 'the bar stays, ready to start again');
    assert.deepStrictEqual(fs.readdirSync(recordings), [], 'nothing was kept');

    assert.strictEqual(await ipcHandlers['record:stop'](), null, 'Back: nothing to save');
  });
});

test('Stop while Restart is still throwing the take away closes the bar and keeps nothing', unix, () =>
  withRecordingMain({ countdown: false }, async ({ ipcHandlers, windows, recordings, captureArgs, captureRunning }) => {
    ipcHandlers['bar:arm']({}, SOURCE);
    const bar = windows.find(isPage('bar'));
    await ipcHandlers['bar:start']();
    await captureRunning(1);

    const restarted = ipcHandlers['bar:restart']({ sender: bar.webContents });
    assert.strictEqual(await ipcHandlers['record:stop'](), null, 'nothing is saved');
    assert.deepStrictEqual(await restarted, { cancelled: true, closed: true });
    assert.ok(bar.isDestroyed());
    assert.deepStrictEqual(fs.readdirSync(recordings), []);
    assert.ok(!windows.some(isPage('editor')));
    assert.strictEqual(captureArgs().length, 1, 'no second take was started');
  }));

// ---- the "what's in shot" frame and zooms on clicks ---------------------------

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The zoom the frame was last told to show.
const shownZoom = (windows) => windows.find(isPage('shot'))?.sent.filter((m) => m.channel === 'shot:update').at(-1)?.data.zoom ?? 1;
async function waitForZoom(windows, test, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!test(shownZoom(windows))) {
    if (Date.now() > end) assert.fail(`${what}: the frame shows ${shownZoom(windows)}`);
    await sleepMs(20);
  }
}

test('a double-click while recording zooms the frame in and it stays; a single click does nothing; the next double-click zooms out', unix, () =>
  withRecordingMain({ countdown: false, doubleClickZoom: true }, async ({ ipcHandlers, windows, captureRunning, click }) => {
    ipcHandlers['bar:arm']({}, SOURCE);
    await ipcHandlers['bar:start']();
    await captureRunning(1);
    click(5);
    await sleepMs(500);
    assert.ok(shownZoom(windows) < 1.02, `one click: no zoom (${shownZoom(windows)})`);
    click(6, 6.25);
    await waitForZoom(windows, (z) => z > 1.98, 'zoomed in to 2x after the double-click');
    // It stays: no zooming out on its own.
    await sleepMs(2000);
    assert.ok(shownZoom(windows) > 1.98, `still zoomed in two seconds later: ${shownZoom(windows)}`);
    click(9);
    await sleepMs(400);
    assert.ok(shownZoom(windows) > 1.98, `a single click leaves it zoomed in: ${shownZoom(windows)}`);
    click(10, 10.2);
    await waitForZoom(windows, (z) => z < 1.02, 'zoomed out after the next double-click');
  }));

test('with double-click to zoom off, a double-click shows no frame', unix, () =>
  withRecordingMain({ countdown: false, doubleClickZoom: false }, async ({ ipcHandlers, windows, captureRunning, click }) => {
    ipcHandlers['bar:arm']({}, SOURCE);
    await ipcHandlers['bar:start']();
    await captureRunning(1);
    click(5, 5.2);
    await sleepMs(600);
    assert.ok(shownZoom(windows) < 1.02, `no zoom: ${shownZoom(windows)}`);
  }));
