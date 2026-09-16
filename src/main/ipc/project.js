'use strict';
// The editor's project file (docs/EDITOR-V2.md section 3), main-process side.
//
// The editor holds the whole project in memory, makes every edit with the
// pure core (src/core/project.js) and sends the result back here to be kept.
// That replaces v1's one-handler-per-action IPC: there are only two calls,
//
//   project:load -> { project (v2), sources: { [key]: { video, cursor,
//                    systemAudio, missing } } as file:// URLs, migrated }
//   project:save (project) -> { saved: true }
//
// A v1 project.json is migrated in memory on load and written as v2 on the
// first save, so opening an old recording without changing anything leaves
// its file as it was.
//
// Saves are debounced: dragging a zoom's edge sends dozens of projects a
// second and only the last one needs to reach the disk. Each write goes to a
// temporary file that is then renamed over project.json, so a crash or a
// full disk mid-write never leaves a half-written project behind. Export and
// closing the editor flush a pending save first.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SAVE_DELAY_MS = 400;
// A project is a few kilobytes; anything near this is not one.
const MAX_PROJECT_BYTES = 16 * 1024 * 1024;

let core = null;
function loadCore() {
  core ??= require('../../core/project.js');
  return core;
}

// A file named by project.json, which people can edit: it must stay a plain
// relative name inside the recording's folder.
function recordingFile(base, name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) ||
      name.split(/[\\/]/).includes('..')) return null;
  return path.join(base, name);
}

const fileUrl = (file) => (file && fs.existsSync(file) ? pathToFileURL(file).href : null);

// Recordings are saved in a folder named by the moment they started (ms), which
// becomes the default title of a migrated project.
function createdAtFor(dir) {
  const n = Number(path.basename(dir));
  if (Number.isSafeInteger(n) && n > 1e12) return n;
  try {
    return Math.round(fs.statSync(path.join(dir, 'project.json')).birthtimeMs) || null;
  } catch {
    return null;
  }
}

function readProject(dir) {
  const file = path.join(dir, 'project.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(err.code === 'ENOENT'
      ? "This recording's project file is missing."
      : "This recording's project file couldn't be read.");
  }
  const project = loadCore().loadProjectData(raw, { createdAt: createdAtFor(dir) });
  return { project, migrated: raw.version !== project.version };
}

// Everything the editor's preview needs to load, per recording, as file://
// URLs (so Windows paths work). A missing video is reported, not thrown: the
// editor says so in plain words and still shows the rest.
function sourceFiles(dir, project) {
  const out = {};
  for (const [key, meta] of Object.entries(project.sources)) {
    const base = path.resolve(dir, meta.dir ?? '.');
    const video = recordingFile(base, meta.video);
    out[key] = {
      video: fileUrl(video),
      cursor: meta.cursor ? fileUrl(recordingFile(base, meta.cursor)) : null,
      systemAudio: meta.systemAudio ? fileUrl(recordingFile(base, meta.systemAudio)) : null,
      missing: !video || !fs.existsSync(video)
    };
  }
  return out;
}

function writeAtomic(dir, project) {
  const file = path.join(dir, 'project.json');
  const tmp = path.join(dir, `.project.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(project, null, 2)}\n`);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// One store for the app: the project last loaded for a folder, and at most
// one pending (debounced) save.
function createProjectStore({ delayMs = SAVE_DELAY_MS, onError = () => {} } = {}) {
  // dir -> the recordings as loaded. The editor can't change which files a
  // project points at (a renderer that could would be able to make the
  // exporter read any file on disk), so every save keeps these.
  const known = new Map();
  let pending = null; // { dir, project }
  let timer = null;

  function load(dir) {
    if (typeof dir !== 'string' || !dir) throw new Error('There is no recording open.');
    flush();
    const { project, migrated } = readProject(dir);
    known.set(dir, project.sources);
    return { project, sources: sourceFiles(dir, project), migrated };
  }

  // Checks the project now (so the editor hears about a bad one), writes it
  // a moment later.
  function save(dir, raw) {
    if (typeof dir !== 'string' || !dir) throw new Error('There is no recording open.');
    if (!known.has(dir)) throw new Error('Open the recording before saving it.');
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('That is not a project.');
    const size = JSON.stringify(raw).length;
    if (size > MAX_PROJECT_BYTES) throw new Error('That project is too large to save.');
    const project = loadCore().validateProject({ ...raw, version: loadCore().VERSION, sources: known.get(dir) });
    if (pending && pending.dir !== dir) flush();
    pending = { dir, project };
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        flush();
      } catch (err) {
        onError(err);
      }
    }, delayMs);
    return project;
  }

  // Writes the pending save now, if any. Throws if it can't be written.
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!pending) return false;
    const { dir, project } = pending;
    pending = null;
    writeAtomic(dir, project);
    return true;
  }

  // The recordings the open project may use, as loaded plus any added since.
  function sources(dir) {
    return known.get(dir) ?? null;
  }

  // Another recording joins the project in `dir` as `key` (Add recording,
  // ipc/append-recording.js). Only main adds one, from a folder it checked,
  // so the page still can't point the project at other files.
  function addSource(dir, key, meta) {
    if (!known.has(dir)) throw new Error('Open the recording before adding another one to it.');
    known.set(dir, { ...known.get(dir), [key]: meta });
  }

  return { load, save, flush, sources, addSource, pending: () => pending !== null };
}

function registerProjectIpc({ ipcMain, store, projectDir }) {
  ipcMain.handle('project:load', () => store.load(projectDir()));
  ipcMain.handle('project:save', (_e, project) => {
    store.save(projectDir(), project);
    return { saved: true };
  });
}

module.exports = {
  createProjectStore, registerProjectIpc, readProject, sourceFiles, writeAtomic, SAVE_DELAY_MS
};
