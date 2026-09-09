'use strict';
const { app, BrowserWindow, ipcMain, systemPreferences, shell, dialog } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFile, execFileSync } = require('node:child_process');
const { createPermissions } = require('./permissions');
const { createRecorder } = require('./recorder');
const { spawnHelper, stopHelper } = require('./helpers');

const BIN_DIR = path.join(__dirname, '..', '..', 'bin');
const permissions = createPermissions({ systemPreferences, shell });

// Electron exposes no `app.bundleIdentifier` getter (Node's `app` object has
// none), and app.getName() returns the *product* name ("Electron" in dev),
// not the bundle id `bin/sources --exclude-bundle` needs to compare against.
// The real identifier lives in the running .app's Info.plist, one directory
// above Contents/Resources (process.resourcesPath). Read it once with
// PlistBuddy; if that ever fails (non-macOS, unusual layout), fall back to
// an empty string so --exclude-bundle simply filters nothing rather than
// crashing sources:list.
function getBundleIdentifier() {
  try {
    const infoPlist = path.join(path.dirname(process.resourcesPath), 'Info.plist');
    return execFileSync('/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleIdentifier', infoPlist], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const BUNDLE_ID = getBundleIdentifier();

// Surface a helper spawn failure to the user instead of leaving them staring
// at a picker window that looks like it is recording but never will be.
function onRecorderError(err) {
  dialog.showErrorBox(
    'Loupe',
    `Recording stopped unexpectedly (${err.source}): ${err.message}`
  );
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

// TASK 14 STUB: the real HUD window (zoom/timer overlay + stop control) is
// built in Task 14. This placeholder exists only so record:start has a
// window to exclude from capture and a mediaSourceId to pass along; Task 14
// deletes this function and replaces it with the real implementation.
function createHudWindow() {
  return { getMediaSourceId: () => 'window:0' };
}

ipcMain.handle('sources:list', () =>
  new Promise((resolve, reject) => {
    const args = BUNDLE_ID ? ['--exclude-bundle', BUNDLE_ID] : [];
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

ipcMain.handle('record:start', async (_e, { source, width, height, title, mic }) => {
  if (!permissions.canRecord()) throw new Error('Screen Recording permission is required');
  if (mic) await permissions.requestMicrophone();

  const dir = path.join(os.homedir(), 'Movies', 'Loupe', String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });

  const hud = createHudWindow();
  await recorder.start({
    source, width, height, title, mic, dir,
    hudWindowId: hud.getMediaSourceId().split(':')[1],
    zoomEnabled: permissions.canZoom()
  });
  pickerWindow?.hide();
  return { dir, zoomEnabled: permissions.canZoom() };
});

ipcMain.handle('record:stop', async () => {
  const result = await recorder.stop();
  pickerWindow?.show();
  return result;
});

app.whenReady().then(createPickerWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

module.exports = { createPickerWindow };
