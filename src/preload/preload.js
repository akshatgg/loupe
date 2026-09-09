'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loupe', {
  listSources: () => ipcRenderer.invoke('sources:list'),
  permissions: () => ipcRenderer.invoke('permissions:status'),
  openPane: (pane) => ipcRenderer.invoke('permissions:open', pane),
  startRecording: (opts) => ipcRenderer.invoke('record:start', opts),
  stopRecording: () => ipcRenderer.invoke('record:stop'),
  onHud: (cb) => ipcRenderer.on('hud:update', (_e, data) => cb(data))
});
