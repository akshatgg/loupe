'use strict';
const electron = require('electron');
const { app, BrowserWindow, ipcMain, systemPreferences, shell, dialog, globalShortcut } = electron;
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createPermissions } = require('./permissions');
const { createRecorder } = require('./recorder');
const { spawnHelper, stopHelper } = require('./helpers');
const { validateRegion, clampRegionToBounds } = require('./region');
const { transition } = require('./bar-state');
const { createLiveCamera, stepLiveCamera } = require('./live-camera');
const { inputTapArgs } = require('./settings');
const { createAppShell } = require('./app-shell');
const { createExportRunner, registerExportIpc } = require('./ipc/export');
const { createProjectStore, registerProjectIpc } = require('./ipc/project');
const { registerShareIpc } = require('./ipc/share');
const { registerFileActionsIpc } = require('./ipc/fileActions');
const {
  helperCommand, coordinateMapper, attachThumbnails
} = require('./platform');

const IS_WINDOWS = process.platform === 'win32';
// Physical pixels <-> DIPs on Windows; identities on macOS (platform.js).
const coords = coordinateMapper(() => electron.screen);

// Keeps one of Loupe's own windows (the bar, the area outline, the zoom frame)
// out of the recording. macOS does this in bin/capture from window ids (see
// bar:start); on Windows the window itself opts out of capture
// (WDA_EXCLUDEFROMCAPTURE, Windows 10 2004 and later), which
// Windows.Graphics.Capture honours.
function excludeFromCapture(win) {
  if (IS_WINDOWS) win.setContentProtection(true);
}

const BIN_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.join(__dirname, '..', '..', 'bin');
const permissions = createPermissions({ systemPreferences, shell });

// Surface a helper failure to the user -- but only capture's failure means
// the recording itself is gone. Losing inputtap (the zoom/click/cursor
// gesture hook) is a degradation, not a fatal error: capture keeps writing
// raw.mov, so tearing down the bar and reopening the picker here would
// actually cause the data loss the dialog falsely claims already happened --
// stopRecording() bails out once barWindow is null, so every later Stop
// press or app quit would become a no-op and the recording would run forever
// with no way to finalize it. recorder.js already keeps `recording` true and
// records the error in state() for exactly this case (see recorder.test.js);
// the bar's 200ms poll already surfaces it via bar.js's `error`/`warn`
// spans, so nothing further is needed here.
function onRecorderError(err) {
  if (err.source === 'inputtap') return;

  // A dead capture process means nothing is being written to raw.mov any
  // more -- this really is the end of the recording. Route it through the
  // exact same finalize-and-reopen-the-picker path a normal Stop press
  // takes, so whatever was captured up to this point is still saved to
  // project.json/cursor.bin rather than discarded.
  dialog.showErrorBox(
    'Loupe',
    `Recording stopped: ${err.message}`
  );
  stopRecording().catch((e) => {
    console.error('Loupe: failed to finalize the recording after a capture error:', e);
  });
}

const recorder = createRecorder({
  binDir: BIN_DIR, spawnHelper, stopHelper, onError: onRecorderError,
  toDipPoint: coords.toDipPoint, toCaptureRect: coords.toScreenRect
});

let pickerWindow = null;

function createPickerWindow() {
  pickerWindow = new BrowserWindow({
    width: 940, height: 660, title: 'Loupe',
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js') }
  });
  // Only windows on the active Space are listed, so choosing a window that
  // lives on another desktop means switching to it. A picker pinned to its own
  // Space would be left behind at exactly that moment, so it follows instead --
  // switch desktops, hit Refresh, and the window is there to pick.
  pickerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pickerWindow.loadFile(path.join(__dirname, '..', 'renderer', 'picker', 'index.html'));
  return pickerWindow;
}

// "New recording" from the menu or the Library. The picker may have been
// closed since launch, so it is made again rather than assumed; while a bar is
// armed or recording, that session is the recording, so nothing opens.
function showPicker() {
  if (barWindow) return;
  if (!pickerWindow || pickerWindow.isDestroyed()) createPickerWindow();
  else { pickerWindow.show(); pickerWindow.focus(); }
}

