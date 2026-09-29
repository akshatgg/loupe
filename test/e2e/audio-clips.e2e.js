'use strict';
// Songs and sound files as clips on the timeline, the way a video editor
// does it, in the real app with real mouse and keys: the toolbar's Audio
// button adds several files one after another; a song over another goes on
// a new row; blocks are dragged, moved to another row, trimmed at both ends
// and faded with their corner knobs; the Audio panel is the selected clip's
// inspector (volume, fades, typed times, repeat, lower under speech, mute,
// split, duplicate, delete); S splits the selected audio, ⌥-drag copies it,
// Delete removes it, and undo takes every step back. Last, the export: each
// clip is heard where it sits, at its volume, and nowhere else -- and the
// preview's mix sounds the same. Screenshots go to test/e2e/out/audio-clips/.
//
// Settings and recordings live in a temporary folder, never the user's own.
//
//   node_modules/.bin/electron test/e2e/audio-clips.e2e.js
// Needs ffmpeg on the PATH.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const electron = require('electron');

const { app, BrowserWindow } = electron;
const VIDEOS = path.join(__dirname, '..', 'fixtures', 'videos');
const SONG = path.join(VIDEOS, 'song.m4a'); // 4 s of 330 Hz
const BEEP = path.join(VIDEOS, 'beep.m4a'); // 1.5 s of 550 Hz
const CLICKS = path.join(VIDEOS, 'clicks120.m4a'); // 6 s of clicks at 120 BPM
const TALKING = path.join(VIDEOS, 'h264-aac.mp4'); // 2 s video with a 440 Hz sound
const OUT = path.join(__dirname, 'out', 'audio-clips');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-aclips-')));
const home = path.join(work, 'home');
const userData = path.join(work, 'userData');
fs.mkdirSync(home);
fs.mkdirSync(userData);
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', userData);
os.homedir = () => home;
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ countdown: false, systemAudio: false, recordCamera: false }));

// The Open dialog answers with whatever the test picks next (one or more files).
let nextChoice = null;
electron.dialog.showOpenDialog = async () => {
  const files = nextChoice === null ? [] : [].concat(nextChoice);
  return { canceled: !files.length, filePaths: files };
};

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

// Amplitude of `freq` in samples[from, to) seconds (Hann window), or RMS
// without a frequency -- the same measure in the page and here.
const AMPLITUDE = `(left, rate, { freq, from, to }) => {
  const a = Math.round(from * rate), b = Math.round(to * rate);
  if (!freq) { let s = 0; for (let i = a; i < b; i++) s += left[i] * left[i]; return Math.sqrt(s / (b - a)); }
  let re = 0, im = 0, ws = 0;
  for (let i = a; i < b; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - a) / (b - a));
    const ph = 2 * Math.PI * freq * i / rate;
    re += left[i] * w * Math.cos(ph); im += left[i] * w * Math.sin(ph); ws += w;
  }
  return 2 * Math.hypot(re, im) / ws;
}`;
const amplitude = eval(AMPLITUDE);

