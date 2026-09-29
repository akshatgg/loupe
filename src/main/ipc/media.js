'use strict';

// Pictures and videos for overlays (a logo, B-roll, picture-in-picture):
// the chosen file is checked -- a picture by its first bytes, a video by
// video-probe.js, as Import video does -- and COPIED into <project>/media/.
//
//   'media:choose' -> { file, name, kind, fileDuration, rotation } | null

const fs = require('node:fs');
const path = require('node:path');
const { requireProjectDir, openUnique } = require('./project-files');
const { safeStem } = require('./music');
const { probeVideo } = require('../video-probe');
const { VIDEO_EXTENSIONS } = require('../import-video');

const SUBDIR = 'media';
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;

// A picture's first bytes, by kind.
function looksLikePicture(head, ext) {
  if (ext === '.png') return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === '.jpg' || ext === '.jpeg') return head[0] === 0xff && head[1] === 0xd8;
  return head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP';
}

async function importMedia(projectDir, sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || sourcePath.includes('\0')) {
    throw new Error('Choose a picture or a video.');
  }
  const ext = path.extname(sourcePath).toLowerCase();
  const isImage = IMAGE_EXTENSIONS.includes(ext);
  if (!isImage && !VIDEO_EXTENSIONS.includes(ext)) {
    throw new Error('Overlays can be PNG, JPG or WebP pictures, or MP4 and MOV videos.');
  }
  const st = await fs.promises.stat(sourcePath).catch(() => null);
  if (!st?.isFile()) throw new Error('That file can’t be found.');
  let info = { kind: 'image', fileDuration: null, rotation: 0 };
  if (isImage) {
    if (st.size > MAX_IMAGE_BYTES) throw new Error('That picture is too large.');
    const fd = await fs.promises.open(sourcePath, 'r');
    const head = Buffer.alloc(12);
    try { await fd.read(head, 0, 12, 0); } finally { await fd.close(); }
    if (!looksLikePicture(head, ext)) throw new Error('That file isn’t a picture Loupe can read.');
  } else {
    const probe = await probeVideo(sourcePath); // plain words for anything it can't play
    info = { kind: 'video', fileDuration: probe.duration, rotation: probe.rotation };
  }
  const dir = path.join(projectDir, SUBDIR);
  const stem = safeStem(sourcePath).replace(/^Music$/, 'Media');
  const { fd, name } = openUnique(dir, stem, ext);
  fs.closeSync(fd);
  const dest = path.join(dir, name);
  try {
    await fs.promises.copyFile(sourcePath, dest);
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw new Error('That file couldn’t be copied into the project.', { cause: err });
  }
  return { file: `${SUBDIR}/${name}`, name: path.basename(name, ext), ...info };
}

function registerMediaIpc({ ipcMain, dialog, BrowserWindow, getProjectDir }) {
  ipcMain.handle('media:choose', async (e) => {
    const projectDir = requireProjectDir(getProjectDir);
    const win = BrowserWindow.fromWebContents?.(e.sender) ?? undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Add an overlay', buttonLabel: 'Add', properties: ['openFile'],
      filters: [{ name: 'Pictures and videos', extensions: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].map((x) => x.slice(1)) }]
    });
    if (canceled || !filePaths?.length) return null;
    return importMedia(projectDir, filePaths[0]);
  });
}

module.exports = { registerMediaIpc, importMedia, IMAGE_EXTENSIONS };