// ---------------------------------------------------------------------------
// The control bar. Pressing "Continue" in the picker ARMS the bar (opens it,
// shows the chosen source and its area controls) but does
// NOT start recording -- bin/capture is only spawned once the user presses
// Start on the bar itself (bar:start below). The same bar window then
// switches to showing elapsed time/zoom/mic/Stop once recording begins; it
// is one persistent window across both states, not two windows.
//
// barPhase is the pure state src/main/bar-state.js's transition() governs:
// 'armed' -> 'recording' -> gone. Every IPC handler that moves the bar
// between states runs its action through transition() so an invalid call
// (e.g. a second Start while already recording) is rejected by the same
// logic test/bar-state.test.js exercises directly, not by ad hoc checks
// scattered across each handler.
let barWindow = null;
let barTimer = null;
let startedAt = 0;
let barPhase = null; // null (no bar open) | 'armed' | 'recording'

// The source the user picked in the picker, validated once at arm time
// (see bar:arm) and reused, unmodified, by bar:start -- the picker itself
// never starts a recording, it only supplies what to record.
let armedSource = null;

// The region-selection overlay, and the area the bar has picked so far.
// 'full' means no crop (record the whole source); 'rect'/'draw' both mean
// the overlay is showing a rectangle, with `currentAreaRect` (GLOBAL screen
// points, the same space bin/sources reports source x/y in) holding the
// live result of whatever the user last dragged. For a window source the
// overlay covers just that window, so the crop can trim e.g. a browser's
// toolbar -- see validateStartOptions's region handling below.
let overlayWindow = null;
let overlayInitData = null; // {target, mode, rect} the overlay pulls once on load
let areaMode = 'full';
let currentAreaRect = null;

// Single teardown path for the bar window + its poll timer. Idempotent by
// construction: barWindow is read into a local and nulled before anything
// else runs, so a second/concurrent call sees barWindow already null and
// does nothing. Closing an already-destroyed BrowserWindow would throw,
// hence the isDestroyed() guard -- the same case that used to crash the
// process when the OS destroyed the old HUD out from under us (e.g. Cmd+Q)
// and the next 200ms timer tick called webContents.send() on the dangling
// reference.
function teardownBar() {
  if (barTimer) { clearInterval(barTimer); barTimer = null; }
  const win = barWindow;
  barWindow = null;
  if (win && !win.isDestroyed()) win.close();
}

// While the region overlay is up it covers the whole target above every
// other window, so Escape must always get the user out -- it does exactly
// what the bar's Back does. Held as a global shortcut, and only while the
// overlay is showing: neither the overlay (shown inactive) nor the bar
// (focusable:false) ever has keyboard focus to hear a plain keydown, and
// holding Escape any longer would steal it from the app being demoed.
let escapeHeld = false;

function holdEscapeForBack(hold) {
  if (hold === escapeHeld) return;
  if (hold) {
    escapeHeld = globalShortcut.register('Escape', () => {
      stopRecording().catch((e) => console.error('Loupe: Escape/Back failed:', e));
    });
    if (!escapeHeld) console.warn('Loupe: could not register Escape to dismiss the area overlay');
  } else {
    globalShortcut.unregister('Escape');
    escapeHeld = false;
  }
}

function closeOverlayWindow() {
  holdEscapeForBack(false);
  const win = overlayWindow;
  overlayWindow = null;
  overlayInitData = null;
  if (win && !win.isDestroyed()) win.close();
}

// Tears down everything an armed (or recording) session owns and resets the
// pure state back to "nothing armed". Used by both a clean Back/Stop and by
// the window being destroyed out from under us (Cmd+Q mid-arm, etc.).
// The "what's in shot" frame: while recording, outlines on screen the part
// of the recorded area the video will show at the current zoom, with the
// zoom level on it. A transparent, click-through window over exactly the
// recorded area, stepped by live-camera.js (the renderer's own camera math)
// at ~60fps. Excluded from the capture like the bar -- and, like the bar, it
// must already be on screen when bin/capture starts, since ScreenCaptureKit
// only resolves --exclude-window ids among the windows on screen right then.
let shotWindow = null;
let shotTimer = null;