function exportedSound(file) {
  // The left channel, as the preview's mix is measured (-ac 1 would mix both).
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-af', 'pan=mono|c0=c0', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 64 << 20 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

async function run() {
  require('../../src/main/main');
  const picker = await waitFor('the picker', () => pageOf('picker'));
  await waitFor('the picker to load', () => !picker.webContents.isLoading());
  nextChoice = path.join(VIDEOS, 'video6.mp4');
  await picker.webContents.executeJavaScript('document.getElementById("importVideo").click()');
  const editor = await waitFor('the editor', () => pageOf('editor'), 30000);
  await waitFor('the editor to load', () => editor.webContents.executeJavaScript('document.body.dataset.ready === "true"'), 30000);
  // Playback runs on animation frames, which Chromium pauses in a window
  // hidden behind others (a busy desktop): not while this test watches it.
  editor.webContents.setBackgroundThrottling(false);
  const js = (code) => editor.webContents.executeJavaScript(code);
  const send = (e) => editor.webContents.sendInputEvent(e);
  const shot = async (name) => {
    await sleep(250);
    fs.writeFileSync(path.join(OUT, `${name}.png`), (await editor.webContents.capturePage()).toPNG());
  };
  const clips = () => js('window.__editor.store.project.audio.clips');
  const clip = async (id) => (await clips()).find((c) => c.id === id);
  const xAt = (t) => js(`Math.round(window.__editor.timeline.clientX(${t}))`);
  const box = (selector) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  async function drag(x0, y0, x1, y1, modifiers = []) {
    send({ type: 'mouseMove', x: x0, y: y0 });
    send({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1, modifiers });
    for (let k = 1; k <= 12; k++) {
      send({ type: 'mouseMove', x: Math.round(x0 + ((x1 - x0) * k) / 12), y: Math.round(y0 + ((y1 - y0) * k) / 12), modifiers: ['leftButtonDown', ...modifiers] });
      await sleep(16);
    }
    send({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1, modifiers });
    await sleep(150);
  }
  async function key(keyCode, modifiers = []) {
    await js('document.activeElement?.blur()');
    send({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1) send({ type: 'char', keyCode, modifiers });
    send({ type: 'keyUp', keyCode, modifiers });
    await sleep(120);
  }
  const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
  // Only the songs: the imported video has no sound, and nothing ducks.
  await js('document.querySelector(".first-run .btn")?.click()');

  await check('the Audio button adds two files one after another at the playhead; the last is selected, its settings shown', async () => {
    await js('window.__editor.player.seek(0.5)');
    nextChoice = [SONG, BEEP];
    await js('document.getElementById("addAudioBtn").click()');
    await waitFor('two audio clips', async () => (await clips()).length === 2);
    const [a, b] = await clips();
    assert.deepStrictEqual([a.name, a.lane, b.name, b.lane], ['song', 0, 'beep', 0]);
    near(a.start, 0.5, 0.01, 'the first at the playhead');
    near(a.fileDuration, 4, 0.1, 'its length is known');
    near(b.start, a.start + a.fileDuration, 0.01, 'the second right after it');
    assert.deepStrictEqual(await js('window.__editor.store.selection'), { kind: 'audio', id: b.id });
    assert.strictEqual(await js('!document.getElementById("audioInspector").hidden'), true, 'the inspector shows');
    assert.strictEqual(await js('document.getElementById("clipName").textContent'), 'beep');
    assert.strictEqual(await js('document.querySelectorAll(".aclip").length'), 2);
    assert.strictEqual(await js('document.querySelectorAll("#audioList .audio-row").length'), 2);
    await shot('01-added');
  });

  await check('a song added over another goes on a new row', async () => {
    await js('window.__editor.player.seek(1)');
    nextChoice = SONG;
    await js('document.getElementById("addAudioBtn").click()');
    await waitFor('the third clip', async () => (await clips()).length === 3);
    const c = (await clips())[2];
    assert.strictEqual(c.lane, 1);
    assert.strictEqual(await js('document.querySelectorAll(".lbl-music").length'), 2, 'the timeline shows Audio 2');
    await shot('02-second-row');
  });

  const blockOf = (id) => box(`.aclip[data-id="${id}"]`);
  await check('drag a block along its row, and down onto a new row', async () => {
    const c = (await clips())[2];
    let b = await blockOf(c.id);
    const y = Math.round(b.y + b.h / 2);
    await drag(Math.round(b.x + b.w / 2), y, Math.round(b.x + b.w / 2 + (await xAt(0.6)) - (await xAt(0))), y);
    near((await clip(c.id)).start, 1.6, 0.08, 'moved 0.6 s right');
    assert.strictEqual((await clip(c.id)).lane, 1, 'on its row');
    b = await blockOf(c.id);
    await drag(Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2), Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2 + 34));
    assert.strictEqual((await clip(c.id)).lane, 2, 'dropped on the empty third row');
    near((await clip(c.id)).start, 1.6, 0.08, 'at the same time');
    await key('z', ['meta']);
    assert.strictEqual((await clip(c.id)).lane, 1, 'undo puts it back');
    await shot('03-moved');
  });

  await check('drag the ends to trim and the top corners to fade', async () => {
    const a = (await clips())[0];
    let b = await blockOf(a.id);
    const y = Math.round(b.y + b.h / 2);
    const px = (await xAt(1)) - (await xAt(0));
    // The left end: later start, later into the song, same end.
    await drag(Math.round(b.x + 3), y, Math.round(b.x + 3 + px), y);
    let now = await clip(a.id);
    near(now.start, a.start + 1, 0.08, 'start');
    near(now.from, 1, 0.08, 'song from');
    near(now.start + (now.fileDuration - now.from), a.start + a.fileDuration, 0.02, 'the end stays');
    // The right end: shorter.
    b = await blockOf(a.id);
    await drag(Math.round(b.x + b.w - 3), y, Math.round(b.x + b.w - 3 - px), y);
    now = await clip(a.id);
    near(now.length, 2, 0.1, 'trimmed to 2 s');
    // The fade knobs.
    b = await blockOf(a.id);
    await js(`document.querySelector('.aclip[data-id="${a.id}"]').classList.add('selected')`);
    await drag(Math.round(b.x + 2), Math.round(b.y + 5), Math.round(b.x + 2 + px / 2), Math.round(b.y + 5));
    near((await clip(a.id)).fadeIn, 0.5, 0.1, 'fade in');
    b = await blockOf(a.id);
    await drag(Math.round(b.x + b.w - 3), Math.round(b.y + 5), Math.round(b.x + b.w - 3 - px / 2), Math.round(b.y + 5));
    near((await clip(a.id)).fadeOut, 0.5, 0.1, 'fade out');
    await shot('04-trimmed-and-faded');
  });

  await check('the inspector: volume, fades, typed times, repeat, lower under speech, mute', async () => {
    const a = (await clips())[0];
    await js(`document.querySelector('#audioList .audio-row[data-id="${a.id}"]').click()`);
    assert.deepStrictEqual(await js('window.__editor.store.selection'), { kind: 'audio', id: a.id });
    const setSlider = (id, v) => js(`(() => { const i = document.getElementById('${id}'); i.value = '${v}';
      i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const type = (id, v) => js(`(() => { const i = document.getElementById('${id}'); i.value = '${v}';
      i.dispatchEvent(new Event('change')); })()`);
    await setSlider('clipVolume', 1.5);
    await setSlider('clipFadeIn', 0.2);
    await setSlider('clipFadeOut', 0.3);
    await type('clipStart', '0:00.5');
    await type('clipFrom', '0.5');
    await type('clipLength', '2.5');
    let now = await clip(a.id);
    assert.deepStrictEqual(['volume', 'fadeIn', 'fadeOut', 'start', 'from', 'length'].map((k) => now[k]), [1.5, 0.2, 0.3, 0.5, 0.5, 2.5]);
    assert.strictEqual(await js('document.getElementById("clipLength").value'), '0:02.5');
    await js('document.getElementById("clipLoop").click()');
    now = await clip(a.id);
    assert.deepStrictEqual([now.loop, now.length], [true, null], 'repeats to the end of the video');
    assert.strictEqual(await js('document.getElementById("clipLength").value'), '0:05.5');
    await js('document.getElementById("clipLoop").click()');
    await js('document.getElementById("clipDuck").click()');
    await js('document.getElementById("clipMute").click()');
    now = await clip(a.id);
    assert.deepStrictEqual([now.loop, now.duck, now.muted], [false, false, true]);
    assert.strictEqual(await js(`document.querySelector('.aclip[data-id="${a.id}"]').classList.contains('muted')`), true);
    await js('document.getElementById("clipMute").click()');
    await js('document.querySelector(".panel-wrap").scrollTop = 0');
    await shot('05-inspector');
  });

  await check('S splits the selected audio; Duplicate and ⌥-drag copy it; Delete removes it; undo brings each back', async () => {
    const a = (await clips())[0];
    const before = (await clips()).length;
    await js(`window.__editor.editor.select({ kind: 'audio', id: '${a.id}' }); window.__editor.player.seek(1.5)`);
    const videoClips = await js('window.__editor.store.project.clips.length');
    await key('s');
    let all = await clips();
    assert.strictEqual(all.length, before + 1, 'split in two');
    assert.strictEqual(await js('window.__editor.store.project.clips.length'), videoClips, 'the video is not split');
    const second = all.find((c) => c.id !== a.id && Math.abs(c.start - 1.5) < 1e-6);
    assert.ok(second, 'the second half starts at the playhead');
    near(second.from, a.from + 1, 1e-6, 'and plays on from there');
    await js(`window.__editor.editor.select({ kind: 'audio', id: '${second.id}' })`);
    await js('document.getElementById("duplicateAudio").click()');
    all = await clips();
    assert.strictEqual(all.length, before + 2, 'duplicated');
    const secondEnd = second.start + (second.length ?? second.fileDuration - second.from);
    near(all.at(-1).start, secondEnd, 1e-6, 'the copy right after it');
    // ⌥-drag the beep: a copy moves, the original stays.
    const beep = all.find((c) => c.name === 'beep');
    const b = await blockOf(beep.id);
    const px = (await xAt(0.5)) - (await xAt(0));
    await drag(Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2), Math.round(b.x + b.w / 2 - px), Math.round(b.y + b.h / 2), ['alt']);
    all = await clips();
    assert.strictEqual(all.length, before + 3, 'a copy was made');
    near((await clip(beep.id)).start, beep.start, 1e-6, 'the original stayed');
    // Delete the selected copy.
    await key('Delete');
    assert.strictEqual((await clips()).length, before + 2, 'deleted');
    for (let i = 0; i < 4; i++) await key('z', ['meta']);
    assert.strictEqual((await clips()).length, before + 1, 'undo: delete, copy, duplicate taken back');
    await key('z', ['meta']);
    assert.strictEqual((await clips()).length, before, 'and the split');
    await shot('06-split-copy');
  });

  await check('the export: each clip heard where it sits, at its volume, faded, muted ones silent -- and the preview mix sounds the same', async () => {
    // A known arrangement, set through the inspector's own edits.
    await js(`(() => { const s = window.__editor.store; const P = window.__editor.editor.core;
      s.apply((p) => {
        let q = p;
        for (const c of p.audio.clips) q = P.removeAudioClip(q, c.id);
        const song = p.audio.clips.find((c) => c.name === 'song');
        const beep = p.audio.clips.find((c) => c.name === 'beep');
        q = P.addAudioClip(q, { file: song.file, name: 'song', start: 0.5, fileDuration: song.fileDuration, volume: 1, duck: false, length: 2 });
        q = P.addAudioClip(q, { file: beep.file, name: 'beep', start: 3, fileDuration: beep.fileDuration, volume: 0.5, duck: false });
        q = P.addAudioClip(q, { file: beep.file, name: 'muted beep', start: 0.8, fileDuration: beep.fileDuration, volume: 1, duck: false, muted: true });
        q = P.addAudioClip(q, { file: song.file, name: 'faded', start: 4.6, fileDuration: song.fileDuration, volume: 1, duck: false, length: 1.2, fadeIn: 1 });
        return q;
      });
    })()`);
    // The mix made from this arrangement, not the one before.
    await waitFor('the preview mix of this arrangement',
      () => js('(() => { const a = window.__editor.player.audio; return a.upToDate(window.__editor.store.project) && !a.state.preparing && a.mix !== null; })()'), 60000);
    const windows = [
      { freq: 330, from: 0.1, to: 0.45, name: 'no song before it starts' },
      { freq: 330, from: 0.7, to: 2.3, name: 'the song' },
      { freq: 550, from: 0.9, to: 2.2, name: 'the muted beep (silent)' },
      { freq: 330, from: 2.7, to: 2.95, name: 'no song after its 2 s' },
      { freq: 550, from: 3.2, to: 4.3, name: 'the beep at half volume' },
      { freq: 550, from: 4.7, to: 5.9, name: 'no beep after its 1.5 s' },
      { freq: 330, from: 4.65, to: 4.95, name: 'the faded song, coming up' },
      { freq: 330, from: 5.45, to: 5.75, name: 'the faded song, full' }
    ];
    const preview = await js(`(() => { const m = window.__editor.player.audio.mix; const left = m.getChannelData(0);
      const amp = ${AMPLITUDE}; return ${JSON.stringify(windows)}.map((w) => amp(left, m.sampleRate, w)); })()`);
    await js('window.__editor.saver.flush()');
    const result = await js('window.loupe.exportVideo({ resolution: "720p" })');
    const left = exportedSound(result.file);
    const exported = windows.map((w) => amplitude(left, 48000, w));
    windows.forEach((w, i) => console.log(`    ${w.name}: preview ${preview[i].toFixed(4)}, export ${exported[i].toFixed(4)}`));
    const song = exported[1];
    assert.ok(song > 0.05, 'the song is heard');
    for (const i of [0, 2, 3, 5]) assert.ok(exported[i] < song * 0.05, `${windows[i].name}: ${exported[i]}`);
    near(exported[4] / song, 0.5, 0.08, 'the beep at half the song’s level');
    assert.ok(exported[6] < exported[7] * 0.7, 'the fade in starts quieter');
    windows.forEach((w, i) => assert.ok(Math.abs(preview[i] - exported[i]) <= Math.max(0.006, 0.1 * exported[i]),
      `${w.name}: preview ${preview[i]} vs export ${exported[i]}`));
    await shot('07-arranged');
  });

  // The preview mixes again a moment after an edit: wait until the mix
  // playing is the one made from the project as it is now. (Nothing heard at
  // all is no mix: silence.)
  const freshMix = () => waitFor('the preview mix of this edit',
    () => js('(() => { const a = window.__editor.player.audio; return a.upToDate(window.__editor.store.project) && !a.state.preparing; })()'), 60000);
  const previewAmp = (w) => js(`(() => { const m = window.__editor.player.audio.mix; if (!m) return 0; const amp = ${AMPLITUDE};
    return amp(m.getChannelData(0), m.sampleRate, ${JSON.stringify(w)}); })()`);
  const laneBtn = (lane, key) => js(`document.querySelector('.lane-btn[data-lane="${lane}"][data-key="${key}"]').click()`);
  const lanes = () => js('window.__editor.store.project.audio.lanes');

  await check('row buttons: Mute silences a row, Solo plays only its row, Lock keeps its clips from changing', async () => {
    const song = (await clips()).find((c) => c.name === 'song');
    await laneBtn(0, 'muted');
    assert.strictEqual((await lanes())[0].muted, true);
    assert.strictEqual(await js(`document.querySelector('.aclip[data-id="${song.id}"]').classList.contains('muted')`), true, 'its clips look muted');
    await freshMix();
    assert.ok(await previewAmp({ freq: 330, from: 0.7, to: 2.3 }) < 0.005, 'row 1 muted: no song');
    await laneBtn(0, 'muted');
    // The muted beep on row 2 turned on, then row 2 soloed: only it is heard.
    const mutedBeep = (await clips()).find((c) => c.name === 'muted beep');
    await js(`window.__editor.store.apply((p) => window.__editor.editor.core.updateAudioClip(p, '${mutedBeep.id}', { muted: false }))`);
    await laneBtn(1, 'solo');
    await freshMix();
    assert.ok(await previewAmp({ freq: 330, from: 0.7, to: 2.3 }) < 0.005, 'solo row 2: the song on row 1 is not heard');
    assert.ok(await previewAmp({ freq: 550, from: 0.9, to: 2.2 }) > 0.05, 'the beep on row 2 is');
    await shot('08-solo');
    await laneBtn(1, 'solo');
    // Lock row 1: its song can't be dragged or deleted.
    await laneBtn(0, 'locked');
    const b = await blockOf(song.id);
    await drag(Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2), Math.round(b.x + b.w / 2 + 60), Math.round(b.y + b.h / 2));
    near((await clip(song.id)).start, song.start, 1e-9, 'not moved');
    assert.deepStrictEqual(await js('window.__editor.store.selection'), { kind: 'audio', id: song.id }, 'but selected, to see it');
    assert.strictEqual(await js('!document.querySelector(".locked-note").hidden'), true, 'the panel says why');
    await key('Delete');
    assert.ok(await clip(song.id), 'not deleted');
    await laneBtn(0, 'locked');
    await js(`window.__editor.store.apply((p) => window.__editor.editor.core.updateAudioClip(p, '${mutedBeep.id}', { muted: true }))`);
  });

  await check('the volume line: drag it; ⌥-click adds points, drag one, double-click removes it -- and the export follows', async () => {
    const song = (await clips()).find((c) => c.name === 'song');
    await js(`window.__editor.editor.select({ kind: 'audio', id: '${song.id}' })`);
    let b = await blockOf(song.id);
    const yOf = (g, r = b) => Math.round(r.y + r.h - 2 - (g / 2) * (r.h - 4));
    const xOf = async (t) => Math.round(await xAt(song.start + t));
    // The line at 100%, dragged down to 50%.
    await drag(await xOf(1), yOf(1), await xOf(1), yOf(0.5));
    near((await clip(song.id)).volume, 0.5, 0.05, 'volume from the line');
    // Two points; the second dragged to silence.
    b = await blockOf(song.id);
    for (const t of [0.3, 1.7]) {
      const x = await xOf(t);
      send({ type: 'mouseDown', x, y: yOf(0.5), button: 'left', clickCount: 1, modifiers: ['alt'] });
      send({ type: 'mouseUp', x, y: yOf(0.5), button: 'left', clickCount: 1, modifiers: ['alt'] });
      await sleep(200);
    }
    let pts = (await clip(song.id)).points;
    assert.strictEqual(pts.length, 2, 'two points');
    near(pts[0].t, 0.3, 0.05, 'where clicked');
    near(pts[0].gain, 0.5, 0.05, 'at the line');
    b = await blockOf(song.id);
    await drag(await xOf(1.7), yOf(0.5, b), await xOf(1.7), yOf(0, b));
    pts = (await clip(song.id)).points;
    near(pts[1].gain, 0, 0.03, 'dragged down to nothing');
    await shot('09-volume-points');
    await freshMix();
    await js('window.__editor.saver.flush()');
    const result = await js('window.loupe.exportVideo({ resolution: "720p" })');
    const left = exportedSound(result.file);
    const early = amplitude(left, 48000, { freq: 330, from: song.start + 0.05, to: song.start + 0.3 });
    const late = amplitude(left, 48000, { freq: 330, from: song.start + 1.75, to: song.start + 1.95 });
    const pEarly = await previewAmp({ freq: 330, from: song.start + 0.05, to: song.start + 0.3 });
    console.log(`    before the points: export ${early.toFixed(4)}, preview ${pEarly.toFixed(4)}; after the silent point: ${late.toFixed(4)}`);
    near(early, 0.0625, 0.008, 'half volume before the first point (0.125 × 50%)');
    assert.ok(late < 0.004, 'silent after the point at 0');
    near(pEarly, early, 0.004, 'the preview hears the same');
    // Double-click the first point: gone.
    b = await blockOf(song.id);
    const x0 = await xOf(pts[0].t);
    for (const clickCount of [1, 2]) {
      send({ type: 'mouseDown', x: x0, y: yOf(pts[0].gain, b), button: 'left', clickCount });
      send({ type: 'mouseUp', x: x0, y: yOf(pts[0].gain, b), button: 'left', clickCount });
    }
    await sleep(200);
    assert.strictEqual((await clip(song.id)).points.length, 1, 'double-click removed it');
    await js('document.getElementById("clearVolumePoints").click()');
    assert.strictEqual((await clip(song.id)).points.length, 0, 'Clear points');
  });

  await check('beat marks: a song’s tempo is found, its beats marked, and drags snap to them', async () => {
    await js('window.__editor.player.seek(0)');
    nextChoice = CLICKS;
    const before = (await clips()).length;
    await js('document.getElementById("addAudioBtn").click()');
    await waitFor('the click track', async () => (await clips()).length === before + 1);
    const c = (await clips()).at(-1);
    await js('document.getElementById("clipBeats").click()');
    assert.strictEqual((await clip(c.id)).beats, true);
    const found = await js(`window.__editor.player.audio.file('music', ${JSON.stringify(c.file)}).beats`);
    near(found.bpm, 120, 1, 'tempo');
    const hint = await js('document.getElementById("clipBeats").closest(".toggle").querySelector(".hint").textContent');
    assert.match(hint, /120 BPM/);
    await shot('10-beats');
    // The beep dragged near 2.5 s + 3 ms lands on the beat at ~2.5 s.
    const beep = (await clips()).find((q) => q.name === 'beep');
    const beat = c.start + found.beats.find((t) => t > 2.3 && t < 2.7);
    const bb = await blockOf(beep.id);
    const dx = (await xAt(beat + 0.03)) - (await xAt(beep.start));
    await drag(Math.round(bb.x + 20), Math.round(bb.y + bb.h / 2), Math.round(bb.x + 20 + dx), Math.round(bb.y + bb.h / 2));
    near((await clip(beep.id)).start, beat, 0.002, 'snapped onto the beat');
    await key('z', ['meta']);
    await js(`window.__editor.store.apply((p) => window.__editor.editor.core.removeAudioClip(p, '${c.id}'))`);
  });

  await check('detach: a video clip’s own sound becomes a clip; deleted, only the music is left; put back, it plays again', async () => {
    // A second video, with sound, after this one.
    await js('window.__editor.addRecording.show()');
    nextChoice = TALKING;
    await js('document.querySelector(".rec-file .btn").click()');
    await waitFor('the video with sound', () => js('window.__editor.store.project.clips.length === 2'));
    await js('document.querySelector("dialog.add-recording")?.close()');
    const videoClip = await js('window.__editor.store.project.clips[1]');
    await js(`window.__editor.editor.select({ kind: 'clip', id: '${videoClip.id}' }); window.__editor.editor.showPanel('audio')`);
    assert.strictEqual(await js('document.getElementById("detachAudio").textContent'), 'Detach this clip’s sound');
    await js('document.getElementById("detachAudio").click()');
    const sound = (await clips()).at(-1);
    assert.deepStrictEqual([sound.source, sound.file, sound.start], [videoClip.source, null, 6]);
    assert.strictEqual(await js('window.__editor.store.project.clips[1].detached'), true);
    assert.strictEqual(await js(`document.querySelector('.aclip[data-id="${sound.id}"]').classList.contains('source')`), true);
    // The Sound row no longer draws that clip's waveform.
    const drawn = await js(`(() => { const c = document.querySelector('.tl-audio-canvas'); const r = c.getBoundingClientRect();
      const x = window.__editor.timeline.clientX(7) - r.left; const d = window.devicePixelRatio || 1;
      const px = c.getContext('2d').getImageData(Math.round(x * d), 0, 1, c.height).data;
      let lit = 0; for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0 && px[i] > 90) lit++; return lit; })()`);
    assert.ok(drawn < 4, `no waveform left on the Sound row there (${drawn} bright pixels)`);
    await shot('11-detached');
    const exportLeft = async () => {
      await js('window.__editor.saver.flush()');
      return exportedSound((await js('window.loupe.exportVideo({ resolution: "720p" })')).file);
    };
    let left = await exportLeft();
    const heard = amplitude(left, 48000, { freq: 440, from: 6.3, to: 7.7 });
    assert.ok(heard > 0.02, `the video's sound, from its clip: ${heard}`);
    await js(`window.__editor.editor.select({ kind: 'audio', id: '${sound.id}' })`);
    await key('Delete');
    left = await exportLeft();
    assert.ok(amplitude(left, 48000, { freq: 440, from: 6.3, to: 7.7 }) < heard * 0.05, 'deleted: the video is silent there');
    near(amplitude(left, 48000, { freq: 330, from: 0.7, to: 2.3 }), 0.0625, 0.01, 'the music plays on');
    await key('z', ['meta']);
    await js(`window.__editor.editor.select({ kind: 'audio', id: '${sound.id}' })`);
    await js('document.getElementById("reattachAudio").click()');
    assert.strictEqual(await js('window.__editor.store.project.clips[1].detached'), false, 'back on the video');
    assert.ok(!(await clip(sound.id)), 'its clip is gone');
    left = await exportLeft();
    near(amplitude(left, 48000, { freq: 440, from: 6.3, to: 7.7 }), heard, heard * 0.1, 'the video plays its own sound again');
  });

  await check('the level meter shows what plays, in dB, and rests when stopped', async () => {
    await freshMix();
    // Started as a user gesture, as a click on Play is (autoplay policy).
    await editor.webContents.executeJavaScript('window.__editor.player.seek(0.8); window.__editor.player.play()', true);
    await sleep(700);
    const levels = await js('window.__editor.meter.levels');
    console.log(`    meter while playing: ${levels.map((l) => l.peak.toFixed(1)).join(' / ')} dBFS`);
    await shot('12-meter');
    await js('window.__editor.player.pause()');
    assert.ok(levels, 'levels while playing');
    // The song at 50% of 0.125: a peak of about -24 dBFS on each side.
    for (const side of levels) near(side.peak, -24, 3, 'peak');
    const bar = await js('parseFloat(document.querySelector("#meter .meter-fill").style.width)');
    assert.ok(bar > 50 && bar < 70, `the bar shows it: ${bar}%`);
    await sleep(300);
    assert.strictEqual(await js('window.__editor.meter.levels'), null, 'nothing while stopped');
  });

  console.log(`\n${passed} passed. Screenshots: ${OUT}`);
  fs.rmSync(work, { recursive: true, force: true });
}

app.whenReady().then(run).then(() => app.exit(0), (err) => {
  console.error(err);
  app.exit(1);
});
