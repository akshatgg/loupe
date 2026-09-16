'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RECORDING_DEFAULTS, loadRecordingSettings, saveRecordingSettings, applyRecordingSettingsPatch
} = require('../src/main/recording-settings');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-recset-')), 'recording.json');
}

test('defaults: countdown and shortcuts on; computer sound and camera off', () => {
  assert.deepStrictEqual(RECORDING_DEFAULTS, {
    countdown: true, systemAudio: false, recordKeys: true, camera: false, cameraDeviceId: null
  });
});

test('a missing, corrupt or partly invalid file falls back per setting', () => {
  const file = tmpFile();
  assert.deepStrictEqual(loadRecordingSettings(file), RECORDING_DEFAULTS);
  fs.writeFileSync(file, '{nope');
  assert.deepStrictEqual(loadRecordingSettings(file), RECORDING_DEFAULTS);
  fs.writeFileSync(file, JSON.stringify({ countdown: false, camera: 'yes', cameraDeviceId: 7, extra: 1 }));
  assert.deepStrictEqual(loadRecordingSettings(file), { ...RECORDING_DEFAULTS, countdown: false });
});

test('choices round-trip through the file', () => {
  const file = tmpFile();
  const saved = saveRecordingSettings(file, {
    countdown: false, systemAudio: true, recordKeys: false, camera: true, cameraDeviceId: 'abc123'
  });
  assert.deepStrictEqual(loadRecordingSettings(file), saved);
  assert.strictEqual(saved.cameraDeviceId, 'abc123');
});

test('a patch from the renderer is checked strictly', () => {
  const next = applyRecordingSettingsPatch(RECORDING_DEFAULTS, { systemAudio: true, cameraDeviceId: 'cam' });
  assert.strictEqual(next.systemAudio, true);
  assert.strictEqual(next.cameraDeviceId, 'cam');
  assert.throws(() => applyRecordingSettingsPatch(RECORDING_DEFAULTS, { zoom: true }), /Unknown recording setting/);
  assert.throws(() => applyRecordingSettingsPatch(RECORDING_DEFAULTS, { camera: 1 }), /Invalid value for camera/);
  assert.throws(() => applyRecordingSettingsPatch(RECORDING_DEFAULTS, { cameraDeviceId: 'x'.repeat(300) }), /Invalid value/);
  assert.throws(() => applyRecordingSettingsPatch(RECORDING_DEFAULTS, null), /Invalid recording settings patch/);
});
