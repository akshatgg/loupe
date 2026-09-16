'use strict';
// The whole app, start to finish, the way a person uses it: the real main.js
// with the built helpers (npm run build:native first). Picks the display in
// the picker and presses Continue, presses Start on the bar, records about
// five seconds of a window changing colour, stops, and checks that the editor
// opens on the new version-2 project and the Library lists it with a picture.
// Then edits in the editor with real mouse and keys -- trims the end, adds a
// zoom, undoes and redoes from the Edit menu, adds a second recording from the
// Library -- exports an MP4 and checks the file. Screenshots go to
// test/e2e/out/app-flow/ for a look.
//
// Settings and recordings live in a temporary folder, never the user's own.
//
//   node_modules/.bin/electron test/e2e/app-flow.e2e.js
// Needs Screen Recording for the shell running it (Accessibility for zoom).
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const electron = require('electron');

const { app, BrowserWindow, Menu } = electron;
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out', 'app-flow');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-flow-')));
const home = path.join(work, 'home');
const userData = path.join(work, 'userData');
fs.mkdirSync(home);
fs.mkdirSync(userData);
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', userData);
os.homedir = () => home;
// Quick and quiet: no countdown, camera or computer sound; a default preset
// so the new project's look can be checked.
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  countdown: false, systemAudio: false, recordCamera: false, showKeystrokes: true,
  presets: [{ id: 'p_flowtest', name: 'Flow', style: { background: { type: 'color', value: '#224466' }, padding: 0.08 } }],
  defaultPresetId: 'p_flowtest'
}));

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

async function waitFor(what, fn, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const pageOf = (name) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() &&
  w.webContents.getURL().includes(`/renderer/${name}/`));
const js = (win, code) => win.webContents.executeJavaScript(code);
async function shot(win, name) {
  await sleep(300);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
}
const readProject = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));

// Something to record: a window that changes colour every half second.
async function colourWindow() {
  const win = new BrowserWindow({ x: 120, y: 120, width: 700, height: 500, show: true, title: 'Colours' });
  await win.loadURL(`data:text/html,${encodeURIComponent(`<body style="margin:0;height:100vh">
    <script>const c=['#e53935','#43a047','#1e88e5','#fdd835'];let i=0;
    setInterval(()=>{document.body.style.background=c[i++%4]},500);document.body.style.background=c[0];</script>`)}`);
  return win;
}

// One recording through the picker and the bar. Returns its folder.
async function record(seconds) {
  const picker = await waitFor('the picker', () => pageOf('picker'));
  if (!picker.isVisible()) picker.show();
  await waitFor('the picker to load', () => !picker.webContents.isLoading());
  await waitFor('the sources', () => js(picker, `document.querySelectorAll('#list li[role=option]').length > 0`), 30000);
  // The Entire screen tab is first; pick the first display and Continue.
  await js(picker, `document.querySelector('#list li[role=option]').click()`);
  await waitFor('Continue to be enabled', () => js(picker, `!document.getElementById('record').disabled`));
  await js(picker, `document.getElementById('record').click()`);
  const bar = await waitFor('the bar', () => pageOf('bar'));
  await waitFor('the bar to load', () => !bar.webContents.isLoading());
  await waitFor('the Start button', () => js(bar, `!document.getElementById('armed').hidden`));
  const started = await js(bar, 'window.loupe.startRecording()');
  assert.ok(started.dir, 'recording started');
  await waitFor('the bar to show recording', () => js(bar, `!document.getElementById('recording').hidden`));
  await sleep(seconds * 1000);
  // Not awaited in the page: the bar closes as part of stopping.
  await js(bar, 'document.getElementById("stop") ? document.getElementById("stop").click() : window.loupe.stopRecording(); 0');
  return started.dir;
}

async function editorReady() {
  const editor = await waitFor('the editor', () => pageOf('editor'), 30000);
  await waitFor('the editor to load', () => js(editor, 'document.body.dataset.ready === "true"'), 30000);
  return editor;
}

