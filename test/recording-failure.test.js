'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureProblem, discardFailedRecording } = require('../src/main/recording-failure');

test('capture problems are said in plain words, never the helper message', () => {
  const before = captureProblem({ started: false, platform: 'darwin' });
  assert.match(before.message, /couldn't start recording/);
  assert.match(before.detail, /Nothing was recorded/);
  assert.match(before.detail, /locked/);
  assert.doesNotMatch(captureProblem({ started: false, platform: 'win32' }).detail, /System Settings/);
  assert.match(captureProblem({ started: true }).detail, /saved/);
});

test('a failed recording folder is removed only when it holds leftovers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-discard-'));
  const empty = path.join(root, 'a');
  fs.mkdirSync(empty);
  fs.writeFileSync(path.join(empty, 'cursor.bin'), '');
  fs.writeFileSync(path.join(empty, 'raw.mov'), Buffer.alloc(100));
  assert.strictEqual(discardFailedRecording(empty), true);
  assert.ok(!fs.existsSync(empty));

  const other = path.join(root, 'b');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'project.json'), '{}');
  assert.strictEqual(discardFailedRecording(other), false, 'a project is not a leftover');
  assert.ok(fs.existsSync(other));

  const video = path.join(root, 'c');
  fs.mkdirSync(video);
  fs.writeFileSync(path.join(video, 'raw.mov'), Buffer.alloc(200 * 1024));
  assert.strictEqual(discardFailedRecording(video), false, 'a real video is kept');
  assert.strictEqual(discardFailedRecording(path.join(root, 'missing')), false);
  fs.rmSync(root, { recursive: true, force: true });
});
