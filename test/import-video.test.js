'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { importedProject, exportResolutionFor, videoFileName } = require('../src/main/import-video');

const PROBE = { duration: 12.5, width: 1920, height: 1080, fps: 29.97, rotation: 0, codec: 'avc1.64002a', sound: 'aac' };

test('an imported video is one clip over all of it, shown as it is', () => {
  const p = importedProject(PROBE, { title: 'Holiday', createdAt: 1789000000000, file: 'video.mp4' });
  const main = p.sources.main;
  assert.strictEqual(p.version, 2);
  assert.strictEqual(p.title, 'Holiday');
  assert.strictEqual(main.kind, 'file');
  assert.strictEqual(main.video, 'video.mp4');
  assert.strictEqual(main.cursor, null);
  assert.strictEqual(main.mic, true);
  assert.strictEqual(main.width, 1920);
  assert.strictEqual(main.duration, 12.5);
  assert.deepStrictEqual(p.clips.map((c) => [c.start, c.end]), [[0, 12.5]]);
  // The export is the video itself: no frame around it...
  assert.strictEqual(p.style.background.type, 'none');
  assert.strictEqual(p.style.padding, 0);
  assert.strictEqual(p.style.radius, 0);
  assert.strictEqual(p.style.shadow, 0);
  // ...its sound left as it is (clean-up would eat music)...
  assert.strictEqual(p.audio.mic.cleanUp, false);
  assert.strictEqual(p.audio.mic.level, false);
  // ...at its own frame rate and size.
  assert.strictEqual(p.export.fps, 30);
  assert.strictEqual(p.export.resolution, '1080p');
});

test('sound the exporter can not play is left out; rotation is kept', () => {
  const p = importedProject({ ...PROBE, sound: 'other', rotation: 90, width: 1080, height: 1920 },
    { title: 'Phone', createdAt: 1, file: 'video.mov' });
  assert.strictEqual(p.sources.main.mic, false);
  assert.strictEqual(p.sources.main.rotation, 90);
});

test('the export size is the smallest preset that is not below the video', () => {
  assert.strictEqual(exportResolutionFor({ width: 640, height: 360 }), '720p');
  assert.strictEqual(exportResolutionFor({ width: 1280, height: 720 }), '720p');
  assert.strictEqual(exportResolutionFor({ width: 2560, height: 1440 }), '1440p');
  assert.strictEqual(exportResolutionFor({ width: 1080, height: 1920 }), '4k');
  assert.strictEqual(exportResolutionFor({ width: 7680, height: 4320 }), '4k');
});

test('the copy is named after the kind of file, whatever the original was called', () => {
  assert.strictEqual(videoFileName('/Users/me/Movies/My Trip.MOV'), 'video.mov');
  assert.strictEqual(videoFileName('C:\\clips\\a.m4v'), 'video.m4v');
  assert.throws(() => videoFileName('/x/song.mp3'), /MP4 and MOV/);
  assert.throws(() => videoFileName('/x/clip.webm'), /MP4 and MOV/);
});
