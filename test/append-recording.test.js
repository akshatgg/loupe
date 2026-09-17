'use strict';
// src/main/ipc/append-recording.js: "Add recording" in the editor.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createLibrary } = require('../src/main/ipc/library');
const { createProjectStore } = require('../src/main/ipc/project');
const { registerAppendRecordingIpc, nextSourceKey } = require('../src/main/ipc/append-recording');
const v1 = require('../src/main/project');

function recording(root, id, { duration = 6, video = true, zoomKeyframes = [] } = {}) {
  const dir = path.join(root, id);
  const p = v1.createProject({ kind: 'display', id: 'display:1', width: 1280, height: 800 },
    { file: 'raw.mov', fps: 60, duration, hasMicTrack: true });
  p.zoomKeyframes = zoomKeyframes;
  v1.saveProject(dir, p);
  if (video) fs.writeFileSync(path.join(dir, 'raw.mov'), 'movie');
  fs.writeFileSync(path.join(dir, 'cursor.bin'), Buffer.alloc(16));
  return dir;
}

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-append-')));
  const root = path.join(base, 'Loupe');
  const handlers = {};
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
  const library = createLibrary({ root: () => root, locale: 'en-GB' });
  const store = createProjectStore({ delayMs: 5 });
  let open = null;
  registerAppendRecordingIpc({ ipcMain, library: () => library, store, projectDir: () => open });
  const call = (name, ...args) => handlers[name]({}, ...args);
  return { base, root, store, call, setOpen: (dir) => { open = dir; } };
}

test('source keys: src2, then the first free one', () => {
  assert.strictEqual(nextSourceKey({ main: {} }), 'src2');
  assert.strictEqual(nextSourceKey({ main: {}, src2: {}, src4: {} }), 'src3');
  assert.strictEqual(nextSourceKey(null), 'src2');
});

test('lists the other recordings with a video, and adds one the saved project keeps', async () => {
  const { base, root, store, call, setOpen } = setup();
  const here = recording(root, '1789000000000');
  recording(root, '1789000100000', {
    duration: 9, zoomKeyframes: [{ t: 2, zoom: 2.5, cx: 300, cy: 200 }, { t: 4, zoom: 1, cx: 300, cy: 200 }]
  });
  recording(root, '1789000200000', { video: false });
  setOpen(here);
  const { project } = store.load(here);

  const list = await call('project:recordings');
  assert.deepStrictEqual(list.map((r) => r.id), ['1789000100000'], 'not the open one, not one without video');

  const added = await call('project:appendRecording', '1789000100000');
  assert.strictEqual(added.key, 'src2');
  assert.strictEqual(added.meta.dir, path.join(root, '1789000100000'));
  assert.strictEqual(added.meta.duration, 9);
  assert.strictEqual(fileURLToPath(added.files.video), path.join(root, '1789000100000', 'raw.mov'));
  assert.deepStrictEqual(added.zooms, [{ start: 2, end: 4, level: 2.5, follow: true, x: 300, y: 200 }]);

  // The page makes the edit with the core and saves; main keeps the source.
  const P = require('../src/core/project.js');
  let next = P.appendRecording(project, added.key, added.meta);
  next = P.addZoom(next, { source: added.key, ...added.zooms[0] });
  store.save(here, next);
  store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(here, 'project.json'), 'utf8'));
  assert.strictEqual(saved.version, 2);
  assert.deepStrictEqual(saved.clips.map((c) => c.source), ['main', 'src2']);
  assert.strictEqual(saved.sources.src2.dir, path.join(root, '1789000100000'));

  // Reopened, the added recording's files load from its own folder.
  const again = createProjectStore().load(here);
  assert.strictEqual(fileURLToPath(again.sources.src2.video), path.join(root, '1789000100000', 'raw.mov'));

  // A second add gets its own key.
  assert.strictEqual((await call('project:appendRecording', '1789000100000')).key, 'src3');
  fs.rmSync(base, { recursive: true, force: true });
});

test('refuses the open recording, unknown ids, a missing video, and no editor', async () => {
  const { base, root, store, call, setOpen } = setup();
  const here = recording(root, '1789000000000');
  recording(root, '1789000200000', { video: false });
  await assert.rejects(async () => call('project:appendRecording', '1789000000000'), /no recording open/);
  setOpen(here);
  store.load(here);
  await assert.rejects(async () => call('project:appendRecording', '1789000000000'), /recording you’re editing/);
  await assert.rejects(async () => call('project:appendRecording', '../elsewhere'), /could not be found/);
  await assert.rejects(async () => call('project:appendRecording', '1789000200000'), /video file is missing/);
  assert.deepStrictEqual(Object.keys(store.sources(here)), ['main'], 'nothing was added');
  fs.rmSync(base, { recursive: true, force: true });
});
