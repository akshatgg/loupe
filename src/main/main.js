'use strict';
const { app, BrowserWindow, ipcMain, systemPreferences, shell, dialog, globalShortcut } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { createPermissions } = require('./permissions');
const { createRecorder } = require('./recorder');
const { spawnHelper, stopHelper } = require('./helpers');
const { solveCamera } = require('./camera');
const { zoomSegments, deleteSegment, validateSegment } = require('./segments');
const { loadProject, saveProject, readCursorTrack, writeCameraTrack } = require('./project');

const BIN_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.join(__dirname, '..', '..', 'bin');
const permissions = createPermissions({ systemPreferences, shell });

// Surface a helper failure to the user -- but only capture's failure means
// the recording itself is gone. Losing inputtap (the zoom/click/cursor
// gesture hook) is a degradation, not a fatal error: capture keeps writing
// raw.mov, so tearing down the HUD and reopening the picker here would
// actually cause the data loss the dialog falsely claims already happened --
// stopRecording() bails out once hudWindow is null, so every later Stop
// press or app quit would become a no-op and the recording would run forever
// with no way to finalize it. recorder.js already keeps `recording` true and
// records the error in state() for exactly this case (see recorder.test.js);
// the HUD's 200ms poll already surfaces it via hud.js's `error`/`warn`
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
        error: s.error,
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
    if (result?.dir) openEditorWindow(result.dir);
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
  // permissions.js already exposed microphone() for exactly this; it was
  // just never wired into the one place the picker reads permission state
  // from, so its mic checkbox had no feedback at all about whether the OS
  // would actually grant it.
  microphone: permissions.microphone(),
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

// x/y are the source's global-space origin in points (Sources.swift's
// SourceOut.x/y). Unlike width/height they may legitimately be negative --
// a display left of or above the primary display -- so they are validated
// only for being finite numbers, never for being positive. Optional (default
// 0) so a picker/source list from before this field existed still works.
function validateStartOptions(opts) {
  const { source, width, height, title, mic, x, y } = opts ?? {};
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
  return {
    source, width, height, x: ox, y: oy,
    title: typeof title === 'string' ? title : '', mic: Boolean(mic)
  };
}

// Guards the async gap between a record:start call being accepted and
// hudWindow actually existing. The picker renderer is hidden, not
// destroyed, while a recording is in progress (see pickerWindow?.hide()
// below), so it is still live and can invoke this channel again -- and
// `await permissions.requestMicrophone()` below means that gap is real, not
// just a single microtask: a second call could reach here while the first
// is still sitting at the OS mic-permission prompt, well before hudWindow is
// assigned. Once a session is actually running, hudWindow itself is the
// guard; `starting` only needs to cover the window before it exists.
let starting = false;

