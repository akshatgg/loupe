'use strict';
// Harness for the editor's end-to-end tests (editor.js runs them). Tests of the editor window (docs/EDITOR-V2.md section 10). Run with
//
//   npm run test:e2e:editor                      the suite
//   electron test/e2e/editor.js --real <folder>  open a copy of a real recording
//                                                and save screenshots
//
// It opens the real editor page with the app's real preload, and registers
// project:load/save and export:start exactly as main.js does. Fixture
// recordings are made with WebCodecs by the lab page (lab.js). The tests
// press real keys and drag with the real mouse (webContents.sendInputEvent),
// then check project.json on disk, the preview's pixels and the exported
// video. Screenshots of each state go to test/e2e/out/editor/ to look at.

const { BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out', 'editor');
const { createExportRunner, registerExportIpc } = require('../../src/main/ipc/export');
const { createProjectStore, registerProjectIpc } = require('../../src/main/ipc/project');
const v1 = require('../../src/main/project');
const { CURSOR_RECORD_BYTES } = require('../../src/core/cursor.js');

const FIXTURE = { width: 640, height: 400, fps: 30, duration: 8 };

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const log = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------- the app's wiring

const projects = createProjectStore({ delayMs: 50 });
let openDir = null;
const revealed = [];
const runner = createExportRunner({
  BrowserWindow,
  preload: path.join(ROOT, 'src', 'preload', 'exporter.js'),
  page: path.join(ROOT, 'src', 'renderer', 'exporter', 'index.html')
});
registerProjectIpc({ ipcMain, store: projects, projectDir: () => openDir });
registerExportIpc({
  ipcMain, runner, projectDir: () => openDir, beforeStart: () => projects.flush(),
  shell: { showItemInFolder: (f) => revealed.push(f) }
});

async function waitFor(fn, what, timeout = 10000) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(40);
  }
}

async function openEditor(dir, { width = 1280, height = 840 } = {}) {
  projects.flush();
  openDir = dir;
  const win = new BrowserWindow({
    width, height, show: true, x: 40, y: 40, title: 'Loupe — Edit', backgroundColor: '#121214',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'preload.js'), sandbox: true, contextIsolation: true,
      backgroundThrottling: false
    }
  });
  const errors = [];
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') errors.push(e.message);
    if (process.env.EDITOR_LOG) log(`  [editor] ${e.message}`);
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'editor', 'index.html'));
  const js = (code) => win.webContents.executeJavaScript(code);
  await waitFor(() => js('document.body.dataset.ready === "true" || !document.getElementById("fatal").hidden'), 'the editor to load');
  win.focus();
  win.webContents.focus();

  const e = {
    win, js, errors,
    async shot(name) {
      await sleep(250);
      const image = await win.webContents.capturePage();
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
      return path.join(OUT, `${name}.png`);
    },
    async key(keyCode, modifiers = []) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      if (keyCode.length === 1 || keyCode === 'Space') {
        win.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Space' ? ' ' : keyCode, modifiers });
      }
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      await sleep(60);
    },
    async click(x, y, { clickCount = 1 } = {}) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount });
      await sleep(80);
    },
    async drag(x0, y0, x1, y1, steps = 12) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: x0, y: y0 });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        const x = Math.round(x0 + ((x1 - x0) * i) / steps);
        const y = Math.round(y0 + ((y1 - y0) * i) / steps);
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y, modifiers: ['leftButtonDown'] });
        await sleep(16);
      }
      win.webContents.sendInputEvent({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1 });
      await sleep(120);
    },
    // Centre (or a point) of the first element matching a selector, in window coordinates.
    async box(selector) {
      const r = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
      assert.ok(r, `no element ${selector}`);
      return r;
    },
    async clickOn(selector, opts) {
      const r = await e.box(selector);
      await e.click(Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2), opts);
    },
    project: () => js('window.__editor.store.project'),
    // x (window coordinates) of output time t on the timeline.
    timelineX: (t) => js(`Math.round(window.__editor.timeline.clientX(${t}))`),
    async settle() {
      // Wait for the preview's frame and a saved project.
      await js('window.__editor.saver.flush()');
      await sleep(120);
      projects.flush();
    },
    close: () => { projects.flush(); win.destroy(); }
  };
  return e;
}

const readProject = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));

// ------------------------------------------------------------- fixtures

async function openLab() {
  ipcMain.handle('lab:save', (_e, name, bytes) => {
    const file = path.join(OUT, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  });
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'lab-preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false }
  });
  await win.loadFile(path.join(__dirname, 'lab.html'));
  await waitFor(() => win.webContents.executeJavaScript('window.labReady === true'), 'the lab page');
  const call = (fn, ...args) => win.webContents.executeJavaScript(`window.lab.${fn}(...${JSON.stringify(args)})`);
  const palettes = await win.webContents.executeJavaScript('window.lab.PALETTES');
  return { win, call, palettes };
}

function writeCursor(file, duration) {
  const n = Math.round(duration * 60);
  const buf = Buffer.alloc(n * CURSOR_RECORD_BYTES);
  for (let i = 0; i < n; i++) {
    const t = i / 60;
    buf.writeFloatLE(t, i * 16);
    buf.writeFloatLE(420 + 120 * Math.sin(t), i * 16 + 4);
    buf.writeFloatLE(200 + 120 * Math.sin(t * 0.7), i * 16 + 8);
  }
  fs.writeFileSync(file, buf);
}

async function makeFixture(lab) {
  const src = path.join(OUT, 'fixture');
  if (!fs.existsSync(path.join(src, 'raw.mp4'))) {
    await lab.call('makeRecording', {
      name: 'fixture/raw.mp4', width: FIXTURE.width, height: FIXTURE.height, fps: FIXTURE.fps,
      duration: FIXTURE.duration, codec: 'avc', palette: 'a', sound: { freq: 440, amp: 0.5 }
    });
  }
  writeCursor(path.join(src, 'cursor.bin'), FIXTURE.duration);
  return src;
}

// A fresh recording folder with a v1 project.json, as the recorder writes it.
function freshRecording(src, name) {
  const dir = path.join(OUT, 'cases', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(src, 'raw.mp4'), path.join(dir, 'raw.mp4'));
  fs.copyFileSync(path.join(src, 'cursor.bin'), path.join(dir, 'cursor.bin'));
  const project = v1.createProject({ kind: 'display', id: 'display:1', title: 'Display', width: FIXTURE.width, height: FIXTURE.height },
    { file: 'raw.mp4', fps: FIXTURE.fps, duration: FIXTURE.duration, hasMicTrack: true });
  project.zoomKeyframes = [
    { t: 5, zoom: 1, cx: 320, cy: 200 }, { t: 5.2, zoom: 2, cx: 320, cy: 200 }, { t: 6.5, zoom: 1, cx: 320, cy: 200 }
  ];
  v1.saveProject(dir, project);
  return dir;
}

module.exports = { openEditor, openLab, makeFixture, freshRecording, readProject, waitFor, sleep, log, argValue, OUT, FIXTURE, revealed };