function mouse(win) {
  const send = (e) => win.webContents.sendInputEvent(e);
  return {
    async drag(x0, y0, x1, y1, steps = 14) {
      send({ type: 'mouseMove', x: x0, y: y0 });
      send({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        send({ type: 'mouseMove', x: Math.round(x0 + ((x1 - x0) * i) / steps), y: Math.round(y0 + ((y1 - y0) * i) / steps), modifiers: ['leftButtonDown'] });
        await sleep(16);
      }
      send({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1 });
      await sleep(150);
    },
    async key(keyCode, modifiers = []) {
      send({ type: 'keyDown', keyCode, modifiers });
      if (keyCode.length === 1) send({ type: 'char', keyCode, modifiers });
      send({ type: 'keyUp', keyCode, modifiers });
      await sleep(80);
    }
  };
}

async function box(win, selector) {
  return js(win, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
}

async function run() {
  for (const name of ['capture', 'inputtap', 'sources']) {
    if (!fs.existsSync(path.join(ROOT, 'bin', name))) throw new Error(`bin/${name} missing: npm run build:native`);
  }
  const colours = await colourWindow();
  require('../../src/main/main');

  let firstDir;
  await check('picker: the display, Continue, Start; about five seconds; Stop', async () => {
    const picker = await waitFor('the picker', () => pageOf('picker'));
    await waitFor('the picker to load', () => !picker.webContents.isLoading());
    assert.strictEqual(picker.getTitle(), 'New recording');
    await waitFor('the sources', () => js(picker, `document.querySelectorAll('#list li[role=option]').length > 0`), 30000);
    await js(picker, `document.querySelector('#list li[role=option]').click()`);
    await shot(picker, '01-picker');
    colours.focus();
    firstDir = await record(5);
    assert.ok(firstDir.startsWith(path.join(home, 'Movies', 'Loupe')), firstDir);
  });

  let editor;
  await check('the editor opens on the new version-2 project, in front of the picker', async () => {
    editor = await editorReady();
    const project = readProject(firstDir);
    assert.strictEqual(project.version, 2);
    const main = project.sources.main;
    assert.ok(main.duration > 4 && main.duration < 8, `duration ${main.duration}`);
    assert.strictEqual(main.keys, 'keys.json', 'keystrokes were on');
    assert.deepStrictEqual(project.clips.map((c) => c.source), ['main']);
    assert.deepStrictEqual(project.style.background, { type: 'color', value: '#224466' }, 'the default preset');
    assert.strictEqual(project.style.padding, 0.08);
    const picker = pageOf('picker');
    assert.ok(!picker || !picker.isVisible(), 'the picker stays out of the way');
    const inEditor = await js(editor, 'window.__editor.store.project.title');
    assert.strictEqual(inEditor, project.title);
    await waitFor('the window title', () => editor.getTitle() === project.title);
    // The preview draws the recording: not all one colour.
    await waitFor('the preview', () => js(editor, `(() => { const c = document.getElementById('preview');
      const d = document.createElement('canvas'); d.width = 64; d.height = 40;
      const x = d.getContext('2d'); x.drawImage(c, 0, 0, 64, 40); const px = x.getImageData(0, 0, 64, 40).data;
      const seen = new Set(); for (let i = 0; i < px.length; i += 4) seen.add((px[i] >> 4) + ',' + (px[i + 1] >> 4) + ',' + (px[i + 2] >> 4));
      return seen.size > 6; })()`), 20000);
    await waitFor('the first-run card', () => js(editor, 'window.__editor.firstRun.open'));
    await waitFor('pictures along the clip', () => js(editor, 'document.querySelectorAll(".clip-strip img").length >= 3'), 20000);
    await shot(editor, '02-editor-opened');
  });

  await check('the Library lists it with a picture and opens it in the editor', async () => {
    Menu.getApplicationMenu().getMenuItemById('open-recordings').click();
    const library = await waitFor('the Library', () => pageOf('library'));
    await waitFor('the recording in the Library', () => js(library,
      `document.querySelector('.card[data-id="${path.basename(firstDir)}"] img')?.naturalWidth > 0`), 20000);
    await shot(library, '03-library');
    assert.ok(fs.existsSync(path.join(firstDir, 'thumb.jpg')));
  });

  await check('first-run card: "Got it" dismisses it for good', async () => {
    editor.focus();
    await js(editor, 'document.querySelector(".first-run .btn").click()');
    assert.strictEqual(await js(editor, 'Boolean(document.querySelector(".first-run"))'), false);
    assert.strictEqual(await js(editor, 'window.__editor.firstRun.show()'), false, 'not shown again');
  });

  const m = mouse(editor);
  await check('trim the end by dragging the clip edge', async () => {
    const before = await js(editor, 'window.__editor.store.tl.duration');
    const clip = await box(editor, '.clip .handle.end');
    const to = await js(editor, `Math.round(window.__editor.timeline.clientX(${before - 1}))`);
    await m.drag(Math.round(clip.x + clip.w / 2), Math.round(clip.y + clip.h / 2), to, Math.round(clip.y + clip.h / 2));
    const after = await js(editor, 'window.__editor.store.tl.duration');
    assert.ok(Math.abs(before - 1 - after) < 0.15, `trimmed ${before} -> ${after}`);
  });

  await check('add a zoom with Z at the playhead', async () => {
    await js(editor, 'window.__editor.player.seek(1)');
    await js(editor, 'document.activeElement?.blur()');
    await m.key('z');
    const zooms = await js(editor, 'window.__editor.store.project.zooms.length');
    assert.ok(zooms >= 1, 'a zoom was added');
    await shot(editor, '04-trimmed-and-zoomed');
  });

  await check('Edit > Undo and Redo from the app menu go to the editor', async () => {
    editor.show();
    editor.focus();
    await waitFor('the editor to be in front', () => BrowserWindow.getFocusedWindow() === editor, 5000);
    const zooms = await js(editor, 'window.__editor.store.project.zooms.length');
    Menu.getApplicationMenu().getMenuItemById('undo').click();
    await waitFor('undo', async () => (await js(editor, 'window.__editor.store.project.zooms.length')) === zooms - 1);
    Menu.getApplicationMenu().getMenuItemById('redo').click();
    await waitFor('redo', async () => (await js(editor, 'window.__editor.store.project.zooms.length')) === zooms);
    Menu.getApplicationMenu().getMenuItemById('keyboard-shortcuts').click();
    await waitFor('the cheat sheet', () => js(editor, 'window.__editor.cheat.open'));
    await js(editor, 'window.__editor.cheat.toggle()');
  });

  let secondDir;
  await check('a second recording, then Add recording puts it after the first', async () => {
    // Finish the first editor's save, then record again from the menu.
    await js(editor, 'window.__editor.saver.flush()');
    const firstEditor = editor;
    Menu.getApplicationMenu().getMenuItemById('new-recording').click();
    colours.focus();
    secondDir = await record(3);
    await waitFor('the first editor to close', () => firstEditor.isDestroyed());
    editor = await editorReady();
    // Open the first recording again from the Library, then add the second.
    const library = pageOf('library');
    await js(library, `window.loupe.library.open(${JSON.stringify(path.basename(firstDir))})`);
    await waitFor('the second editor to close', () => editor.isDestroyed());
    editor = await editorReady();
    assert.strictEqual(await js(editor, 'window.__editor.store.project.clips.length'), 1);
    const duration = await js(editor, 'window.__editor.store.tl.duration');
    await js(editor, 'document.getElementById("addRecBtn").click()');
    await waitFor('the recordings list', () => js(editor, 'document.querySelectorAll(".rec-row").length === 1'));
    await waitFor('its picture', () => js(editor, 'document.querySelector(".rec-row img")?.naturalWidth > 0'), 20000);
    await shot(editor, '05-add-recording');
    await js(editor, 'document.querySelector(".rec-row").click()');
    await waitFor('the second clip', () => js(editor, 'window.__editor.store.project.clips.length === 2'));
    const project = await js(editor, 'window.__editor.store.project');
    assert.strictEqual(project.clips[1].source, 'src2');
    assert.strictEqual(project.sources.src2.dir, secondDir);
    const total = await js(editor, 'window.__editor.store.tl.duration');
    assert.ok(Math.abs(total - duration - project.sources.src2.duration) < 0.05, `${duration} + second = ${total}`);
    await js(editor, 'window.__editor.timeline.fit()');
    await waitFor('pictures on both clips', () => js(editor,
      '[...document.querySelectorAll(".clip")].every((c) => c.querySelectorAll(".clip-strip img").length > 0)'), 20000);
    await js(editor, 'window.__editor.saver.flush()');
    await shot(editor, '06-two-recordings');
  });

  await check('export an MP4 of the edit and check the file', async () => {
    const expected = await js(editor, 'window.__editor.store.tl.duration');
    const result = await js(editor, 'window.loupe.exportVideo({ resolution: "720p" })');
    assert.ok(fs.existsSync(result.file), result.file);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format',
      '-show_streams', result.file], { encoding: 'utf8' }));
    const video = probe.streams.find((s) => s.codec_type === 'video');
    const seconds = Number(probe.format.duration);
    console.log(`  exported ${path.basename(result.file)}: ${video.width}x${video.height}, ${seconds.toFixed(2)} s (timeline ${expected.toFixed(2)} s)`);
    assert.strictEqual(video.codec_name, 'h264');
    assert.strictEqual(video.height, 720);
    assert.ok(Math.abs(seconds - expected) < 0.25, `length ${seconds} vs ${expected}`);
    // Frames from each recording, for a look: the preset's colour around the picture.
    for (const [name, at] of [['07-export-first', 1.5], ['08-export-second', expected - 1]]) {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', result.file, '-frames:v', '1', path.join(OUT, `${name}.png`)]);
    }
    const saved = readProject(firstDir);
    assert.deepStrictEqual(saved.clips.map((c) => c.source), ['main', 'src2'], 'the saved project has both');
  });

  await check('windows remember where they were', async () => {
    const library = pageOf('library');
    library.setBounds({ x: 200, y: 140, width: 900, height: 640 });
    library.close();
    await waitFor('window-state.json', () => {
      const state = JSON.parse(fs.readFileSync(path.join(userData, 'window-state.json'), 'utf8'));
      return state.library?.width === 900 && state.library.x === 200;
    });
    Menu.getApplicationMenu().getMenuItemById('open-recordings').click();
    const again = await waitFor('the Library again', () => pageOf('library'));
    const b = again.getBounds();
    assert.deepStrictEqual([b.x, b.y, b.width, b.height], [200, 140, 900, 640]);
  });

  colours.destroy();
  console.log(`\n${passed} passed. Screenshots: ${OUT}`);
  fs.rmSync(work, { recursive: true, force: true });
}

app.whenReady().then(run).then(() => app.exit(0), (err) => {
  console.error(err);
  app.exit(1);
});
