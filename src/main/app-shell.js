'use strict';

const os = require('node:os');
const path = require('node:path');
const { createSettingsStore } = require('./settings-store');
const { startDiagnostics } = require('./diagnostics');
const { createUpdater } = require('./updates');
const { buildMenuTemplate, appShortcuts } = require('./menu');
const { recordingsRoot } = require('./platform');
const { createLibrary, registerLibraryIpc, usableFolder } = require('./ipc/library');
const { registerSettingsIpc } = require('./ipc/settings');
const { registerPresetsIpc } = require('./ipc/presets');
const { registerUpdatesIpc } = require('./ipc/updates');
const { registerAboutIpc } = require('./ipc/about');

// Everything around recording and editing: the Library and Settings windows,
// style presets, the menus, update checks and crash reports
// (docs/EDITOR-V2.md section 8). main.js creates this once and calls:
//
//   shell.start()                 at load, before the app is ready (crash reporter)
//   shell.ready()                 in app.whenReady (menus, launch update check)
//   shell.settings                the settings store (get / patch / onChange)
//   shell.recordingsFolder()      where a new recording goes
//   shell.usableRecordingsFolder() the same, checked usable (throws a plain message)
//   shell.openLibrary()           the Library window
//   shell.openSettings(section?)  the Settings window, optionally at a section:
//                                 general | recording | export | updates | privacy | about
//   shell.recordingsChanged()     tell an open Library a recording was added
//
// `deps` from main.js: openEditorWindow(dir), showPicker(), getEditorWindow(),
// getEditorDir() (the recording open in the editor, or null),
// openBlocked() (why the Library can't open a recording right now, or null).
const SECTIONS = ['general', 'recording', 'export', 'updates', 'privacy', 'about'];
const WINDOW_BG = '#2a2b2e';

