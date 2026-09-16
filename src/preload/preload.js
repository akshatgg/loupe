'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  // Editor (src/main/ipc/project.js): the project (v2, v1 migrated) with
  // its recordings as file:// URLs; every edit sends the whole project back,
  // which main checks and saves shortly after.
  loadProject: () => ipcRenderer.invoke('project:load'),
  saveProject: (project) => ipcRenderer.invoke('project:save', project),
  // Export runs in a hidden window (src/main/ipc/export.js): resolves with
  // { file, ... } once saved; progress arrives as { phase, frame, total }.
  exportVideo: (opts) => ipcRenderer.invoke('export:start', opts),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  // Shows the last exported video in Finder/Explorer.
  revealExport: () => ipcRenderer.invoke('export:reveal'),
  // Returns a function that stops listening.
  onExportProgress: (cb) => {
    const listener = (_e, d) => cb(d);
    ipcRenderer.on('export:progress', listener);
    return () => ipcRenderer.removeListener('export:progress', listener);
  },
  // After export (src/main/ipc/share.js, src/main/ipc/fileActions.js document
  // the shapes). Share: hide the button unless shareStatus().enabled;
  // shareUpload resolves {ok, url | code, message}, never throws for
  // offline/too big/cancelled.
  shareStatus: () => ipcRenderer.invoke('share:status'),
  shareUpload: (filePath, details) => ipcRenderer.invoke('share:upload', filePath, details),
  shareCancel: () => ipcRenderer.invoke('share:cancel'),
  onShareProgress: (cb) => {
    const listener = (_e, d) => cb(d);
    ipcRenderer.on('share:progress', listener);
    return () => ipcRenderer.removeListener('share:progress', listener);
  },
  copyText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  copyFile: (filePath) => ipcRenderer.invoke('file:copy', filePath),
  revealFile: (filePath) => ipcRenderer.invoke('file:reveal', filePath),
  prepareFileDrag: (filePath) => ipcRenderer.invoke('file:prepareDrag', filePath),
  // Call from dragstart (after preventDefault); the OS carries the file.
  startFileDrag: (filePath) => { ipcRenderer.invoke('file:startDrag', filePath); },
  // Audio: voiceover takes and background music, saved into the project folder.
  saveVoiceover: (take) => ipcRenderer.invoke('voiceover:save', take),
  deleteVoiceover: (file) => ipcRenderer.invoke('voiceover:delete', { file }),
  chooseMusic: () => ipcRenderer.invoke('music:choose'),
  // A File dropped on the editor; only its path crosses to main, which copies it.
  importMusicFile: (file) =>
    ipcRenderer.invoke('music:import', webUtils.getPathForFile(file)),

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
