'use strict';
// Pictures and videos for overlays, copied into the open project
// (src/main/ipc/media.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { importMedia, registerMediaIpc } = require('../src/main/ipc/media');
const { mediaFileUrls } = require('../src/main/ipc/project-files');

const VIDEOS = path.join(__dirname, 'fixtures', 'videos');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `loupe-media-${n}-`));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201b8d1a7e20000000049454e44ae426082', 'hex');

test('a picture is checked and copied into <project>/media', async () => {
  const project = tmp('p');
  const src = path.join(tmp('s'), 'Logo #1.png');
  fs.writeFileSync(src, PNG);
  const got = await importMedia(project, src);
  assert.deepStrictEqual(got, { file: 'media/Logo #1.png', name: 'Logo #1', kind: 'image', fileDuration: null, rotation: 0 });
  assert.deepStrictEqual(fs.readFileSync(path.join(project, got.file)), PNG);
});

test('a video is probed (length, turn) and copied; unreadable ones are refused before copying', async () => {
  const project = tmp('v');
  const got = await importMedia(project, path.join(VIDEOS, 'rotated.mp4'));
  assert.strictEqual(got.kind, 'video');
  assert.strictEqual(got.rotation, 270);
  assert.ok(Math.abs(got.fileDuration - 2) < 0.05);
  await assert.rejects(importMedia(project, path.join(VIDEOS, 'prores.mov')), /ProRes/);
  const fake = path.join(tmp('f'), 'fake.png');
  fs.writeFileSync(fake, 'not a picture');
  await assert.rejects(importMedia(project, fake), /picture/);
  const other = path.join(tmp('o'), 'x.gif');
  fs.writeFileSync(other, 'GIF89a');
  await assert.rejects(importMedia(project, other), /PNG, JPG/);
  assert.deepStrictEqual(fs.readdirSync(path.join(project, 'media')), ['rotated.mp4']);
  // The exporter gets only files inside media/.
  const urls = mediaFileUrls(project, { overlays: [{ file: 'media/rotated.mp4' }, { file: 'media/../x' }] });
  assert.match(urls['media/rotated.mp4'], /^file:.*media\/rotated\.mp4$/);
  assert.strictEqual(urls['media/../x'], null);
});

test('media:choose asks for pictures and videos', async () => {
  const handlers = {};
  const opts = [];
  registerMediaIpc({
    ipcMain: { handle: (c, fn) => { handlers[c] = fn; } },
    dialog: { showOpenDialog: async (_w, o) => { opts.push(o); return { canceled: true, filePaths: [] }; } },
    BrowserWindow: { fromWebContents: () => null },
    getProjectDir: () => tmp('c')
  });
  assert.strictEqual(await handlers['media:choose']({}), null);
  assert.deepStrictEqual(opts[0].filters[0].extensions, ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'mov', 'm4v']);
});
