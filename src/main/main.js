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
  teardownHud();
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

// Single teardown path for the HUD window + its poll timer. Every call site
// that used to null hudWindow/clear hudTimer by hand (stopRecording,
// onRecorderError, the record:start catch block, and now the window's own
// 'closed' event and app 'will-quit') funnels through here instead, so the
// two pieces of state are always retired together.
//
// Idempotent by construction: hudWindow is read into a local and nulled
// before anything else runs, so a second/concurrent call sees hudWindow
// already null and does nothing. Closing an already-destroyed BrowserWindow
// would throw, hence the isDestroyed() guard -- that is exactly the case
// that used to crash the process when the OS destroyed the HUD out from
// under us (e.g. Cmd+Q) and the next 200ms timer tick called
// webContents.send() on the dangling reference.
function teardownHud() {
  if (hudTimer) { clearInterval(hudTimer); hudTimer = null; }
  const win = hudWindow;
  hudWindow = null;
  if (win && !win.isDestroyed()) win.close();
}

// The floating recording overlay. Its BrowserWindow media-source id is
// passed to `bin/capture --exclude-window` (see record:start below) so
// ScreenCaptureKit excludes it from the recording -- verified end to end,
// see task-14-report.md.
function createHudWindow() {
  const win = new BrowserWindow({
    width: 260, height: 56, x: 40, y: 60,
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, movable: true, skipTaskbar: true,
    // focusable:false + showInactive() below keep the HUD from stealing
    // focus/activation from whatever app is being demoed underneath it.
    focusable: false, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js') }
  });
  hudWindow = win;
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'hud', 'index.html'));
  win.once('ready-to-show', () => win?.showInactive());
  // Covers every way the window can go away that does NOT run through
  // teardownHud() first -- most importantly Electron destroying it on its
  // own when the app quits mid-recording (Cmd+Q, dock "Quit"). When
  // teardownHud() itself calls win.close(), this handler fires again
  // afterwards, but hudWindow is already null by then so it is a no-op.
  win.once('closed', () => teardownHud());

  hudTimer = setInterval(() => {
    const s = recorder.state();
    if (!win.isDestroyed()) {
      win.webContents.send('hud:update', {
        zoom: s.zoom, duration: s.duration, zoomEnabled: s.zoomEnabled,
        tapReenables: s.tapReenables, hasMic: s.hasMic,
        elapsed: (Date.now() - startedAt) / 1000
      });
    }
  }, 200);

  return win;
}

// Both the Stop button (via ipcMain.handle('record:stop', ...)) and the
// global shortcut call this one function directly. ipcMain.emit() would NOT
// trigger an ipcMain.handle() handler, so the shortcut must not re-emit the
// channel -- it must call stopRecording() itself.
async function stopRecording() {
  if (!hudWindow) return null;
  teardownHud();
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
    teardownHud();
    throw err;
  }
  pickerWindow?.hide();
  return { dir, zoomEnabled: permissions.canZoom() };
});

ipcMain.handle('record:stop', stopRecording);

// Whether the Control+Shift+S stop-recording shortcut is actually held by
// us. globalShortcut.register() returns false (not a rejection/throw) when
// another application already owns the combination, and that failure was
// previously silent: the user presses the shortcut mid-recording, nothing
// happens, and there is no error anywhere to explain why. Logged clearly
// below rather than surfaced as a startup dialog -- a modal here would
// interrupt every recording session over a shortcut collision that the HUD
// Stop button already works around. Indicating this in the HUD itself would
// need a renderer change (a new field on 'hud:update' plus UI to render it),
// which is out of scope for this main-process-only fix -- see
// task-14-report.md.
let stopShortcutRegistered = false;

app.whenReady().then(() => {
  createPickerWindow();
  stopShortcutRegistered = globalShortcut.register('Control+Shift+S', () => {
    // Unlike ipcMain.handle('record:stop', stopRecording), Electron has no
    // built-in mechanism to forward a rejection from a globalShortcut
    // callback anywhere -- an unhandled rejection here would otherwise just
    // vanish into (or crash) the main process with no user-visible signal.
    stopRecording().catch((err) => {
      console.error('Loupe: stop-recording shortcut failed to stop the recording:', err);
      dialog.showErrorBox('Loupe', `Failed to stop recording: ${err.message}`);
    });
  });
  if (!stopShortcutRegistered) {
    console.error(
      'Loupe: could not register the Control+Shift+S stop-recording shortcut ' +
      '(another application likely already holds it). The HUD Stop button ' +
      'still works.'
    );
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Quitting mid-recording (Cmd+Q, dock "Quit", etc.) is an ordinary way for a
// session to end, not an edge case, and the capture helper deserves the
// chance to finalize its file rather than being killed out from under a
// half-written recording. 'will-quit' cannot do that: it fires after
// Electron has already started tearing down windows, and returning a
// promise or awaiting anything in it does not delay the quit -- so it is
// only ever safe to use for synchronous cleanup. 'before-quit' fires
// earlier and, uniquely, honours event.preventDefault() to hold off the
// quit while async work runs; that is what makes a real stop-and-save
// achievable at all here, and the `quitting` flag lets the second
// before-quit (from our own app.quit() call below) through instead of
// looping forever. The outer timeout is a deliberate belt-and-suspenders:
// stopHelper() already SIGKILLs a stuck helper after 3s each (see
// helpers.js), so normal shutdown finishes well under 8s, but if that
// invariant is ever violated this still guarantees the app quits rather
// than hanging on Cmd+Q forever.
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !hudWindow) return;
  event.preventDefault();
  quitting = true;
  Promise.race([
    stopRecording().catch((err) => {
      console.error('Loupe: failed to stop recording cleanly while quitting:', err);
    }),
    new Promise((resolve) => setTimeout(resolve, 8000))
  ]).finally(() => app.quit());
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Final synchronous safety net: if some path reached actual quit without
  // going through stopRecording()/onRecorderError (e.g. before-quit's
  // timeout fired, or a future quit path we haven't accounted for), this
  // guarantees hudTimer is cleared before the process goes down rather than
  // relying on the window's own 'closed' event, which may not have fired
  // yet at this point in shutdown.
  teardownHud();
});

module.exports = { createPickerWindow };
