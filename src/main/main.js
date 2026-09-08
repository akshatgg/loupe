'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createPickerWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 620,
    title: 'Loupe',
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js') }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'picker', 'index.html'));
  return win;
}

app.whenReady().then(createPickerWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

module.exports = { createPickerWindow };
