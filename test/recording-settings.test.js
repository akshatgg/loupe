'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  RECORDING_DEFAULTS, recordingView, applyRecordingSettingsPatch, toSettingsPatch
} = require('../src/main/recording-settings');
const { DEFAULT_SETTINGS, applySettingsPatch, normalizeSettings } = require('../src/main/settings');

test('defaults: countdown and shortcuts on; computer sound and camera off', () => {
  assert.deepStrictEqual(RECORDING_DEFAULTS, {
    countdown: true, systemAudio: false, recordKeys: true, camera: false, cameraDeviceId: null
  });
});

test('the picker sees settings.json in its own shape', () => {
  const settings = normalizeSettings({
    countdown: false, systemAudio: true, showKeystrokes: false, recordCamera: true,
    camera: { id: 'abc123', label: 'FaceTime HD Camera' }
  });
  assert.deepStrictEqual(recordingView(settings), {
    countdown: false, systemAudio: true, recordKeys: false, camera: true, cameraDeviceId: 'abc123'
  });
  assert.deepStrictEqual(recordingView(null), RECORDING_DEFAULTS);
});

test('a picker patch becomes a settings patch the Settings window agrees with', () => {
  const before = normalizeSettings({ camera: { id: 'cam', label: 'FaceTime HD Camera' } });
  const patch = toSettingsPatch({ recordKeys: false, camera: true, cameraDeviceId: 'cam' }, before);
  assert.deepStrictEqual(patch, {
    showKeystrokes: false, recordCamera: true, camera: { id: 'cam', label: 'FaceTime HD Camera' }
  });
  // Accepted from a renderer as it is.
  const after = applySettingsPatch(before, patch);
  assert.strictEqual(after.recordCamera, true);
  assert.deepStrictEqual(recordingView(after).cameraDeviceId, 'cam');
  // Another camera: the picker doesn't know its name; none leaks from the old one.
  assert.deepStrictEqual(toSettingsPatch({ cameraDeviceId: 'other' }, before), { camera: { id: 'other', label: '' } });
  assert.deepStrictEqual(toSettingsPatch({ cameraDeviceId: null }, before), { camera: null });
  assert.deepStrictEqual(toSettingsPatch({}, DEFAULT_SETTINGS), {});
});

test('a patch from the renderer is checked strictly', () => {
  const next = applyRecordingSettingsPatch(RECORDING_DEFAULTS, { systemAudio: true, cameraDeviceId: 'cam' });
  assert.strictEqual(next.systemAudio, true);
  assert.strictEqual(next.cameraDeviceId, 'cam');
  for (const apply of [applyRecordingSettingsPatch, (_, p) => toSettingsPatch(p, DEFAULT_SETTINGS)]) {
    assert.throws(() => apply(RECORDING_DEFAULTS, { zoom: true }), /Unknown recording setting/);
    assert.throws(() => apply(RECORDING_DEFAULTS, { camera: 1 }), /Invalid value for camera/);
    assert.throws(() => apply(RECORDING_DEFAULTS, { cameraDeviceId: 'x'.repeat(300) }), /Invalid value/);
    assert.throws(() => apply(RECORDING_DEFAULTS, null), /Invalid recording settings patch/);
  }
});