function createShotWindow(area) {
  const win = new BrowserWindow({
    x: Math.round(area.x), y: Math.round(area.y),
    width: Math.round(area.width), height: Math.round(area.height),
    frame: false, transparent: true, hasShadow: false,
    resizable: false, movable: false, skipTaskbar: true, focusable: false,
    fullscreenable: false, show: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js') }
  });
  shotWindow = win;
  excludeFromCapture(win);
  win.setIgnoreMouseEvents(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'shot', 'index.html'));
  win.showInactive();
  win.once('closed', () => { if (shotWindow === win) shotWindow = null; });
  return win;
}

function startShotFrame(area) {
  const live = createLiveCamera(area);
  let last = performance.now();
  let lastSent = '';
  shotTimer = setInterval(() => {
    const now = performance.now();
    // Capped so a stalled main process doesn't jump the spring in one go.
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    const s = recorder.state();
    const view = stepLiveCamera(live, { target: s.zoom, cursor: s.cursorTrack.at(-1) ?? null, dt });
    const { zoom, rect } = view;
    // At rest this settles to identical values -- don't re-send those 60x/s.
    const key = [zoom.toFixed(3), rect.x.toFixed(1), rect.y.toFixed(1)].join();
    if (key === lastSent || !shotWindow || shotWindow.isDestroyed()) return;
    lastSent = key;
    shotWindow.webContents.send('shot:update', { zoom, rect });
  }, 16);
}

function closeShotWindow() {
  if (shotTimer) { clearInterval(shotTimer); shotTimer = null; }
  const win = shotWindow;
  shotWindow = null;
  if (win && !win.isDestroyed()) win.close();
}

function teardownArmedState() {
  teardownBar();
  closeOverlayWindow();
  closeShotWindow();
  armedSource = null;
  areaMode = 'full';
  currentAreaRect = null;
  barPhase = null;
}

// The floating control bar. Its BrowserWindow media-source id is passed to
// `bin/capture --exclude-window` (see bar:start below, and recorder.js/
// exclude-args.js) so ScreenCaptureKit excludes it from the recording --
// verified end to end, see control-bar-report.md.
function createBarWindow() {
  const win = new BrowserWindow({
    width: 420, height: 96, x: 40, y: 60,
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, movable: true, skipTaskbar: true,
    // focusable:false + showInactive() below keep the bar from stealing
    // focus/activation from whatever app is being demoed underneath it.
    focusable: false, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js') }
  });
  barWindow = win;
  excludeFromCapture(win);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // One level above the region overlay ('screen-saver', see
  // createOverlayWindow): the overlay covers the whole target, and the bar
  // usually sits inside it -- at the same level or below, every click on
  // Start/Back/the area buttons would land on the overlay instead.
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'bar', 'index.html'));
  win.once('ready-to-show', () => {
    win?.showInactive();
    win?.webContents.send('bar:update', barPayload());
  });
  // Covers every way the window can go away that does NOT run through
  // teardownArmedState() first -- most importantly Electron destroying it on
  // its own when the app quits mid-session (Cmd+Q, dock "Quit").
  // teardownArmedState() itself nulls barWindow before calling win.close(),
  // so this handler firing afterward is a harmless no-op.
  win.once('closed', () => teardownArmedState());
  return win;
}

// The region-selection overlay: a transparent, frameless, always-on-top
// window covering exactly the target display or window, positioned at its
// own global-space x/y/width/height (the same numbers bin/sources reports,
// in points) so the overlay's own local coordinate space lines up 1:1 with
// that global space. Reused from the original region-capture work almost
// unchanged (region.js/region-geometry.js's pure math is untouched) -- what
// changed is who drives it: the bar's Full/Rectangle/Draw buttons
// (via setAreaMode below), not a modal confirm/cancel dialog of its own.
function createOverlayWindow(target) {
  const win = new BrowserWindow({
    x: Math.round(target.x), y: Math.round(target.y),
    width: Math.round(target.width), height: Math.round(target.height),
    frame: false, transparent: true, hasShadow: false,
    resizable: false, movable: false, skipTaskbar: true,
    fullscreenable: false, show: false, backgroundColor: '#00000000',
    // Shown inactive (showInactive in setAreaMode), so without this macOS
    // spends the first click just activating the window, not starting a drag.
    acceptFirstMouse: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js') }
  });
  overlayWindow = win;
  excludeFromCapture(win);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 'screen-saver' puts the overlay above whatever else is on screen; the
  // bar sits one level higher still (createBarWindow) so it stays clickable.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'region', 'index.html'));
  // Unlike the bar, nothing is pushed here on 'ready-to-show': the overlay
  // PULLS its initial {target, mode, rect} via region:init once its own
  // renderer has loaded (see setAreaMode below) -- avoiding a race where a
  // command sent immediately after `new BrowserWindow(...)` arrives before
  // the renderer has registered a listener for it.
  win.once('closed', () => {
    if (overlayWindow === win) {
      overlayWindow = null;
      overlayInitData = null;
      holdEscapeForBack(false);
    }
  });
  return win;
}

