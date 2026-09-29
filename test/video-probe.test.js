'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { probeVideo, rotationOf } = require('../src/main/video-probe');

const fixture = (name) => path.join(__dirname, 'fixtures', 'videos', name);

test('an H.264 video with AAC sound is described', async () => {
  const v = await probeVideo(fixture('h264-aac.mp4'));
  assert.strictEqual(v.width, 160);
  assert.strictEqual(v.height, 90);
  assert.ok(Math.abs(v.duration - 2) < 0.05, `duration ${v.duration}`);
  assert.strictEqual(v.fps, 30);
  assert.strictEqual(v.rotation, 0);
  assert.match(v.codec, /^avc1\./);
  assert.strictEqual(v.sound, 'aac');
});

test('a QuickTime file with no sound track', async () => {
  const v = await probeVideo(fixture('silent.mov'));
  assert.strictEqual(v.sound, null);
  assert.strictEqual(v.width, 160);
});

test('a phone-style rotated video reports its upright size and turn', async () => {
  // Made with ffmpeg -display_rotation 90: a quarter turn anticlockwise,
  // which is 270 clockwise.
  const v = await probeVideo(fixture('rotated.mp4'));
  assert.strictEqual(v.rotation, 270);
  assert.strictEqual(v.width, 90);
  assert.strictEqual(v.height, 160);
});

test('sound in a format the exporter can not decode is reported, not fatal', async () => {
  const v = await probeVideo(fixture('opus-sound.mp4'));
  assert.strictEqual(v.sound, 'other');
});

test('a ProRes video is refused in plain words', async () => {
  await assert.rejects(probeVideo(fixture('prores.mov')), /format Loupe can.t read.*H\.264/s);
});

test('a file that is not a video is refused', async () => {
  await assert.rejects(probeVideo(fixture('not-video.mp4')), /isn.t a video Loupe can read/);
  await assert.rejects(probeVideo(fixture('nowhere.mp4')), /couldn.t be opened/);
});

test('rotation from a track matrix (16.16 fixed point)', () => {
  const one = 65536;
  assert.strictEqual(rotationOf([one, 0, 0, 0, one, 0, 0, 0, 0]), 0);
  assert.strictEqual(rotationOf([0, one, 0, -one, 0, 0, 0, 0, 0]), 90); // iPhone portrait
  assert.strictEqual(rotationOf([-one, 0, 0, 0, -one, 0, 0, 0, 0]), 180);
  assert.strictEqual(rotationOf([0, -one, 0, one, 0, 0, 0, 0, 0]), 270);
  assert.strictEqual(rotationOf(undefined), 0);
});
