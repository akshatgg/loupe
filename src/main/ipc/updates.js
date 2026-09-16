'use strict';

const { RELEASES_PAGE } = require('../updates');

// Updates IPC for the Settings window, and the one dialog Loupe shows by
// itself: after the launch-time check finds a version the user hasn't been
// told about yet.
//
//   updates:state            -> the updater state (updates.js createUpdater)
//   updates:check            -> checks now, resolves to the new state
//   updates:install          -> Windows: runs the verified installer and quits
//   updates:copyBrewCommand  -> copies "brew upgrade --cask loupe"
//   updates:openReleasePage  -> opens the release page in the browser
//   'updates:changed' (event) -> pushed to every window on each state change
function registerUpdatesIpc({ ipcMain, electron, getUpdater }) {
  const { app, clipboard, shell, dialog } = electron;
  // Created on first use: it asks Electron for the app version and temp
  // folder, which a unit test's mock of Electron doesn't have.
  const updater = new Proxy({}, { get: (_t, key) => getUpdater()[key] });

  const openReleasePage = () => shell.openExternal(updater.state().latest?.url ?? RELEASES_PAGE);
  const copyBrewCommand = () => clipboard.writeText(updater.brewCommand);
  const restartToUpdate = () => {
    if (updater.install({ relaunch: true })) app.quit();
  };

  ipcMain.handle('updates:state', () => updater.state());
  ipcMain.handle('updates:check', () => updater.check());
  ipcMain.handle('updates:install', restartToUpdate);
  ipcMain.handle('updates:copyBrewCommand', copyBrewCommand);
  ipcMain.handle('updates:openReleasePage', openReleasePage);

  async function notifyIfNew() {
    if (!updater.shouldNotify()) return;
    updater.markNotified();
    const s = updater.state();
    const { version } = s.latest;
    let options;
    if (s.kind === 'installer') {
      options = {
        message: `Loupe ${version} is ready to install`,
        detail: `You have ${s.currentVersion}. Restart now to update, or it will install the next time you quit Loupe.`,
        buttons: ['Restart to update', 'Later'],
        actions: [restartToUpdate, () => {}]
      };
    } else if (s.kind === 'homebrew') {
      options = {
        message: `Loupe ${version} is available`,
        detail: `You have ${s.currentVersion}. To update, run this in Terminal:\n\n${updater.brewCommand}`,
        buttons: ['Copy command', 'What’s new', 'Later'],
        actions: [copyBrewCommand, openReleasePage, () => {}]
      };
    } else {
      options = {
        message: `Loupe ${version} is available`,
        detail: `You have ${s.currentVersion}. Download the new version and replace the one in your Applications folder.`,
        buttons: ['Download', 'Later'],
        actions: [openReleasePage, () => {}]
      };
    }
    const { response } = await dialog.showMessageBox({
      type: 'info', message: options.message, detail: options.detail,
      buttons: options.buttons, defaultId: 0, cancelId: options.buttons.length - 1
    });
    options.actions[response]?.();
  }

  // Launch: check if due (daily at most, and only with the setting on), then
  // speak up once per new version.
  async function launchCheck() {
    try {
      const state = await updater.autoCheck();
      if (state?.status === 'error') console.warn('Loupe: update check failed:', state.error);
      if (state) await notifyIfNew();
    } catch (err) {
      console.error('Loupe: update check failed:', err);
    }
  }

  // "Install on quit" (Windows): an update that was downloaded and verified
  // but not installed yet goes in as Loupe closes.
  app.on('will-quit', () => {
    try {
      updater.install({ relaunch: false });
    } catch (err) {
      console.error('Loupe: could not start the update installer:', err);
    }
  });

  return { launchCheck };
}

module.exports = { registerUpdatesIpc };