function armedTarget() {
  return { x: armedSource.x, y: armedSource.y, width: armedSource.width, height: armedSource.height };
}

function localFromGlobal(rect, target) {
  if (!rect) return null;
  return { x: rect.x - target.x, y: rect.y - target.y, width: rect.width, height: rect.height };
}

// Switches the bar's area mode ('full' | 'rect' | 'draw'), driving the
// overlay window rather than duplicating its rectangle UI on the bar itself.
// 'full' just hides the overlay (no crop, nothing to show); 'rect'/'draw'
// show it, either with the last rect the user drew (mode 'rect', so
// switching away and back doesn't lose it) or with no rect at all (mode
// 'draw', so the next drag anywhere free-draws a fresh one).
function setAreaMode(mode) {
  areaMode = mode;
  const target = armedTarget();
  if (mode === 'full') {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
    holdEscapeForBack(false);
    currentAreaRect = null;
  } else {
    const localRect = mode === 'draw' ? null : localFromGlobal(currentAreaRect, target);
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      overlayInitData = { target, mode, rect: localRect };
      createOverlayWindow(target);
    } else {
      overlayWindow.webContents.send('region:command', { mode, rect: localRect });
    }
    overlayWindow.showInactive();
    holdEscapeForBack(true);
  }
  barWindow?.webContents.send('bar:update', barPayload());
}

function barPayload() {
  return {
    state: barPhase,
    sourceLabel: armedSource?.title || armedSource?.source || '',
    canPickArea: Boolean(armedSource),
    sourceKind: armedSource?.source.startsWith('window:') ? 'window' : 'display',
    areaMode
  };
}

function recordingPayload() {
  const s = recorder.state();
  return {
    state: 'recording',
    zoom: s.zoom, duration: s.duration, zoomEnabled: s.zoomEnabled,
    tapReenables: s.tapReenables, hasMic: s.hasMic, micRequested: Boolean(armedSource?.mic),
    error: s.error,
    elapsed: (Date.now() - startedAt) / 1000
  };
}

// Both the Back button (armed) and the Stop button (recording) resolve to
// this one function -- see preload.js's stopRecording, which both map to.
// "Back" while armed is exactly "stop a recording that was never started":
// recorder.stop() resolves to null when source is still null (start() was
// never called), so no project is saved, no editor opens, and no helper
// process was ever spawned to leak -- teardownArmedState() below is the only
// cleanup either path actually needs. The global Control+Shift+S shortcut
// and app quit call this same function directly (ipcMain.emit() would NOT
// trigger an ipcMain.handle() handler, so they can't just re-emit the
// channel).
async function stopRecording() {
  if (!barWindow) return null;
  barPhase = transition(barPhase, barPhase === 'armed' ? 'back' : 'stop');
  teardownArmedState();
  // recorder.stop() resolves to null when there is nothing to stop (e.g. the
  // bar was only ever armed, or a second call races the first); that is a
  // valid, falsy result and must not be dereferenced. A rejection, though,
  // must not strand the user with no window at all: the picker has to come
  // back regardless of how stop() ends, so the recovery runs in `finally`
  // and the failure is re-thrown afterward rather than swallowed.
  try {
    const result = await recorder.stop();
    if (result?.dir) {
      openEditorWindow(result.dir);
      appShell.recordingsChanged();
    }
    return result;
  } finally {
    showPicker();
  }
}

