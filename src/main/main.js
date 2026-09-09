'use strict';
const { app, BrowserWindow, ipcMain, systemPreferences, shell, dialog, globalShortcut } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { createPermissions } = require('./permissions');
const { createRecorder } = require('./recorder');
const { spawnHelper, stopHelper } = require('./helpers');

const BIN_DIR = path.join(__dirname, '..', '..', 'bin');
const permissions = createPermissions({ systemPreferences, shell });

// Surface a helper spawn failure to the user instead of leaving them staring
// at a picker window that looks like it is recording but never will be.
function onRecorderError(err) {
  dialog.showErrorBox(
    'Loupe',
    `Recording stopped unexpectedly (${err.source}): ${err.message}`
  );
  // A helper failure ends the recording just like a normal stop, so the HUD
  // poll timer must be torn down here too -- otherwise it keeps firing
  // against a window nobody will ever close.
  if (hudTimer) { clearInterval(hudTimer); hudTimer = null; }
  if (hudWindow) { hudWindow.close(); hudWindow = null; }
  pickerWindow?.show();
}

const recorder = createRecorder({
  binDir: BIN_DIR, spawnHelper, stopHelper, onError: onRecorderError
});

let pickerWindow = null;

function createPickerWindow() {
  pickerWindow = new BrowserWindow({
    width: 940, height: 660, title: 'Loupe',
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js') }
  });
  pickerWindow.loadFile(path.join(__dirname, '..', 'renderer', 'picker', 'index.html'));
  return pickerWindow;
}

let hudWindow = null;
let hudTimer = null;
let startedAt = 0;

// The floating recording overlay. Its BrowserWindow media-source id is
// passed to `bin/capture --exclude-window` (see record:start below) so
// ScreenCaptureKit excludes it from the recording -- verified end to end,
// see task-14-report.md.
function createHudWindow() {
  hudWindow = new BrowserWindow({
    width: 260, height: 56, x: 40, y: 60,
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, movable: true, skipTaskbar: true,
    // focusable:false + showInactive() below keep the HUD from stealing
    // focus/activation from whatever app is being demoed underneath it.
    focusable: false, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js') }
  });
  hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hudWindow.loadFile(path.join(__dirname, '..', 'renderer', 'hud', 'index.html'));
  hudWindow.once('ready-to-show', () => hudWindow?.showInactive());

  hudTimer = setInterval(() => {
    const s = recorder.state();
    hudWindow?.webContents.send('hud:update', {
      zoom: s.zoom, duration: s.duration, zoomEnabled: s.zoomEnabled,
      tapReenables: s.tapReenables, hasMic: s.hasMic,
      elapsed: (Date.now() - startedAt) / 1000
    });
  }, 200);

  return hudWindow;
}

// Both the Stop button (via ipcMain.handle('record:stop', ...)) and the
// global shortcut call this one function directly. ipcMain.emit() would NOT
// trigger an ipcMain.handle() handler, so the shortcut must not re-emit the
// channel -- it must call stopRecording() itself.
async function stopRecording() {
  if (!hudWindow) return null;
  if (hudTimer) { clearInterval(hudTimer); hudTimer = null; }
  const win = hudWindow;
  hudWindow = null;
  // recorder.stop() resolves to null when there is nothing to stop (e.g. a
  // second call racing the first); that is a valid, falsy result and must
  // not be dereferenced. A rejection, though, must not strand the user with
  // no window at all: the picker has to come back regardless of how
  // stop() ends, so the recovery runs in `finally` and the failure is
  // re-thrown afterward rather than swallowed.
  try {
    const result = await recorder.stop();
    return result;
  } finally {
    win.close();
    pickerWindow?.show();
  }
}

ipcMain.handle('sources:list', () =>
  new Promise((resolve, reject) => {
    const args = ['--exclude-pid', String(process.pid)];
    execFile(path.join(BIN_DIR, 'sources'), args, { maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(stdout || err.message));
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
      });
  }));

ipcMain.handle('permissions:status', () => ({
  screenRecording: permissions.screenRecording(),
  accessibility: permissions.accessibility(),
  canRecord: permissions.canRecord(),
  canZoom: permissions.canZoom()
}));

ipcMain.handle('permissions:open', (_e, pane) => permissions.openPane(pane));

// The main process is the actual trust boundary here, not the picker
// renderer: a compromised or hostile renderer can invoke this handler with
// whatever it likes, so every field is checked against the shape the app
// itself produces before it is allowed anywhere near recorder.start() --
// `width`/`height` in particular feed the camera solver's and renderer's
// arithmetic, where a non-finite or negative value fails silently deep in
// geometry maths rather than at an obvious boundary. `source` is not
// checked against a live source list on purpose: the window list can
// change between listing and recording, and re-verifying here would just
// introduce a race that rejects legitimate recordings.
const SOURCE_ID_RE = /^(display|window):\d+$/;

function validateStartOptions(opts) {
  const { source, width, height, title, mic } = opts ?? {};
  if (typeof source !== 'string' || !SOURCE_ID_RE.test(source)) {
    throw new Error(`Invalid source id: ${JSON.stringify(source)}`);
  }
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
    throw new Error(`Invalid width: ${JSON.stringify(width)}`);
  }
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
    throw new Error(`Invalid height: ${JSON.stringify(height)}`);
  }
  if (title !== undefined && typeof title !== 'string') {
    throw new Error(`Invalid title: ${JSON.stringify(title)}`);
  }
  return { source, width, height, title: typeof title === 'string' ? title : '', mic: Boolean(mic) };
}

ipcMain.handle('record:start', async (_e, rawOpts) => {
  const { source, width, height, title, mic } = validateStartOptions(rawOpts);
  if (!permissions.canRecord()) throw new Error('Screen Recording permission is required');
  if (mic) await permissions.requestMicrophone();

  const dir = path.join(os.homedir(), 'Movies', 'Loupe', String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });

  startedAt = Date.now();
  const hud = createHudWindow();
  try {
    await recorder.start({
      source, width, height, title, mic, dir,
      // getMediaSourceId() returns "window:<CGWindowID>:0" on macOS; the
      // middle segment is the same windowID `bin/sources` reports as
      // "window:<n>" and that SCContentFilter(excludingWindows:) matches
      // against -- verified empirically, see task-14-report.md.
      hudWindowId: hud.getMediaSourceId().split(':')[1],
      zoomEnabled: permissions.canZoom()
    });
  } catch (err) {
    if (hudTimer) { clearInterval(hudTimer); hudTimer = null; }
    if (hudWindow) { hudWindow.close(); hudWindow = null; }
    throw err;
  }
  pickerWindow?.hide();
  return { dir, zoomEnabled: permissions.canZoom() };
});

ipcMain.handle('record:stop', stopRecording);

app.whenReady().then(() => {
  createPickerWindow();
  globalShortcut.register('Control+Shift+S', () => { stopRecording(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });

module.exports = { createPickerWindow };
