'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeCameraTrack, readCameraTrack, CAMERA_RECORD_BYTES } = require('../src/main/project');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-cam-'));

test('camera track round-trips', () => {
  const dir = tempDir();
  const samples = [
    { t: 0, zoom: 1, cx: 800, cy: 500 },
    { t: 0.5, zoom: 2.25, cx: 810.5, cy: 505.25 }
  ];
  writeCameraTrack(dir, samples);
  const back = readCameraTrack(dir);
  assert.strictEqual(back.length, 2);
  assert.ok(Math.abs(back[1].zoom - 2.25) < 1e-4);
  assert.ok(Math.abs(back[1].cx - 810.5) < 1e-3);
});

test('camera records are 16 bytes', () => {
  const dir = tempDir();
  writeCameraTrack(dir, [{ t: 0, zoom: 1, cx: 0, cy: 0 }]);
  assert.strictEqual(fs.statSync(path.join(dir, 'camera.bin')).size, CAMERA_RECORD_BYTES);
});

test('reading a missing camera track returns an empty array', () => {
  assert.deepStrictEqual(readCameraTrack(tempDir()), []);
});
