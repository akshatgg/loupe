'use strict';

const { DEFAULT_SETTINGS } = require('./settings');

// The recording choices the picker offers besides the microphone and the zoom
// shortcuts (docs/EDITOR-V2.md section 7): the 3-2-1 countdown, computer
// sound, keyboard shortcuts, and the camera bubble with the camera to use.
//
// They live in settings.json with everything else (settings.js), so the
// picker and the Settings window can never disagree. The picker still sees
// them in its own flat shape, which this module translates:
//
//   picker            settings.json
//   countdown         countdown
//   systemAudio       systemAudio
//   recordKeys        showKeystrokes
//   camera            recordCamera          (the bubble on or off)
//   cameraDeviceId    camera.id             (camera: { id, label } | null)
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

function recordingView(settings) {
  const s = settings && typeof settings === 'object' ? settings : DEFAULT_SETTINGS;
  const pick = (key) => (isBoolean(s[key]) ? s[key] : DEFAULT_SETTINGS[key]);
  const id = s.camera && typeof s.camera.id === 'string' ? s.camera.id : null;
  return {
    countdown: pick('countdown'),
    systemAudio: pick('systemAudio'),
    recordKeys: pick('showKeystrokes'),
    camera: pick('recordCamera'),
    cameraDeviceId: validDeviceId(id) ? id : null
  };
}

const RECORDING_DEFAULTS = Object.freeze(recordingView(DEFAULT_SETTINGS));

// The picker is not a trust boundary: unknown keys and bad values throw.
function checkRecordingPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(`Invalid recording settings patch: ${JSON.stringify(patch)}`);
  }
  for (const [key, value] of Object.entries(patch)) {
    const valid = VALIDATORS[key];
    if (!valid) throw new Error(`Unknown recording setting: ${JSON.stringify(key)}`);
    if (!valid(value)) throw new Error(`Invalid value for ${key}: ${JSON.stringify(value)}`);
  }
}

// The picker's view after a patch (used by tests and page mocks).
function applyRecordingSettingsPatch(current, patch) {
  checkRecordingPatch(patch);
  return { ...current, ...patch };
}

// A checked picker patch as a settings.json patch. A camera chosen here keeps
// the name the Settings window stored for it when it is the same camera; the
// picker only knows the id.
function toSettingsPatch(patch, settings) {
  checkRecordingPatch(patch);
  const out = {};
  if ('countdown' in patch) out.countdown = patch.countdown;
  if ('systemAudio' in patch) out.systemAudio = patch.systemAudio;
  if ('recordKeys' in patch) out.showKeystrokes = patch.recordKeys;
  if ('camera' in patch) out.recordCamera = patch.camera;
  if ('cameraDeviceId' in patch) {
    const id = patch.cameraDeviceId;
    const before = settings?.camera;
    out.camera = id === null ? null : { id, label: before?.id === id ? before.label : '' };
  }
  return out;
}

module.exports = {
  RECORDING_DEFAULTS, recordingView, applyRecordingSettingsPatch, toSettingsPatch
};
