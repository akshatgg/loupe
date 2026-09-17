'use strict';
// Captions at export, main-process side: the export options that burn
// captions in and save a .srt beside the video (src/main/ipc/export.js,
// src/main/ipc/captions.js writeSubtitlesBeside).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateExportOptions, buildJob, registerExportIpc } = require('../src/main/ipc/export');
const { writeSubtitlesBeside } = require('../src/main/ipc/captions');
const P = require('../src/core/project.js');

const CAPTIONS = [
  { id: 'a', source: 'main', start: 1, end: 2.5, text: 'Before the cut' },
  { id: 'b', source: 'main', start: 6, end: 7.5, text: 'After the cut' }
];

// A v2 recording folder whose 3..5 s are cut out.
function recording({ captions = CAPTIONS, show = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-captions-export-'));
  let p = P.createProject({ main: { width: 1280, height: 720, duration: 10, video: 'raw.mov' } });
  p = P.setCaptions(p, { segments: captions, show });
  p = P.cutRange(p, 3, 5);
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(p));
  fs.writeFileSync(path.join(dir, 'raw.mov'), 'not really a video');
  return dir;
}

test('export options: burn captions and save subtitles are true or false', () => {
  assert.deepStrictEqual(validateExportOptions({ burnCaptions: false, subtitles: true }),
    { resolution: undefined, codec: undefined, quality: undefined, fps: undefined, burnCaptions: false, subtitles: true });
  assert.strictEqual('subtitles' in validateExportOptions({ subtitles: false }), false);
  assert.throws(() => validateExportOptions({ burnCaptions: 'yes' }), /burnCaptions must be true or false/);
  assert.throws(() => validateExportOptions({ subtitles: 1 }), /subtitles must be true or false/);
});

test('burning captions overrides whether the project shows them; left out, the project decides', () => {
  const dir = recording({ show: true });
  assert.strictEqual(buildJob(dir, {}).job.project.captions.show, true);
  assert.strictEqual(buildJob(dir, { burnCaptions: false }).job.project.captions.show, false);
  const hidden = recording({ show: false });
  assert.strictEqual(buildJob(hidden, { burnCaptions: true }).job.project.captions.show, true);
  assert.strictEqual(buildJob(hidden, {}).subtitles, false);
  assert.strictEqual(buildJob(hidden, { subtitles: true }).subtitles, true);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(hidden, { recursive: true, force: true });
});

test('subtitles are written beside the video, timed to the edited video', async () => {
  const dir = recording();
  const project = P.loadProjectData(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')));
  const file = await writeSubtitlesBeside(path.join(dir, 'My demo.mp4'), project);
  assert.strictEqual(file, path.join(dir, 'My demo.srt'));
  assert.strictEqual(fs.readFileSync(file, 'utf8'),
    '1\n00:00:01,000 --> 00:00:02,500\nBefore the cut\n\n2\n00:00:04,000 --> 00:00:05,500\nAfter the cut\n');
  assert.strictEqual(fs.existsSync(`${file}.part`), false);
  assert.strictEqual(await writeSubtitlesBeside(path.join(dir, 'none.mp4'), P.setCaptions(project, { segments: [] })), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('export:start saves the .srt only when asked, and only after the video is saved', async () => {
  const dir = recording();
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const jobs = [];
  let fail = false;
  const runner = {
    busy: () => false,
    start: (job, out) => {
      jobs.push(job);
      if (fail) return Promise.reject(new Error('The export failed.'));
      fs.writeFileSync(out, 'video');
      return Promise.resolve({ file: out });
    },
    cancel: () => Promise.resolve(false)
  };
  registerExportIpc({ ipcMain, runner, projectDir: () => dir });
  const sender = { send: () => {}, isDestroyed: () => false };
  const title = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).title;
  const srt = path.join(dir, `${title} 2.srt`);

  const plain = await handlers['export:start']({ sender }, { resolution: '720p' });
  assert.strictEqual(plain.subtitles, undefined);
  assert.strictEqual(fs.existsSync(srt), false);

  const withSrt = await handlers['export:start']({ sender }, { resolution: '720p', subtitles: true, burnCaptions: true });
  assert.strictEqual(withSrt.subtitles, srt);
  assert.match(fs.readFileSync(srt, 'utf8'), /After the cut/);
  assert.strictEqual(jobs[1].project.captions.show, true);

  fs.rmSync(srt);
  fail = true;
  await assert.rejects(handlers['export:start']({ sender }, { resolution: '720p', subtitles: true }), /export failed/);
  assert.strictEqual(fs.existsSync(srt), false, 'no subtitles for a video that was not made');
  fs.rmSync(dir, { recursive: true, force: true });
});