function listNativeSources() {
  return new Promise((resolve, reject) => {
    const { file, args } = helperCommand(BIN_DIR, 'sources');
    args.push('--exclude-pid', String(process.pid));
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(new Error(stdout || err.message));
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
      });
  });
}

ipcMain.handle('sources:list', async () => {
  const sources = await listNativeSources();
  if (!IS_WINDOWS) return sources;
  // bin/sources on Windows reports physical pixels and no thumbnails: bring
  // the rects into DIPs like everything else, and borrow Chromium's
  // thumbnails for the pictures.
  const inDips = sources.map((s) => {
    const r = coords.toDipRect({ x: s.x, y: s.y, width: s.width, height: s.height });
    return { ...s, x: r.x, y: r.y, width: r.width, height: r.height };
  });
  try {
    const captured = await electron.desktopCapturer.getSources({
      types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }
    });
    return attachThumbnails(inDips, captured, electron.screen.getAllDisplays());
  } catch (err) {
    console.error('Loupe: could not load source thumbnails:', err);
    return inDips;
  }
});

ipcMain.handle('region:init', () => overlayInitData);

// The overlay reports its rect on every drag/resize/draw change, not just
// once at the end, so the bar's Start button always has a current rect to
// hand to recorder.start(). The overlay renderer is not a trust boundary any
// more than the picker is -- validateRegion enforces the same finite/
// minimum-size shape record:start's validateStartOptions does, and
// clampRegionToBounds pulls it back inside the target display in case
// anything upstream (a stale drag, a rounding edge) let it slip past the
// edge. A malformed update is simply ignored -- the last good rect stays in
// effect rather than corrupting state or crashing the main process.
ipcMain.handle('region:live', (_e, rawRegion) => {
  if (!overlayInitData) return;
  try {
    currentAreaRect = clampRegionToBounds(validateRegion(rawRegion), overlayInitData.target);
  } catch {
    // ignore malformed live updates
  }
});

ipcMain.handle('permissions:status', () => ({
  screenRecording: permissions.screenRecording(),
  accessibility: permissions.accessibility(),
  // permissions.js already exposed microphone() for exactly this; it was
  // just never wired into the one place the picker reads permission state
  // from, so its mic checkbox had no feedback at all about whether the OS
  // would actually grant it.
  microphone: permissions.microphone(),
  canRecord: permissions.canRecord(),
  canZoom: permissions.canZoom()
}));

ipcMain.handle('permissions:open', (_e, pane) => permissions.openPane(pane));

// Settings (settings:get/set included), the Library and Settings windows,
// presets, menus, updates and crash reports: see app-shell.js.
const appShell = createAppShell({
  electron, openEditorWindow, showPicker, getEditorWindow: () => editorWindow,
  getEditorDir: () => (editorWindow && !editorWindow.isDestroyed() ? editorDir : null),
  // Opening a recording from the Library mid-recording would put the editor
  // on screen (and in the video); mid-export it would close the exporting editor.
  openBlocked: () => {
    if (barWindow) return 'Finish or cancel the recording first, then open this one.';
    if (exporter.busy()) return 'An export is still running. Open this recording when it has finished.';
    return null;
  }
});
appShell.start();
const currentSettings = () => appShell.settings.get();

// The main process is the actual trust boundary here, not the picker
// renderer: a compromised or hostile renderer can invoke this handler with
// whatever it likes, so every field is checked against the shape the app
// itself produces before it is allowed anywhere near recorder.start() --
// `width`/`height` in particular feed the camera solver's and renderer's
// arithmetic, where a non-finite or negative value fails silently deep in
// geometry maths rather than at an obvious boundary. `source` is not
// checked against a live source list on purpose: the window list can
// change between listing and recording, and re-verifying here would just
// introduce a race that rejects legitimate recordings. Used both by
// bar:arm (region always undefined -- the picker no longer offers one) and
// by bar:start (region resolved from whatever the overlay last reported).
const SOURCE_ID_RE = /^(display|window):\d+$/;

