'use strict';
// The visuals lab page's way out: whole files (as lab-preload.js), and a
// WebM recorded in chunks, which main writes the way the webcam bubble's
// writer does (a Duration made room for, then filled in).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('labHost', {
  save: (name, bytes) => ipcRenderer.invoke('lab:save', name, bytes),
  saveChunks: (name, chunks, durationMs) => ipcRenderer.invoke('lab:saveChunks', name, chunks, durationMs)
});
