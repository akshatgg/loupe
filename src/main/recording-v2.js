'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The project-format-v2 fields (docs/EDITOR-V2.md section 3) a recording
// writes at stop, next to the v1 fields the current editor and exporter
// read. The project stays `version: 1` -- loadProject would refuse anything
// else -- and the v2 migration reads these instead of guessing:
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

module.exports = {
  buildMainSource, writeKeys, readKeys, validKeyLabel,
  KEYS_FILE, WEBCAM_FILE, SYSTEM_AUDIO_FILES
};
