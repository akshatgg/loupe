'use strict';
// End-to-end test of the finer audio tools (docs/EDITOR-V2.md, "Finer audio
// tools"): left or right, low / middle / high tones, and evening out loud and
// quiet parts, for an audio clip, the microphone and the computer sound.
//
//   electron test/e2e/audio-tools.e2e.js        (npm run test:e2e:audio-tools)
//
// Opens the real editor on a recording with a microphone tone (440 Hz) and
// computer sound (660 Hz), adds three sounds one after another -- a song
// (330 Hz), a low tone (80 Hz) and a loud one (1 kHz) -- and exports. Then,
// through the folded "Advanced" part of each sound's settings: the song goes
// fully left, the low tone's low band goes up, the loud tone is evened out,
// the microphone goes fully right and the computer sound's middle band goes
// down. Each export's sound is read back with ffmpeg, both sides, and
// compared with the one before; undo and Reset put everything back, and the
// last export sounds like the first. Screenshots go to
// test/e2e/out/editor/audio-tools-*.png. Needs ffmpeg on the PATH.

const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  openEditor, openLab, makeFixture, readProject, waitFor, log, OUT, FIXTURE
} = require('./editor-harness');
const { registerMusicIpc } = require('../../src/main/ipc/music');
const P = require('../../src/core/project.js');

const MOD = process.platform === 'darwin' ? 'meta' : 'control';

let projectDir = null;
let musicPick = null;
registerMusicIpc({
  ipcMain, BrowserWindow, getProjectDir: () => projectDir,
  dialog: { ...dialog, showOpenDialog: async () => ({ canceled: !musicPick, filePaths: musicPick ? [musicPick] : [] }) }
});

function writeToneWav(file, seconds, { freq, amp, rate = 48000 }) {
  const frames = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / rate));
    buf.writeInt16LE(v, 44 + i * 4);
    buf.writeInt16LE(v, 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

// Amplitude of `freq` in samples[from, to) seconds (Hann window) -- the same
// measure in the page (the preview's mix) and here (the exported file).
const AMPLITUDE = `(x, rate, { freq, from, to }) => {
  const a = Math.round(from * rate), b = Math.round(to * rate);
  let re = 0, im = 0, ws = 0;
  for (let i = a; i < b; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - a) / (b - a));
    const ph = 2 * Math.PI * freq * i / rate;
    re += x[i] * w * Math.cos(ph); im += x[i] * w * Math.sin(ph); ws += w;
  }
  return 2 * Math.hypot(re, im) / ws;
}`;
const amplitude = eval(AMPLITUDE);

// Both sides of an exported file's sound: [left, right] at 48 kHz.
function exportedSound(file) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 256 << 20 });
  const both = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const left = new Float32Array(both.length / 2);
  const right = new Float32Array(both.length / 2);
  for (let i = 0; i < left.length; i++) { left[i] = both[2 * i]; right[i] = both[2 * i + 1]; }
  return [left, right];
}

// What is measured in every export: each tone where it plays.
const TONES = {
  mic: { freq: 440, from: 0.5, to: 7.5 },
  system: { freq: 660, from: 0.5, to: 7.5 },
  song: { freq: 330, from: 0.5, to: 2 },
  low: { freq: 80, from: 3, to: 4.5 },
  loud: { freq: 1000, from: 5.5, to: 7 }
};
const dB = (ratio) => 20 * Math.log10(ratio);

