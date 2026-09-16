'use strict';

// Shared by the IPC modules that put files into the open project's folder
// (voiceover takes, imported music). The renderer is not a trust boundary:
// every path it can influence is resolved here and must stay inside the
// project folder.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function requireProjectDir(getProjectDir) {
  const dir = getProjectDir();
  if (typeof dir !== 'string' || !dir) throw new Error('No project is open.');
  return dir;
}

// `rel` must be a plain relative path under `subdir` (e.g. "music/song.mp3"):
// no absolute paths, no "..", no backslashes, nothing outside the folder. No
// colons either: on Windows "voiceover/C:take.webm" is drive-relative and
// quietly names a different file ("take.webm"), and "a:b" is an NTFS stream.
function resolveProjectFile(projectDir, subdir, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512
      || rel.includes('\\') || rel.includes('\0') || rel.includes(':') || path.isAbsolute(rel)) {
    throw new Error('Invalid file path.');
  }
  const parts = rel.split('/');
  if (parts.length !== 2 || parts[0] !== subdir || parts[1] === '' || parts[1] === '.' || parts[1] === '..') {
    throw new Error('Invalid file path.');
  }
  const base = path.resolve(projectDir, subdir);
  const full = path.resolve(base, parts[1]);
  if (path.dirname(full) !== base) throw new Error('Invalid file path.');
  return full;
}

// Opens `<dir>/<stem><ext>`, or `<stem> 2<ext>`, `<stem> 3<ext>`, ... --
// whichever doesn't exist yet -- with O_EXCL so two saves racing can't pick
// the same name. Returns { fd, name }.
function openUnique(dir, stem, ext) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i < 10000; i++) {
    const name = i === 1 ? `${stem}${ext}` : `${stem} ${i}${ext}`;
    try {
      return { fd: fs.openSync(path.join(dir, name), 'wx'), name };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Too many files with the same name.');
}

// The music and voiceover files a project names (audio.music.file,
// audio.voiceover[].file), as file:// URLs for the exporter. project.json can
// be edited by hand, so only files inside the project's own music/ and
// voiceover/ folders are handed out; anything else, or a file that is gone,
// is null and that sound is simply left out of the video.
function audioFileUrls(projectDir, project) {
  const url = (subdir, rel) => {
    try {
      const full = resolveProjectFile(projectDir, subdir, rel);
      return fs.existsSync(full) ? pathToFileURL(full).href : null;
    } catch {
      return null;
    }
  };
  const audio = project?.audio ?? {};
  const voiceover = {};
  for (const take of Array.isArray(audio.voiceover) ? audio.voiceover : []) {
    if (typeof take?.id === 'string') voiceover[take.id] = url('voiceover', take.file);
  }
  return { music: audio.music ? url('music', audio.music.file) : null, voiceover };
}

module.exports = { requireProjectDir, resolveProjectFile, openUnique, audioFileUrls };
