'use strict';
// src/main/ipc/export.js without Electron: option validation, building the
// export job from a project folder, and the runner's handling of the export
// window's messages (writes, done, failure, cancel) with a fake window.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  validateExportOptions, buildJob, createExportRunner, registerExportIpc, recentExports, rememberExport
} = require('../src/main/ipc/export');
const { createProject, saveProject } = require('../src/main/project');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `loupe-export-${name}-`));
}

function v1Dir(name, { video = true } = {}) {
  const dir = tempDir(name);
  saveProject(dir, createProject({ width: 1440, height: 900 }, { file: 'raw.mov', duration: 10, fps: 60 }));
  if (video) fs.writeFileSync(path.join(dir, 'raw.mov'), 'not really a video');
  fs.writeFileSync(path.join(dir, 'cursor.bin'), Buffer.alloc(16));
  return dir;
}

function fakeElectron() {
  const windows = [];
  class FakeWindow {
    constructor(opts) {
      this.opts = opts;
      this.destroyed = false;
      this.listeners = {};
      this.handlers = {};
      this.ipcListeners = {};
      this.webContents = {
        ipc: {
          handle: (ch, fn) => { this.handlers[ch] = fn; },
          on: (ch, fn) => { this.ipcListeners[ch] = fn; }
        },
        on: (evt, fn) => { this.listeners[`wc:${evt}`] = fn; }
      };
      windows.push(this);
    }
    on(evt, fn) { this.listeners[evt] = fn; }
    loadFile(page) { this.page = page; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.listeners.closed?.();
    }
  }
  return { windows, BrowserWindow: FakeWindow };
}

