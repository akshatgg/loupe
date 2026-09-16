'use strict';
// Checks a file path handed over by a renderer before sharing, copying or
// dragging it. The renderer is not a trust boundary: without this a
// compromised page could upload or put any file on the clipboard, so only
// existing, absolute, regular files of the kinds Loupe exports get through.
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

function checkExportedFile(filePath, { fsImpl = fs } = {}) {
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
  return { path: resolved, size: stat.size, contentType, name: path.basename(resolved) };
}

module.exports = { checkExportedFile, FileCheckError, EXPORT_TYPES };