// x/y are the source's global-space origin in points (Sources.swift's
// SourceOut.x/y). Unlike width/height they may legitimately be negative --
// a display left of or above the primary display -- so they are validated
// only for being finite numbers, never for being positive. Optional (default
// 0) so a picker/source list from before this field existed still works.
function validateStartOptions(opts) {
  const { source, width, height, title, mic, x, y, region } = opts ?? {};
  if (typeof source !== 'string' || !SOURCE_ID_RE.test(source)) {
    throw new Error(`Invalid source id: ${JSON.stringify(source)}`);
  }
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
    throw new Error(`Invalid width: ${JSON.stringify(width)}`);
  }
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
    throw new Error(`Invalid height: ${JSON.stringify(height)}`);
  }
  const ox = x === undefined ? 0 : x;
  const oy = y === undefined ? 0 : y;
  if (typeof ox !== 'number' || !Number.isFinite(ox)) {
    throw new Error(`Invalid x: ${JSON.stringify(x)}`);
  }
  if (typeof oy !== 'number' || !Number.isFinite(oy)) {
    throw new Error(`Invalid y: ${JSON.stringify(y)}`);
  }
  if (title !== undefined && typeof title !== 'string') {
    throw new Error(`Invalid title: ${JSON.stringify(title)}`);
  }
  // A region crop works for display and window sources alike (Capture.swift
  // rebases it against whichever one was picked). Validated the same way
  // width/height/x/y are: finite numbers, positive size at or above a
  // sensible minimum, via validateRegion (shared with the region:live
  // handler above).
  const validatedRegion = region === undefined ? undefined : validateRegion(region);
  return {
    source, width, height, x: ox, y: oy,
    title: typeof title === 'string' ? title : '', mic: Boolean(mic),
    region: validatedRegion
  };
}

// Guards the async gap between a bar:arm/bar:start call being accepted and
// the corresponding window/recorder state actually existing -- the picker
// renderer is hidden, not destroyed, while armed/recording, and
// `await permissions.requestMicrophone()` in bar:start means that gap is
// real, not just a single microtask.
let starting = false;

// Picker "Continue": arms the bar with the chosen source, but does not
// record anything yet. `region` is deliberately never part of rawOpts here
// -- the picker no longer offers area selection (see the region-capture
// UI removed from picker.js); the bar decides that afterward.
ipcMain.handle('bar:arm', (_e, rawOpts) => {
  if (starting || barWindow) {
    throw new Error('A recording bar is already open.');
  }
  const opts = validateStartOptions(rawOpts);
  if (!permissions.canRecord()) throw new Error('Screen Recording permission is required');
  armedSource = opts;
  areaMode = 'full';
  currentAreaRect = null;
  barPhase = 'armed';
  createBarWindow();
  pickerWindow?.hide();
});

ipcMain.handle('bar:setAreaMode', (_e, mode) => {
  if (mode !== 'full' && mode !== 'rect' && mode !== 'draw') {
    throw new Error(`Invalid area mode: ${JSON.stringify(mode)}`);
  }
  if (barPhase !== 'armed' || !armedSource) {
    throw new Error('The area can only be changed before recording starts.');
  }
  setAreaMode(mode);
});

