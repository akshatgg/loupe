'use strict';
// Preload for the hidden export window (src/renderer/exporter). Deliberately
// narrow: the page can only fetch its job and hand back bytes, progress and
// the outcome. main (src/main/ipc/export.js) checks every payload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loupeExporter', {
  job: () => ipcRenderer.invoke('exporter:job'),
  write: (position, bytes) => ipcRenderer.invoke('exporter:write', position, bytes),
  progress: (p) => ipcRenderer.send('exporter:progress', p),
  done: (summary) => ipcRenderer.invoke('exporter:done', summary),
  fail: (message) => ipcRenderer.send('exporter:fail', message)
});
