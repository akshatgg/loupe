'use strict';

// Voiceover takes recorded in the editor (src/core/audio/voiceover.js records
// them with MediaRecorder). Files live in <project>/voiceover/ and are
// referenced from project.json as "voiceover/Voiceover 2.webm".
//
//   'voiceover:save'   { data: Uint8Array|ArrayBuffer, mimeType } -> { file, bytes }
//   'voiceover:delete' { file } -> { deleted: true }   (discarding a take)

const fs = require('node:fs');
const path = require('node:path');
const { requireProjectDir, resolveProjectFile, openUnique } = require('./project-files');

const SUBDIR = 'voiceover';
// An hour of Opus at 128 kbit/s is ~58 MB; this leaves plenty of room while
// refusing anything absurd before it is written to disk.
const MAX_BYTES = 512 * 1024 * 1024;

// The container is identified from the bytes, not from the renderer's
// mimeType claim, so a file's extension always matches what's inside it.
function containerExtension(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return '.webm';
  }
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return '.ogg';
  }
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return '.m4a';
  }
  return null;
}

function validateVoiceoverPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid voiceover.');
  const { data } = payload;
  let bytes;
  if (data instanceof Uint8Array) bytes = data;
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else throw new Error('Invalid voiceover data.');
  if (bytes.length === 0) throw new Error('The recording is empty.');
  if (bytes.length > MAX_BYTES) throw new Error('The recording is too large.');
  const ext = containerExtension(bytes);
  if (!ext) throw new Error('Unsupported recording format.');
  return { bytes, ext };
}

function saveVoiceover(projectDir, payload) {
  const { bytes, ext } = validateVoiceoverPayload(payload);
  const dir = path.join(projectDir, SUBDIR);
  const { fd, name } = openUnique(dir, 'Voiceover', ext);
  try {
    fs.writeSync(fd, bytes);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(path.join(dir, name), { force: true });
    throw err;
  }
  fs.closeSync(fd);
  return { file: `${SUBDIR}/${name}`, bytes: bytes.length };
}

function deleteVoiceover(projectDir, payload) {
  const full = resolveProjectFile(projectDir, SUBDIR, payload?.file);
  // Only files this module could have written may be deleted.
  if (!/\.(webm|ogg|m4a)$/.test(full)) {
    throw new Error('Invalid file path.');
  }
  fs.rmSync(full, { force: true });
  return { deleted: true };
}

function registerVoiceoverIpc({ ipcMain, getProjectDir }) {
  ipcMain.handle('voiceover:save', (_e, payload) =>
    saveVoiceover(requireProjectDir(getProjectDir), payload));
  ipcMain.handle('voiceover:delete', (_e, payload) =>
    deleteVoiceover(requireProjectDir(getProjectDir), payload));
}

module.exports = {
  registerVoiceoverIpc, validateVoiceoverPayload, saveVoiceover, deleteVoiceover,
  containerExtension, MAX_BYTES
};
