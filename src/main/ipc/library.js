'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The recordings library: every project folder in the recordings folder, and
// what the Library window can do to one (open, rename, duplicate, reveal,
// move to the Trash).
//
// The renderer names a recording by its folder name (`id`), never by a path,
// and every id is resolved here to a real directory directly inside the
// recordings folder -- after following symlinks -- that holds a project.json.
// So a hostile or buggy renderer can't rename, copy, reveal or trash anything
// else on the disk.

const THUMB = 'thumb.jpg';
const MAX_TITLE = 120;
// Export outputs are big and can be made again; a duplicate doesn't need them.
const ABANDONED_COPY_MS = 60 * 60 * 1000;
const SKIP_ON_DUPLICATE = /^export-.*\.(mp4|mov|webm|gif)$/i;

function defaultTitle(createdAt, locale) {
  const when = new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(createdAt));
  return `Recording ${when}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Write-then-rename, so a crash mid-write can't leave a truncated project.
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const finite = (n) => (Number.isFinite(n) && n >= 0 ? n : null);

// Length in seconds. v2: the clips in order (before speed changes -- the
// timeline module owns that maths, and the library only needs a rough
// length). v1: the capture's duration.
function projectDuration(project) {
  if (project.version === 2) {
    if (Array.isArray(project.clips) && project.clips.length) {
      const sum = project.clips.reduce((s, c) => s + Math.max(0, (c?.end ?? 0) - (c?.start ?? 0)), 0);
      if (Number.isFinite(sum)) return sum;
    }
    return finite(project.sources?.main?.duration);
  }
  return finite(project.capture?.duration);
}

// The main recording's video file, or null.
function projectVideo(dir, project) {
  let file = null;
  if (project.version === 2) {
    const main = project.sources?.main;
    if (typeof main?.video === 'string') {
      const base = typeof main.dir === 'string' ? path.resolve(dir, main.dir) : dir;
      file = path.resolve(base, main.video);
    }
  } else if (project.capture) {
    file = path.join(dir, typeof project.capture.file === 'string' ? path.basename(project.capture.file) : 'raw.mov');
  }
  return file && fs.existsSync(file) ? file : null;
}

function projectSize(project) {
  const s = project.version === 2 ? project.sources?.main : project.source;
  return { width: finite(s?.width), height: finite(s?.height) };
}

// A recording folder's name is the time it was made (Date.now()); v2
// projects also record createdAt. Either beats the folder's file dates,
// which a copy or a sync tool may have changed.
function createdAtOf(id, project, stat) {
  if (Number.isFinite(project.createdAt) && project.createdAt > 0) return project.createdAt;
  if (/^\d{12,14}$/.test(id)) return Number(id);
  return stat.birthtimeMs || stat.mtimeMs;
}

function validTitle(title) {
  if (typeof title !== 'string') throw new Error('The name must be text.');
  const clean = title.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length > MAX_TITLE) throw new Error(`Names can be up to ${MAX_TITLE} characters.`);
  return clean;
}

// `root` is a function returning the recordings folder, so a change of
// folder in Settings applies straight away. `locale` (a string, or a function
// for one) should be app.getLocale(): the windows format dates with it, while
// the main process's own Intl default follows the system region instead, so
// without it a title could read "06:06 pm" above a date line saying "18:06".
// Makes sure the recordings folder exists and can be written to, and returns
// its real path. A folder chosen in Settings can be on a drive that has since
// been unplugged, or one the user no longer has access to; the raw "EACCES:
// permission denied, mkdir" means nothing to most people, so say what it is.
function usableFolder(folder) {
  try {
    fs.mkdirSync(folder, { recursive: true });
    fs.accessSync(folder, fs.constants.W_OK);
    return fs.realpathSync(folder);
  } catch {
    throw new Error(`Loupe can't use the recordings folder ${folder}. If it's on a drive, connect it; or choose another folder in Settings.`);
  }
}

function createLibrary({ root, locale, now = Date.now, createThumbnail }) {
  const rootReal = () => usableFolder(root());
  const copying = new Set();

  // The directory for `id`, or an error. See the note at the top.
  function resolve(id) {
    if (typeof id !== 'string' || !/^[^/\\\0]{1,255}$/.test(id) || id === '.' || id === '..') {
      throw new Error('That recording could not be found.');
    }
    const base = rootReal();
    let real;
    try {
      real = fs.realpathSync(path.join(base, id));
    } catch {
      throw new Error('That recording could not be found.');
    }
    if (path.dirname(real) !== base || !fs.statSync(real).isDirectory()
        || !fs.existsSync(path.join(real, 'project.json'))) {
      throw new Error('That recording could not be found.');
    }
    return real;
  }

  function entry(id, dir) {
    const stat = fs.statSync(dir);
    const project = readJson(path.join(dir, 'project.json'));
    const createdAt = createdAtOf(id, project, stat);
    const custom = typeof project.title === 'string' && project.title.trim() ? project.title.trim() : null;
    const thumb = path.join(dir, THUMB);
    let thumbUrl = null;
    try {
      // The modification time in the URL makes the window reload a thumbnail
      // that was regenerated, instead of showing its cached copy.
      thumbUrl = `${pathToFileURL(thumb).href}?v=${Math.round(fs.statSync(thumb).mtimeMs)}`;
    } catch { /* not generated yet */ }
    return {
      id,
      title: custom ?? defaultTitle(createdAt, typeof locale === 'function' ? locale() : locale),
      customTitle: Boolean(custom),
      createdAt,
      duration: projectDuration(project),
      ...projectSize(project),
      hasVideo: Boolean(projectVideo(dir, project)),
      thumbnail: thumbUrl
    };
  }

  function list() {
    const base = rootReal();
    const out = [];
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const dir = path.join(base, d.name);
      if (!fs.existsSync(path.join(dir, 'project.json'))) continue;
      try {
        out.push(entry(d.name, dir));
      } catch (err) {
        // One unreadable project mustn't hide all the others.
        console.warn(`Loupe: skipped recording ${d.name}:`, err.message);
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  // Makes thumb.jpg once (from the video, via the OS's own thumbnailer) and
  // returns its URL, or null when there's no video to take a picture of.
  async function thumbnail(id) {
    const dir = resolve(id);
    const thumb = path.join(dir, THUMB);
    if (!fs.existsSync(thumb)) {
      const video = projectVideo(dir, readJson(path.join(dir, 'project.json')));
      if (!video || !createThumbnail) return null;
      const jpeg = await createThumbnail(video);
      if (!jpeg) return null;
      fs.writeFileSync(thumb, jpeg);
    }
    return entry(id, dir).thumbnail;
  }

  // An empty name puts back the date-based one.
  function rename(id, title) {
    const dir = resolve(id);
    const clean = validTitle(title);
    const file = path.join(dir, 'project.json');
    const project = readJson(file);
    if (clean) project.title = clean;
    else delete project.title;
    writeJson(file, project);
    return entry(id, dir);
  }

  // The copy is made in a hidden folder (list() skips dot folders) and only
  // renamed into place once complete: a big recording takes a while to copy,
  // and a half-copied one must never show up in the Library, be opened, or
  // collide with a second Duplicate pressed before the first one finished.
  async function duplicate(id) {
    const dir = resolve(id);
    const base = rootReal();
    sweepAbandonedCopies(base);
    const source = entry(id, dir);
    let work;
    for (let n = 0; ; n++) {
      work = path.join(base, `.copying-${now()}-${n}`);
      try {
        fs.mkdirSync(work);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    // cp wants a target that doesn't exist yet; `work` only reserves the name.
    const target = path.join(work, 'copy');
    let copyId;
    copying.add(work);
    try {
      await fs.promises.cp(dir, target, {
        recursive: true, errorOnExist: true, force: false,
        filter: (src) => src === dir || !(path.dirname(src) === dir && SKIP_ON_DUPLICATE.test(path.basename(src)))
      });
      const file = path.join(target, 'project.json');
      const project = readJson(file);
      project.title = `${source.title} copy`.slice(0, MAX_TITLE);
      // The copy keeps the original's date, so it sorts next to it.
      project.createdAt = source.createdAt;
      writeJson(file, project);
      // Picked only now, and renamed in the same synchronous step, so two
      // duplicates finishing together can't pick the same name.
      let stamp = now();
      while (fs.existsSync(path.join(base, String(stamp)))) stamp++;
      copyId = String(stamp);
      fs.renameSync(target, path.join(base, copyId));
    } catch (err) {
      if (err.code === 'ENOSPC') throw new Error('There isn’t enough free space on the disk to make a copy.');
      // Moved to the Trash (or its drive unplugged) while it was being copied.
      if (err.code === 'ENOENT') throw new Error('That recording was moved or deleted while it was being copied.');
      throw err;
    } finally {
      copying.delete(work);
      fs.rmSync(work, { recursive: true, force: true });
    }
    return entry(copyId, path.join(base, copyId));
  }

  // A copy cut short by Loupe quitting or crashing leaves its hidden folder
  // behind -- possibly gigabytes nobody can see. Any that isn't being made
  // right now and is over an hour old is removed (the age guards a second
  // copy of Loupe that might still be working on one).
  function sweepAbandonedCopies(base) {
    let names = [];
    try { names = fs.readdirSync(base); } catch { return; }
    for (const name of names) {
      const m = /^\.copying-(\d+)-\d+$/.exec(name);
      const full = path.join(base, name);
      if (!m || copying.has(full) || now() - Number(m[1]) < ABANDONED_COPY_MS) continue;
      try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* try again next time */ }
    }
  }

  return { root, resolve, list, thumbnail, rename, duplicate };
}

// ~/Movies/Loupe rather than /Users/name/Movies/Loupe on macOS; Windows
// people read full paths.
function displayPath(p, home = os.homedir(), platform = process.platform) {
  if (platform === 'win32' || !home) return p;
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

// IPC for the Library window. `openEditor(dir)` is main.js's
// openEditorWindow; `showPicker()` brings up the source picker;
// `editorDir()` is the folder open in the editor right now, or null;
// `focusEditor()` brings that editor to the front; `openBlocked()` is a
// plain-words reason another recording can't be opened right now (a
// recording or an export in progress), or null. `beforeEditorChange(dir)`
// and `editorRenamed(dir, title)` run around a rename of the recording open
// in the editor: the editor's own save waiting to be written goes first, and
// the editor is then told the new name, so its next save doesn't put the
// old one back.
function registerLibraryIpc({
  ipcMain, electron, library, openEditor, showPicker, editorDir = () => null,
  focusEditor = () => {}, openBlocked = () => null,
  beforeEditorChange = () => {}, editorRenamed = () => {}
}) {
  const { shell, dialog, BrowserWindow } = electron;

  const sameFolder = (a, b) => {
    try {
      return fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
      return false;
    }
  };

  ipcMain.handle('library:list', () => {
    const root = library.root();
    return { root, displayRoot: displayPath(root), recordings: library.list() };
  });
  ipcMain.handle('library:thumbnail', (_e, id) => library.thumbnail(id));
  // Opening replaces the editor, and closing an editor stops its export; so
  // the recording already open is only brought to the front, and another one
  // waits until a recording or export in progress has finished.
  ipcMain.handle('library:open', (_e, id) => {
    const dir = library.resolve(id);
    const open = editorDir();
    if (open && sameFolder(open, dir)) {
      focusEditor();
      return;
    }
    const blocked = openBlocked();
    if (blocked) throw new Error(blocked);
    openEditor(dir);
  });
  ipcMain.handle('library:rename', (_e, id, title) => {
    const dir = library.resolve(id);
    const open = editorDir();
    const inEditor = Boolean(open && sameFolder(open, dir));
    if (inEditor) beforeEditorChange(open);
    const renamed = library.rename(id, title);
    if (inEditor) editorRenamed(open, renamed.title);
    return renamed;
  });
  // A copy of the open recording includes the edits still waiting to be written.
  ipcMain.handle('library:duplicate', (_e, id) => {
    const open = editorDir();
    if (open && sameFolder(open, library.resolve(id))) beforeEditorChange(open);
    return library.duplicate(id);
  });
  ipcMain.handle('library:reveal', (_e, id) => { shell.showItemInFolder(library.resolve(id)); });
  ipcMain.handle('library:revealRoot', () => shell.openPath(library.root()));
  ipcMain.handle('library:newRecording', () => { showPicker(); });

  // The confirmation is a native dialog shown from here, not the page, so a
  // recording can't be trashed without the user saying so.
  ipcMain.handle('library:trash', async (e, id) => {
    const dir = library.resolve(id);
    // The editor would go on saving (and exporting) into a folder that is now
    // in the Trash, so it has to be closed first.
    const open = editorDir();
    if (open && sameFolder(open, dir)) {
      throw new Error('This recording is open in the editor. Close the editor, then try again.');
    }
    const { title } = library.list().find((r) => r.id === id) ?? { title: 'this recording' };
    const bin = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';
    const owner = BrowserWindow.fromWebContents(e.sender);
    const { response } = await dialog.showMessageBox(owner, {
      type: 'warning',
      message: `Move "${title}" to the ${bin}?`,
      detail: `The recording and everything made from it in its folder go to the ${bin}. You can put it back from there.`,
      buttons: [`Move to ${bin}`, 'Cancel'],
      defaultId: 1,
      cancelId: 1
    });
    if (response !== 0) return { trashed: false };
    await shell.trashItem(dir);
    return { trashed: true };
  });
}

module.exports = {
  THUMB, MAX_TITLE, createLibrary, registerLibraryIpc, usableFolder,
  defaultTitle, projectDuration, projectVideo, displayPath
};
