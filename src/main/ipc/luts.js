'use strict';

// LUTs for a clip's colour (look.js color.lut): the chosen .cube file is
// checked (it must read as a 3D table) and COPIED into <project>/luts/, so
// the project keeps working if the original moves, as music does.
//
//   'lut:choose' -> { file, name } | null (cancelled)
//
// `file` is relative to the project folder ("luts/Film.cube"); `name` is the
// LUT's own title, or its file name.

const fs = require('node:fs');
const path = require('node:path');
const { requireProjectDir, openUnique } = require('./project-files');
const { safeStem } = require('./music');

const SUBDIR = 'luts';
const MAX_BYTES = 64 * 1024 * 1024;

let core = null;
const lutCore = () => (core ??= require('../../core/lut.js'));

async function importLut(projectDir, sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || sourcePath.includes('\0')) {
    throw new Error('Choose a .cube LUT file.');
  }
  if (path.extname(sourcePath).toLowerCase() !== '.cube') throw new Error('Loupe reads LUTs saved as .cube files.');
  const st = await fs.promises.stat(sourcePath).catch(() => null);
  if (!st?.isFile()) throw new Error('That LUT file can’t be found.');
  if (st.size > MAX_BYTES) throw new Error('That LUT file is too large.');
  const text = await fs.promises.readFile(sourcePath, 'utf8');
  const lut = lutCore().parseCube(text); // throws a plain message for a bad file
  const dir = path.join(projectDir, SUBDIR);
  const { fd, name } = openUnique(dir, safeStem(sourcePath).replace(/^Music$/, 'LUT'), '.cube');
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  return { file: `${SUBDIR}/${name}`, name: lut.title || path.basename(name, '.cube') };
}

function registerLutIpc({ ipcMain, dialog, BrowserWindow, getProjectDir }) {
  ipcMain.handle('lut:choose', async (e) => {
    const projectDir = requireProjectDir(getProjectDir);
    const win = BrowserWindow.fromWebContents?.(e.sender) ?? undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Load a LUT', buttonLabel: 'Load', properties: ['openFile'],
      filters: [{ name: 'LUT', extensions: ['cube'] }]
    });
    if (canceled || !filePaths?.length) return null;
    return importLut(projectDir, filePaths[0]);
  });
}

module.exports = { registerLutIpc, importLut };