ipcMain.handle('record:start', async (_e, rawOpts) => {
  // Without this, a second invocation would call createHudWindow() again,
  // which assigns hudTimer = setInterval(...) over the still-live handle
  // from the first session -- leaking that interval forever, since nothing
  // will ever clear it again -- and recorder.start() would null out the
  // first session's captureChild/inputChild without stopping them,
  // orphaning a capture helper that still holds raw.mov open.
  if (starting || hudWindow) {
    throw new Error('A recording is already in progress.');
  }
  starting = true;
  try {
    const { source, width, height, x, y, title, mic } = validateStartOptions(rawOpts);
    if (!permissions.canRecord()) throw new Error('Screen Recording permission is required');

    // A denied mic prompt used to be discarded entirely: bin/capture was
    // started with --mic 1 regardless, which fails outright with "no
    // microphone available" and takes the whole recording down with it --
    // over a permission the user may not even have cared about (the
    // checkbox may just be left on from a previous session). Falling back to
    // recording without audio, rather than refusing to start, keeps the
    // failure proportional to what was actually lost: someone who pressed
    // Record wants the screen recording above all; losing the mic track is
    // recoverable/acceptable, losing the whole session to a permission
    // dialog they may have dismissed by reflex is not. The picker is told
    // via the resolved `mic` field so it can tell the user why there's no
    // audio.
    let recordMic = mic;
    if (mic) {
      const granted = await permissions.requestMicrophone();
      if (!granted) recordMic = false;
    }

    const dir = path.join(os.homedir(), 'Movies', 'Loupe', String(Date.now()));
    fs.mkdirSync(dir, { recursive: true });

    startedAt = Date.now();
    const hud = createHudWindow();
    try {
      await recorder.start({
        source, width, height, x, y, title, mic: recordMic, dir,
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
    return { dir, zoomEnabled: permissions.canZoom(), mic: recordMic, micRequested: mic };
  } finally {
    starting = false;
  }
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

let editorWindow = null;
let editorDir = null;

// Tracks the render helper for an in-flight export (if any), and the output
// path it is writing to. Both are read by the editor window's 'closed'
// handler (to stop an orphaned render) and by export:start (to refuse a
// second concurrent export -- see the comment there for why "refuse" was
// chosen over "coalesce").
let exportChild = null;
let exportOutPath = null;

// editorDir/editorWindow/exportChild/exportOutPath are a single global
// "current editor" slot, not one per calling window. Two choices were
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

  editorDir = dir;
  const win = new BrowserWindow({
    width: 1080, height: 720, title: 'Loupe — Edit',
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js') }
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
    // Closing the editor mid-export would otherwise orphan bin/render: it
    // keeps running, holds the output file open, burns CPU on a render
    // nobody will see, and its progress messages silently no-op against a
    // destroyed window (editorWindow?.webContents.send above). Stop it the
    // same way a normal export abort would, and remove the now-meaningless
    // partial output so it can't be mistaken for a finished export.
    if (exportChild) {
      const child = exportChild;
      const outPath = exportOutPath;
      stopHelper(child).then(() => {
        if (outPath) fs.promises.unlink(outPath).catch(() => {});
      });
    }
  });
  return editorWindow;
}

function cameraFor(dir) {
  const project = loadProject(dir);
  const cursorTrack = readCursorTrack(dir);
  return solveCamera({
    keyframes: project.zoomKeyframes,
    cursorTrack,
    duration: project.capture.duration,
    width: project.source.width,
    height: project.source.height
  });
}

// Export presets are expressed as a target HEIGHT (the number of vertical
// lines the "p" in e.g. "1080p" conventionally refers to) rather than a
// fixed WxH pair. A fixed 1920x1080 (16:9) pair would stretch or crop any
// source whose aspect ratio differs -- and it does here: this machine's
// display is 1470x956, an aspect ratio of 1.54, not 1.78. Scaling by the
// height and deriving the width from the SOURCE's own aspect ratio
// guarantees the exported picture is never distorted, at the cost of
// "1080p" not always meaning literally 1920x1080 -- it means "downscaled/
// upscaled so the picture is 1080 lines tall, at the source's true shape."
// Targeting height (rather than the longer edge) matters because "p" is a
// vertical-resolution convention: a source that is wider than 16:9 would,
// under a long-edge target, come out shorter than the preset name promises
// (e.g. a 1470x956 source at "1080p" would previously yield 1080x702 --
// fewer lines than 720p, and a quarter of the pixels a real 1080p frame
// carries) -- exactly backwards from what selecting "1080p" should mean.
// Dimensions are rounded to the nearest even number because H.264/HEVC
// encoders require even width/height.
//
// Upscaling is intentionally allowed: a preset taller than the source's own
// pixels (e.g. picking 4k against a source shorter than 2160) does not add
// real detail to the full frame, but the exported canvas is not just the
// full frame -- the camera track can zoom into a crop of it, and a larger
// export canvas gives that crop more room to be rendered without looking
// blocky. Refusing to honor the chosen preset would take that headroom away
// for a modest, and arguably wrong, file-size saving.
const EXPORT_PRESETS = { '1080p': 1080, '1440p': 1440, '4k': 2160 };

function evenRound(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

function resolveExportSize(preset, source) {
  const heightTarget = EXPORT_PRESETS[preset];
  if (!heightTarget) throw new Error(`Unknown export preset: ${JSON.stringify(preset)}`);
  const scale = heightTarget / source.height;
  return {
    width: evenRound(source.width * scale),
    height: evenRound(source.height * scale)
  };
}

ipcMain.handle('project:load', () => {
  const project = loadProject(editorDir);
  return {
    dir: editorDir,
    project,
    video: path.join(editorDir, 'raw.mov'),
    segments: zoomSegments(project.zoomKeyframes, project.capture.duration),
    camera: cameraFor(editorDir)
  };
});

ipcMain.handle('project:deleteZoom', (_e, rawSegment) => {
  // The renderer is not a trust boundary, the same as record:start's
  // rawOpts -- see validateSegment for why. Without this, a malformed
  // payload like {start: -Infinity, end: Infinity} would wipe every
  // keyframe and persist it via saveProject below.
  const segment = validateSegment(rawSegment);
  const project = loadProject(editorDir);
  project.zoomKeyframes = deleteSegment(project.zoomKeyframes, segment);
  saveProject(editorDir, project);
  return {
    project,
    segments: zoomSegments(project.zoomKeyframes, project.capture.duration),
    camera: cameraFor(editorDir)
  };
});

ipcMain.handle('export:start', async (_e, { preset, codec }) => {
  // Nothing else guards against two exports running at once: the output
  // path is derived purely from the resolved dimensions, so two exports at
  // the same preset would target the SAME file and both call
  // writeCameraTrack on the same project directory concurrently. The
  // renderer disables its export button while an export is running, but
  // that is a UI nicety, not a guarantee -- a second IPC call can still
  // reach here (e.g. a stale enabled button, a replayed message, a bug in
  // the renderer). Rejecting outright (rather than returning the in-flight
  // promise to the second caller) was chosen because a second call may ask
  // for a different preset/codec than the one already running; silently
  // handing back a different export's result would be surprising and could
  // resolve with the wrong file. Rejecting gives the renderer an explicit,
  // actionable error it already knows how to surface on its status line.
  if (exportChild) {
    throw new Error('An export is already in progress.');
  }
  const project = loadProject(editorDir);
  const { width, height } = resolveExportSize(preset, project.source);
  // The renderer draws from camera.bin, not from zoomKeyframes directly, so
  // it must be rewritten here to reflect any deletions made in the editor --
  // otherwise a deleted zoom would still show up in the exported file even
  // though the preview no longer shows it.
  writeCameraTrack(editorDir, cameraFor(editorDir));
  const out = path.join(editorDir, `export-${width}x${height}.mp4`);
  exportOutPath = out;
  return new Promise((resolve, reject) => {
    const settle = (fn, arg) => {
      exportChild = null;
      exportOutPath = null;
      // Only the editor-closed path (see openEditorWindow's 'closed'
      // handler) used to unlink a partial export. A failed or rejected
      // export here left `out` behind, named exactly like a finished
      // export.mp4 -- not data loss (the raw recording is untouched) but a
      // half-written file that looks done is a trap for later. `fn === reject`
      // is the failure path; a successful export must keep its output, so
      // this must never run for `fn === resolve`.
      if (fn === reject) fs.promises.unlink(out).catch(() => {});
      fn(arg);
    };
    exportChild = spawnHelper(path.join(BIN_DIR, 'render'), [
      '--project', editorDir, '--out', out,
      '--width', String(width), '--height', String(height), '--codec', codec || 'h264'
    ], {
      onMessage: (m) => {
        if (m.type === 'progress') editorWindow?.webContents.send('export:progress', m);
        if (m.type === 'error') settle(reject, new Error(m.message));
      },
      // Silently dropping helper output here is exactly the pattern that
      // hid the writer-failure bug this fix addresses elsewhere -- log it
      // instead of discarding it, even though it isn't fatal to the export.
      onMalformed: (l) => console.error('render malformed:', l),
      onExit: (code) => settle(
        code === 0 ? resolve : reject,
        code === 0 ? out : new Error(`render exited ${code}`)
      ),
      onError: (err) => settle(reject, err)
    });
  });
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
  // Originally only ever considered hudWindow, so quitting mid-export (no
  // recording in progress, but bin/render still running) skipped this
  // whole block and fell straight to will-quit's synchronous teardownHud --
  // which knows nothing about exports -- orphaning bin/render holding its
  // output file open. exportChild is the same in-flight-export signal
  // export:start already uses to refuse a second concurrent export, so it
  // is checked here the same way hudWindow is.
  if (quitting || (!hudWindow && !exportChild)) return;
  event.preventDefault();
  quitting = true;
  const tasks = [];
  if (hudWindow) {
    tasks.push(stopRecording().catch((err) => {
      console.error('Loupe: failed to stop recording cleanly while quitting:', err);
    }));
  }
  if (exportChild) {
    // stopHelper() already handles graceful termination (SIGTERM, then
    // SIGKILL after its own timeout) and is a no-op on an already-exited
    // child, so it's safe to reuse verbatim here. The abandoned partial
    // output is unlinked the same as the rejection and editor-closed paths,
    // since quitting mid-export is just another way an export never
    // finishes.
    const child = exportChild;
    const outPath = exportOutPath;
    exportChild = null;
    exportOutPath = null;
    tasks.push(stopHelper(child).then(() => {
      if (outPath) return fs.promises.unlink(outPath).catch(() => {});
    }));
  }
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
  // guarantees hudTimer is cleared before the process goes down rather than
  // relying on the window's own 'closed' event, which may not have fired
  // yet at this point in shutdown.
  teardownHud();
});

module.exports = {
  createPickerWindow,
  // Exposed only so test/main-editor.test.js can drive the editor-scoping,
  // export-cleanup, and quit-with-in-flight-export fixes directly (with a
  // mocked 'electron') without spinning up a real Electron process. Nothing
  // in the app itself uses these.
  __test__: {
    openEditorWindow,
    editorState: () => ({ editorDir, editorWindow, exportChild, exportOutPath }),
    setExportState: (child, outPath) => { exportChild = child; exportOutPath = outPath; }
  }
};