async function main() {
  const lab = await openLab();
  const src = await makeFixture(lab);
  const dir = path.join(OUT, 'cases', 'audio-tools');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['raw.mp4', 'cursor.bin']) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  writeToneWav(path.join(dir, 'system.wav'), FIXTURE.duration, { freq: 660, amp: 0.25 });
  const sounds = path.join(OUT, 'audio-tools-sounds');
  fs.mkdirSync(sounds, { recursive: true });
  const files = {
    song: path.join(sounds, 'Song.wav'), low: path.join(sounds, 'Low tone.wav'), loud: path.join(sounds, 'Loud tone.wav')
  };
  writeToneWav(files.song, 2.5, { freq: 330, amp: 0.1 });
  writeToneWav(files.low, 2.5, { freq: 80, amp: 0.05 });
  writeToneWav(files.loud, 2.5, { freq: 1000, amp: 0.5 }); // -6 dBFS
  // Tones are not speech: no clean-up or levelling, and quiet enough that
  // nothing reaches the limiter. The microphone plays at 0.5 x 0.2 = 0.1,
  // the computer sound at 0.25 x 0.4 = 0.1.
  const project = P.setAudio(P.createProject({
    main: {
      width: FIXTURE.width, height: FIXTURE.height, duration: FIXTURE.duration, fps: FIXTURE.fps,
      video: 'raw.mp4', mic: true, systemAudio: 'system.wav', cursor: 'cursor.bin'
    },
    createdAt: Date.now()
  }), { mic: { cleanUp: false, level: false, volume: 0.2 }, system: { volume: 0.4 } });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2));
  projectDir = dir;

  const ed = await openEditor(dir);
  const checks = [];
  const ok = (what) => { checks.push(what); log(`ok ${checks.length} - ${what}`); };
  const audio = () => ed.project().then((p) => p.audio);
  const clipNamed = async (name) => (await audio()).clips.find((c) => c.name === name);
  const select = (id) => ed.js(`window.__editor.editor.select(${id ? `{ kind: 'audio', id: '${id}' }` : 'null'}); window.__editor.editor.showPanel('audio')`);
  const ready = (what) => waitFor(() => ed.js(`(() => { const e = window.__editor; const a = e.player.audio;
    return a.state.ready && !a.state.preparing && a.mix !== null && a.upToDate(e.store.project); })()`), what, 60000);
  const previewAmp = (side, tone) => ed.js(`(${AMPLITUDE})(window.__editor.player.audio.mix.getChannelData(${side}), window.__editor.player.audio.mix.sampleRate, ${JSON.stringify(tone)})`);
  // A slider dragged through several values and let go: one gesture.
  const dragSlider = (id, values) => ed.js(`(() => { const i = document.getElementById('${id}');
    for (const v of ${JSON.stringify([].concat(values))}) { i.value = String(v); i.dispatchEvent(new Event('input', { bubbles: true })); }
    i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const hidden = (id) => ed.js(`document.getElementById('${id}').closest('.field').hidden`);
  const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b} (±${eps})`);
  async function exported(label) {
    await ed.settle();
    const result = await ed.js('window.loupe.exportVideo({ resolution: "720p" })');
    assert.ok(fs.existsSync(result.file), 'exported');
    const [left, right] = exportedSound(result.file);
    const out = { left, right };
    for (const [name, tone] of Object.entries(TONES)) out[name] = [amplitude(left, 48000, tone), amplitude(right, 48000, tone)];
    log(`    ${label}: ${Object.keys(TONES).map((n) => `${n} ${out[n][0].toFixed(4)} / ${out[n][1].toFixed(4)}`).join(', ')}  (left / right)`);
    return out;
  }

  try {
    // What an earlier run left unfolded is forgotten first (the panel reads
    // it when it is first opened).
    await ed.js('for (const k of ["clip", "mic", "system"]) localStorage.removeItem(`loupe.audio.advanced.${k}`)');
    await ed.clickOn('#tabs [data-panel="audio"]');
    await waitFor(() => ed.js('!!document.querySelector("#micAdvanced")'), 'the audio panel');
    assert.deepStrictEqual(await ed.js('["micAdvanced", "systemAdvanced", "clipAdvanced"].map((id) => document.getElementById(id).open)'),
      [false, false, false], 'Advanced starts folded');
    assert.deepStrictEqual(await ed.js('["micAdvanced", "systemAdvanced"].map((id) => document.querySelector(`#${id} summary`).textContent)'),
      ['Advanced', 'Advanced']);

    // Three sounds, one after another, each at full volume and not lowered
    // under the microphone's tone.
    for (const [name, at] of [['song', 0], ['low', 2.5], ['loud', 5]]) {
      const before = (await audio()).clips.length;
      await ed.js(`window.__editor.editor.select(null); window.__editor.player.seek(${at})`);
      musicPick = files[name];
      await ed.js('document.getElementById("addMusic").click()');
      await waitFor(async () => (await audio()).clips.length === before + 1, `the ${name} clip`, 20000);
      await dragSlider('clipVolume', 1);
      await ed.js('document.getElementById("clipDuck").click()');
    }
    const clips = (await audio()).clips;
    assert.deepStrictEqual(clips.map((c) => [c.name, c.volume, c.duck]), [['Song', 1, false], ['Low tone', 1, false], ['Loud tone', 1, false]]);
    clips.forEach((c, i) => near(c.start, i * 2.5, 0.02, `${c.name} starts`));
    for (const c of clips) assert.ok(!('pan' in c) && !('eq' in c) && !('compressor' in c), 'a new clip has no tone settings');
    const untouched = await audio();
    assert.ok(!('pan' in untouched.mic) && !('eq' in untouched.system), 'nor do the microphone and computer sound');

    const first = await exported('untouched');
    near(first.mic[0], 0.1, 0.01, 'the microphone, as it always was');
    near(first.system[0], 0.1, 0.01, 'the computer sound, as it always was');
    near(first.song[0], 0.1, 0.01, 'the song');
    near(first.low[0], 0.05, 0.006, 'the low tone');
    near(first.loud[0], 0.5, 0.04, 'the loud tone');
    for (const name of Object.keys(TONES)) near(first[name][0], first[name][1], 0.003, `${name} is the same on both sides`);
    ok('with nothing changed, every sound exports at its volume, the same on both sides');

    // ---- the song, fully left
    const song = await clipNamed('Song');
    await select(song.id);
    await ed.js('document.querySelector("#clipAdvanced summary").click()');
    await waitFor(() => ed.js('document.getElementById("clipAdvanced").open && localStorage.getItem("loupe.audio.advanced.clip") === "1"'), 'Advanced open and remembered');
    await dragSlider('clipPan', [-0.3, -0.7, -1]);
    assert.strictEqual((await clipNamed('Song')).pan, -1);
    assert.strictEqual(await ed.js('document.querySelector("#clipPan").closest(".field").querySelector(".value").textContent'), '100% left');
    assert.strictEqual(await ed.js('document.querySelector("#clipAdvanced .advanced-note").textContent'), 'in use');
    await ed.key('z', [MOD]);
    assert.ok(!('pan' in (await clipNamed('Song'))), 'one undo takes the whole drag back');
    assert.strictEqual(await ed.js('document.getElementById("clipPan").value'), '0', 'and the slider shows it');
    await ed.key('z', [MOD, 'shift']);
    assert.strictEqual((await clipNamed('Song')).pan, -1, 'redo');
    ok('Advanced unfolds and is remembered; dragging “Left or right” is one undo step');

    // ---- the low tone, its low band up
    await select((await clipNamed('Low tone')).id);
    assert.strictEqual(await ed.js('document.getElementById("clipAdvanced").open'), true, 'still open for another clip');
    assert.strictEqual(await ed.js('document.getElementById("clipPan").value'), '0', 'showing that clip’s own settings');
    await dragSlider('clipEqLow', [6, 12]);
    assert.deepStrictEqual((await clipNamed('Low tone')).eq, { low: 12, mid: 0, high: 0 });

    // ---- the loud tone, evened out
    await select((await clipNamed('Loud tone')).id);
    assert.deepStrictEqual([await hidden('clipCompThreshold'), await hidden('clipCompRatio')], [true, true], 'its sliders are hidden while it is off');
    await ed.js('document.getElementById("clipCompOn").click()');
    assert.deepStrictEqual([await hidden('clipCompThreshold'), await hidden('clipCompRatio')], [false, false], 'and shown once it is on');
    await dragSlider('clipCompThreshold', [-20, -24]);
    await dragSlider('clipCompRatio', [3, 4]);
    const comp = (await clipNamed('Loud tone')).compressor;
    assert.deepStrictEqual([comp.on, comp.threshold, comp.ratio], [true, -24, 4]);
    await ed.js('document.getElementById("clipAdvanced").scrollIntoView({ block: "center" })');
    await ed.shot('audio-tools-01-clip-advanced');
    ok('the low band and “Even out loud and quiet parts” (with its level and amount) change the clip');

    await ready('the mix with the clips’ tools');
    const second = await exported('clips changed');
    assert.ok(second.song[1] < 0.004, `the song is silent on the right: ${second.song[1]}`);
    near(dB(second.song[0] / first.song[0]), 3, 0.5, 'and 3 dB up on the left, in dB');
    near(dB(second.low[0] / first.low[0]), 12, 1.5, 'the low tone is 12 dB up, in dB');
    // -6 dBFS is 18 dB over -24: at 4:1 that leaves 4.5 dB over, 13.5 dB less.
    near(dB(second.loud[0] / first.loud[0]), -13.5, 2, 'the loud tone is turned down, in dB');
    for (const name of ['mic', 'system']) for (const side of [0, 1]) near(second[name][side], first[name][side], 0.004, `${name} is as it was`);
    near(await previewAmp(0, TONES.song), second.song[0], 0.01, 'the preview: the song on the left');
    assert.ok(await previewAmp(1, TONES.song) < 0.004, 'the preview: silent on the right');
    near(await previewAmp(0, TONES.low), second.low[0], 0.015, 'the preview: the low tone');
    near(await previewAmp(0, TONES.loud), second.loud[0], 0.015, 'the preview: the loud tone');
    ok('export: the song only on the left, the low tone louder, the loud tone turned down -- and the preview sounds the same');

    // ---- the microphone to the right, the computer sound's middle down
    await select(null);
    await ed.js('document.querySelector("#micAdvanced summary").click(); document.querySelector("#systemAdvanced summary").click()');
    await waitFor(() => ed.js('localStorage.getItem("loupe.audio.advanced.mic") === "1" && localStorage.getItem("loupe.audio.advanced.system") === "1"'), 'both remembered');
    await dragSlider('micPan', [0.5, 1]);
    await dragSlider('systemEqMid', [-6, -12]);
    assert.strictEqual((await audio()).mic.pan, 1);
    assert.deepStrictEqual((await audio()).system.eq, { low: 0, mid: -12, high: 0 });
    await ed.key('z', [MOD]);
    await ed.key('z', [MOD]);
    assert.ok(!('pan' in (await audio()).mic) && !('eq' in (await audio()).system), 'two undos take both back');
    await ed.key('z', [MOD, 'shift']);
    await ed.key('z', [MOD, 'shift']);
    assert.strictEqual((await audio()).mic.pan, 1, 'redo');
    await ed.js('document.querySelector(".panel-wrap").scrollTop = 0');
    await ed.shot('audio-tools-02-video-advanced');
    await ready('the mix with the video’s tools');
    const third = await exported('microphone and computer sound changed');
    assert.ok(third.mic[0] < 0.004, `the microphone is silent on the left: ${third.mic[0]}`);
    near(dB(third.mic[1] / first.mic[1]), 3, 0.5, 'and 3 dB up on the right, in dB');
    for (const side of [0, 1]) assert.ok(dB(third.system[side] / first.system[side]) < -5, `the computer sound's 660 Hz is down: ${dB(third.system[side] / first.system[side])} dB`);
    near(await previewAmp(1, TONES.mic), third.mic[1], 0.01, 'the preview: the microphone on the right');
    assert.ok(await previewAmp(0, TONES.mic) < 0.004, 'the preview: silent on the left');
    ok('the microphone and the computer sound have the same tools, heard in the preview and the export');

    assert.ok(readProject(dir).audio.clips.some((c) => c.pan === -1) && readProject(dir).audio.mic.pan === 1, 'saved to project.json');

    // ---- Reset, everywhere
    await ed.js('document.getElementById("micToneReset").click(); document.getElementById("systemToneReset").click()');
    for (const name of ['Song', 'Low tone', 'Loud tone']) {
      await select((await clipNamed(name)).id);
      await ed.js('document.getElementById("clipToneReset").click()');
      assert.strictEqual(await ed.js('document.getElementById("clipToneReset").disabled'), true, 'nothing left to reset');
    }
    const flat = { pan: 0, eq: { low: 0, mid: 0, high: 0 } };
    const reset = await audio();
    for (const s of [reset.mic, reset.system, ...reset.clips]) {
      assert.deepStrictEqual({ pan: s.pan, eq: s.eq }, flat);
      assert.strictEqual(s.compressor.on, false);
    }
    assert.strictEqual(await hidden('clipCompThreshold'), true);
    await ed.key('z', [MOD]);
    assert.strictEqual((await clipNamed('Loud tone')).compressor.on, true, 'undo brings the last reset back');
    await ed.key('z', [MOD, 'shift']);
    assert.strictEqual((await clipNamed('Loud tone')).compressor.on, false);
    await ready('the mix after Reset');
    const last = await exported('after Reset');
    for (const name of Object.keys(TONES)) for (const side of [0, 1]) near(last[name][side], first[name][side], 0.002, `${name} is back`);
    let worst = 0;
    const n = Math.min(last.left.length, first.left.length);
    assert.ok(Math.abs(last.left.length - first.left.length) < 64, 'the same length');
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(last.left[i] - first.left[i]), Math.abs(last.right[i] - first.right[i]));
    log(`    the last export against the first: the largest difference in any sample is ${worst.toExponential(2)}`);
    assert.ok(worst < 0.002, `sample for sample the same sound: ${worst}`);
    ok('Reset puts each sound back; the export is then the same as the untouched one, sample for sample');

    const errors = ed.errors.filter((e) => !/Electron Security Warning|willReadFrequently/.test(e));
    assert.deepStrictEqual(errors, [], 'no errors in the editor console');
    ok('no errors in the console');
  } catch (err) {
    await ed.shot('audio-tools-fail').catch(() => {});
    log(`not ok - ${String(err.stack ?? err).split('\n').slice(0, 5).join('\n  ')}`);
    return 1;
  } finally {
    ed.close();
  }
  log(`# ${checks.length} passed; screenshots in ${path.relative(path.join(__dirname, '..', '..'), OUT)}/audio-tools-*.png`);
  return 0;
}

app.whenReady().then(main).then(
  (code) => app.exit(code),
  (err) => { log(`not ok - ${err.stack ?? err}`); app.exit(1); }
);
