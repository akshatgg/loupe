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
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (_e, s) => cb(s)),
  // App shell (src/main/app-shell.js): the Library and Settings windows.
  openLibrary: () => ipcRenderer.invoke('shell:openLibrary'),
  openSettings: (section) => ipcRenderer.invoke('shell:openSettings', section),
  // Style presets, for the editor's Style panel (src/main/ipc/presets.js has
  // the full contract). apply(id) resolves to a copy of the preset's style.
  presets: {
    list: () => ipcRenderer.invoke('presets:list'),
    save: (preset) => ipcRenderer.invoke('presets:save', preset),
    rename: (id, name) => ipcRenderer.invoke('presets:rename', { id, name }),
    remove: (id) => ipcRenderer.invoke('presets:delete', id),
    setDefault: (id) => ipcRenderer.invoke('presets:setDefault', id),
    apply: (id) => ipcRenderer.invoke('presets:apply', id)
  },
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
  onExportProgress: (cb) => ipcRenderer.on('export:progress', (_e, d) => cb(d))
});
