'use strict';
// LUT files copied into the open project (src/main/ipc/luts.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerLutIpc, importLut } = require('../src/main/ipc/luts');
const { lutFileUrls } = require('../src/main/ipc/project-files');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `loupe-lut-${name}-`));
const CUBE = 'TITLE "Film"\nLUT_3D_SIZE 2\n' + Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`).join('\n') + '\n';

test('a .cube LUT is checked, then copied into <project>/luts with a safe, unique name', async () => {
  const project = tmp('p');
  const src = path.join(tmp('s'), 'Teal & Orange?.cube');
  fs.writeFileSync(src, CUBE);
  const first = await importLut(project, src);
  const second = await importLut(project, src);
  assert.deepStrictEqual(first, { file: 'luts/Teal & Orange.cube', name: 'Film' });
  assert.strictEqual(second.file, 'luts/Teal & Orange 2.cube');
  assert.strictEqual(fs.readFileSync(path.join(project, first.file), 'utf8'), CUBE);
  // The exporter is handed only the LUTs the project uses, inside luts/.
  const urls = lutFileUrls(project, { clips: [{ color: { lut: first.file } }, { color: { lut: '../secret.cube' } }, {}] });
  assert.deepStrictEqual(Object.keys(urls), [first.file, '../secret.cube']);
  assert.match(urls[first.file], /^file:\/\/.*\/luts\/Teal%20&%20Orange\.cube$/);
  assert.strictEqual(urls['../secret.cube'], null);
});

test('a file that isn’t a usable LUT is refused before anything is copied', async () => {
  const project = tmp('bad');
  const dir = tmp('src');
  const bad = path.join(dir, 'x.cube');
  fs.writeFileSync(bad, 'LUT_1D_SIZE 4\n0 0 0');
  await assert.rejects(importLut(project, bad), /1D/);
  const png = path.join(dir, 'x.png');
  fs.writeFileSync(png, 'png');
  await assert.rejects(importLut(project, png), /\.cube/);
  await assert.rejects(importLut(project, 'relative.cube'), /Choose/);
  assert.strictEqual(fs.existsSync(path.join(project, 'luts')), false);
});

test('lut:choose opens a .cube-only dialog; without a project it is refused', async () => {
  const handlers = {};
  const calls = [];
  let dir = null;
  const src = path.join(tmp('c'), 'Look.cube');
  fs.writeFileSync(src, CUBE);
  registerLutIpc({
    ipcMain: { handle: (c, fn) => { handlers[c] = fn; } },
    dialog: { showOpenDialog: async (_w, o) => { calls.push(o); return { canceled: false, filePaths: [src] }; } },
    BrowserWindow: { fromWebContents: () => null },
    getProjectDir: () => dir
  });
  await assert.rejects(handlers['lut:choose']({}), /No project/);
  dir = tmp('open');
  assert.deepStrictEqual(await handlers['lut:choose']({}), { file: 'luts/Look.cube', name: 'Film' });
  assert.deepStrictEqual(calls[0].filters[0].extensions, ['cube']);
});
