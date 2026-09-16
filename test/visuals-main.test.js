'use strict';
// The main-process side of the visual features: background pictures
// (ipc/background.js), the files the editor and exporter get for the webcam,
// shortcuts and background (ipc/project.js, ipc/export.js), and the default
// style preset a new recording is written with (recorder.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  registerBackgroundIpc, resolveBackgroundFile, validateImagePath
} = require('../src/main/ipc/background');
const { buildJob } = require('../src/main/ipc/export');
const { sourceFiles } = require('../src/main/ipc/project');
const { WALLPAPERS, wallpaperId, isProjectBackground } = require('../src/core/wallpapers.js');
const { createProject, saveProject } = require('../src/main/project');

const ROOT = path.join(__dirname, '..');
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `loupe-${name}-`));
}

function harness({ projectDir, openResult }) {
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const dialog = { showOpenDialog: async () => openResult };
  registerBackgroundIpc({ ipcMain, dialog, BrowserWindow: { fromWebContents: () => null }, getProjectDir: () => projectDir });
  return (ch, ...args) => Promise.resolve().then(() => handlers[ch]({ sender: {} }, ...args));
}

test('every bundled wallpaper exists and is small', () => {
  for (const w of WALLPAPERS) {
    const file = path.join(ROOT, 'src', 'assets', 'wallpapers', `${w.id}.png`);
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.subarray(0, 8).equals(PNG.subarray(0, 8)), `${w.id} is a PNG`);
    assert.ok(bytes.length < 400 * 1024, `${w.id} is ${bytes.length} bytes`);
  }
  assert.strictEqual(wallpaperId('wallpaper:dusk'), 'dusk');
  assert.strictEqual(wallpaperId('wallpaper:../../etc'), null);
  assert.strictEqual(wallpaperId('dusk'), null);
  assert.ok(isProjectBackground('background/My picture.png'));
  for (const bad of ['background/../x.png', 'background/a/b.png', '/abs/x.png', 'background/..', 'music/x.png', 'background/C:x.png']) {
    assert.ok(!isProjectBackground(bad), bad);
  }
});

test('background values resolve only to wallpapers and pictures in the project', () => {
  const dir = tmpDir('bg');
  fs.mkdirSync(path.join(dir, 'background'));
  fs.writeFileSync(path.join(dir, 'background', 'pic.png'), PNG);
  const outside = path.join(tmpDir('bg-outside'), 'secret.png');
  fs.writeFileSync(outside, PNG);
  assert.strictEqual(resolveBackgroundFile(dir, 'wallpaper:ocean'), path.join(ROOT, 'src', 'assets', 'wallpapers', 'ocean.png'));
  assert.strictEqual(resolveBackgroundFile(dir, 'background/pic.png'), path.join(dir, 'background', 'pic.png'));
  assert.strictEqual(resolveBackgroundFile(dir, 'background/missing.png'), null);
  assert.strictEqual(resolveBackgroundFile(dir, outside), null);
  assert.strictEqual(resolveBackgroundFile(dir, `background/../../${path.basename(path.dirname(outside))}/secret.png`), null);
  assert.strictEqual(resolveBackgroundFile(null, 'background/pic.png'), null);
  assert.strictEqual(resolveBackgroundFile(dir, 42), null);
});

test('background:choose copies the picture into the project; background:url finds it', async () => {
  const dir = tmpDir('bg-choose');
  const pic = path.join(tmpDir('bg-src'), 'Holiday: beach.JPEG');
  fs.writeFileSync(pic, PNG);
  const invoke = harness({ projectDir: dir, openResult: { canceled: false, filePaths: [pic] } });
  const first = await invoke('background:choose');
  assert.strictEqual(first.value, 'background/Holiday beach.jpg');
  assert.ok(fs.readFileSync(path.join(dir, 'background', 'Holiday beach.jpg')).equals(PNG));
  assert.strictEqual(first.url, pathToFileURL(path.join(dir, 'background', 'Holiday beach.jpg')).href);
  const second = await invoke('background:choose');
  assert.strictEqual(second.value, 'background/Holiday beach 2.jpg');
  assert.strictEqual(await invoke('background:url', first.value), first.url);
  assert.match(await invoke('background:url', 'wallpaper:sand'), /assets\/wallpapers\/sand\.png$/);
  assert.strictEqual(await invoke('background:url', '/etc/hosts'), null);
  const cancelled = harness({ projectDir: dir, openResult: { canceled: true, filePaths: [] } });
  assert.strictEqual(await cancelled('background:choose'), null);
  await assert.rejects(harness({ projectDir: null, openResult: {} })('background:choose'), /No project/);
});

