'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loupe', {
  listSources: () => ipcRenderer.invoke('sources:list'),
  permissions: () => ipcRenderer.invoke('permissions:status'),
  openPane: (pane) => ipcRenderer.invoke('permissions:open', pane),
  startRecording: (opts) => ipcRenderer.invoke('record:start', opts),
  stopRecording: () => ipcRenderer.invoke('record:stop'),
  pickRegion: (payload) => ipcRenderer.invoke('region:pick', payload),
  regionInit: () => ipcRenderer.invoke('region:init'),
  regionConfirm: (region) => ipcRenderer.invoke('region:confirm', region),
  regionCancel: () => ipcRenderer.invoke('region:cancel'),
  onHud: (cb) => ipcRenderer.on('hud:update', (_e, data) => cb(data)),
  loadProject: () => ipcRenderer.invoke('project:load'),
  deleteZoom: (segment) => ipcRenderer.invoke('project:deleteZoom', segment),
  exportVideo: (opts) => ipcRenderer.invoke('export:start', opts),
  onExportProgress: (cb) => ipcRenderer.on('export:progress', (_e, d) => cb(d))
});
