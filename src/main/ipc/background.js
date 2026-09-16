'use strict';

// Background pictures for the editor's Style panel.
//
//   'background:choose'       -> { value, url } | null (cancelled)
//       opens a picture, COPIES it into <project>/background/ (so the project
//       keeps working if the original moves) and returns the style value
//       "background/<file>" and a file:// URL to show it
//   'background:url' (value)  -> file:// URL | null
//       where a background value's picture is: a bundled wallpaper
//       ("wallpaper:<id>", src/core/wallpapers.js) or a copied picture of
//       the open project. Anything else -- an absolute path, "..", a file
//       that isn't there (a preset made in another recording) -- is null.
//
// The export job resolves its background through resolveBackgroundFile too,
// so a project.json can never make the exporter read any other file.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { requireProjectDir, resolveProjectFile, openUnique } = require('./project-files');
const { safeStem } = require('./music');

const SUBDIR = 'background';
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
const MAX_BYTES = 64 * 1024 * 1024;
const SRC_DIR = path.join(__dirname, '..', '..');

let wallpapers = null;
function loadWallpapers() {
  wallpapers ??= require('../../core/wallpapers.js');
  return wallpapers;
}

// The picture file a background value names, or null.
function resolveBackgroundFile(projectDir, value) {
  if (typeof value !== 'string') return null;
  const W = loadWallpapers();
  const id = W.wallpaperId(value);
  let file = null;
  if (id) {
    file = path.join(SRC_DIR, W.wallpaperPath(id));
  } else if (W.isProjectBackground(value) && typeof projectDir === 'string' && projectDir) {
    try {
      file = resolveProjectFile(projectDir, SUBDIR, value);
    } catch {
      return null;
    }
  }
  return file && fs.existsSync(file) ? file : null;
}

function validateImagePath(p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0') || !path.isAbsolute(p)) {
    throw new Error('Choose a picture to use.');
  }
  const ext = path.extname(p).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(ext)) {
    throw new Error('That kind of picture isn’t supported. Try a PNG or JPEG.');
  }
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new Error('That picture can’t be found.');
  }
  if (!st.isFile() || st.size === 0) throw new Error('Choose a picture to use.');
  if (st.size > MAX_BYTES) throw new Error('That picture is too large.');
  return ext;
}

async function importBackground(projectDir, sourcePath) {
  const ext = validateImagePath(sourcePath);
  const dir = path.join(projectDir, SUBDIR);
  const { fd, name } = openUnique(dir, safeStem(sourcePath), ext === '.jpeg' ? '.jpg' : ext);
  const dest = path.join(dir, name);
  fs.closeSync(fd);
  try {
    await fs.promises.copyFile(sourcePath, dest);
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw new Error('That picture couldn’t be copied into the project.', { cause: err });
  }
  return { value: `${SUBDIR}/${name}`, url: pathToFileURL(dest).href };
}

function registerBackgroundIpc({ ipcMain, dialog, BrowserWindow, getProjectDir }) {
  ipcMain.handle('background:choose', async (e) => {
    const projectDir = requireProjectDir(getProjectDir);
    const win = BrowserWindow.fromWebContents?.(e.sender) ?? undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose a background picture',
      buttonLabel: 'Use picture',
      properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: IMAGE_EXTENSIONS.map((x) => x.slice(1)) }]
    });
    if (canceled || !filePaths?.length) return null;
    return importBackground(projectDir, filePaths[0]);
  });

  ipcMain.handle('background:url', (_e, value) => {
    const file = resolveBackgroundFile(getProjectDir(), value);
    return file ? pathToFileURL(file).href : null;
  });
}

module.exports = {
  registerBackgroundIpc, resolveBackgroundFile, importBackground, validateImagePath, IMAGE_EXTENSIONS
};
