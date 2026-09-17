'use strict';
// The editor's visual features driven for real (the real editor page and
// preload, real mouse and keys): annotations added from the panel, dragged
// and resized on the preview, typed into in place and moved on the timeline;
// a transition picked on a clip join; the Webcam panel; wallpapers, keyboard
// badges and presets in the Style panel. Checks project.json on disk and the
// preview's pixels; screenshots go to test/e2e/out/editor/visuals-*.png.
//
//   npm run test:e2e:visuals   (runs this after the export checks)
//   electron test/e2e/visuals-editor.e2e.js [--only <words>]

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  openEditor, openLab, makeFixture, readProject, waitFor, sleep, log, argValue, OUT, FIXTURE
} = require('./editor-harness');
const { reserveDuration, durationElement } = require('../../src/main/webm');
const { registerPresetsIpc } = require('../../src/main/ipc/presets');
const { registerBackgroundIpc } = require('../../src/main/ipc/background');
const v1 = require('../../src/main/project');

const MOD = process.platform === 'darwin' ? 'meta' : 'control';
const WEBCAM_OFFSET = 0.5;
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} is not within ${eps} of ${b}`);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ------------------------------------------------------------- the app's wiring (beyond the harness)

let currentDir = null;
let settings = { presets: [], defaultPresetId: null };
registerPresetsIpc({ ipcMain, store: { get: () => settings, patch: (p) => { settings = { ...settings, ...p }; } } });
registerBackgroundIpc({ ipcMain, dialog, BrowserWindow, getProjectDir: () => currentDir });

async function makeWebcam(src) {
  const file = path.join(src, 'webcam.webm');
  if (fs.existsSync(file)) return;
  ipcMain.handle('lab:saveChunks', (_e, name, chunks, durationMs) => {
    const first = reserveDuration(Buffer.from(chunks[0]));
    fs.writeFileSync(file, Buffer.concat([first.chunk, ...chunks.slice(1).map((c) => Buffer.from(c))]));
    if (first.durationOffset !== null) {
      const fd = fs.openSync(file, 'r+');
      fs.writeSync(fd, durationElement(durationMs, first.timecodeScale), 0, 11, first.durationOffset);
      fs.closeSync(fd);
    }
  });
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'visuals-lab-preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false }
  });
  await win.loadFile(path.join(__dirname, 'visuals-lab.html'));
  await waitFor(() => win.webContents.executeJavaScript('window.visualsLabReady === true'), 'the visuals lab');
  await win.webContents.executeJavaScript('window.visualsLab.makeWebcam({ name: "webcam.webm", seconds: 4.2, width: 320, height: 240 })');
  win.destroy();
}

// A recording folder as this version's recorder writes it: a v1 project
// with the v2 source fields (webcam, keyboard shortcuts).
function recording(src, name) {
  const dir = path.join(OUT, 'visuals', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['raw.mp4', 'cursor.bin', 'webcam.webm']) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify([{ t: 1, label: '⌘K' }, { t: 6, label: '⇧⌘P' }]));
  const project = v1.createProject({ kind: 'display', id: 'display:1', title: 'Display', width: FIXTURE.width, height: FIXTURE.height },
    { file: 'raw.mp4', fps: FIXTURE.fps, duration: FIXTURE.duration, hasMicTrack: true });
  project.sources = {
    main: {
      webcam: { file: 'webcam.webm', offset: WEBCAM_OFFSET, width: 320, height: 240 },
      keys: 'keys.json', pauses: [], systemAudio: null
    }
  };
  v1.saveProject(dir, project);
  return dir;
}

// ------------------------------------------------------------- helpers

async function seek(ed, t) {
  await ed.js(`window.__editor.player.seek(${t})`);
  await waitFor(() => ed.js(`(() => { const p = window.__editor.player; const at = window.__editor.store.tl.toSource(p.time);
    const v = p.videos[at.source]; return v.readyState >= 2 && !v.seeking && Math.abs(v.currentTime - at.t) < 0.02; })()`), 'the preview frame');
  await sleep(200);
}

// Window coordinates of a canvas-pixel point on the preview.
async function previewPoint(ed, cx, cy) {
  return ed.js(`(() => { const c = document.getElementById('preview'); const r = c.getBoundingClientRect(); const k = c.width / r.width;
    return { x: Math.round(r.left + ${cx} / k), y: Math.round(r.top + ${cy} / k) }; })()`);
}

async function pixel(ed, cx, cy) {
  return ed.js(`Array.from(document.getElementById('preview').getContext('2d').getImageData(${Math.round(cx)}, ${Math.round(cy)}, 1, 1).data.slice(0, 3))`);
}

// Canvas-pixel geometry of an annotation in the current preview frame.
async function geometry(ed, id) {
  return ed.js(`import('../../core/layers/annotations.js').then((A) => {
    const s = window.__editor.player.state; const a = window.__editor.store.project.annotations.find((q) => q.id === ${JSON.stringify(id)});
    return A.annotationGeometry(document.getElementById('preview').getContext('2d'), s, a); })`);
}

const lastAnnotation = (ed) => ed.js('window.__editor.store.project.annotations.at(-1)');

// ------------------------------------------------------------- the cases

const CASES = [
  ['annotations: add, drag on the preview, type in place, resize, move on the timeline, delete and undo', async (ed, dir) => {
    await ed.clickOn('#tabs .tab[data-panel=annotations]');
    await ed.shot('visuals-01-annotations-panel');
    await seek(ed, 2.2);
    await ed.clickOn('.add-tile[data-type="text"]');
    await ed.settle();
    let text = await lastAnnotation(ed);
    assert.strictEqual(text.type, 'text');
    near(text.start, 2.2, 0.05, 'added at the playhead');
    assert.deepStrictEqual(await ed.js('window.__editor.store.selection'), { kind: 'annotation', id: text.id });
    assert.strictEqual(await ed.js('!document.querySelector(".anno-frame").hidden'), true, 'handles show on the preview');
    await ed.shot('visuals-02-text-added');

    // Drag it down and right on the preview.
    let g = await geometry(ed, text.id);
    const state = await ed.js('({ w: window.__editor.player.state.content.w, h: window.__editor.player.state.content.h })');
    const from = await previewPoint(ed, g.cx, g.cy);
    const to = await previewPoint(ed, g.cx + state.w * 0.2, g.cy + state.h * 0.3);
    await ed.drag(from.x, from.y, to.x, to.y);
    await ed.settle();
    text = readProject(dir).annotations.find((a) => a.id === text.id);
    near(text.x, 0.7, 0.03, 'dragged x');
    near(text.y, 0.44, 0.03, 'dragged y');

    // Double-click to type new words.
    g = await geometry(ed, text.id);
    const mid = await previewPoint(ed, g.cx, g.cy);
    await ed.click(mid.x, mid.y, { clickCount: 1 });
    await ed.click(mid.x, mid.y, { clickCount: 2 });
    await waitFor(() => ed.js('!document.querySelector(".anno-inline").hidden'), 'the inline text box');
    await ed.js('document.querySelector(".anno-inline").select()');
    for (const ch of 'Click Save') await ed.key(ch === ' ' ? 'Space' : ch);
    await ed.shot('visuals-03-typing');
    await ed.key('Return');
    await ed.settle();
    assert.strictEqual(readProject(dir).annotations.find((a) => a.id === text.id).text, 'Click Save');
    // The words are in the picture: the backing is dark behind them.
    g = await geometry(ed, text.id);
    const backing = await pixel(ed, g.box.x + 4, g.cy);
    assert.ok(Math.max(...backing) < 70, `text backing ${backing}`);

    // A box, resized by its corner.
    await ed.clickOn('#tabs .tab[data-panel=annotations]');
    await ed.key('Escape');
    await ed.clickOn('.add-tile[data-type="box"]');
    await ed.settle();
    const box0 = await lastAnnotation(ed);
    g = await geometry(ed, box0.id);
    const corner = await previewPoint(ed, g.box.x + g.box.w, g.box.y + g.box.h);
    const corner2 = await previewPoint(ed, g.box.x + g.box.w * 1.5, g.box.y + g.box.h * 1.25);
    await ed.drag(corner.x, corner.y, corner2.x, corner2.y);
    await ed.settle();
    const box1 = readProject(dir).annotations.find((a) => a.id === box0.id);
    near(box1.w, box0.w * 1.5, 0.02, 'box width');
    near(box1.h, box0.h * 1.25, 0.02, 'box height');
    near(box1.x, box0.x, 1e-6, 'box stays anchored');
    const g1 = await geometry(ed, box0.id);
    const edge = await pixel(ed, g1.box.x, g1.box.y + g1.box.h / 2);
    assert.ok(dist(edge, [255, 214, 10]) < 90, `yellow box edge ${edge}`);
    await ed.shot('visuals-04-box');

    // A hidden area turns what's under it into blocks.
    await ed.key('Escape');
    await ed.clickOn('.add-tile[data-type="blur"]');
    await ed.settle();
    assert.strictEqual((await lastAnnotation(ed)).type, 'blur');

    // Move the box along the timeline by a second.
    const bar = await ed.box(`.anno-bar[data-id="${box0.id}"]`);
    const y = Math.round(bar.y + bar.h / 2);
    const x0 = Math.round(bar.x + bar.w / 2);
    await ed.drag(x0, y, x0 + Math.round((await ed.timelineX(1)) - (await ed.timelineX(0))), y);
    await ed.settle();
    near(readProject(dir).annotations.find((a) => a.id === box0.id).start, box1.start + 1, 0.12, 'moved on the timeline');
    // Its end edge makes it longer.
    const bar2 = await ed.box(`.anno-bar[data-id="${box0.id}"] .handle.end`);
    const y2 = Math.round(bar2.y + bar2.h / 2);
    const before = readProject(dir).annotations.find((a) => a.id === box0.id);
    await ed.drag(Math.round(bar2.x + bar2.w / 2), y2, await ed.timelineX(before.end + 1), y2);
    await ed.settle();
    near(readProject(dir).annotations.find((a) => a.id === box0.id).end, before.end + 1, 0.15, 'longer');
    await ed.shot('visuals-05-timeline');

    // Delete, then undo.
    const count = readProject(dir).annotations.length;
    const moved = await ed.box(`.anno-bar[data-id="${box0.id}"] .anno-bar-label`);
    await ed.click(Math.round(moved.x + moved.w / 2), Math.round(moved.y + moved.h / 2));
    assert.strictEqual(await ed.js('window.__editor.store.selection?.kind'), 'annotation');
    await ed.key('Backspace');
    await ed.settle();
    assert.strictEqual(readProject(dir).annotations.length, count - 1);
    await ed.key('z', [MOD]);
    await ed.settle();
    assert.strictEqual(readProject(dir).annotations.length, count);

    // A title card: full screen in the preview.
    await seek(ed, 0);
    await ed.clickOn('#tabs .tab[data-panel=annotations]');
    await ed.key('Escape');
    await ed.clickOn('.add-tile[data-type="title"]');
    await ed.settle();
    const title = await lastAnnotation(ed);
    assert.strictEqual(title.start, 0);
    await seek(ed, 1.5);
    const titlePixel = await pixel(ed, 6, 6);
    assert.ok(dist(titlePixel, [0x1f, 0x1f, 0x23]) < 12, `title card corner ${titlePixel}`);
    await ed.shot('visuals-06-title');

    // With one selected, the add buttons are still there for the next one,
    // and a click on the empty space beside the preview lets go of it.
    assert.deepStrictEqual(await ed.js('window.__editor.store.selection'), { kind: 'annotation', id: title.id });
    assert.strictEqual(await ed.js('[...document.querySelectorAll(".add-tile")].filter((b) => b.offsetParent).length'), 5, 'add tiles stay visible');
    assert.strictEqual(await ed.js('!!document.querySelector(".anno-back")?.offsetParent'), true, 'a way back to the list');
    const stage = await ed.box('#stage');
    await ed.click(Math.round(stage.x + 8), Math.round(stage.y + stage.h / 2));
    assert.strictEqual(await ed.js('window.__editor.store.selection'), null, 'clicking beside the preview deselects');
    assert.strictEqual(await ed.js('[...document.querySelectorAll(".add-tile")].filter((b) => b.offsetParent).length'), 5);
  }],

  ['style: a background on a recording with no room around it makes some; tabs open at their top', async (ed, dir) => {
    await ed.clickOn('#tabs .tab[data-panel=style]');
    await ed.js('window.__editor.store.apply((p) => ({ ...p, style: { ...p.style, padding: 0, background: { type: "none", value: null } } }))');
    await ed.settle();
    await ed.js('document.querySelector(".panel-body[data-panel=style] .swatch:not(.swatch-none)").scrollIntoView()');
    await ed.clickOn('.panel-body[data-panel=style] .swatch:not(.swatch-none)');
    await ed.settle();
    const style = readProject(dir).style;
    assert.notStrictEqual(style.background.type, 'none');
    assert.ok(style.padding > 0, `padding ${style.padding}: the background shows`);
    await ed.js('document.querySelector(".panel-wrap").scrollTop = 600');
    await ed.clickOn('#tabs .tab[data-panel=audio]');
    assert.strictEqual(await ed.js('document.querySelector(".panel-wrap").scrollTop'), 0, 'Audio opens at its top');
    await ed.shot('visuals-06b-background-room');
  }],

  ['transitions: click the join between clips and pick a crossfade', async (ed, dir) => {
    await seek(ed, 4);
    await ed.key('s');
    await ed.settle();
    assert.strictEqual(readProject(dir).clips.length, 2);
    await ed.clickOn('.tl-join');
    assert.strictEqual(await ed.js('!document.querySelector(".join-menu").hidden'), true, 'the transition menu opens');
    await ed.clickOn('.join-menu button[data-transition="crossfade"]');
    await ed.clickOn('.join-menu button[data-length="1"]');
    await ed.shot('visuals-07-transition-menu');
    await ed.settle();
    const [c1] = readProject(dir).clips;
    assert.deepStrictEqual(readProject(dir).transitions, [{ after: c1.id, type: 'crossfade', duration: 1 }]);
    // Before the join the next clip's first frame blends in: colour 3 and 4.
    await seek(ed, 3.75);
    const s = await ed.js('({ x: window.__editor.player.state.content.x + window.__editor.player.state.content.w * 0.25, y: window.__editor.player.state.content.y + window.__editor.player.state.content.h * 0.2 })');
    const palettes = JSON.parse(fs.readFileSync(path.join(OUT, 'palettes.json'), 'utf8'));
    const want = palettes.a[3].map((v, i) => v * 0.75 + palettes.a[4][i] * 0.25);
    // The held picture arrives once its video has seeked.
    await waitFor(async () => dist(await pixel(ed, s.x, s.y), want) < 35, 'the crossfade in the preview', 8000)
      .catch(async (err) => { throw new Error(`${err.message}: preview ${await pixel(ed, s.x, s.y)}, expected about ${want.map(Math.round)}`); });
    await ed.shot('visuals-08-crossfade');
    // None takes it away (Escape closes the menu left open first).
    await ed.key('Escape');
    assert.strictEqual(await ed.js('document.querySelector(".join-menu").hidden'), true, 'Escape closes the menu');
    await ed.clickOn('.tl-join');
    await ed.clickOn('.join-menu button[data-transition="null"]');
    await ed.settle();
    assert.deepStrictEqual(readProject(dir).transitions, []);
  }],

  ['webcam: the bubble in the preview and its panel', async (ed, dir) => {
    await ed.clickOn('#tabs .tab[data-panel=webcam]');
    assert.strictEqual(await ed.js('document.querySelector(".panel-body[data-panel=webcam] .panel-empty").hidden'), true, 'controls, not the empty state');
    await seek(ed, 2.2);
    const bubbleCentre = async () => ed.js(`import('../../core/layers/webcam.js').then((W) => { const r = W.bubbleRect(window.__editor.player.state); return { x: r.x + r.d / 2, y: r.y + r.d / 2 }; })`);
    await waitFor(async () => {
      const c = await bubbleCentre();
      const palettes = JSON.parse(fs.readFileSync(path.join(OUT, 'palettes.json'), 'utf8'));
      const rgb = await pixel(ed, c.x, c.y);
      // Webcam time 1.7 s: colour 3.
      return dist(rgb, palettes.webcam[3]) < 50;
    }, 'the webcam picture in the bubble', 8000);
    await ed.shot('visuals-09-webcam');
    await ed.clickOn('.corner-btn[data-corner="top-left"]');
    await ed.clickOn('.seg-btn[data-value="rounded"]');
    await ed.settle();
    assert.deepStrictEqual(readProject(dir).style.webcam, { show: true, shape: 'rounded', size: 0.22, corner: 'top-left' });
    const c = await bubbleCentre();
    const size = await ed.js('window.__editor.player.state.size');
    assert.ok(c.x < size.width / 2 && c.y < size.height / 2, 'moved to the top left');
    await ed.shot('visuals-10-webcam-corner');
    await ed.clickOn('.panel-body[data-panel=webcam] .toggle');
    await ed.settle();
    assert.strictEqual(readProject(dir).style.webcam.show, false);
  }],

  ['style: wallpaper, keyboard badges, presets', async (ed, dir) => {
    // Some padding, so the background shows around the recording.
    await ed.js(`(() => { const s = document.querySelector('input[aria-label="Padding"]'); s.value = '0.1';
      s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await ed.clickOn('.swatch-picture[title="Ocean wallpaper"]');
    await ed.settle();
    assert.deepStrictEqual(readProject(dir).style.background, { type: 'image', value: 'wallpaper:ocean' });
    await waitFor(async () => {
      const rgb = await pixel(ed, 4, 4);
      return rgb[2] > 60 && rgb[2] > rgb[0];
    }, 'the wallpaper in the preview');
    // Badges: on by default for a recording with shortcuts.
    assert.strictEqual(readProject(dir).style.keystrokes?.show ?? (await ed.js('window.__editor.store.project.style.keystrokes.show')), true);
    await seek(ed, 1.4);
    await ed.js('document.querySelector(".panel-wrap").scrollTop = 0');
    await ed.shot('visuals-11-style-wallpaper-badge');
    const st = await ed.js('({ size: window.__editor.player.state.size, unit: window.__editor.player.state.unit, content: window.__editor.player.state.content })');
    const badgeTop = st.content.y + st.content.h - 36 * st.unit - 42 * st.unit * 1.8;
    const badge = await pixel(ed, st.content.x + st.content.w / 2, badgeTop + 6 * st.unit);
    assert.ok(Math.max(...badge) < 60, `a dark badge ${badge}`);

    // Save as a preset, change the look, apply the preset again.
    await ed.clickOn('.preset-save + .btn, .panel-body[data-panel=style] .btn.wide');
    await ed.js('document.querySelector(".preset-save input").focus()');
    for (const ch of 'Ocean') await ed.key(ch);
    await ed.key('Return');
    await waitFor(() => settings.presets.length === 1, 'the preset saved');
    assert.strictEqual(settings.presets[0].name, 'Ocean');
    await waitFor(() => ed.js('document.querySelectorAll(".preset-row").length === 1'), 'the preset listed');
    await ed.clickOn('.swatch[title="Gradient 2"]');
    await ed.settle();
    assert.strictEqual(readProject(dir).style.background.type, 'gradient');
    await ed.clickOn('.preset-apply');
    await ed.settle();
    assert.deepStrictEqual(readProject(dir).style.background, { type: 'image', value: 'wallpaper:ocean' });
    await ed.clickOn('.preset-default');
    await waitFor(() => settings.defaultPresetId === settings.presets[0].id, 'the default preset');
    await waitFor(() => ed.js('document.querySelector(".preset-default").classList.contains("on")'), 'the star');
    await ed.shot('visuals-12-presets');
    // Badges off.
    await ed.js('document.querySelector(".panel-wrap").scrollTop = 10000');
    const toggles = await ed.js('Array.from(document.querySelectorAll(".panel-body[data-panel=style] .toggle .label")).map((l) => l.textContent)');
    const i = toggles.indexOf('Show keyboard shortcuts');
    assert.ok(i >= 0, 'the keyboard toggle is there');
    await ed.js(`document.querySelectorAll(".panel-body[data-panel=style] .toggle")[${i}].scrollIntoView()`);
    await ed.clickOn(`.panel-body[data-panel=style] .panel-section:last-child .toggle`);
    await ed.settle();
    assert.strictEqual(readProject(dir).style.keystrokes.show, false);
  }]
];

