'use strict';

const fs = require('node:fs');
const path = require('node:path');

// What a recording is, in project-format-v2 terms (docs/EDITOR-V2.md
// section 3). recorder.js gathers the facts at stop in this shape, next to
// the v1-shaped fields it has always kept in memory, and toProjectV2 turns
// them into the version-2 project.json the editor opens:
//
//   project.sources.main = {
//     dir: ".", kind, id, title, width, height, originX, originY,
//     video: "raw.mov" | "raw.mp4", duration, fps: 60,
//     mic: bool,                     // the mic track inside the video file
//     systemAudio: "system.m4a" | "system.wav" | null,
//     webcam: { file: "webcam.webm", offset, width, height } | null,
//     cursor: "cursor.bin",
//     keys: "keys.json" | null,      // null when shortcuts were not recorded
//     clicks: [{t, x, y, button}],   // the same array as v1 project.clicks
//     pauses: [{start, end}]         // source time, sorted, not overlapping
//   }
//   project.clips = [{ id, source: "main", start, end }]  // the recording minus its pauses
//
// keys.json is [{t, label}], t in source time.

const KEYS_FILE = 'keys.json';
const WEBCAM_FILE = 'webcam.webm';

// A file name a helper reported writing, accepted only as a plain name in
// the recording folder (it is joined onto that folder later).
function safeFileName(name, allowed) {
  return typeof name === 'string' && allowed.includes(name) ? name : null;
}

const SYSTEM_AUDIO_FILES = ['system.m4a', 'system.wav'];

function buildMainSource({
  source, captureFile, duration, hasMic, systemAudioFile, webcam, keysRecorded, clicks, pauses
}) {
  return {
    dir: '.',
    kind: source.kind,
    id: source.id,
    title: source.title,
    width: source.width,
    height: source.height,
    originX: source.originX,
    originY: source.originY,
    video: captureFile,
    duration,
    fps: 60,
    mic: Boolean(hasMic),
    systemAudio: safeFileName(systemAudioFile, SYSTEM_AUDIO_FILES),
    webcam: webcam ?? null,
    cursor: 'cursor.bin',
    keys: keysRecorded ? KEYS_FILE : null,
    clicks,
    pauses
  };
}

function writeKeys(dir, keys) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, KEYS_FILE), JSON.stringify(keys));
}

function readKeys(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, KEYS_FILE), 'utf8'));
  } catch {
    return [];
  }
}

// Labels come from our own helper, but they end up drawn into videos: keep
// them short, single-line text.
function validKeyLabel(label) {
  return typeof label === 'string' && label.length > 0 && label.length <= 40 && !/[\n\r]/.test(label);
}

// src/core is ES modules; loaded only when a recording stops.
let core = null;
function loadCore() {
  core ??= require('../core/project.js');
  return core;
}

// The recording (v1 fields + sources.main + clips, as recorder.js keeps it)
// as a version-2 project: the recording minus its pauses, the zooms made
// while recording, and `style` -- the default preset's, when one is chosen
// -- over the new-project look. Returns null when the facts don't make a
// project (a capture that never produced a frame); the caller then keeps the
// v1 file, which the editor migrates.
function toProjectV2(recording, { createdAt = null, style = null } = {}) {
  const P = loadCore();
  try {
    const main = recording.sources.main;
    const project = P.createProject({ main, createdAt, style: style ?? undefined });
    const zooms = P.zoomsFromKeyframes(recording.zoomKeyframes, main.duration);
    return P.validateProject({ ...project, zooms });
  } catch {
    // A preset saved by another version may not validate; the recording
    // matters more than its look.
    if (style) return toProjectV2(recording, { createdAt });
    return null;
  }
}

module.exports = {
  toProjectV2, buildMainSource, writeKeys, readKeys, validKeyLabel,
  KEYS_FILE, WEBCAM_FILE, SYSTEM_AUDIO_FILES
};
