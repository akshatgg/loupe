'use strict';
// Checks a file path handed over by a renderer before sharing, copying or
// dragging it. The renderer is not a trust boundary: without this a
// compromised page could upload or put any file on the clipboard, so only
// existing, absolute, regular files of the kinds Loupe exports get through --
// and, in the app, only files Loupe itself exported (createExportedFiles).
const fs = require('node:fs');
const path = require('node:path');

const EXPORT_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.gif': 'image/gif'
};

class FileCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// `isExported(resolvedPath)`, when given, must also say yes: main passes the
// list of exports it made, so a page can't share or copy some other video
// (or anything at all dressed up with a video extension).
function checkExportedFile(filePath, { fsImpl = fs, isExported = null } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096 ||
      filePath.includes('\0') || !path.isAbsolute(filePath)) {
    throw new FileCheckError('invalid', 'That file can’t be used.');
  }
  const resolved = path.resolve(filePath);
  const contentType = EXPORT_TYPES[path.extname(resolved).toLowerCase()];
  if (!contentType) {
    throw new FileCheckError('unsupported', 'Only exported videos and GIFs can be used here.');
  }
  let stat;
  try {
    stat = fsImpl.statSync(resolved);
  } catch {
    throw new FileCheckError('missing', 'The exported file can’t be found. It may have been moved or deleted.');
  }
  if (!stat.isFile()) {
    throw new FileCheckError('missing', 'The exported file can’t be found. It may have been moved or deleted.');
  }
  if (isExported && !isExported(resolved)) {
    throw new FileCheckError('unsupported', 'Only videos exported from Loupe can be used here.');
  }
  return { path: resolved, size: stat.size, contentType, name: path.basename(resolved) };
}

// The files Loupe has exported: the ones finished while the app runs, plus
// the open recording's earlier exports (`recent()`, from exports.json, which
// main only ever names plain files in the recording's own folder). A path
// counts when it IS one of them -- compared after resolving links, and never
// through a link, so a symlink placed where an export was can't point the
// check at another file.
function createExportedFiles({ recent = () => [], fsImpl = fs } = {}) {
  const made = new Set();
  const real = (p) => {
    try {
      return fsImpl.realpathSync(p);
    } catch {
      return null;
    }
  };

  function remember(file) {
    const r = real(file);
    if (r) made.add(r);
  }

  function isExported(file) {
    let link;
    try {
      link = fsImpl.lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
    if (link) return false;
    const r = real(file);
    if (!r) return false;
    if (made.has(r)) return true;
    return recent().some((f) => real(f) === r);
  }

  const check = (filePath) => checkExportedFile(filePath, { fsImpl, isExported });
  return { remember, isExported, check };
}

module.exports = { checkExportedFile, createExportedFiles, FileCheckError, EXPORT_TYPES };
