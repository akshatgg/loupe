'use strict';
// End-to-end test of sound in the editor (docs/EDITOR-V2.md section 5, Audio):
//
//   electron test/e2e/audio.e2e.js        (npm run test:e2e:audio)
//
// Opens the real editor on a recording with a microphone tone (440 Hz) and
// computer sound (660 Hz), then with the real mouse and keyboard: turns
// clean-up off, mutes and unmutes computer sound, adds music through the
// "Add music" dialog (220 Hz), records a voiceover with Chromium's fake
// microphone (count-in, the video playing, Space to stop), drags the take
// along the timeline's sound strip and undoes it. Then it checks that the
// preview's mix and the exported video's sound agree, tone by tone.
// Screenshots go to test/e2e/out/editor/audio-*.png.

const { app, ipcMain, dialog, BrowserWindow } = require('electron');

// A fake microphone that beeps, granted without a prompt.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  openEditor, openLab, makeFixture, readProject, waitFor, sleep, log, OUT, FIXTURE
} = require('./editor-harness');
const { registerVoiceoverIpc } = require('../../src/main/ipc/voiceover');
const { registerMusicIpc } = require('../../src/main/ipc/music');
const P = require('../../src/core/project.js');

const MOD = process.platform === 'darwin' ? 'meta' : 'control';

let projectDir = null;
let musicPick = null;
registerVoiceoverIpc({ ipcMain, getProjectDir: () => projectDir });
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

// Measures the preview's current mix in the page: tone amplitudes and RMS.
const MEASURE = `(windows) => {
  const mix = window.__editor.player.audio.mix;
  const left = mix.getChannelData(0);
  const rate = mix.sampleRate;
  return windows.map(({ freq, from, to }) => {
    const a = Math.round(from * rate), b = Math.round(to * rate);
    if (!freq) { let s = 0; for (let i = a; i < b; i++) s += left[i] * left[i]; return Math.sqrt(s / (b - a)); }
    let re = 0, im = 0, ws = 0;
    for (let i = a; i < b; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - a) / (b - a));
      const ph = 2 * Math.PI * freq * i / rate;
      re += left[i] * w * Math.cos(ph); im += left[i] * w * Math.sin(ph); ws += w;
    }
    return 2 * Math.hypot(re, im) / ws;
  });
}`;