// The bar's Start button: this is the only place bin/capture is ever
// spawned now -- pressing Continue in the picker no longer starts anything.
ipcMain.handle('bar:start', async () => {
  if (starting || barPhase !== 'armed' || !armedSource) {
    throw new Error('Cannot start recording right now.');
  }
  starting = true;
  try {
    barPhase = transition(barPhase, 'start');
    if (!permissions.canRecord()) throw new Error('Screen Recording permission is required');

    // A denied mic prompt used to be discarded entirely: bin/capture was
    // started with --mic 1 regardless, which fails outright with "no
    // microphone available" and takes the whole recording down with it --
    // over a permission the user may not even have cared about (the
    // checkbox may just be left on from a previous session). Falling back to
    // recording without audio, rather than refusing to start, keeps the
    // failure proportional to what was actually lost.
    let recordMic = armedSource.mic;
    if (armedSource.mic) {
      const granted = await permissions.requestMicrophone();
      if (!granted) recordMic = false;
    }

    const dir = path.join(appShell.usableRecordingsFolder(), String(Date.now()));
    fs.mkdirSync(dir, { recursive: true });

    // Every Loupe-owned window that could be on screen right now -- the bar
    // itself (always) and, with the outline still open, the
    // region overlay -- must never appear in the recording.
    // getMediaSourceId() returns "window:<CGWindowID>:0" on macOS; the
    // middle segment is the same windowID `bin/sources` reports as
    // "window:<n>" and that SCContentFilter(excludingWindows:) matches
    // against -- verified empirically, see control-bar-report.md.
    const excludeWindowIds = [barWindow.getMediaSourceId().split(':')[1]];
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      excludeWindowIds.push(overlayWindow.getMediaSourceId().split(':')[1]);
    }
    // "The area outline goes away once recording starts" -- closed here,
    // before capture spawns, rather than merely hidden, since it would only
    // be clutter from this point on. This close is NOT relied on as the only
    // protection against it appearing on screen: bin/capture is ALSO told
    // its window id above, so a race between "Electron finished closing the
    // window" and "ScreenCaptureKit's stream actually started rendering
    // frames" can never let it slip into a frame either way.
    closeOverlayWindow();

    const region = areaMode === 'full' ? undefined : currentAreaRect;
    const validated = validateStartOptions({ ...armedSource, region });

    // Only when zoom can actually happen -- otherwise there's never a frame.
    const zoomEnabled = permissions.canZoom();
    const area = validated.region
      ?? { x: validated.x, y: validated.y, width: validated.width, height: validated.height };
    if (zoomEnabled) {
      excludeWindowIds.push(createShotWindow(area).getMediaSourceId().split(':')[1]);
    }

    startedAt = Date.now();
    try {
      await recorder.start({
        source: validated.source, width: validated.width, height: validated.height,
        x: validated.x, y: validated.y, title: validated.title, mic: recordMic, dir,
        region: validated.region,
        excludeWindowIds,
        zoomEnabled,
        inputTapArgs: inputTapArgs(currentSettings())
      });
    } catch (err) {
      closeShotWindow();
      barPhase = 'armed';
      throw err;
    }
    if (zoomEnabled) startShotFrame(area);

    barTimer = setInterval(() => {
      if (barWindow && !barWindow.isDestroyed()) {
        barWindow.webContents.send('bar:update', recordingPayload());
      }
    }, 200);
    barWindow.webContents.send('bar:update', recordingPayload());

    return { dir, zoomEnabled: permissions.canZoom(), mic: recordMic, micRequested: armedSource.mic };
  } finally {
    starting = false;
  }
});

ipcMain.handle('record:stop', stopRecording);

// Export follow-ups: share links, copy/drag/reveal the exported file.
registerShareIpc(ipcMain);
registerFileActionsIpc(ipcMain);

// Whether the Control+Shift+S stop-recording shortcut is actually held by
// us. globalShortcut.register() returns false (not a rejection/throw) when
// another application already owns the combination, and that failure was
// previously silent: the user presses the shortcut mid-recording, nothing
// happens, and there is no error anywhere to explain why. Logged clearly
// below rather than surfaced as a startup dialog -- a modal here would
// interrupt every recording session over a shortcut collision that the bar's
// Stop button already works around. Indicating this in the bar itself would
// need a renderer change (a new field on 'bar:update' plus UI to render it),
// which is out of scope for this fix -- see control-bar-report.md.
let stopShortcutRegistered = false;

app.whenReady().then(() => {
  // Groups Loupe's windows under one taskbar button with the right name.
  if (IS_WINDOWS) app.setAppUserModelId('tech.markai.loupe');
  appShell.ready();
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
      '(another application likely already holds it). The bar\'s Stop button ' +
      'still works.'
    );
  }
});

let editorWindow = null;
let editorDir = null;

