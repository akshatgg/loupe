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
    systemPreferences: {},
    shell: {},
    dialog: { showErrorBox: () => {} },
    globalShortcut: { register: () => true, unregisterAll: () => {} }
  };

  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: mock };

  return { windows, appHandlers, ipcHandlers, quitCalls };
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
  // the underlying render helper failing before it produces output. Since
  // bin/render does not exist in this environment, spawnHelper's real
  // ENOENT path already rejects export:start -- exercise that directly.
  await assert.rejects(() => ipcHandlers['export:start']({ preset: '1080p', codec: 'h264' }));

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
