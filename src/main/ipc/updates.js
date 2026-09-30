'use strict';

const { RELEASES_PAGE, CHECK_INTERVAL_MS } = require('../updates');

// Updates IPC for every window's Update now button and the Settings window,
// and the one dialog Loupe shows by itself: when the check it makes on
// opening (and once a day while open) finds a newer version.
//
//   updates:state            -> the updater state (updates.js createUpdater)
//   updates:check            -> checks now, resolves to the new state
//   updates:install          -> Update now: installs and restarts Loupe (as
//                               soon as the download is ready), or opens the
//                               release page where Loupe can't update itself
//   updates:copyBrewCommand  -> copies "brew upgrade --cask loupe"
//   updates:openReleasePage  -> opens the release page in the browser
//   'updates:changed' (event) -> pushed to every window on each state change
//
// isBusy(): a recording or export is running. A download that finishes then
// doesn't restart Loupe by itself; Update now stays there to click.
function registerUpdatesIpc({ ipcMain, electron, getUpdater, isBusy = () => false }) {
  const { app, clipboard, shell, dialog } = electron;
  // Created on first use: it asks Electron for the app version and temp
  // folder, which a unit test's mock of Electron doesn't have.
  const updater = new Proxy({}, { get: (_t, key) => getUpdater()[key] });

  const openReleasePage = () => shell.openExternal(updater.state().latest?.url ?? RELEASES_PAGE);
  const copyBrewCommand = () => clipboard.writeText(updater.brewCommand);
  // The update is started from will-quit, not here: quitting can be held
  // up (before-quit in main.js first stops and saves a recording in
  // progress, or an export), and an installer already running would close
  // Loupe in the middle of that and lose the recording.
  let relaunch = false;
  const restartToUpdate = () => {
    const s = updater.state();
    if (!updater.installsItself() || s.status !== 'ready') return;
    relaunch = true;
    app.quit();
  };

  function updateNow() {
    const s = updater.state();
    if (!s.latest) return;
    if (!updater.installsItself()) {
      openReleasePage();
    } else if (s.status === 'ready') {
      restartToUpdate();
    } else {
      updater.requestInstall();
    }
  }

  ipcMain.handle('updates:state', () => updater.state());
  ipcMain.handle('updates:check', () => updater.check());
  ipcMain.handle('updates:install', updateNow);
  ipcMain.handle('updates:copyBrewCommand', copyBrewCommand);
  ipcMain.handle('updates:openReleasePage', openReleasePage);

  // The dialog, at most once per launch, for a check Loupe made by itself.
  // "Check now" in Settings is already on screen, so it doesn't add one.
  let announce = false;
  let announced = false;

  async function announceUpdate(s) {
    const { version } = s.latest;
    let options;
    if (updater.installsItself()) {
      options = {
        message: `Loupe ${version} is available`,
        detail: `You have ${s.currentVersion}. Update now to install it and open Loupe again`
          + `${s.status === 'ready' ? '' : ' once it has downloaded'}, or it will install the next time you quit Loupe.`,
        buttons: ['Update now', 'Later'],
        actions: [updateNow, () => {}]
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

  // Called by the app shell on every state change.
  function stateChanged(s) {
    if (s.status === 'ready' && s.pending && !isBusy()) restartToUpdate();
    if (!announce) return;
    if (s.latest && ['available', 'downloading', 'ready'].includes(s.status)) {
      announce = false;
      announced = true;
      announceUpdate(s).catch((err) => console.error('Loupe: could not show the update dialog:', err));
    } else if (s.status === 'current' || s.status === 'error') {
      announce = false;
    }
  }

  async function autoCheck() {
    announce = !announced;
    try {
      const state = await updater.autoCheck();
      if (!state) announce = false;
      if (state?.status === 'error') console.warn('Loupe: update check failed:', state.error);
    } catch (err) {
      announce = false;
      console.error('Loupe: update check failed:', err);
    }
  }

  // Each time Loupe opens (with the setting on), and once a day after that
  // while it stays open.
  function launchCheck() {
    const timer = setInterval(autoCheck, CHECK_INTERVAL_MS);
    timer.unref?.();
    return autoCheck();
  }

  // "Install on quit": an update that was downloaded and verified but not
  // installed yet goes in as Loupe closes -- and starts Loupe again
  // afterwards when the user chose "Update now".
  app.on('will-quit', () => {
    try {
      updater.install({ relaunch });
    } catch (err) {
      console.error('Loupe: could not start the update:', err);
    }
  });

  return { launchCheck, stateChanged };
}

module.exports = { registerUpdatesIpc };