async function waitFor(fn) {
  for (let i = 0; i < 200; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('timed out');
}

test('export options: known values only, v1 "preset" accepted as the size', () => {
  assert.deepStrictEqual(validateExportOptions({ preset: '4k', codec: 'hevc' }),
    { resolution: '4k', codec: 'hevc', quality: undefined, fps: undefined });
  assert.deepStrictEqual(validateExportOptions(undefined),
    { resolution: undefined, codec: undefined, quality: undefined, fps: undefined });
  assert.throws(() => validateExportOptions('1080p'), /must be an object/);
  assert.throws(() => validateExportOptions({ resolution: '8k' }), /Unknown export size/);
  assert.throws(() => validateExportOptions({ codec: 'prores' }), /Unknown video format/);
  assert.throws(() => validateExportOptions({ quality: 'max' }), /Unknown export quality/);
  assert.throws(() => validateExportOptions({ fps: 1000 }), /Unsupported frame rate/);
});

test('a v1 project becomes a v2 job with file URLs and the output beside it', () => {
  const dir = v1Dir('job');
  const { job, out, project } = buildJob(dir, { resolution: '720p' });
  assert.strictEqual(project.version, 2);
  assert.strictEqual(job.resolution, '720p');
  assert.strictEqual(job.codec, 'h264');
  assert.strictEqual(job.fps, 60);
  assert.match(job.sources.main.video, /^file:\/\/.*raw\.mov$/);
  assert.match(job.sources.main.cursor, /^file:\/\/.*cursor\.bin$/);
  assert.strictEqual(job.sources.main.systemAudio, null);
  assert.deepStrictEqual(job.audioFiles, { music: null, voiceover: {} });
  // 1440x900 at 720p keeps the recording's shape.
  assert.strictEqual(out, path.join(dir, 'export-1152x720.mp4'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing video or a file name leaving the folder is refused', () => {
  const dir = v1Dir('missing', { video: false });
  assert.throws(() => buildJob(dir, {}), /video file is missing \(raw\.mov\)/);
  const project = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  project.capture.file = '../../etc/passwd';
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
  assert.throws(() => buildJob(dir, {}), /invalid video file/);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.throws(() => buildJob(dir, {}), /Couldn't read/);
});

test('the runner writes positioned bytes and renames the file when done', async () => {
  const dir = tempDir('run');
  const out = path.join(dir, 'video.mp4');
  const { windows, BrowserWindow } = fakeElectron();
  const runner = createExportRunner({ BrowserWindow, preload: 'p.js', page: 'index.html' });
  const progress = [];
  const running = runner.start({ hello: 1 }, out, { onProgress: (p) => progress.push(p) });
  assert.strictEqual(runner.busy(), true);
  await assert.rejects(runner.start({}, out), /already in progress/);

  const win = await waitFor(() => windows[0]);
  assert.strictEqual(win.opts.show, false);
  assert.strictEqual(win.opts.webPreferences.sandbox, true);
  assert.strictEqual(win.opts.webPreferences.preload, 'p.js');
  assert.deepStrictEqual(await win.handlers['exporter:job']({}), { hello: 1 });

  await win.handlers['exporter:write']({}, 0, new Uint8Array([1, 2, 3, 4]));
  await win.handlers['exporter:write']({}, 6, new Uint8Array([9]));
  await win.handlers['exporter:write']({}, 2, new Uint8Array([7, 7]));
  assert.throws(() => win.handlers['exporter:write']({}, -1, new Uint8Array(1)), /Invalid write position/);
  assert.throws(() => win.handlers['exporter:write']({}, 0, 'bytes'), /Invalid write/);
  assert.ok(fs.existsSync(`${out}.part`));
  assert.strictEqual(fs.existsSync(out), false, 'not under its real name until finished');

  win.ipcListeners['exporter:progress']({}, { phase: 'video', frame: 3, total: 10, evil: { a: 1 } });
  assert.deepStrictEqual(progress, [{ phase: 'video', frame: 3, total: 10 }]);

  await win.handlers['exporter:done']({}, { frames: 10, seconds: 1.5 });
  const result = await running;
  assert.deepStrictEqual(result, { frames: 10, seconds: 1.5, file: out });
  assert.deepStrictEqual([...fs.readFileSync(out)], [1, 2, 7, 7, 0, 0, 9]);
  assert.strictEqual(fs.existsSync(`${out}.part`), false);
  assert.strictEqual(win.destroyed, true);
  assert.strictEqual(runner.busy(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failed export rejects with its message and leaves no file', async () => {
  const dir = tempDir('fail');
  const out = path.join(dir, 'video.mp4');
  const { windows, BrowserWindow } = fakeElectron();
  const runner = createExportRunner({ BrowserWindow, preload: 'p.js', page: 'index.html' });
  const running = runner.start({}, out);
  const win = await waitFor(() => windows[0]);
  await win.handlers['exporter:write']({}, 0, new Uint8Array(100));
  win.ipcListeners['exporter:fail']({}, "This computer can't decode the video.");
  await assert.rejects(running, /can't decode the video/);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.strictEqual(runner.busy(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cancelling, or the window going away, removes the partial file', async () => {
  const dir = tempDir('cancel');
  const out = path.join(dir, 'video.mp4');
  const { windows, BrowserWindow } = fakeElectron();
  const runner = createExportRunner({ BrowserWindow, preload: 'p.js', page: 'index.html' });

  const first = runner.start({}, out);
  const win = await waitFor(() => windows[0]);
  await win.handlers['exporter:write']({}, 0, new Uint8Array(10));
  assert.strictEqual(await runner.cancel(), true);
  await assert.rejects(first, (e) => e.cancelled === true);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.strictEqual(win.destroyed, true);
  assert.strictEqual(await runner.cancel(), false, 'nothing left to cancel');

  const second = runner.start({}, out);
  const win2 = await waitFor(() => windows[1]);
  win2.listeners['wc:render-process-gone']();
  await assert.rejects(second, /stopped unexpectedly/);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('export:start exports the open recording and sends progress to the editor', async () => {
  const dir = v1Dir('ipc');
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const calls = [];
  const runner = {
    busy: () => false,
    start: (job, out, { onProgress }) => { calls.push({ job, out }); onProgress({ frame: 1 }); return Promise.resolve({ file: out }); },
    cancel: () => Promise.resolve(false)
  };
  let open = null;
  registerExportIpc({ ipcMain, runner, projectDir: () => open });
  const sent = [];
  const sender = { send: (ch, p) => sent.push([ch, p]), isDestroyed: () => false };
  await assert.rejects(handlers['export:start']({ sender }, {}), /no recording open/);
  open = dir;
  await assert.rejects(handlers['export:start']({ sender }, { resolution: 'huge' }), /Unknown export size/);
  const result = await handlers['export:start']({ sender }, { preset: '1080p' });
  assert.strictEqual(result.file, path.join(dir, 'export-1728x1080.mp4'));
  assert.deepStrictEqual(sent, [['export:progress', { frame: 1 }]]);
  assert.strictEqual(await handlers['export:cancel'](), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('export:start flushes the pending project save first; export:reveal shows only the last export', async () => {
  const dir = v1Dir('reveal');
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const order = [];
  const runner = {
    busy: () => false,
    start: (job, out) => { order.push('start'); fs.writeFileSync(out, 'video'); return Promise.resolve({ file: out }); },
    cancel: () => Promise.resolve(false)
  };
  const revealed = [];
  registerExportIpc({
    ipcMain, runner, projectDir: () => dir,
    beforeStart: () => { order.push('flush'); },
    shell: { showItemInFolder: (f) => revealed.push(f) }
  });
  assert.strictEqual(await handlers['export:reveal']({}, '/etc/passwd'), false, 'nothing exported yet');
  const result = await handlers['export:start']({ sender: { send() {} } }, {});
  assert.deepStrictEqual(order, ['flush', 'start']);
  assert.strictEqual(await handlers['export:reveal']({}, '/etc/passwd'), true);
  assert.deepStrictEqual(revealed, [result.file]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('export options: formats, size limits and GIF settings', () => {
  assert.deepStrictEqual(validateExportOptions({ format: 'gif', gifWidth: 480, gifFps: 10, dither: false }),
    { resolution: undefined, codec: undefined, quality: undefined, fps: undefined, format: 'gif', gifWidth: 480, gifFps: 10, dither: false });
  assert.strictEqual(validateExportOptions({ sizeLimit: 25 }).sizeLimit, 25);
  assert.strictEqual(validateExportOptions({ sizeLimit: null }).sizeLimit, null);
  assert.throws(() => validateExportOptions({ format: 'avi' }), /Unknown export format/);
  assert.throws(() => validateExportOptions({ sizeLimit: 0 }), /size limit/);
  assert.throws(() => validateExportOptions({ sizeLimit: '25' }), /size limit/);
  assert.throws(() => validateExportOptions({ gifWidth: 1000 }), /GIF width/);
  assert.throws(() => validateExportOptions({ gifFps: 60 }), /GIF frame rate/);
  assert.throws(() => validateExportOptions({ dither: 1 }), /Dithering/);
});

test('a GIF job is named .gif at its own size', () => {
  const dir = v1Dir('gif');
  const { job, out } = buildJob(dir, { format: 'gif', gifWidth: 720 });
  assert.strictEqual(job.format, 'gif');
  assert.strictEqual(job.gifWidth, 720);
  // 1440x900 is 1728x1080 at 1080p; 720 wide keeps the shape.
  assert.strictEqual(out, path.join(dir, 'export-720x450.gif'));
  assert.strictEqual(path.basename(buildJob(dir, { format: 'webm', resolution: '720p' }).out), 'export-1152x720.webm');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recent exports: newest first, one entry per file, only files that exist, nothing outside the folder', () => {
  const dir = tempDir('recent');
  const a = path.join(dir, 'export-1x1.mp4');
  const b = path.join(dir, 'export-2x2.gif');
  fs.writeFileSync(a, 'aaaa');
  fs.writeFileSync(b, 'bb');
  assert.deepStrictEqual(recentExports(dir), []);
  rememberExport(dir, { file: a, format: 'mp4', width: 1, height: 1, duration: 3, bytes: 4 }, { now: 1 });
  rememberExport(dir, { file: b, format: 'gif', width: 2, height: 2, duration: 3, bytes: 2 }, { now: 2 });
  rememberExport(dir, { file: a, format: 'mp4', width: 1, height: 1, duration: 3, bytes: 4 }, { now: 3 });
  assert.deepStrictEqual(recentExports(dir).map((r) => [r.name, r.at, r.bytes]), [['export-1x1.mp4', 3, 4], ['export-2x2.gif', 2, 2]]);
  assert.strictEqual(recentExports(dir)[0].file, a);
  fs.rmSync(a);
  assert.deepStrictEqual(recentExports(dir).map((r) => r.name), ['export-2x2.gif']);
  // A hand-edited list can't point elsewhere.
  fs.writeFileSync(path.join(dir, 'exports.json'), JSON.stringify([{ name: '../x.gif', format: 'gif' }, { name: 'export-2x2.gif', format: 'exe' }, 'junk']));
  assert.deepStrictEqual(recentExports(dir), []);
  fs.writeFileSync(path.join(dir, 'exports.json'), '{nope');
  assert.deepStrictEqual(recentExports(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
