'use strict';

// The app menus: the macOS menu bar, and on Windows the same commands in each
// window's menu bar (Electron applies one application menu to every framed
// window there; the bar, area outline and zoom frame are frameless, so they
// never show it).
//
// buildMenuTemplate is pure -- a plain Electron menu template with the
// commands passed in as functions -- so the structure and shortcuts are
// testable without Electron. Items with an `id` are also what the e2e test
// clicks (Menu.getApplicationMenu().getMenuItemById).
//
// `actions`: newRecording, openRecordings, openSettings(section?),
// checkForUpdates, showShortcuts, openWebsite, reportProblem, showLogs.
function buildMenuTemplate({ platform, appName = 'Loupe', isDev = false, actions }) {
  const mac = platform === 'darwin';
  const a = (name, ...args) => () => actions[name](...args);

  const newRecording = { id: 'new-recording', label: 'New Recording', accelerator: 'CmdOrCtrl+N', click: a('newRecording') };
  const openRecordings = { id: 'open-recordings', label: 'Open Recordings', accelerator: 'CmdOrCtrl+O', click: a('openRecordings') };
  const settings = {
    id: 'settings', label: mac ? 'Settings…' : 'Settings', accelerator: 'CmdOrCtrl+,', click: a('openSettings')
  };
  const checkForUpdates = { id: 'check-for-updates', label: mac ? 'Check for Updates…' : 'Check for updates', click: a('checkForUpdates') };
  const about = { id: 'about', label: `About ${appName}`, click: a('openSettings', 'about') };

  const template = [];

  if (mac) {
    template.push({
      label: appName,
      submenu: [
        about,
        { type: 'separator' },
        settings,
        checkForUpdates,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${appName}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${appName}` }
      ]
    });
  }

  template.push({
    label: mac ? 'File' : '&File',
    submenu: mac
      ? [newRecording, openRecordings, { type: 'separator' }, { role: 'close' }]
      : [newRecording, openRecordings, { type: 'separator' }, settings, { type: 'separator' },
        { role: 'close', label: 'Close window' }, { role: 'quit', label: 'Exit' }]
  });

  template.push({
    label: mac ? 'Edit' : '&Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(mac ? [{ role: 'pasteAndMatchStyle' }] : []),
      { role: 'delete' },
      { type: 'separator' },
      { role: 'selectAll' }
    ]
  });

  template.push({
    label: mac ? 'View' : '&View',
    submenu: [
      // Reloading or opening developer tools is for working on Loupe itself.
      ...(isDev ? [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] : []),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  });

  template.push({
    label: mac ? 'Window' : '&Window',
    submenu: mac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close', label: 'Close window' }]
  });

  template.push({
    role: 'help',
    label: mac ? 'Help' : '&Help',
    submenu: [
      { id: 'website', label: `${appName} website`, click: a('openWebsite') },
      { id: 'keyboard-shortcuts', label: 'Keyboard shortcuts', accelerator: mac ? undefined : 'F1', click: a('showShortcuts') },
      { type: 'separator' },
      { id: 'report-problem', label: 'Report a problem…', click: a('reportProblem') },
      { id: 'show-logs', label: 'Show logs', click: a('showLogs') },
      ...(mac ? [] : [{ type: 'separator' }, checkForUpdates, about])
    ]
  });

  return template;
}

// The app-wide shortcuts, for Help > Keyboard shortcuts when the editor (which
// has its own, fuller cheat sheet) isn't the window in front.
function appShortcuts(platform) {
  const mac = platform === 'darwin';
  const cmd = mac ? '⌘' : 'Ctrl+';
  return [
    ['New recording', `${cmd}N`],
    ['Open recordings', `${cmd}O`],
    ['Settings', `${cmd},`],
    ['Stop recording', mac ? '⌃⇧S' : 'Ctrl+Shift+S'],
    ['Zoom while recording', 'Hold your zoom shortcut and scroll']
  ];
}

module.exports = { buildMenuTemplate, appShortcuts };