function createAppShell({ electron, openEditorWindow, showPicker, getEditorWindow, getEditorDir, openBlocked }) {
  const { app, ipcMain, BrowserWindow } = electron;
  const preload = path.join(__dirname, '..', 'preload', 'shell.js');
  const renderer = (name) => path.join(__dirname, '..', 'renderer', name, 'index.html');

  const settings = createSettingsStore({ file: () => path.join(app.getPath('userData'), 'settings.json') });
  const logDir = () => path.join(app.getPath('userData'), 'logs');
  const defaultRecordingsFolder = () => recordingsRoot((name) => app.getPath(name), os.homedir());

  let libraryWindow = null;
  let settingsWindow = null;
  let updater = null;
  let updatesIpc = null;

  function getUpdater() {
    if (!updater) {
      updater = createUpdater({
        currentVersion: app.getVersion(),
        // Electron's fetch goes through the system's proxy settings; Node's doesn't.
        fetchImpl: (...args) => (electron.net?.fetch ?? fetch)(...args),
        downloadDir: path.join(app.getPath('temp'), 'loupe-update'),
        getSettings: settings.get,
        patchSettings: (patch) => settings.patch(patch, { trusted: true }),
        spawn: (...args) => require('node:child_process').spawn(...args),
        onChange: (state) => broadcast('updates:changed', state)
      });
    }
    return updater;
  }

  const broadcast = (channel, data) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, data);
    }
  };

  function openWindow(existing, create) {
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return existing;
    }
    return create();
  }

  function openLibrary() {
    libraryWindow = openWindow(libraryWindow, () => {
      const win = new BrowserWindow({
        width: 1040, height: 700, minWidth: 560, minHeight: 420,
        title: 'Recordings', backgroundColor: WINDOW_BG, show: false,
        webPreferences: { preload }
      });
      win.loadFile(renderer('library'));
      win.once('ready-to-show', () => win.show());
      win.on('closed', () => { if (libraryWindow === win) libraryWindow = null; });
      return win;
    });
    return libraryWindow;
  }

  function openSettings(section) {
    const at = SECTIONS.includes(section) ? section : null;
    const existed = settingsWindow && !settingsWindow.isDestroyed();
    settingsWindow = openWindow(settingsWindow, () => {
      const win = new BrowserWindow({
        width: 780, height: 600, minWidth: 620, minHeight: 460,
        title: 'Settings', backgroundColor: WINDOW_BG, show: false,
        fullscreenable: false, webPreferences: { preload }
      });
      win.loadFile(renderer('settings'), at ? { hash: at } : undefined);
      win.once('ready-to-show', () => win.show());
      win.on('closed', () => { if (settingsWindow === win) settingsWindow = null; });
      return win;
    });
    if (existed && at) settingsWindow.webContents.send('settings:showSection', at);
    return settingsWindow;
  }

  function showShortcuts() {
    const focused = BrowserWindow.getFocusedWindow();
    const editor = getEditorWindow?.();
    // The editor has its own cheat sheet ("?"); let it show that.
    if (editor && !editor.isDestroyed() && focused === editor) {
      editor.webContents.send('app:showShortcuts');
      return;
    }
    const lines = appShortcuts(process.platform).map(([what, keys]) => `${what}:  ${keys}`);
    electron.dialog.showMessageBox(focused ?? undefined, {
      type: 'info', message: 'Keyboard shortcuts', detail: lines.join('\n'), buttons: ['OK']
    });
  }

  // Before the app is ready. Diagnostics start as early as they can so a
  // crash during startup is still recorded.
  function start() {
    // Only inside real Electron: unit tests load main.js with a mock that
    // has no crash reporter, and must keep node's own error handling.
    if (electron.crashReporter) {
      startDiagnostics({
        electron, logDir: logDir(), enabled: settings.get().saveCrashReports,
        showErrorBox: (title, text) => electron.dialog.showErrorBox(title, text)
      });
    }

    const settingsIpc = registerSettingsIpc({ ipcMain, electron, store: settings, defaultRecordingsFolder });
    registerPresetsIpc({ ipcMain, store: settings });

    const library = createLibrary({
      root: settingsIpc.recordingsFolder,
      locale: () => app.getLocale(),
      createThumbnail: async (video) => {
        const image = await electron.nativeImage.createThumbnailFromPath(video, { width: 640, height: 400 });
        return image.isEmpty() ? null : image.toJPEG(82);
      }
    });
    registerLibraryIpc({
      ipcMain, electron, library, openEditor: openEditorWindow, showPicker,
      editorDir: () => getEditorDir?.() ?? null,
      focusEditor: () => {
        const editor = getEditorWindow?.();
        if (!editor || editor.isDestroyed()) return;
        if (editor.isMinimized()) editor.restore();
        editor.show();
        editor.focus();
      },
      openBlocked: () => openBlocked?.() ?? null
    });

    // The Library follows the recordings folder when it changes.
    settings.onChange((next, before) => {
      if (next.recordingsFolder !== before.recordingsFolder) recordingsChanged();
    });

    updatesIpc = registerUpdatesIpc({ ipcMain, electron, getUpdater });
    const about = registerAboutIpc({ ipcMain, electron, logDir });

    ipcMain.handle('shell:openLibrary', () => { openLibrary(); });
    ipcMain.handle('shell:openSettings', (_e, section) => { openSettings(section); });

    const actions = {
      newRecording: () => showPicker(),
      openRecordings: openLibrary,
      openSettings,
      checkForUpdates: () => {
        openSettings('updates');
        getUpdater().check();
      },
      showShortcuts,
      openWebsite: about.openWebsite,
      reportProblem: about.reportProblem,
      showLogs: about.showLogs
    };
    return actions;
  }

  let actions = null;

  function ready() {
    const { Menu } = electron;
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
      platform: process.platform, appName: 'Loupe', isDev: !app.isPackaged, actions
    })));
    // Reopening Loupe from the Dock with no windows open brings back the picker.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().every((w) => !w.isVisible())) showPicker();
    });
    updatesIpc.launchCheck();
  }

  function recordingsChanged() {
    if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.webContents.send('library:changed');
  }

  return {
    settings,
    start: () => { actions = start(); },
    ready,
    recordingsFolder: () => settings.get().recordingsFolder ?? defaultRecordingsFolder(),
    // The same, created if needed; throws a plain-words error when it can't
    // be used (an unplugged drive), before any recording starts.
    usableRecordingsFolder: () => usableFolder(settings.get().recordingsFolder ?? defaultRecordingsFolder()),
    openLibrary,
    openSettings,
    recordingsChanged,
    updater: getUpdater
  };
}

module.exports = { createAppShell, SECTIONS };
