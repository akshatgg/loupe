'use strict';
// "Add recording" in the editor: another recording from the Library played
// after this one (docs/EDITOR-V2.md section 3, `appendRecording`).
//
//   project:recordings                 -> [{ id, title, duration, width, height, thumbnail }]
//                                         the Library's recordings, minus the one open
//   project:recordingThumbnail (id)    -> file:// URL or null (made once, like the Library's)
//   project:appendRecording (id)       -> { key, meta, files, zooms, title }
//
// The page names a recording by its Library id only; main resolves it to a
// folder inside the recordings folder (ipc/library.js), reads that project,
// and adds its main recording to the open project's known sources under a
// new key ("src2", "src3", ...) with an absolute `dir`. The page then makes
// the edit with the core's appendRecording(key, meta), so it is one undo step
// like any other, and saving keeps the recording because main now knows it.

const fs = require('node:fs');
const path = require('node:path');
const { readProject, sourceFiles } = require('./project');

// "src2", "src3", ... -- the first key no source uses yet.
function nextSourceKey(sources) {
  for (let n = 2; ; n++) {
    const key = `src${n}`;
    if (!sources || !Object.hasOwn(sources, key)) return key;
  }
}

const sameFolder = (a, b) => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
};

// The main recording of the project in `otherDir`, ready to join another
// project: its folder made absolute, so it is found wherever that project is.
function recordingToAppend(otherDir) {
  const { project } = readProject(otherDir);
  const main = project.sources.main;
  const meta = { ...main, dir: path.resolve(otherDir, main.dir ?? '.') };
  // The zooms made for that recording come along; edited or recorded, they
  // belong to its picture. Their v1 keyframes are left behind (they replay a
  // recording's own timing, and the editor treats them as plain zooms).
  const zooms = project.zooms
    .filter((z) => z.source === 'main')
    .map(({ start, end, level, follow, x, y }) => ({ start, end, level, follow, x, y }));
  return { meta, zooms, title: project.title };
}

function registerAppendRecordingIpc({ ipcMain, library, store, projectDir }) {
  const others = () => {
    const dir = projectDir();
    return library().list().filter((r) => !(dir && sameFolder(library().resolve(r.id), dir)));
  };

  ipcMain.handle('project:recordings', () => others().filter((r) => r.hasVideo));
  ipcMain.handle('project:recordingThumbnail', (_e, id) => library().thumbnail(id));
  ipcMain.handle('project:appendRecording', (_e, id) => {
    const dir = projectDir();
    if (!dir) throw new Error('There is no recording open.');
    const otherDir = library().resolve(id);
    if (sameFolder(otherDir, dir)) throw new Error('That’s the recording you’re editing.');
    const { meta, zooms, title } = recordingToAppend(otherDir);
    const key = nextSourceKey(store.sources(dir));
    const files = sourceFiles(dir, { sources: { [key]: meta } })[key];
    if (files.missing) throw new Error('That recording’s video file is missing, so it can’t be added.');
    store.addSource(dir, key, meta);
    return { key, meta, files, zooms, title };
  });
}

module.exports = { registerAppendRecordingIpc, nextSourceKey, recordingToAppend };
