'use strict';

// Background music: the chosen song is COPIED into <project>/music/, so the
// project keeps working if the original is moved or deleted, and the
// recordings folder can be zipped up and opened elsewhere.
//
//   'music:choose'           -> { file, name } | null (cancelled)   open dialog, then import
//   'music:import' (absPath) -> { file, name }                     e.g. a file dropped on the editor
//
// `file` is relative to the project folder ("music/Song.mp3"), ready for
// project.audio.music.file.

const fs = require('node:fs');
const path = require('node:path');
const { requireProjectDir, openUnique } = require('./project-files');

const SUBDIR = 'music';
// Keep in sync with MUSIC_EXTENSIONS in src/core/audio/music.js (a test
// checks). Formats Chromium can decode.
const MUSIC_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.wav', '.aif', '.aiff', '.flac', '.ogg', '.opus', '.webm'];
const MAX_BYTES = 1024 * 1024 * 1024;

function validateMusicPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0')
      || !path.isAbsolute(p)) {
    throw new Error('Choose a music file to add.');
  }
  const ext = path.extname(p).toLowerCase();
  if (!MUSIC_EXTENSIONS.includes(ext)) {
    throw new Error('That file type isn’t supported. Try an MP3, M4A, WAV or FLAC file.');
  }
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new Error('That music file can’t be found.');
  }
  if (!st.isFile()) throw new Error('Choose a music file to add.');
  if (st.size === 0) throw new Error('That music file is empty.');
  if (st.size > MAX_BYTES) throw new Error('That music file is too large.');
  return { ext, size: st.size };
}

// File names from the user's disk end up in project.json and in a path;
// keep them readable but strip anything that could confuse either.
function safeStem(p) {
  const stem = path.basename(p, path.extname(p))
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\0-\x1f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 100);
  return stem || 'Music';
}

function importMusic(projectDir, sourcePath) {
  const { ext } = validateMusicPath(sourcePath);
  const dir = path.join(projectDir, SUBDIR);
  const { fd, name } = openUnique(dir, safeStem(sourcePath), ext);
  const dest = path.join(dir, name);
  fs.closeSync(fd);
  try {
    fs.copyFileSync(sourcePath, dest);
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
  return { file: `${SUBDIR}/${name}`, name: path.basename(sourcePath) };
}

function registerMusicIpc({ ipcMain, dialog, BrowserWindow, getProjectDir }) {
  ipcMain.handle('music:import', (_e, sourcePath) =>
    importMusic(requireProjectDir(getProjectDir), sourcePath));

  ipcMain.handle('music:choose', async (e) => {
    const projectDir = requireProjectDir(getProjectDir);
    const win = BrowserWindow.fromWebContents?.(e.sender) ?? undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Add music',
      buttonLabel: 'Add',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: MUSIC_EXTENSIONS.map((x) => x.slice(1)) }]
    });
    if (canceled || !filePaths?.length) return null;
    return importMusic(projectDir, filePaths[0]);
  });
}

module.exports = { registerMusicIpc, importMusic, validateMusicPath, safeStem, MUSIC_EXTENSIONS };