async function main() {
  const labWin = await openLab();
  const src = await makeFixture(labWin);
  await makeWebcam(src);
  const webcamColours = await (async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'visuals-lab-preload.js'), sandbox: true } });
    await win.loadFile(path.join(__dirname, 'visuals-lab.html'));
    await waitFor(() => win.webContents.executeJavaScript('window.visualsLabReady === true'), 'the visuals lab');
    const c = await win.webContents.executeJavaScript('window.visualsLab.WEBCAM_COLOURS');
    win.destroy();
    return c;
  })();
  fs.writeFileSync(path.join(OUT, 'palettes.json'), JSON.stringify({ a: labWin.palettes.a, webcam: webcamColours }));
  for (const f of fs.readdirSync(OUT)) if (/^visuals-.*\.png$/.test(f)) fs.rmSync(path.join(OUT, f));
  const only = argValue('--only');
  let n = 0;
  let failed = 0;
  for (const [i, [title, fn]] of CASES.entries()) {
    if (only && !title.includes(only)) continue;
    n++;
    const dir = recording(src, `case-${i + 1}`);
    currentDir = dir;
    const ed = await openEditor(dir);
    try {
      await waitFor(() => ed.js('Object.values(window.__editor.player.videos).every((v) => v.readyState >= 2)'), 'the video');
      await fn(ed, dir);
      const errors = ed.errors.filter((e) => !/Electron Security Warning|willReadFrequently/.test(e));
      assert.deepStrictEqual(errors, [], 'no errors in the editor console');
      log(`ok ${n} - ${title}`);
    } catch (err) {
      failed++;
      await ed.shot(`visuals-fail-${i + 1}`).catch(() => {});
      log(`not ok ${n} - ${title}\n  ${String(err.stack ?? err).split('\n').slice(0, 5).join('\n  ')}`);
    } finally {
      ed.close();
    }
  }
  log(`# ${n - failed}/${n} passed; screenshots in test/e2e/out/editor/visuals-*.png`);
  return failed ? 1 : 0;
}

app.whenReady().then(main).then(
  (code) => app.exit(code),
  (err) => { log(`not ok - ${err.stack ?? err}`); app.exit(1); }
);
