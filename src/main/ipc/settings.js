'use strict';

// Settings IPC, shared by the picker (zoom shortcuts) and the Settings
// window. Every change goes through the settings store, which validates it
// (settings.js) and announces it; this module forwards those announcements to
// every open window as 'settings:changed', so two windows never disagree.
function registerSettingsIpc({ ipcMain, electron, store, defaultRecordingsFolder }) {
  const { dialog, BrowserWindow, app } = electron;

  const recordingsFolder = () => store.get().recordingsFolder ?? defaultRecordingsFolder();

  ipcMain.handle('settings:get', () => store.get());

  // The renderer is not a trust boundary: applySettingsPatch refuses unknown
  // keys, invalid values, and keys only the main process may set.
  ipcMain.handle('settings:set', (_e, patch) => store.patch(patch));

  // Where recordings go right now, and where they'd go after Reset.
  ipcMain.handle('settings:paths', () => ({
    recordingsFolder: recordingsFolder(),
    defaultRecordingsFolder: defaultRecordingsFolder(),
    isDefault: store.get().recordingsFolder === null
  }));

  // The only way to change the recordings folder: the OS folder chooser, so
  // the path is always one the user picked themselves.
  ipcMain.handle('settings:chooseRecordingsFolder', async (e) => {
    const owner = BrowserWindow.fromWebContents(e.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
      title: 'Choose where to save recordings',
      buttonLabel: 'Use this folder',
      defaultPath: recordingsFolder(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || !filePaths[0]) return store.get();
    return store.patch({ recordingsFolder: filePaths[0] }, { trusted: true });
  });

  ipcMain.handle('settings:resetRecordingsFolder', () =>
    store.patch({ recordingsFolder: null }, { trusted: true }));

  store.onChange((next, before) => {
    // Login items register the running executable. In development that's
    // Electron itself, so only a packaged app touches the real setting.
    if (next.openAtLogin !== before.openAtLogin && app.isPackaged) {
      try {
        app.setLoginItemSettings({ openAtLogin: next.openAtLogin });
      } catch (err) {
        console.error('Loupe: could not change "open at login":', err);
      }
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('settings:changed', next);
    }
  });

  return { recordingsFolder };
}

module.exports = { registerSettingsIpc };
