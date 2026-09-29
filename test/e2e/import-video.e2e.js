'use strict';
// Importing a video file and cutting it by typed times, in the real app:
// the Library's "Import video" (with the Open dialog answered by the test)
// makes a new project and opens the editor; the Cut box (X) keeps a stretch;
// the export is checked with ffprobe. A phone-style rotated video must
// export upright -- compared with ffmpeg's own upright decoding of the file
// -- and "Choose a video file…" in Add recording puts another one after it.
// Screenshots go to test/e2e/out/import-video/.
//
// Settings and recordings live in a temporary folder, never the user's own.
//
//   node_modules/.bin/electron test/e2e/import-video.e2e.js
// Needs ffmpeg and ffprobe on the PATH.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const electron = require('electron');

const { app, BrowserWindow, Menu } = electron;
const VIDEOS = path.join(__dirname, '..', 'fixtures', 'videos');
const OUT = path.join(__dirname, 'out', 'import-video');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-import-')));
const home = path.join(work, 'home');
const userData = path.join(work, 'userData');
fs.mkdirSync(home);
fs.mkdirSync(userData);
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', userData);
os.homedir = () => home;
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ countdown: false, systemAudio: false, recordCamera: false }));

// The Open dialog answers with whatever the test picks next.
let nextChoice = null;
electron.dialog.showOpenDialog = async () => (nextChoice
  ? { canceled: false, filePaths: [nextChoice] }
  : { canceled: true, filePaths: [] });

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

async function waitFor(what, fn, ms = 20000) {
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
  fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}
const readProject = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
const recordingsRoot = () => path.join(home, 'Movies', 'Loupe');
const folders = () => (fs.existsSync(recordingsRoot()) ? fs.readdirSync(recordingsRoot()).filter((n) => !n.startsWith('.')) : []);

function probe(file) {
  const out = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' }));
  return { seconds: Number(out.format.duration), video: out.streams.find((s) => s.codec_type === 'video'), audio: out.streams.find((s) => s.codec_type === 'audio') };
}

// One frame at `at` seconds as 16x16 grey pixels. ffmpeg turns a rotated
// file upright itself, so it is the reference for "the right way up".
function tinyFrame(file, at) {
  return execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-vf', 'scale=16:16,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
}
const meanDiff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

async function editorReady(previous = null) {
  const editor = await waitFor('the editor', () => {
    const e = pageOf('editor');
    return e && e !== previous ? e : null;
  }, 30000);
  await waitFor('the editor to load', () => js(editor, 'document.body.dataset.ready === "true"'), 30000);
  return editor;
}

async function importFromLibrary(file) {
  const library = await waitFor('the Library', () => pageOf('library'));
  await waitFor('the Library to load', () => !library.webContents.isLoading());
  const before = folders().length;
  nextChoice = file;
  await js(library, 'document.getElementById("importVideo").click()');
  await waitFor('the import', () => folders().length === before + 1);
  const dir = path.join(recordingsRoot(), folders().sort().at(-1));
  return { library, dir };
}

async function exportMp4(editor) {
  await js(editor, 'window.__editor.saver.flush()');
  return js(editor, 'window.loupe.exportVideo({ resolution: "720p" })');
}

