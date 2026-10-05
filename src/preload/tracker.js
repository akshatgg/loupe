'use strict';
// Preload for the hidden window that follows what's under a hidden area
// (src/renderer/exporter/tracker.js). Deliberately narrow: the page can only
// fetch its job and hand back progress and the outcome. main
// (src/main/ipc/track.js) checks every payload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loupeTracker', {
  job: () => ipcRenderer.invoke('tracker:job'),
  progress: (p) => ipcRenderer.send('tracker:progress', p),
  done: (result) => ipcRenderer.send('tracker:done', result),
  fail: (message) => ipcRenderer.send('tracker:fail', message)
});
