'use strict';

const path = require('node:path');
const { recordingView, toSettingsPatch } = require('../recording-settings');
const { startCountdown } = require('../countdown');
const { createCameraBubble, cameraAccess } = require('./camera');

// The recording additions' main-process side (docs/EDITOR-V2.md section 7):
// the picker's extra choices, the countdown, the pause shortcut and the
// webcam bubble. main.js owns the bar and its state machine and calls in at
// fixed points:
//
//   bar:arm     onArm()                  camera bubble up, if chosen
//   bar:start   runCountdown(onTick)     3-2-1 unless turned off; false = cancelled
//               excludeWindowIds()       the bubble, for --exclude-window
//               recorderOptions()        { systemAudio, keys, micName } for recorder.start
//               onRecordingStarted(dir)  webcam recording + pause shortcut
//   Stop        finishWebcam()           promise for recorder.stop({ webcam })
//   teardown    teardown()               everything above undone
//
// `togglePause` is main.js's pause/resume action, bound to the shortcut.

// Held only while recording, so it is never taken from other apps otherwise.
const PAUSE_SHORTCUT = 'Control+Alt+P';
const COUNTDOWN_SECONDS = 3;

function registerRecordingExtras({
  electron, preload, rendererDir, getSettings, patchSettings, excludeFromCapture, now,
  togglePause, refreshBar
}) {
  const { ipcMain, BrowserWindow, globalShortcut, systemPreferences } = electron;
  // settings.json, through the app's one settings store (app-shell.js); the
  // picker sees the recording choices in its own shape (recording-settings.js).
  // A settings problem must never stop a recording: the defaults apply.
  const current = () => {
    try {
      return recordingView(getSettings());
    } catch {
      return recordingView(null);
    }
  };
  const camera = cameraAccess(systemPreferences);

  let countdown = null;
  let pauseShortcutHeld = false;
  // What was recorded this session, for the bar ("camera off" and so on).
  let cameraWanted = false;

  const bubble = createCameraBubble({
    BrowserWindow, ipcMain, preload, now, excludeFromCapture,
    page: path.join(rendererDir, 'camera', 'index.html'),
    getWorkArea: () => {
      try {
        return electron.screen.getPrimaryDisplay().workArea;
      } catch {
        return null;
      }
    },
    // The bar shows "camera off" when the bubble goes away on its own.
    onChange: () => refreshBar()
  });

  ipcMain.handle('recordingSettings:get', () => current());
  // The picker is not a trust boundary: unknown keys and bad values throw.
  ipcMain.handle('recordingSettings:set', (_e, patch) => {
    patchSettings(toSettingsPatch(patch, getSettings()));
    return current();
  });
  ipcMain.handle('permissions:requestCamera', async () => {
    if (camera.granted()) return true;
    return Boolean(await camera.request());
  });

  function onArm() {
    const s = current();
    cameraWanted = s.camera;
    if (s.camera && camera.granted()) bubble.open({ deviceId: s.cameraDeviceId });
  }

  // Resolves true to go ahead, false when cancelled (Esc, Back, quit).
  // `onTick(n)` shows n on the bar. Escape belongs to the countdown while it
  // runs; main.js gives it back to the area overlay afterwards.
  async function runCountdown(onTick) {
    if (!current().countdown) return true;
    countdown = startCountdown({ seconds: COUNTDOWN_SECONDS, onTick });
    const c = countdown;
    const escape = globalShortcut.register('Escape', () => c.cancel());
    try {
      return await c.promise;
    } finally {
      if (escape) globalShortcut.unregister('Escape');
      if (countdown === c) countdown = null;
    }
  }

  function cancelCountdown() {
    if (!countdown) return false;
    countdown.cancel();
    return true;
  }

  function excludeWindowIds() {
    const id = bubble.windowId();
    return id ? [id] : [];
  }

  // `micName`: the microphone chosen in Settings, by its label (null = the
  // system default).
  function recorderOptions() {
    const s = current();
    let micName = null;
    try {
      const label = getSettings()?.microphone?.label;
      if (typeof label === 'string' && label) micName = label;
    } catch {
      // the default microphone
    }
    return { systemAudio: s.systemAudio, keys: s.recordKeys, micName };
  }

  function onRecordingStarted(dir) {
    if (bubble.isOpen()) bubble.start(dir);
    if (!pauseShortcutHeld) {
      pauseShortcutHeld = globalShortcut.register(PAUSE_SHORTCUT, togglePause);
      if (!pauseShortcutHeld) console.warn(`Loupe: could not register ${PAUSE_SHORTCUT} to pause`);
    }
  }

  function finishWebcam() {
    return bubble.finish();
  }

  function teardown() {
    countdown?.cancel();
    countdown = null;
    if (pauseShortcutHeld) {
      globalShortcut.unregister(PAUSE_SHORTCUT);
      pauseShortcutHeld = false;
    }
    bubble.close();
  }

  // For the bar: whether the camera is showing, and why not when it was wanted.
  function payload() {
    let cameraError = null;
    if (cameraWanted && !bubble.isOpen()) {
      cameraError = camera.granted() ? bubble.error() ?? 'Camera off' : 'Loupe is not allowed to use the camera';
    }
    return { cameraOn: bubble.isOpen(), cameraError, pauseShortcut: PAUSE_SHORTCUT };
  }

  return {
    settings: current, onArm, runCountdown, cancelCountdown, excludeWindowIds,
    recorderOptions, onRecordingStarted, finishWebcam, teardown, payload,
    cameraGranted: () => camera.granted()
  };
}

module.exports = { registerRecordingExtras, PAUSE_SHORTCUT, COUNTDOWN_SECONDS };
