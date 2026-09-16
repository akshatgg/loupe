'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Preload for the Library and Settings windows (src/main/app-shell.js). A
// separate file from preload.js so these windows get only what they use. The
// matching handlers, and the validation of every argument, are in
// src/main/ipc/.
const on = (channel) => (cb) => {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('loupe', {
  platform: process.platform,

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettingsChanged: on('settings:changed'),

  settings: {
    paths: () => ipcRenderer.invoke('settings:paths'),
    chooseRecordingsFolder: () => ipcRenderer.invoke('settings:chooseRecordingsFolder'),
    resetRecordingsFolder: () => ipcRenderer.invoke('settings:resetRecordingsFolder'),
    onShowSection: on('settings:showSection')
  },

  library: {
    list: () => ipcRenderer.invoke('library:list'),
    thumbnail: (id) => ipcRenderer.invoke('library:thumbnail', id),
    open: (id) => ipcRenderer.invoke('library:open', id),
    rename: (id, title) => ipcRenderer.invoke('library:rename', id, title),
    duplicate: (id) => ipcRenderer.invoke('library:duplicate', id),
    reveal: (id) => ipcRenderer.invoke('library:reveal', id),
    revealFolder: () => ipcRenderer.invoke('library:revealRoot'),
    trash: (id) => ipcRenderer.invoke('library:trash', id),
    newRecording: () => ipcRenderer.invoke('library:newRecording'),
    onChanged: on('library:changed')
  },

  presets: {
    list: () => ipcRenderer.invoke('presets:list'),
    rename: (id, name) => ipcRenderer.invoke('presets:rename', { id, name }),
    remove: (id) => ipcRenderer.invoke('presets:delete', id),
    setDefault: (id) => ipcRenderer.invoke('presets:setDefault', id)
  },

  updates: {
    state: () => ipcRenderer.invoke('updates:state'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    copyBrewCommand: () => ipcRenderer.invoke('updates:copyBrewCommand'),
    openReleasePage: () => ipcRenderer.invoke('updates:openReleasePage'),
    onChanged: on('updates:changed')
  },

  app: {
    about: () => ipcRenderer.invoke('app:about'),
    openLink: (name) => ipcRenderer.invoke('app:openLink', name),
    licenses: () => ipcRenderer.invoke('app:licenses'),
    openChromiumCredits: () => ipcRenderer.invoke('app:openChromiumCredits'),
    reportProblem: () => ipcRenderer.invoke('app:reportProblem'),
    showLogs: () => ipcRenderer.invoke('app:showLogs'),
    openLibrary: () => ipcRenderer.invoke('shell:openLibrary'),
    openSettings: (section) => ipcRenderer.invoke('shell:openSettings', section)
  }
});
