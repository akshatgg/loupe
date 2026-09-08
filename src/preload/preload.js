'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loupe', {
  listSources: () => ipcRenderer.invoke('sources:list')
});
