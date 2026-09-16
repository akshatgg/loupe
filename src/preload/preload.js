'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loupe', {
  // 'darwin' or 'win32': the picker and editor name keys the way the OS does.
  platform: process.platform,
  listSources: () => ipcRenderer.invoke('sources:list'),
  permissions: () => ipcRenderer.invoke('permissions:status'),
  openPane: (pane) => ipcRenderer.invoke('permissions:open', pane),
  // Picker: saved preferences (currently how zoom is triggered).
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  // Picker: "Continue" arms the control bar -- nothing is recording yet.
  armRecording: (opts) => ipcRenderer.invoke('bar:arm', opts),
  // Bar (armed state): Start actually begins recording, with whatever area
  // was last chosen via setAreaMode/the region overlay.
  startRecording: () => ipcRenderer.invoke('bar:start'),
  // Bar: Back (armed) and Stop (recording) are the same underlying
  // teardown-and-return-to-the-picker action -- see main.js's stopRecording.
  stopRecording: () => ipcRenderer.invoke('record:stop'),
  setAreaMode: (mode) => ipcRenderer.invoke('bar:setAreaMode', mode),
  onBarUpdate: (cb) => ipcRenderer.on('bar:update', (_e, data) => cb(data)),
  // Region overlay: pulls its initial {target, mode, rect} once on load,
  // then main.js pushes further mode/rect changes as the bar drives it, and
  // the overlay reports every live drag back with reportAreaLive.
  regionInit: () => ipcRenderer.invoke('region:init'),
  onRegionCommand: (cb) => ipcRenderer.on('region:command', (_e, data) => cb(data)),
  reportAreaLive: (rect) => ipcRenderer.invoke('region:live', rect),
  // "What's in shot" frame, pushed by main.js while recording.
  onShotUpdate: (cb) => ipcRenderer.on('shot:update', (_e, data) => cb(data)),
  loadProject: () => ipcRenderer.invoke('project:load'),
  deleteZoom: (segment) => ipcRenderer.invoke('project:deleteZoom', segment),
  undoZoomDelete: () => ipcRenderer.invoke('project:undoZoomDelete'),
  restoreZooms: () => ipcRenderer.invoke('project:restoreZooms'),
  setShowCursor: (show) => ipcRenderer.invoke('project:setShowCursor', show),
  paintSpeed: (paint) => ipcRenderer.invoke('project:paintSpeed', paint),
  exportVideo: (opts) => ipcRenderer.invoke('export:start', opts),
  onExportProgress: (cb) => ipcRenderer.on('export:progress', (_e, d) => cb(d)),
  // Captions: the speech model's one-time download and saving subtitles.
  // Transcription itself runs in a worker in the page (renderer/captions).
  captions: {
    models: () => ipcRenderer.invoke('captions:models'),
    ensureModel: (key) => ipcRenderer.invoke('captions:model-ensure', key),
    cancelModel: (key) => ipcRenderer.invoke('captions:model-cancel', key),
    removeModel: (key) => ipcRenderer.invoke('captions:model-remove', key),
    onModelProgress: (cb) => {
      const handler = (_e, d) => cb(d);
      ipcRenderer.on('captions:model-progress', handler);
      return () => ipcRenderer.removeListener('captions:model-progress', handler);
    },
    saveSubtitles: (payload) => ipcRenderer.invoke('captions:save-subtitles', payload)
  }
});