// Exports run one at a time in a hidden window (ipc/export.js). The editor
// window's 'closed' handler and before-quit cancel one still running.
const exporter = createExportRunner({
  BrowserWindow,
  preload: path.join(__dirname, '..', 'preload', 'exporter.js'),
  page: path.join(__dirname, '..', 'renderer', 'exporter', 'index.html')
});
// The editor's project.json: loaded (v1 migrated) and saved through
// ipc/project.js, which debounces the writes. Export and closing the editor
// flush a save still waiting, so neither ever works from a stale file.
const projects = createProjectStore({
  onError: (err) => console.error('Loupe: could not save the project:', err)
});
registerProjectIpc({ ipcMain, store: projects, projectDir: () => editorDir });
registerExportIpc({
  ipcMain, runner: exporter, projectDir: () => editorDir, shell,
  beforeStart: () => projects.flush()
});

function flushProject() {
  try {
    projects.flush();
  } catch (err) {
    console.error('Loupe: could not save the project:', err);
  }
}

// editorDir/editorWindow are a single global "current editor" slot, not one per calling window. Two choices were
// available for fixing the corruption this caused (record, leave the editor
// open, record again -- the stale editor's project:load/deleteZoom/export
// silently target the new recording's directory): key this state by
// event.sender instead, or close the previous editor whenever a new one
// opens. Closing was chosen: an editor exists only because record:stop just
// finished a recording and opened one for it (openEditorWindow has exactly
// one call site), so there is never a legitimate reason for two editors to
// be open at once, and "the editor" belongs to whichever recording most
// recently finished. Keying by sender would let two editors run
// concurrently, which this product has no use for and which would still
// need every handler (project:load, deleteZoom, export:start) rewritten to
// look up its caller's own state instead of a shared global -- a bigger,
// riskier change for a capability nothing asks for.
function openEditorWindow(dir) {
  const prevWin = editorWindow;
  if (prevWin && !prevWin.isDestroyed()) prevWin.close();
  flushProject();

  editorDir = dir;
  // Room for the preview, the sidebar and the timeline; the preview scales
  // to whatever shape the video has.
  const win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 600, title: 'Loupe — Edit',
    backgroundColor: '#161618',
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js'), sandbox: true, contextIsolation: true }
  });
  editorWindow = win;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'editor', 'index.html'));
  win.on('closed', () => {
    // `prevWin.close()` above does not close `win` synchronously in every
    // Electron version/path, so this handler can still be the STALE
    // editor's, firing after a newer editor has already replaced it in
    // `editorWindow`. Only retire editorWindow/editorDir when the window
    // closing is still the one on record -- otherwise this would null out
    // (or worse, leave dangling) the state of the editor that is actually
    // live, which is the exact corruption this fix exists to prevent.
    if (editorWindow === win) editorWindow = null;
    flushProject();
    // Closing the editor mid-export stops the export: nobody is left to see
    // it finish, and its partial file is removed (ipc/export.js).
    if (exporter.busy()) exporter.cancel();
  });
  return editorWindow;
}

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
  // An edit made just before quitting is still waiting to be written.
  flushProject();
  // Quitting mid-export is just another way an export never finishes: it is
  // cancelled and its partial file removed before the app goes.
  if (quitting || (!barWindow && !exporter.busy())) return;
  event.preventDefault();
  quitting = true;
  const tasks = [];
  if (barWindow) {
    tasks.push(stopRecording().catch((err) => {
      console.error('Loupe: failed to stop recording cleanly while quitting:', err);
    }));
  }
  if (exporter.busy()) tasks.push(exporter.cancel());
  Promise.race([
    Promise.all(tasks),
    new Promise((resolve) => setTimeout(resolve, 8000))
  ]).finally(() => app.quit());
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Final synchronous safety net: if some path reached actual quit without
  // going through stopRecording()/onRecorderError (e.g. before-quit's
  // timeout fired, or a future quit path we haven't accounted for), this
  // guarantees barTimer is cleared and the overlay is closed before the
  // process goes down rather than relying on the windows' own 'closed'
  // events, which may not have fired yet at this point in shutdown.
  teardownArmedState();
});

module.exports = {
  createPickerWindow,
  // Exposed only so test/main-editor.test.js can drive the editor-scoping,
  // export-cleanup, and quit-with-in-flight-export fixes directly (with a
  // mocked 'electron') without spinning up a real Electron process. Nothing
  // in the app itself uses these.
  __test__: {
    openEditorWindow,
    editorState: () => ({ editorDir, editorWindow }),
    projects,
    exporter,
    validateStartOptions
  }
};