async function run() {
  require('../../src/main/main');

  let editor;
  let dir;
  await check('Import video on the New recording screen opens the video in the editor', async () => {
    const picker = await waitFor('the picker', () => pageOf('picker'));
    await waitFor('the picker to load', () => !picker.webContents.isLoading());
    nextChoice = path.join(VIDEOS, 'silent.mov');
    await js(picker, 'document.getElementById("importVideo").click()');
    const opened = await editorReady();
    await waitFor('the picker to close', () => picker.isDestroyed());
    assert.strictEqual(await js(opened, 'window.__editor.store.project.sources.main.kind'), 'file');
    Menu.getApplicationMenu().getMenuItemById('open-recordings').click();
    editor = opened;
  });

  await check('Import video in the Library copies the file into a new project and opens the editor', async () => {
    const previous = editor;
    ({ dir } = await importFromLibrary(path.join(VIDEOS, 'h264-aac.mp4')));
    editor = await editorReady(previous);
    const project = readProject(dir);
    assert.strictEqual(project.sources.main.kind, 'file');
    assert.strictEqual(project.sources.main.video, 'video.mp4');
    assert.strictEqual(project.title, 'h264-aac');
    assert.ok(fs.existsSync(path.join(dir, 'video.mp4')));
    assert.ok(Math.abs(await js(editor, 'window.__editor.store.tl.duration') - 2) < 0.05);
    const library = pageOf('library');
    await waitFor('its card in the Library', () => js(library, `Boolean(document.querySelector('.card[data-id="${path.basename(dir)}"]'))`));
    await shot(library, '01-library');
  });

  await check('X opens the Cut box; "Keep only this part" keeps 0:00.5-0:01.5', async () => {
    editor.focus();
    await js(editor, 'document.activeElement?.blur()');
    editor.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'x' });
    editor.webContents.sendInputEvent({ type: 'char', keyCode: 'x' });
    editor.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'x' });
    await waitFor('the Cut box', () => js(editor, 'document.querySelector(".cut-dialog").open'));
    // A To time past the end is refused in words, and nothing changes.
    await js(editor, `document.getElementById('cutFrom').value = '0:00.5';
      document.getElementById('cutTo').value = '9'; document.getElementById('cutKeep').click()`);
    assert.match(await js(editor, 'document.querySelector(".cut-note").textContent'), /only 0:02 long/);
    await shot(editor, '02-cut-box');
    await js(editor, `document.getElementById('cutTo').value = '1.5'; document.getElementById('cutKeep').click()`);
    assert.strictEqual(await js(editor, 'document.querySelector(".cut-dialog").open'), false);
    const duration = await js(editor, 'window.__editor.store.tl.duration');
    assert.ok(Math.abs(duration - 1) < 0.02, `kept ${duration}`);
    await js(editor, 'window.__editor.store.undo()');
    assert.ok(Math.abs(await js(editor, 'window.__editor.store.tl.duration') - 2) < 0.05, 'one undo step');
    await js(editor, 'window.__editor.store.redo()');
  });

  await check('the playhead moves only while the mouse button is held', async () => {
    await js(editor, 'window.__editor.player.seek(0)');
    const ruler = await js(editor, `(() => { const r = document.querySelector('.tl-ruler').getBoundingClientRect();
      return { y: Math.round(r.y + r.height / 2) }; })()`);
    const xAt = (t) => js(editor, `Math.round(window.__editor.timeline.clientX(${t}))`);
    const send = (e) => editor.webContents.sendInputEvent(e);
    // Press on the ruler at 0.2 s -- and the release never reaches the page
    // (let go outside the window, behind a dialog...).
    const x0 = await xAt(0.2);
    send({ type: 'mouseMove', x: x0, y: ruler.y });
    send({ type: 'mouseDown', x: x0, y: ruler.y, button: 'left', clickCount: 1 });
    await sleep(100);
    const pressedAt = await js(editor, 'window.__editor.player.time');
    // Then the mouse just moves over the clips, no button held.
    const clipsY = await js(editor, `(() => { const r = document.querySelector('.clip').getBoundingClientRect();
      return Math.round(r.y + r.height / 2); })()`);
    for (const t of [0.5, 0.7, 0.9]) {
      send({ type: 'mouseMove', x: await xAt(t), y: clipsY });
      await sleep(40);
    }
    const after = await js(editor, 'window.__editor.player.time');
    assert.ok(Math.abs(after - pressedAt) < 0.02, `the playhead followed the mouse: ${pressedAt.toFixed(2)} -> ${after.toFixed(2)}`);
    send({ type: 'mouseUp', x: await xAt(0.9), y: clipsY, button: 'left', clickCount: 1 });
    await sleep(100);
  });

  await check('dragging a clip edge darkens the part being cut; the timeline closes up on release', async () => {
    const send = (e) => editor.webContents.sendInputEvent(e);
    const clipBox = () => js(editor, `(() => { const r = document.querySelector('.clip').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const before = await clipBox();
    const lengthBefore = await js(editor, 'window.__editor.store.tl.duration');
    const y = Math.round(before.y + before.h / 2);
    const x0 = Math.round(before.x + 4);
    const x1 = Math.round(before.x + before.w * 0.4);
    send({ type: 'mouseMove', x: x0, y });
    send({ type: 'mouseDown', x: x0, y, button: 'left', clickCount: 1 });
    for (let k = 1; k <= 10; k++) {
      send({ type: 'mouseMove', x: Math.round(x0 + ((x1 - x0) * k) / 10), y, modifiers: ['leftButtonDown'] });
      await sleep(20);
    }
    await sleep(150);
    const mid = await clipBox();
    assert.ok(Math.abs(mid.w - before.w) < 1, `the clip keeps its place while dragging: ${before.w} -> ${mid.w}`);
    const shade = await js(editor, `(() => { const el = document.querySelector('.trim-shade.cut');
      return el && { x: el.getBoundingClientRect().x, w: el.getBoundingClientRect().width }; })()`);
    assert.ok(shade && Math.abs(shade.w - (x1 - before.x)) < 8, `the cut part is shaded: ${JSON.stringify(shade)}`);
    const playheadX = await js(editor, `document.querySelector('.tl-playhead').getBoundingClientRect().x`);
    assert.ok(Math.abs(playheadX - x1) < 8, `the playhead is on the edge: ${playheadX} vs ${x1}`);
    const live = await js(editor, 'window.__editor.store.tl.duration');
    assert.ok(live < lengthBefore - 0.2, `the edit is live: ${lengthBefore} -> ${live}`);
    await shot(editor, '03a-trim-drag');
    send({ type: 'mouseUp', x: x1, y, button: 'left', clickCount: 1 });
    await sleep(200);
    const after = await clipBox();
    assert.ok(after.w < before.w - 20, `closed up after release: ${before.w} -> ${after.w}`);
    assert.strictEqual(await js(editor, 'document.querySelectorAll(".trim-shade, .trim-edge").length'), 0);
    await js(editor, 'window.__editor.store.undo()');
    assert.ok(Math.abs(await js(editor, 'window.__editor.store.tl.duration') - lengthBefore) < 0.01, 'one undo step');
  });

  await check('dragging a trimmed clip\u2019s left edge back out shows the footage coming back, with its pictures', async () => {
    // The clip starts 0.5 s into its video (the Cut box kept 0.5-1.5).
    const clip0 = await js(editor, 'window.__editor.store.project.clips[0]');
    assert.strictEqual(clip0.start, 0.5);
    const send = (e) => editor.webContents.sendInputEvent(e);
    const clipBox = () => js(editor, `(() => { const r = document.querySelector('.clip').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const before = await clipBox();
    const pps = (await js(editor, 'window.__editor.timeline.clientX(1)')) - (await js(editor, 'window.__editor.timeline.clientX(0)'));
    const y = Math.round(before.y + before.h / 2);
    const x0 = Math.round(before.x + 3);
    const x1 = Math.round(x0 - pps * 0.4); // 0.4 s out, into the labels' side
    send({ type: 'mouseMove', x: x0, y });
    send({ type: 'mouseDown', x: x0, y, button: 'left', clickCount: 1 });
    for (let k = 1; k <= 10; k++) {
      send({ type: 'mouseMove', x: Math.round(x0 + ((x1 - x0) * k) / 10), y, modifiers: ['leftButtonDown'] });
      await sleep(25);
    }
    await sleep(600); // pictures of the footage coming back
    const mid = await clipBox();
    const shade = await js(editor, `(() => { const el = document.querySelector('.trim-shade.restored');
      return el && { x: el.getBoundingClientRect().x, w: el.getBoundingClientRect().width }; })()`);
    const pictures = await js(editor, `(() => { const c = document.querySelector('.clip'); const s = document.querySelector('.trim-shade.restored');
      if (!s) return 0; const right = s.getBoundingClientRect().right;
      return [...c.querySelectorAll('.clip-strip img')].filter((i) => i.getBoundingClientRect().left < right && i.naturalWidth > 0).length; })()`);
    const playheadX = await js(editor, `document.querySelector('.tl-playhead').getBoundingClientRect().x`);
    console.log(`    clip ${before.w.toFixed(0)} -> ${mid.w.toFixed(0)} px wide; coming back: ${JSON.stringify(shade)}, ${pictures} picture(s) in it`);
    await shot(editor, '03b-restoring');
    assert.ok(mid.w > before.w + pps * 0.3, 'the clip grows as the footage comes back');
    assert.ok(shade && Math.abs(shade.x - mid.x) < 3 && Math.abs(shade.w - pps * 0.4) < pps * 0.08, 'the part coming back is marked at its start');
    assert.ok(pictures >= 1, 'with its own pictures');
    assert.ok(Math.abs(playheadX - mid.x) < 6, 'the playhead on the new first frame');
    send({ type: 'mouseUp', x: x1, y, button: 'left', clickCount: 1 });
    await sleep(200);
    const after = await js(editor, 'window.__editor.store.project.clips[0]');
    assert.ok(Math.abs(after.start - 0.1) < 0.03, `0.4 s of footage back: starts at ${after.start}`);
    assert.strictEqual(await js(editor, 'document.querySelectorAll(".trim-shade").length'), 0, 'the marking goes on release');
    await js(editor, 'window.__editor.store.undo()');
    assert.strictEqual(await js(editor, 'window.__editor.store.project.clips[0].start'), 0.5, 'one undo step');
  });

  await check('the export is the kept second, with the video\'s sound', async () => {
    const result = await exportMp4(editor);
    const { seconds, video, audio } = probe(result.file);
    console.log(`  exported ${video.width}x${video.height}, ${seconds.toFixed(2)} s`);
    assert.ok(Math.abs(seconds - 1) < 0.1, `length ${seconds}`);
    assert.ok(audio, 'has sound');
    assert.strictEqual(video.height, 720);
    // The first exported frame is the source at 0.5 s.
    const diff = meanDiff(tinyFrame(result.file, 0.02), tinyFrame(path.join(VIDEOS, 'h264-aac.mp4'), 0.52));
    assert.ok(diff < 12, `picture matches the source at 0.5 s (diff ${diff.toFixed(1)})`);
  });

  await check('a rotated phone video imports standing up and exports upright', async () => {
    const previous = editor;
    ({ dir } = await importFromLibrary(path.join(VIDEOS, 'rotated.mp4')));
    editor = await editorReady(previous);
    const main = readProject(dir).sources.main;
    assert.deepStrictEqual([main.width, main.height, main.rotation], [90, 160, 270]);
    await shot(editor, '03-rotated-editor');
    const result = await exportMp4(editor);
    const { video } = probe(result.file);
    console.log(`  exported ${video.width}x${video.height}`);
    assert.ok(video.height > video.width, 'portrait');
    const reference = tinyFrame(path.join(VIDEOS, 'rotated.mp4'), 1);
    const upright = meanDiff(tinyFrame(result.file, 1), reference);
    const wrongWay = meanDiff(tinyFrame(result.file, 1), [...reference].reverse());
    console.log(`  difference from upright ${upright.toFixed(1)}, from upside down ${wrongWay.toFixed(1)}`);
    assert.ok(upright < 12 && upright < wrongWay / 2, 'upright like ffmpeg shows it');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', result.file, '-frames:v', '1', path.join(OUT, '04-rotated-export.png')]);
  });

  await check('music: add a song, start it later by typing in its settings, and the export follows', async () => {
    // Only the music: the video's own sound off.
    await js(editor, `window.__editor.store.apply((p) => ({ ...p, audio: { ...p.audio, mic: { ...p.audio.mic, muted: true } } }))`);
    await js(editor, 'window.__editor.player.seek(0)');
    nextChoice = path.join(VIDEOS, 'song.m4a');
    await js(editor, 'document.getElementById("addAudioBtn").click()');
    await waitFor('the song as a clip', () => js(editor, 'window.__editor.store.project.audio.clips.length === 1'));
    await waitFor('its settings', () => js(editor, '!document.getElementById("audioInspector").hidden'));
    // Typed: start at 0:00.6, play the song from 0:00.5.
    await js(editor, `(() => { const s = document.getElementById('clipStart'); s.value = '0:00.6';
      s.dispatchEvent(new Event('change')); const f = document.getElementById('clipFrom'); f.value = '0.5';
      f.dispatchEvent(new Event('change')); })()`);
    const clip = await js(editor, 'window.__editor.store.project.audio.clips[0]');
    assert.deepStrictEqual([clip.start, clip.from], [0.6, 0.5]);
    await shot(editor, '04a-music-panel');
    const result = await exportMp4(editor);
    const loud = (from, to) => {
      const out = spawnSync('ffmpeg', ['-v', 'info', '-ss', String(from), '-t', String(to - from),
        '-i', result.file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
      const m = /mean_volume: (-?[\d.]+) dB/.exec(out.stderr);
      return m ? Number(m[1]) : -Infinity;
    };
    const before = loud(0.05, 0.5);
    const after = loud(0.9, 1.9);
    console.log(`  sound before the music ${before} dB, after ${after} dB`);
    assert.ok(before < -60, 'silent before the music starts');
    assert.ok(after > -40, 'music after it starts');
  });

  await check('Add recording > Choose a video file puts another video after this one', async () => {
    await js(editor, 'window.__editor.addRecording.show()');
    nextChoice = path.join(VIDEOS, 'silent.mov');
    await js(editor, 'document.querySelector(".rec-file .btn").click()');
    await waitFor('the second clip', () => js(editor, 'window.__editor.store.project.clips.length === 2'));
    const sources = await js(editor, 'window.__editor.store.project.clips.map((c) => c.source)');
    assert.deepStrictEqual(sources, ['main', 'src2']);
    assert.ok(Math.abs(await js(editor, 'window.__editor.store.tl.duration') - 4) < 0.1);
    await shot(editor, '05-added-file');
    const result = await exportMp4(editor);
    const { seconds } = probe(result.file);
    assert.ok(Math.abs(seconds - 4) < 0.15, `length ${seconds}`);
  });

  console.log(`\n${passed} passed. Screenshots: ${OUT}`);
  fs.rmSync(work, { recursive: true, force: true });
}

app.whenReady().then(run).then(() => app.exit(0), (err) => {
  console.error(err);
  app.exit(1);
});
