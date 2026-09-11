'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createProject, saveProject, loadProject,
  writeCursorTrack, readCursorTrack,
  SCHEMA_VERSION, CURSOR_RECORD_BYTES
} = require('../src/main/project');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-test-'));
}

const SOURCE = { kind: 'window', title: 'Safari', width: 3024, height: 1890 };
const CAPTURE = { file: 'raw.mov', fps: 60, duration: 12.5, hasMicTrack: true };

test('a new project carries the schema version and empty tracks', () => {
  const p = createProject(SOURCE, CAPTURE);
  assert.strictEqual(p.version, SCHEMA_VERSION);
  assert.deepStrictEqual(p.zoomKeyframes, []);
  assert.deepStrictEqual(p.clicks, []);
  assert.deepStrictEqual(p.speedSegments, []);
  assert.deepStrictEqual(p.voiceover, []);
});

test('a new project defaults to preserving voice pitch', () => {
  assert.strictEqual(createProject(SOURCE, CAPTURE).settings.preserveVoicePitch, true);
});

test('a new project shows the cursor by default', () => {
  assert.strictEqual(createProject(SOURCE, CAPTURE).settings.showCursor, true);
});

test('save then load round-trips', () => {
  const dir = tempDir();
  const p = createProject(SOURCE, CAPTURE);
  p.zoomKeyframes.push({ t: 1.5, zoom: 2.4, cx: 100, cy: 200 });
  p.clicks.push({ t: 1.6, x: 100, y: 200, button: 'left' });
  saveProject(dir, p);
  assert.deepStrictEqual(loadProject(dir), p);
});

test('loading a project with an unknown schema version throws', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ version: 99 }));
  assert.throws(() => loadProject(dir), /unsupported project version: 99/);
});

test('cursor track round-trips through the binary format', () => {
  const dir = tempDir();
  const track = [
    { t: 0, x: 10, y: 20, shape: 'arrow' },
    { t: 0.5, x: 30.5, y: 40.25, shape: 'ibeam' },
    { t: 1, x: 50, y: 60, shape: 'pointinghand' }
  ];
  writeCursorTrack(dir, track);
  const back = readCursorTrack(dir);
  assert.strictEqual(back.length, 3);
  assert.strictEqual(back[1].shape, 'ibeam');
  assert.ok(Math.abs(back[1].x - 30.5) < 1e-3);
  assert.ok(Math.abs(back[1].y - 40.25) < 1e-3);
});

test('cursor records are exactly 16 bytes so Swift can read them aligned', () => {
  const dir = tempDir();
  writeCursorTrack(dir, [{ t: 0, x: 1, y: 2, shape: 'arrow' }]);
  assert.strictEqual(fs.statSync(path.join(dir, 'cursor.bin')).size, CURSOR_RECORD_BYTES);
});

test('an unknown cursor shape falls back to arrow rather than throwing', () => {
  const dir = tempDir();
  writeCursorTrack(dir, [{ t: 0, x: 1, y: 2, shape: 'crosshair-of-doom' }]);
  assert.strictEqual(readCursorTrack(dir)[0].shape, 'arrow');
});

test('reading a missing cursor track returns an empty array', () => {
  assert.deepStrictEqual(readCursorTrack(tempDir()), []);
});
