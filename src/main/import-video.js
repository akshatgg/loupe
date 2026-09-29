'use strict';
// A video file from anywhere, as a Loupe project (docs/superpowers/specs/
// 2026-09-28-import-video-design.md). The Library copies the file into a new
// project folder (ipc/library.js importVideo); this decides what the copy is
// called and what project.json says about it.

const path = require('node:path');

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v'];
const EXPORT_HEIGHTS = [['720p', 720], ['1080p', 1080], ['1440p', 1440], ['4k', 2160]];
const MAX_EXPORT_FPS = 60;

// src/core is ES modules; loaded only when a video is imported.
let core = null;
function loadCore() {
  core ??= require('../core/project.js');
  return core;
}

// The copy's name inside the project folder: always "video.<ext>", so
// nothing in someone's own file name has to be trusted as a path.
function videoFileName(sourcePath) {
  const ext = path.extname(String(sourcePath)).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(ext)) throw new Error('Loupe can open MP4 and MOV videos.');
  return `video${ext}`;
}

// With the video's own shape the preset is the export's height: the
// smallest one that doesn't make the video smaller.
function exportResolutionFor({ height }) {
  const fit = EXPORT_HEIGHTS.find(([, h]) => h >= height);
  return (fit ?? EXPORT_HEIGHTS[EXPORT_HEIGHTS.length - 1])[0];
}

// `probe` is video-probe.js's description of the file.
function importedProject(probe, { title, createdAt, file }) {
  const P = loadCore();
  const project = P.createProject({
    title,
    createdAt,
    main: {
      dir: '.',
      kind: 'file',
      title,
      width: probe.width,
      height: probe.height,
      video: file,
      duration: probe.duration,
      fps: probe.fps,
      // The video's own sound plays as the recording's microphone track does.
      mic: probe.sound === 'aac',
      cursor: null,
      rotation: probe.rotation
    },
    // Nothing around the picture: the export is the video itself.
    style: { background: { type: 'none', value: null }, padding: 0, radius: 0, shadow: 0 }
  });
  return P.validateProject({
    ...project,
    audio: { ...project.audio, mic: { ...project.audio.mic, cleanUp: false, level: false } },
    export: {
      ...project.export,
      fps: Math.min(MAX_EXPORT_FPS, Math.max(1, Math.round(probe.fps))),
      resolution: exportResolutionFor(probe)
    }
  });
}

module.exports = { importedProject, exportResolutionFor, videoFileName, VIDEO_EXTENSIONS };
