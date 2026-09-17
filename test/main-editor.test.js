'use strict';
// Drives src/main/main.js directly, with 'electron' replaced by an in-memory
// mock, so the editor-scoping (Finding 1), partial-export-cleanup (Finding
// 3), and quit-with-in-flight-export (Finding 4) fixes can be exercised as
// real code paths -- not just reasoned about -- without an actual Electron
// process or a live screen recording.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const electronPath = require.resolve('electron');
const mainPath = require.resolve('../src/main/main');

function installElectronMock() {
  const windows = [];
  const appHandlers = {};
  const ipcHandlers = {};
  const quitCalls = [];
  const shortcuts = new Map();

  class FakeWebContents {
    constructor() {
      this.handlers = {};
      this.listeners = {};
      // webContents.ipc: the hidden export window's own IPC (ipc/export.js).
      this.ipc = {
        handle: (channel, fn) => { this.handlers[channel] = fn; },
        on: (channel, fn) => { this.listeners[channel] = fn; }
      };
    }
    send() {}
    on() {}
  }

  class FakeBrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this._closed = false;
      this._listeners = {};
      this.webContents = new FakeWebContents();
      windows.push(this);
    }
    on(evt, cb) { (this._listeners[evt] ||= []).push(cb); return this; }
    once(evt, cb) { this.on(evt, cb); return this; }
    loadFile() {}
    show() {}
    showInactive() {}
    hide() {}
    setVisibleOnAllWorkspaces() {}
    setAlwaysOnTop(flag, level, relativeLevel = 0) { this.topLevel = { flag, level, relativeLevel }; }
    setIgnoreMouseEvents() {}
    getMediaSourceId() { return 'window:0:0'; }
    isDestroyed() { return this._closed; }
    destroy() { this.close(); }
    // Fires 'closed' listeners on a later tick, the same way real Electron's
    // window teardown is asynchronous relative to close() returning -- this
    // is exactly the race Finding 1's identity check has to survive.
    close() {
      if (this._closed) return;
      this._closed = true;
      setImmediate(() => {
        for (const cb of this._listeners.closed || []) cb();
      });
    }
  }

  const mock = {
    app: {
      isPackaged: false,
      whenReady: () => new Promise(() => {}), // never resolves: skip startup wiring
      on: (evt, cb) => { (appHandlers[evt] ||= []).push(cb); },
      quit: () => { quitCalls.push(Date.now()); }
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: (channel, fn) => { ipcHandlers[channel] = fn; }
    },
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
    shell: {},
    dialog: { showErrorBox: () => {} },
    globalShortcut: {
      register: (accel, cb) => { shortcuts.set(accel, cb); return true; },
      unregister: (accel) => { shortcuts.delete(accel); },
      unregisterAll: () => { shortcuts.clear(); }
    }
  };

  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: mock };

  return { windows, appHandlers, ipcHandlers, quitCalls, shortcuts };
}

function freshMain() {
  delete require.cache[mainPath];
  const harness = installElectronMock();
  const main = require(mainPath);
  return { main, ...harness };
}

function makeProjectDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loupe-${name}-`));
  const { saveProject, createProject } = require('../src/main/project');
  saveProject(dir, createProject({ width: 100, height: 100 }, { duration: 10 }));
  return dir;
}

test('opening a second editor closes the first and adopts the new directory', () => {
  const { main } = freshMain();
  const dirA = makeProjectDir('a');
  const dirB = makeProjectDir('b');

  const winA = main.__test__.openEditorWindow(dirA);
  assert.strictEqual(main.__test__.editorState().editorDir, dirA);
  assert.strictEqual(main.__test__.editorState().editorWindow, winA);

  const winB = main.__test__.openEditorWindow(dirB);

  // The switch to the new editor must be immediate, not dependent on the
  // old window's async 'closed' event having fired yet.
  assert.strictEqual(main.__test__.editorState().editorDir, dirB);
  assert.strictEqual(main.__test__.editorState().editorWindow, winB);
  assert.notStrictEqual(main.__test__.editorState().editorWindow, winA);
  assert.strictEqual(winA.isDestroyed(), true, 'the stale first editor was told to close');

  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

test('a stale editor closing later does not clobber the live editor', async () => {
  const { main, ipcHandlers } = freshMain();
  const dirA = makeProjectDir('a2');
  const dirB = makeProjectDir('b2');

  fs.writeFileSync(path.join(dirB, 'cursor.bin'), Buffer.alloc(16));
  main.__test__.openEditorWindow(dirA);
  const winB = main.__test__.openEditorWindow(dirB);

  // winA's 'closed' event fires asynchronously (setImmediate in the mock,
  // mirroring real Electron). Let it run.
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(main.__test__.editorState().editorWindow, winB,
    'winA closing later must not null out the live editor');
  assert.strictEqual(main.__test__.editorState().editorDir, dirB);

  // And the live editor's own IPC handlers still operate on its own
  // directory, not the stale one's.
  const loaded = await ipcHandlers['project:load']();
  assert.ok(loaded.sources.main.cursor.includes(path.basename(dirB)), loaded.sources.main.cursor);

  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

test('project:save refuses a malformed zoom and leaves project.json untouched', async () => {
  const { main, ipcHandlers } = freshMain();
  const dir = makeProjectDir('save-guard');
  main.__test__.openEditorWindow(dir);
  const before = fs.readFileSync(path.join(dir, 'project.json'), 'utf8');

  const { project } = await ipcHandlers['project:load']();
  await assert.rejects(async () => ipcHandlers['project:save']({}, {
    ...project, zooms: [{ id: 'z1', source: 'main', start: -Infinity, end: Infinity, level: 2, follow: true, x: 0, y: 0, recorded: false }]
  }));
  main.__test__.projects.flush();
  assert.strictEqual(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'), before);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a rejected export leaves no partial output file behind', async () => {
  const { main, ipcHandlers } = freshMain();
  const dir = makeProjectDir('export-fail');
  main.__test__.openEditorWindow(dir);

  // This project has no raw.mov, so the export is refused before anything
  // is written.
  await assert.rejects(() => ipcHandlers['export:start']({ sender: {} }, { resolution: '1080p', codec: 'h264' }),
    /video file is missing/);

  const files = fs.readdirSync(dir);
  const partials = files.filter((f) => f.endsWith('.part') || /\.(mp4|webm|gif)$/.test(f));
  assert.deepStrictEqual(partials, [], `expected no partial export file, found: ${partials}`);
  assert.strictEqual(main.__test__.exporter.busy(), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('quitting mid-export cancels it and removes the partial file', async () => {
  const { main, appHandlers, windows } = freshMain();
  const dir = makeProjectDir('quit-export');
  main.__test__.openEditorWindow(dir);

  const outPath = path.join(dir, 'export-100x100.mp4');
  const running = main.__test__.exporter.start({}, outPath);
  running.catch(() => {});
  // Wait for the partial file and the hidden export window.
  for (let i = 0; i < 50 && !windows.some((w) => w.opts?.webPreferences?.backgroundThrottling === false); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const exportWin = windows.find((w) => w.opts?.webPreferences?.backgroundThrottling === false);
  assert.ok(exportWin, 'the export runs in a hidden window');
  assert.strictEqual(fs.existsSync(`${outPath}.part`), true);

  let prevented = false;
  const fakeEvent = { preventDefault: () => { prevented = true; } };
  assert.ok(appHandlers['before-quit'] && appHandlers['before-quit'].length > 0);
  appHandlers['before-quit'][0](fakeEvent);
  assert.strictEqual(prevented, true, 'quit must be held off to stop the export cleanly');

  await assert.rejects(running, /cancelled/);
  assert.strictEqual(main.__test__.exporter.busy(), false);
  assert.strictEqual(exportWin.isDestroyed(), true, 'the export window is closed');
  assert.strictEqual(fs.existsSync(`${outPath}.part`), false, 'the partial export must be removed');
  assert.strictEqual(fs.existsSync(outPath), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateStartOptions accepts a well-formed region on a display source', () => {
  const { main } = freshMain();
  const region = { x: 50, y: 60, width: 600, height: 400 };
  const result = main.__test__.validateStartOptions({
    source: 'display:1', width: 1470, height: 956, region
  });
  assert.deepStrictEqual(result.region, region);
});

test('validateStartOptions accepts a well-formed region on a window source', () => {
  const { main } = freshMain();
  // e.g. a browser window minus its toolbar: global points, inside the window.
  const region = { x: 100, y: 180, width: 800, height: 500 };
  const result = main.__test__.validateStartOptions({
    source: 'window:99', width: 1000, height: 700, x: 100, y: 100, region
  });
  assert.deepStrictEqual(result.region, region);
});

test('validateStartOptions rejects a region below the minimum size', () => {
  const { main } = freshMain();
  assert.throws(() => main.__test__.validateStartOptions({
    source: 'display:1', width: 1470, height: 956,
    region: { x: 0, y: 0, width: 2, height: 3 }
  }));
});

test('validateStartOptions leaves region undefined when none was requested', () => {
  const { main } = freshMain();
  const result = main.__test__.validateStartOptions({
    source: 'display:1', width: 1470, height: 956
  });
  assert.strictEqual(result.region, undefined);
});

// ---- region overlay escape hatches ----------------------------------------
// The overlay covers the whole target above every other window. If the bar
// sits underneath it, or nothing dismisses it, the user is locked out of the
// entire screen -- the bug this guards against needed a reboot to escape.

function armWithRectangle() {
  const harness = freshMain();
  const { ipcHandlers, windows } = harness;
  ipcHandlers['bar:arm']({}, { source: 'display:1', width: 1470, height: 956, x: 0, y: 0 });
  const bar = windows.at(-1);
  ipcHandlers['bar:setAreaMode']({}, 'rect');
  const overlay = windows.at(-1);
  assert.notStrictEqual(overlay, bar, 'Rectangle must open the region overlay');
  return { ...harness, bar, overlay };
}

test('the control bar stacks above the region overlay so it stays clickable', () => {
  const { bar, overlay } = armWithRectangle();
  const rank = ({ level, relativeLevel }) => [level === 'screen-saver' ? 1 : 0, relativeLevel];
  const [barLevel, barRel] = rank(bar.topLevel);
  const [ovLevel, ovRel] = rank(overlay.topLevel);
  assert.ok(barLevel > ovLevel || (barLevel === ovLevel && barRel > ovRel),
    `bar ${JSON.stringify(bar.topLevel)} must be above overlay ${JSON.stringify(overlay.topLevel)}`);
});

test('Escape while the area overlay is up acts as Back', async () => {
  const { bar, overlay, shortcuts } = armWithRectangle();
  assert.ok(shortcuts.has('Escape'), 'Escape must be held while the overlay is showing');

  shortcuts.get('Escape')();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(bar.isDestroyed(), 'the bar must close, as Back does');
  assert.ok(overlay.isDestroyed(), 'the overlay must close');
  assert.ok(!shortcuts.has('Escape'), 'Escape must be handed back to other apps');
});

test('Escape is released as soon as the overlay is hidden again', () => {
  const { ipcHandlers, shortcuts } = armWithRectangle();
  ipcHandlers['bar:setAreaMode']({}, 'full');
  assert.ok(!shortcuts.has('Escape'));
});

// ---- editing through project:load / project:save ---------------------------

async function core() {
  return import('../src/core/project.js');
}

test('the editor loads a v1 project as v2 with its cursor track and video as file URLs', async () => {
  const { main, ipcHandlers } = freshMain();
  const { writeCursorTrack } = require('../src/main/project');
  const dir = makeProjectDir('cursor-load');
  writeCursorTrack(dir, [{ t: 0, x: 10, y: 20, shape: 'arrow' }]);
  fs.writeFileSync(path.join(dir, 'raw.mov'), '');
  main.__test__.openEditorWindow(dir);

  const loaded = await ipcHandlers['project:load']();
  assert.strictEqual(loaded.project.version, 2);
  assert.strictEqual(loaded.migrated, true);
  assert.match(loaded.sources.main.cursor, /^file:.*cursor\.bin$/);
  assert.match(loaded.sources.main.video, /^file:.*raw\.mov$/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('an edit saved by the editor reaches project.json once flushed, and closing the editor flushes it', async () => {
  const { main, ipcHandlers } = freshMain();
  const P = await core();
  const dir = makeProjectDir('save-close');
  const win = main.__test__.openEditorWindow(dir);

  const { project } = await ipcHandlers['project:load']();
  const edited = P.setStyle(P.paintSpeed(project, { start: 2, end: 6, rate: 2 }), { cursor: { show: false } });
  await ipcHandlers['project:save']({}, edited);
  win.close();
  await new Promise((resolve) => setImmediate(resolve));

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  assert.strictEqual(saved.version, 2);
  assert.strictEqual(saved.style.cursor.show, false);
  assert.deepStrictEqual(saved.speed.map((s) => [s.start, s.end, s.rate]), [[2, 6, 2]]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('export builds its job from the latest edit, even one still waiting to be saved', async () => {
  const { main, ipcHandlers } = freshMain();
  const P = await core();
  const dir = makeProjectDir('speed-export');
  main.__test__.openEditorWindow(dir);
  const { project } = await ipcHandlers['project:load']();
  await ipcHandlers['project:save']({}, P.paintSpeed(project, { start: 2, end: 6, rate: 2 }));
  // No raw.mov: the job is refused after the flush, which is what is checked.
  await assert.rejects(() => ipcHandlers['export:start']({ sender: {} }, {}), /video file is missing/);
  const { buildJob } = require('../src/main/ipc/export');
  fs.writeFileSync(path.join(dir, 'raw.mov'), '');
  const { job, out } = buildJob(dir, { resolution: '1080p' });
  assert.strictEqual(job.project.version, 2);
  assert.deepStrictEqual(job.project.speed.map((s) => [s.start, s.end, s.rate]), [[2, 6, 2]]);
  assert.strictEqual(path.dirname(out), dir);
  fs.rmSync(dir, { recursive: true, force: true });
});
