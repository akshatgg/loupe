'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The recording choices the picker offers besides the microphone and the zoom
// shortcuts (docs/EDITOR-V2.md section 7): the 3-2-1 countdown, computer
// sound, keyboard shortcuts, and the camera bubble with the camera to use.
// Stored in their own file (recording.json in userData) next to settings.json,
// with the same rules as settings.js: forgiving to read, strict to write.
const RECORDING_DEFAULTS = Object.freeze({
  countdown: true,        // on unless turned off
  systemAudio: false,
  recordKeys: true,       // shortcuts only, never typing (InputTap)
  camera: false,
  cameraDeviceId: null    // null = the system's default camera
});

const isBoolean = (v) => typeof v === 'boolean';
// Chromium's MediaDeviceInfo.deviceId: an opaque string; kept short.
const validDeviceId = (v) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 256);

const VALIDATORS = {
  countdown: isBoolean,
  systemAudio: isBoolean,
  recordKeys: isBoolean,
  camera: isBoolean,
  cameraDeviceId: validDeviceId
};

function normalizeRecordingSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [key, fallback] of Object.entries(RECORDING_DEFAULTS)) {
    out[key] = Object.hasOwn(src, key) && VALIDATORS[key](src[key]) ? src[key] : fallback;
  }
  return out;
}

function loadRecordingSettings(file) {
  try {
    return normalizeRecordingSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return normalizeRecordingSettings(null);
  }
}

function saveRecordingSettings(file, settings) {
  const clean = normalizeRecordingSettings(settings);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, file);
  return clean;
}

function applyRecordingSettingsPatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(`Invalid recording settings patch: ${JSON.stringify(patch)}`);
  }
  for (const [key, value] of Object.entries(patch)) {
    const valid = VALIDATORS[key];
    if (!valid) throw new Error(`Unknown recording setting: ${JSON.stringify(key)}`);
    if (!valid(value)) throw new Error(`Invalid value for ${key}: ${JSON.stringify(value)}`);
  }
  return normalizeRecordingSettings({ ...current, ...patch });
}

module.exports = {
  RECORDING_DEFAULTS,
  loadRecordingSettings, saveRecordingSettings, applyRecordingSettingsPatch
};