test('only pictures, and not huge or missing ones', () => {
  const dir = tmpDir('bg-validate');
  const txt = path.join(dir, 'notes.txt');
  fs.writeFileSync(txt, 'hi');
  assert.throws(() => validateImagePath(txt), /PNG or JPEG/);
  assert.throws(() => validateImagePath('relative.png'), /Choose/);
  assert.throws(() => validateImagePath(path.join(dir, 'gone.png')), /can’t be found/);
  const empty = path.join(dir, 'empty.png');
  fs.writeFileSync(empty, '');
  assert.throws(() => validateImagePath(empty), /Choose/);
});

function v2Dir() {
  const dir = tmpDir('visual-job');
  const project = {
    version: 2, title: 'T', createdAt: 0,
    sources: {
      main: {
        dir: '.', kind: 'display', id: 'd', title: 'D', width: 800, height: 500, originX: 0, originY: 0,
        video: 'raw.mov', duration: 5, fps: 60, mic: false, systemAudio: null, cursor: 'cursor.bin',
        webcam: { file: 'webcam.webm', offset: 0.2, width: 640, height: 480 }, keys: 'keys.json', clicks: [], pauses: []
      }
    },
    clips: [{ id: 'c1', source: 'main', start: 0, end: 5 }],
    style: { background: { type: 'image', value: 'wallpaper:dusk' } }
  };
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
  for (const f of ['raw.mov', 'cursor.bin', 'webcam.webm', 'keys.json']) fs.writeFileSync(path.join(dir, f), '[]');
  return { dir, project };
}

test('the export job and the editor get the webcam, shortcuts and background picture', () => {
  const { dir, project } = v2Dir();
  const { job } = buildJob(dir, {});
  assert.strictEqual(job.sources.main.webcam, pathToFileURL(path.join(dir, 'webcam.webm')).href);
  assert.strictEqual(job.sources.main.keys, pathToFileURL(path.join(dir, 'keys.json')).href);
  assert.strictEqual(job.background, pathToFileURL(path.join(ROOT, 'src', 'assets', 'wallpapers', 'dusk.png')).href);
  const files = sourceFiles(dir, project);
  assert.strictEqual(files.main.webcam, job.sources.main.webcam);
  assert.strictEqual(files.main.keys, job.sources.main.keys);
  // Not there: null, and the export still builds.
  fs.rmSync(path.join(dir, 'webcam.webm'));
  assert.strictEqual(buildJob(dir, {}).job.sources.main.webcam, null);
  // A background path outside the project is never handed to the exporter.
  project.style.background.value = path.join(dir, 'raw.mov');
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
  assert.strictEqual(buildJob(dir, {}).job.background, null);
});

test('a v1 project with a recorder-written style opens with that style', () => {
  const dir = tmpDir('preset-style');
  const v1 = createProject({ kind: 'display', width: 1000, height: 600 }, { file: 'raw.mov', duration: 4, fps: 60 });
  v1.style = { background: { type: 'image', value: 'wallpaper:aurora' }, padding: 0.1, radius: 20 };
  saveProject(dir, v1);
  fs.writeFileSync(path.join(dir, 'raw.mov'), 'x');
  const { job } = buildJob(dir, {});
  assert.strictEqual(job.project.style.padding, 0.1);
  assert.match(job.background, /aurora\.png$/);
});

test('the recorder starts the project from the default preset style it is given, or the defaults', async () => {
  const { defaultStyle } = require('../src/core/project.js');
  const { createRecorder } = require('../src/main/recorder');
  for (const style of [{ padding: 0.12, background: { type: 'color', value: '#101010' } }, null]) {
    let local = 0;
    const sinks = {};
    const rec = createRecorder({
      binDir: '/fake', platform: 'darwin', now: () => local, stopHelper: async () => 0,
      spawnHelper: (bin, args, opts) => {
        sinks[bin.endsWith('capture') || args[0] === 'capture' ? 'capture' : 'inputtap'] = opts.onMessage;
        return { kill() {}, exitCode: null, signalCode: null, once() {} };
      }
    });
    const dir = tmpDir('rec-style');
    await rec.start({ source: 'display:1', mic: false, dir, width: 800, height: 600 });
    local = 1000;
    sinks.capture({ type: 'started', clock: 1000, now: 1000 });
    local = 1003;
    sinks.capture({ type: 'stopped', duration: 3, now: 1003 });
    await rec.stop({ style });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
    // Stop writes a version-2 project (recording-v2.js): the preset fills in
    // over the full default style.
    assert.strictEqual(saved.version, 2);
    if (style) {
      assert.strictEqual(saved.style.padding, 0.12);
      assert.deepStrictEqual(saved.style.background, style.background);
      assert.strictEqual(saved.style.radius, defaultStyle().radius);
    } else {
      assert.deepStrictEqual(saved.style, defaultStyle());
    }
  }
});
