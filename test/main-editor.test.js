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
    send() {}
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

// A fake helper child matching the shape stopHelper() (helpers.js) expects:
// kill(), 'close'/'exit' listeners, exitCode/signalCode, __loupeClosed.
function fakeChild() {
  const listeners = {};
  return {
    __loupeClosed: false,
    exitCode: null,
    signalCode: null,
    killedWith: null,
    kill(sig) {
      this.killedWith = sig;
      this.exitCode = 0;
      setImmediate(() => { for (const cb of listeners.close || []) cb(0); });
    },
    once(evt, cb) { (listeners[evt] ||= []).push(cb); }
  };
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
  assert.strictEqual(loaded.dir, dirB);

  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

test('project:deleteZoom rejects a malformed segment and leaves keyframes untouched', async () => {
  const { main, ipcHandlers } = freshMain();
  const { saveProject, createProject, loadProject } = require('../src/main/project');
  const dir = makeProjectDir('deletezoom-guard');
  const project = createProject({ width: 100, height: 100 }, { duration: 10 });
  project.zoomKeyframes = [
    { t: 1, zoom: 2, cx: 0, cy: 0 },
    { t: 5, zoom: 1, cx: 0, cy: 0 }
  ];
  saveProject(dir, project);
  main.__test__.openEditorWindow(dir);

  // The exact attack from the finding: {start: -Infinity, end: Infinity}
  // would wipe every keyframe via deleteSegment if it reached it unvalidated.
  // project:deleteZoom throws synchronously (validateSegment runs before any
  // await); wrap in an async function so assert.rejects sees a rejection
  // rather than a synchronous throw.
  await assert.rejects(async () => ipcHandlers['project:deleteZoom']({}, { start: -Infinity, end: Infinity }));

  const after = loadProject(dir);
  assert.deepStrictEqual(after.zoomKeyframes, project.zoomKeyframes);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a rejected export leaves no partial output file behind', async () => {
  const { main, ipcHandlers } = freshMain();
  const dir = makeProjectDir('export-fail');
  main.__test__.openEditorWindow(dir);

  // Stub out spawnHelper's binary invocation indirectly isn't possible
  // without touching helpers.js, so instead drive the failure path the same
  // way export:start's own executor does: call the handler, then simulate
  // the underlying render helper failing before it produces output. This
  // project has no raw.mov, so the render helper fails (or, without a built
  // bin/render, spawnHelper's ENOENT path does) -- exercise that directly.
  await assert.rejects(() => ipcHandlers['export:start']({}, { preset: '1080p', codec: 'h264' }));

  const files = fs.readdirSync(dir);
  const partials = files.filter((f) => f.startsWith('export-'));
  assert.deepStrictEqual(partials, [], `expected no partial export file, found: ${partials}`);
  assert.strictEqual(main.__test__.editorState().exportChild, null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('quitting mid-export stops the render helper and unlinks the partial file', async () => {
  const { main, appHandlers } = freshMain();
  const dir = makeProjectDir('quit-export');
  main.__test__.openEditorWindow(dir);

  const outPath = path.join(dir, 'export-100x100.mp4');
  fs.writeFileSync(outPath, 'partial data');
  const child = fakeChild();
  main.__test__.setExportState(child, outPath);

  let prevented = false;
  const fakeEvent = { preventDefault: () => { prevented = true; } };
  assert.ok(appHandlers['before-quit'] && appHandlers['before-quit'].length > 0);
  appHandlers['before-quit'][0](fakeEvent);

  assert.strictEqual(prevented, true, 'quit must be held off to stop the export cleanly');
  assert.strictEqual(main.__test__.editorState().exportChild, null);

  // Wait for stopHelper()'s kill -> 'close' -> unlink chain to finish.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.strictEqual(child.killedWith, 'SIGTERM', 'the render helper must be asked to stop');
  assert.strictEqual(fs.existsSync(outPath), false, 'the orphaned partial export must be removed');

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

// ---- cursor visibility ------------------------------------------------------

test('the editor gets the cursor track so its preview can draw the cursor', async () => {
  const { main, ipcHandlers } = freshMain();
  const { writeCursorTrack } = require('../src/main/project');
  const dir = makeProjectDir('cursor-load');
  writeCursorTrack(dir, [{ t: 0, x: 10, y: 20, shape: 'arrow' }, { t: 0.5, x: 30, y: 40, shape: 'ibeam' }]);
  main.__test__.openEditorWindow(dir);

  const loaded = await ipcHandlers['project:load']();
  assert.deepStrictEqual(loaded.cursor, [{ t: 0, x: 10, y: 20 }, { t: 0.5, x: 30, y: 40 }]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('turning the cursor off is saved to the project, which the export reads', async () => {
  const { main, ipcHandlers } = freshMain();
  const { loadProject } = require('../src/main/project');
  const dir = makeProjectDir('cursor-toggle');
  main.__test__.openEditorWindow(dir);

  const update = await ipcHandlers['project:setShowCursor']({}, false);
  assert.strictEqual(update.project.settings.showCursor, false);
  assert.strictEqual(loadProject(dir).settings.showCursor, false);

  await ipcHandlers['project:setShowCursor']({}, true);
  assert.strictEqual(loadProject(dir).settings.showCursor, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('project:setShowCursor refuses anything but a boolean', async () => {
  const { main, ipcHandlers } = freshMain();
  const { loadProject } = require('../src/main/project');
  const dir = makeProjectDir('cursor-bad');
  main.__test__.openEditorWindow(dir);

  for (const bad of ['false', 0, null, undefined, {}]) {
    await assert.rejects(async () => ipcHandlers['project:setShowCursor']({}, bad), undefined, String(bad));
  }
  assert.strictEqual(loadProject(dir).settings.showCursor, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- zoom removal can be undone ----------------------------------------------

function makeZoomProjectDir(name) {
  const { saveProject, createProject } = require('../src/main/project');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loupe-${name}-`));
  const project = createProject({ width: 100, height: 100 }, { duration: 10 });
  project.zoomKeyframes = [
    { t: 1, zoom: 3, cx: 50, cy: 50 }, { t: 3, zoom: 1, cx: 50, cy: 50 },
    { t: 5, zoom: 4, cx: 50, cy: 50 }, { t: 7, zoom: 1, cx: 50, cy: 50 }
  ];
  project.recordedZoomKeyframes = project.zoomKeyframes.map((k) => ({ ...k }));
  saveProject(dir, project);
  return { dir, recorded: project.zoomKeyframes };
}

test('a deleted zoom comes back with undo, and all of them with restore -- even after reopening', async () => {
  const { main, ipcHandlers } = freshMain();
  const { loadProject } = require('../src/main/project');
  const { dir, recorded } = makeZoomProjectDir('zoom-undo');
  main.__test__.openEditorWindow(dir);

  const [first, second] = (await ipcHandlers['project:load']()).segments;
  await ipcHandlers['project:deleteZoom']({}, first);
  let update = await ipcHandlers['project:deleteZoom']({}, second);
  assert.strictEqual(update.segments.length, 0);
  assert.strictEqual(loadProject(dir).zoomKeyframes.length, 0);

  update = await ipcHandlers['project:undoZoomDelete']();
  assert.deepStrictEqual(update.segments.map((s) => s.peak), [4], 'the last one removed comes back first');

  // A fresh main process = the editor closed and reopened.
  const reopened = freshMain();
  reopened.main.__test__.openEditorWindow(dir);
  update = await reopened.ipcHandlers['project:restoreZooms']();
  assert.deepStrictEqual(update.segments.map((s) => s.peak), [3, 4]);
  assert.deepStrictEqual(loadProject(dir).zoomKeyframes, recorded);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- speed stretches ---------------------------------------------------------

test('painting a speed over a stretch is saved and shortens the video', async () => {
  const { main, ipcHandlers } = freshMain();
  const { loadProject } = require('../src/main/project');
  const dir = makeProjectDir('speed-paint'); // 10s recording
  main.__test__.openEditorWindow(dir);

  const update = await ipcHandlers['project:paintSpeed']({}, { srcStart: 2, srcEnd: 6, rate: 2 });
  assert.deepStrictEqual(update.project.speedSegments, [{ srcStart: 2, srcEnd: 6, rate: 2 }]);
  assert.ok(update.outputDuration > 8 && update.outputDuration < 8.2, `output ${update.outputDuration}`);
  assert.deepStrictEqual(loadProject(dir).speedSegments, [{ srcStart: 2, srcEnd: 6, rate: 2 }]);

  const loaded = await ipcHandlers['project:load']();
  assert.strictEqual(loaded.outputDuration, update.outputDuration);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a bad speed paint is refused and nothing is saved', async () => {
  const { main, ipcHandlers } = freshMain();
  const { loadProject } = require('../src/main/project');
  const dir = makeProjectDir('speed-bad');
  main.__test__.openEditorWindow(dir);

  await assert.rejects(async () => ipcHandlers['project:paintSpeed']({}, { srcStart: 2, srcEnd: 6, rate: 100 }));
  assert.deepStrictEqual(loadProject(dir).speedSegments, []);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('export hands the renderer the retime plan for the current speed stretches', async () => {
  const { main, ipcHandlers } = freshMain();
  const dir = makeProjectDir('speed-export');
  main.__test__.openEditorWindow(dir);
  await ipcHandlers['project:paintSpeed']({}, { srcStart: 2, srcEnd: 6, rate: 2 });

  // No raw.mov here, so the real render helper fails -- after main has
  // already written what it hands over.
  await assert.rejects(() => ipcHandlers['export:start']({}, { preset: '1080p', codec: 'h264' }));

  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'retime.json'), 'utf8'));
  assert.strictEqual(plan.fps, 60);
  assert.strictEqual(plan.frames.length, Math.ceil(plan.outputDuration * 60 - 1e-6));
  assert.ok(plan.audio.length > 0);
  assert.strictEqual(typeof plan.preservePitch, 'boolean');

  fs.rmSync(dir, { recursive: true, force: true });
});
