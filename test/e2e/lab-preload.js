'use strict';
// The e2e lab page's only way out: saving files it made (fixtures, PNGs)
// into the folders run.js named.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('labHost', {
  save: (name, bytes) => ipcRenderer.invoke('lab:save', name, bytes)
});