async function main() {
  const lab = await openLab();
  const src = await makeFixture(lab);
  const dir = path.join(OUT, 'cases', 'audio');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['raw.mp4', 'cursor.bin']) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  writeToneWav(path.join(dir, 'system.wav'), FIXTURE.duration, { freq: 660, amp: 0.25 });
  const song = path.join(OUT, 'audio-song', 'Song for the demo.wav');
  fs.mkdirSync(path.dirname(song), { recursive: true });
  writeToneWav(song, 20, { freq: 220, amp: 0.5, rate: 44100 });
  // A fresh v2 recording, as the recorder writes it: clean-up and levelling on.
  const project = P.createProject({
    main: {
      width: FIXTURE.width, height: FIXTURE.height, duration: FIXTURE.duration, fps: FIXTURE.fps,
      video: 'raw.mp4', mic: true, systemAudio: 'system.wav', cursor: 'cursor.bin'
    },
    createdAt: Date.now()
  });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2));
  projectDir = dir;

  const ed = await openEditor(dir);
  const checks = [];
  const ok = (what) => { checks.push(what); log(`ok ${checks.length} - ${what}`); };
  const audio = () => ed.project().then((p) => p.audio);
  const ready = (what) => waitFor(() => ed.js('(() => { const a = window.__editor.player.audio; return a.state.ready && !a.state.preparing && a.mix !== null; })()'), what, 60000);
  const measure = (windows) => ed.js(`(${MEASURE})(${JSON.stringify(windows)})`);

  try {
    await ed.clickOn('#tabs [data-panel="audio"]');
    await waitFor(() => ed.js('!!document.querySelector("#micCleanUp")'), 'the audio panel');
    assert.deepStrictEqual(await ed.js('[document.querySelector("#micCleanUp").checked, document.querySelector("#micLevel").checked]'), [true, true],
      'clean-up and even out volume are on for a new recording');
    await ready('the first mix (cleaned up and evened out)');
    await ed.js('window.__editor.player.seek(1)');
    await ed.shot('audio-01-panel');
    ok('the Audio panel shows the microphone and computer sound, with clean-up on');

    // A tone is not speech: clean-up would remove it, so turn it off.
    await ed.clickOn('#micCleanUp + .switch');
    await waitFor(async () => (await audio()).mic.cleanUp === false, 'clean-up off');
    await ed.clickOn('.panel-section:nth-of-type(2) .mute-btn');
    assert.strictEqual((await audio()).system.muted, true);
    assert.strictEqual(await ed.js('document.querySelector("#systemVolume").closest(".field").classList.contains("disabled")'), true);
    await ed.clickOn('.panel-section:nth-of-type(2) .mute-btn');
    assert.strictEqual((await audio()).system.muted, false);
    ok('switches and mute buttons change the project');

    musicPick = song;
    await ed.clickOn('#addMusic');
    await waitFor(async () => (await audio()).music?.file === 'music/Song for the demo.wav', 'the music in the project');
    assert.ok(fs.existsSync(path.join(dir, 'music', 'Song for the demo.wav')), 'the song is copied into the project');
    assert.deepStrictEqual((await audio()).music, { file: 'music/Song for the demo.wav', volume: 0.3, duck: true });
    await ready('the mix with music');
    await waitFor(async () => (await measure([{ freq: 220, from: 1, to: 2 }]))[0] > 0.01, 'music in the preview', 20000);
    ok('Add music copies the song in and the preview plays it');

    // Record a voiceover from 3 s: count-in, then the video plays while talking.
    await ed.js('window.__editor.player.seek(3)');
    await ed.clickOn('#recordVoiceover');
    await waitFor(() => ed.js('!document.querySelector(".vo-overlay").hidden && !document.querySelector(".vo-count").hidden'), 'the count-in');
    await ed.shot('audio-02-count-in');
    await waitFor(() => ed.js('!document.querySelector(".vo-bar").hidden'), 'recording', 8000);
    await sleep(1200);
    assert.strictEqual(await ed.js('window.__editor.player.playing'), true, 'the video plays while recording');
    await ed.shot('audio-03-recording');
    await ed.key('Space');
    await waitFor(async () => (await audio()).voiceover.length === 1, 'the take in the project', 10000);
    const take = (await audio()).voiceover[0];
    assert.match(take.file, /^voiceover\/Voiceover\.(webm|ogg|m4a)$/);
    assert.ok(fs.existsSync(path.join(dir, take.file)), 'the take is saved in the project folder');
    assert.ok(Math.abs(take.t - 3) < 0.05, `anchored at the playhead: ${take.t}`);
    assert.strictEqual(await ed.js('window.__editor.player.playing'), false, 'stopping pauses the video');
    await waitFor(() => ed.js('document.querySelectorAll(".take-row").length === 1'), 'the take listed');
    ok('Record voiceover: count-in, plays the video, Space stops, the take is saved and listed');

    // Drag the take one second later along the sound strip, then undo.
    await ready('the mix with the voiceover');
    await ed.settle();
    const lane = await ed.box('.tl-audio');
    const y = Math.round(lane.y + lane.h / 2);
    const x0 = await ed.timelineX(3.3);
    const x1 = await ed.timelineX(4.3);
    await ed.drag(x0, y, x1, y);
    const moved = (await audio()).voiceover[0];
    assert.ok(Math.abs(moved.t - 4) < 0.08, `dragged to ${moved.t}`);
    await ed.key('z', [MOD]);
    assert.ok(Math.abs((await audio()).voiceover[0].t - 3) < 0.05, 'undo puts it back');
    await ed.key('z', [MOD, 'shift']);
    assert.ok(Math.abs((await audio()).voiceover[0].t - 4) < 0.08, 'redo moves it again');
    ok('a take drags along the timeline, with undo and redo');

    await ready('the final mix');
    await ed.js('window.__editor.player.seek(4.2)');
    await ed.shot('audio-04-music-and-voiceover');
    await ed.settle();

    // What the preview plays is what the export has.
    const windows = [
      { freq: 440, from: 0.5, to: 2.5 }, { freq: 660, from: 0.5, to: 2.5 }, { freq: 220, from: 0.5, to: 2.5 },
      { freq: 440, from: 5.5, to: 7 }, { freq: 660, from: 5.5, to: 7 }, { freq: 220, from: 5.5, to: 7 },
      { from: 4.1, to: 5.2 }
    ];
    const preview = await measure(windows);
    const result = await ed.js('window.loupe.exportVideo({ resolution: "720p" })');
    assert.ok(fs.existsSync(result.file), 'exported');
    const inspection = await lab.call('inspect', pathToFileURL(result.file).href, {
      bands: windows.filter((w) => w.freq), sound: windows.filter((w) => !w.freq)
    });
    const exported = [...inspection.audio.bands.map((b) => b.amplitude), inspection.audio.windows[0].rms];
    const names = ['mic', 'computer sound', 'music (ducked)', 'mic later', 'computer sound later', 'music later', 'voiceover RMS'];
    windows.forEach((_, i) => {
      log(`    ${names[i]}: preview ${preview[i].toFixed(4)}, export ${exported[i].toFixed(4)}`);
      assert.ok(Math.abs(preview[i] - exported[i]) <= Math.max(0.01, 0.08 * exported[i]), `${names[i]}: preview ${preview[i]} vs export ${exported[i]}`);
    });
    assert.ok(exported[0] > 0.1 && exported[1] > 0.2 && exported[2] > 0.005, 'every part is heard');
    assert.ok(Math.abs(inspection.audio.duration - FIXTURE.duration) < 0.1, `sound lasts ${inspection.audio.duration}s`);
    ok('the preview mix matches the exported sound, tone by tone');

    assert.strictEqual(readProject(dir).audio.voiceover.length, 1, 'saved to project.json');
    const errors = ed.errors.filter((e) => !/Electron Security Warning|willReadFrequently/.test(e));
    assert.deepStrictEqual(errors, [], 'no errors in the editor console');
    ok('no errors in the console');
  } catch (err) {
    await ed.shot('audio-fail').catch(() => {});
    log(`not ok - ${String(err.stack ?? err).split('\n').slice(0, 5).join('\n  ')}`);
    return 1;
  } finally {
    ed.close();
  }
  log(`# ${checks.length} passed; screenshots in ${path.relative(path.join(__dirname, '..', '..'), OUT)}/audio-*.png`);
  return 0;
}

app.whenReady().then(main).then(
  (code) => app.exit(code),
  (err) => { log(`not ok - ${err.stack ?? err}`); app.exit(1); }
);
