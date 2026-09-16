'use strict';
// The whole app, the way a person records: the real main.js, picker, bar,
// camera bubble and built helpers (npm run build:native first). Arms the bar
// with every addition turned on, lets the 3-2-1 run, presses shortcuts, plays
// a sound, pauses and resumes from the bar, stops, and checks the recording
// folder and the editor that opens.
//
// Kept away from the user's own files: recordings go to a temporary home
// folder and settings to a temporary userData. The camera is Chromium's fake
// one (a test pattern), and camera access is reported as granted.
//
//   node_modules/.bin/electron test/e2e/app-recording.e2e.js
// Needs Screen Recording and Accessibility for the shell running it.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const electron = require('electron');

const { app, BrowserWindow, systemPreferences } = electron;
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin');
const COMMAND = 0x100000;
const F15 = 113;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Real path: the app resolves the recordings folder (/var is /private/var).
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-app-')));
const home = path.join(work, 'home');
const userData = path.join(work, 'userData');
fs.mkdirSync(home);
fs.mkdirSync(userData);
app.setPath('userData', userData);
os.homedir = () => home;
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  countdown: true, systemAudio: true, showKeystrokes: true, recordCamera: true, camera: null
}));
const realStatus = systemPreferences.getMediaAccessStatus.bind(systemPreferences);
systemPreferences.getMediaAccessStatus = (type) => (type === 'camera' ? 'granted' : realStatus(type));

async function waitFor(what, fn, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const pageOf = (name) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() &&
  w.webContents.getURL().includes(`/renderer/${name}/`));

