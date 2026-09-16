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

  // ---- recording additions (src/main/ipc/recording.js) ----------------------
  // Picker: countdown, computer sound, keyboard shortcuts, camera and which one.
  getRecordingSettings: () => ipcRenderer.invoke('recordingSettings:get'),
  setRecordingSettings: (patch) => ipcRenderer.invoke('recordingSettings:set', patch),
  requestCamera: () => ipcRenderer.invoke('permissions:requestCamera'),
  // Bar: pause/resume while recording, and Esc/Cancel during the countdown.
  pauseRecording: () => ipcRenderer.invoke('bar:pause'),
  resumeRecording: () => ipcRenderer.invoke('bar:resume'),
  cancelCountdown: () => ipcRenderer.invoke('bar:cancelCountdown'),
  // Webcam bubble (src/renderer/camera): only its own window is listened to.
  camera: {
    init: () => ipcRenderer.invoke('camera:init'),
    started: (info) => ipcRenderer.invoke('camera:started', info),
    chunk: (bytes) => ipcRenderer.invoke('camera:chunk', bytes),
    stopped: (info) => ipcRenderer.invoke('camera:stopped', info),
    error: (info) => ipcRenderer.invoke('camera:error', info),
    onCommand: (cb) => ipcRenderer.on('camera:command', (_e, d) => cb(d))
  }
});
