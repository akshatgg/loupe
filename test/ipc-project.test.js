'use strict';
// src/main/ipc/project.js: the editor's project:load / project:save.
// Loading migrates v1 in memory; saving validates, keeps the recordings the
// project was loaded with, debounces, and writes atomically.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectStore, registerProjectIpc } = require('../src/main/ipc/project');
const v1 = require('../src/main/project');

function v1Dir(name, { video = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loupe-project-${name}-`));
  const p = v1.createProject({ kind: 'display', width: 1440, height: 900 }, { file: 'raw.mov', duration: 10, fps: 60 });
  p.zoomKeyframes = [{ t: 1, zoom: 2, cx: 100, cy: 100 }, { t: 3, zoom: 1, cx: 100, cy: 100 }];
  v1.saveProject(dir, p);
  if (video) fs.writeFileSync(path.join(dir, 'raw.mov'), 'x');
  fs.writeFileSync(path.join(dir, 'cursor.bin'), Buffer.alloc(16));
  return dir;
}

const readJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));

test('load migrates a v1 project in memory and leaves the file alone', () => {
  const dir = v1Dir('load');
  const store = createProjectStore();
  const loaded = store.load(dir);
  assert.strictEqual(loaded.project.version, 2);
  assert.strictEqual(loaded.migrated, true);
  assert.strictEqual(loaded.project.zooms.length, 1);
  assert.match(loaded.sources.main.video, /^file:\/\/.*raw\.mov$/);
  assert.match(loaded.sources.main.cursor, /cursor\.bin$/);
  assert.strictEqual(loaded.sources.main.systemAudio, null);
  assert.strictEqual(loaded.sources.main.missing, false);
  assert.strictEqual(loaded.folder, `${require('node:url').pathToFileURL(dir).href}/`);
  assert.strictEqual(readJson(dir).version, 1, 'opening does not rewrite the file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a folder named by its start time gives the migrated project its title', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-project-title-'));
  const dir = path.join(parent, '1789144861212');
  fs.cpSync(v1Dir('title'), dir, { recursive: true });
  const { project } = createProjectStore().load(dir);
  assert.strictEqual(project.createdAt, 1789144861212);
  assert.match(project.title, /^Recording \d+ \w{3} 2026, \d\d:\d\d$/);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('a missing video is reported, and a missing project file is a plain error', () => {
  const dir = v1Dir('missing', { video: false });
  const store = createProjectStore();
  const loaded = store.load(dir);
  assert.strictEqual(loaded.sources.main.missing, true);
  assert.strictEqual(loaded.sources.main.video, null);
  fs.rmSync(path.join(dir, 'project.json'));
  assert.throws(() => store.load(dir), /project file is missing/);
  fs.writeFileSync(path.join(dir, 'project.json'), '{ nope');
  assert.throws(() => store.load(dir), /couldn't be read/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saves are debounced, validated, atomic and written as v2', async () => {
  const dir = v1Dir('save');
  const store = createProjectStore({ delayMs: 30 });
  const { project } = store.load(dir);
  store.save(dir, { ...project, title: 'First' });
  store.save(dir, { ...project, title: 'Second' });
  assert.strictEqual(readJson(dir).version, 1, 'nothing written straight away');
  assert.strictEqual(store.pending(), true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const saved = readJson(dir);
  assert.strictEqual(saved.version, 2);
  assert.strictEqual(saved.title, 'Second');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), [], 'no temporary file left');

  assert.throws(() => store.save(dir, { ...project, zooms: [{ id: 'z1' }] }));
  assert.throws(() => store.save(dir, 'nope'), /not a project/);
  assert.strictEqual(store.pending(), false, 'a refused save is not queued');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('flush writes a pending save at once; the recordings a project points at cannot be changed', () => {
  const dir = v1Dir('flush');
  const store = createProjectStore({ delayMs: 10000 });
  const { project } = store.load(dir);
  const evil = { ...project, sources: { main: { ...project.sources.main, dir: '/', video: 'etc/passwd' } } };
  store.save(dir, evil);
  assert.strictEqual(store.flush(), true);
  assert.strictEqual(store.flush(), false);
  const saved = readJson(dir);
  assert.strictEqual(saved.sources.main.dir, '.');
  assert.strictEqual(saved.sources.main.video, 'raw.mov');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saving before loading is refused', () => {
  const dir = v1Dir('unloaded');
  const store = createProjectStore();
  assert.throws(() => store.save(dir, {}), /Open the recording/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('project:load and project:save act on the open recording', async () => {
  const dir = v1Dir('ipc');
  const handlers = {};
  const store = createProjectStore({ delayMs: 5 });
  let open = null;
  registerProjectIpc({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, store, projectDir: () => open });
  assert.throws(() => handlers['project:load']({}), /no recording open/);
  open = dir;
  const { project } = handlers['project:load']({});
  assert.deepStrictEqual(handlers['project:save']({}, { ...project, title: 'Demo' }), { saved: true });
  store.flush();
  assert.strictEqual(readJson(dir).title, 'Demo');
  fs.rmSync(dir, { recursive: true, force: true });
});