async function run() {
  for (const name of ['capture', 'inputtap', 'sources']) {
    if (!fs.existsSync(path.join(BIN, name))) throw new Error(`bin/${name} missing: npm run build:native`);
  }
  const postkey = path.join(work, 'postkey');
  execFileSync('swiftc', ['-O', path.join(__dirname, 'postkey.swift'), '-o', postkey]);

  // Listed before the app starts: two bin/sources at once (this and the
  // picker's) can wait on each other, and execFileSync would hold up the app.
  const display = JSON.parse(execFileSync(path.join(BIN, 'sources'), { maxBuffer: 64 * 1024 * 1024 }))
    .find((s) => s.kind === 'display');
  require('../../src/main/main');
  const picker = await waitFor('the picker', () => pageOf('picker'));
  await waitFor('the picker to load', () => !picker.webContents.isLoading());

  // Continue in the picker: the bar and the camera bubble come up.
  await picker.webContents.executeJavaScript(`window.loupe.armRecording(${JSON.stringify({
    source: display.id, width: display.width, height: display.height,
    x: display.x ?? 0, y: display.y ?? 0, title: display.title, mic: false
  })})`);
  const bar = await waitFor('the bar', () => pageOf('bar'));
  const bubble = await waitFor('the camera bubble', () => pageOf('camera'));
  assert.ok(bubble.isAlwaysOnTop(), 'the bubble floats above other windows');
  await waitFor('the camera preview', () => bubble.webContents.executeJavaScript(
    'document.getElementById("video").videoWidth > 0'));
  const barJs = (e) => bar.webContents.executeJavaScript(e);
  await waitFor('the bar to load', () => !bar.webContents.isLoading());

  // Start: the bar counts 3, 2, 1 before anything records.
  const started = barJs('window.loupe.startRecording()');
  const seen = new Set();
  const countdownEnd = Date.now() + 5000;
  while (Date.now() < countdownEnd) {
    const state = await barJs(`({ counting: !document.getElementById('countdown').hidden,
      count: document.getElementById('count').textContent,
      recording: !document.getElementById('recording').hidden })`);
    if (state.counting) seen.add(state.count);
    if (state.recording) break;
    await sleep(50);
  }
  assert.deepStrictEqual([...seen].sort(), ['1', '2', '3'], 'the bar showed 3, 2, 1');
  const startResult = await started;
  const dir = startResult.dir;
  assert.ok(dir.startsWith(path.join(home, 'Movies', 'Loupe')), `recording in the test folder: ${dir}`);

  await sleep(1500);
  // On screen while recording (and still not in the frame checked below).
  assert.ok(bubble.isVisible(), 'the bubble is showing');
  console.log('bubble at', JSON.stringify(bubble.getBounds()));
  execFileSync(postkey, [String(F15), String(COMMAND)]);
  const player = spawn('afplay', ['/System/Library/Sounds/Glass.aiff']);
  await sleep(1200);

  // Pause from the bar: the timer stands still while paused.
  await barJs('document.getElementById("pause").click()');
  await waitFor('the paused bar', () => barJs('!document.getElementById("pausedLabel").hidden'));
  const t1 = await barJs('document.getElementById("time").textContent');
  await sleep(1500);
  const t2 = await barJs('document.getElementById("time").textContent');
  assert.strictEqual(t2, t1, 'the timer stands still while paused');
  await barJs('document.getElementById("pause").click()');
  await waitFor('recording again', () => barJs('document.getElementById("pausedLabel").hidden'));
  await sleep(1200);

  // Stop: the editor opens on the recording.
  // Not awaited in the page: the bar window closes as part of stopping, and
  // a script still running in a closed window never answers.
  await barJs('window.loupe.stopRecording(); 0');
  player.kill();
  const editor = await waitFor('the editor', () => pageOf('editor'));
  await waitFor('the editor to load', () => !editor.webContents.isLoading());
  assert.ok(!pageOf('camera'), 'the bubble closed at stop');

  const project = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  const main = project.sources.main;
  console.log('sources.main:', JSON.stringify({ ...main, clicks: main.clicks.length }));
  console.log('clips:', JSON.stringify(project.clips));
  assert.strictEqual(project.version, 2, 'a version-2 project for the editor');
  assert.strictEqual(main.video, 'raw.mov');
  assert.strictEqual(main.systemAudio, 'system.m4a');
  assert.ok(fs.statSync(path.join(dir, 'system.m4a')).size > 0);
  assert.strictEqual(main.keys, 'keys.json');
  const keys = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8'));
  console.log('keys.json:', JSON.stringify(keys));
  assert.ok(keys.some((k) => k.label === '⌘F15'), 'the shortcut was recorded');

  assert.strictEqual(main.pauses.length, 1, 'one pause');
  const pause = main.pauses[0].end - main.pauses[0].start;
  assert.ok(pause > 1.3 && pause < 2.5, `pause length ${pause}`);
  assert.strictEqual(project.clips.length, 2, 'the pause is cut out of the clips');

  assert.ok(main.webcam, 'the webcam recording is in the project');
  assert.strictEqual(main.webcam.file, 'webcam.webm');
  // The bubble is told to record once capture has been started, which is
  // usually a little before ScreenCaptureKit delivers its first frame (second
  // 0 of the recording): a small negative offset is expected.
  assert.ok(Math.abs(main.webcam.offset) < 1, `webcam offset ${main.webcam.offset}`);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json',
    '-show_format', path.join(dir, 'webcam.webm')], { encoding: 'utf8' }));
  const webcamSeconds = Number(probe.format.duration);
  console.log(`webcam.webm ${webcamSeconds.toFixed(2)} s from ${main.webcam.offset.toFixed(3)} s, ` +
    `video ${main.duration.toFixed(2)} s`);
  assert.ok(Math.abs(main.webcam.offset + webcamSeconds - main.duration) < 0.5,
    'the webcam file ends with the screen recording');

  // A frame of the screen recording, for a look: neither the bar nor the
  // camera bubble (bottom right) may be in it.
  const out = path.join(__dirname, 'out');
  fs.mkdirSync(out, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '2', '-i', path.join(dir, 'raw.mov'),
    '-frames:v', '1', '-vf', 'scale=960:-1', path.join(out, 'app-recording-frame.png')]);

  fs.rmSync(work, { recursive: true, force: true });
  console.log('app recording e2e: all checks passed');
}

app.whenReady().then(run).then(() => app.exit(0), (err) => {
  console.error(err);
  app.exit(1);
});
