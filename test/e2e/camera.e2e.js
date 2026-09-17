'use strict';
// The webcam bubble for real: Electron, the real preload and bubble page,
// MediaRecorder and ipc/camera.js writing webcam.webm, with Chromium's fake
// camera (a moving test pattern) so no real camera or permission prompt is
// involved. Checks the file plays with a proper duration and that the start
// moment reported for alignment is sane.
//
//   node_modules/.bin/electron test/e2e/camera.e2e.js
// (ffprobe on PATH is used to read the file.)
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createCameraBubble } = require('../../src/main/ipc/camera');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const ROOT = path.join(__dirname, '..', '..');
const now = () => performance.now() / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-cam-'));
  let changes = 0;
  const bubble = createCameraBubble({
    BrowserWindow, ipcMain, now,
    preload: path.join(ROOT, 'src', 'preload', 'preload.js'),
    page: path.join(ROOT, 'src', 'renderer', 'camera', 'index.html'),
    getWorkArea: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    onChange: () => { changes++; }
  });

  const win = bubble.open({ deviceId: null });
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  // The preview is running once the <video> has a picture.
  const deadline = Date.now() + 10000;
  for (;;) {
    const size = await win.webContents.executeJavaScript(
      'document.getElementById("video").videoWidth');
    if (size > 0) break;
    if (Date.now() > deadline) throw new Error(`camera preview never started (${bubble.error()})`);
    await sleep(50);
  }
  assert.ok(win.isAlwaysOnTop(), 'always on top');
  assert.ok(Number(bubble.windowId()) > 0, 'a window id for --exclude-window');

  const beforeStart = now();
  assert.ok(bubble.start(dir), 'recording started');
  for (;;) {
    if (bubble.isRecording()) break;
    if (Date.now() > deadline + 5000) throw new Error('MediaRecorder never started');
    await sleep(10);
  }
  const startedKnown = now();
  await sleep(3000);
  // onChange only fires when the bubble goes away on its own (an error).
  assert.strictEqual(changes, 0, `no camera error while recording (${bubble.error()})`);
  const stopAt = now();
  const result = await bubble.finish();
  console.log('finish:', JSON.stringify(result));
  assert.ok(result, 'a webcam file');
  assert.strictEqual(result.file, 'webcam.webm');
  assert.ok(result.width > 0 && result.height > 0, 'size');
  // MediaRecorder's start event fires after start() was asked for, and was
  // reported before the recorder showed as recording.
  assert.ok(result.startLocal >= beforeStart && result.startLocal <= startedKnown,
    `start ${result.startLocal} between ${beforeStart} and ${startedKnown}`);

  const file = path.join(dir, 'webcam.webm');
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file
  ], { encoding: 'utf8' }));
  const duration = Number(probe.format.duration);
  const expected = stopAt - result.startLocal;
  console.log(`webcam.webm: ${probe.streams[0].codec_name} ${probe.streams[0].width}x${probe.streams[0].height}, ` +
    `duration ${duration.toFixed(3)} s for ${expected.toFixed(3)} s recorded, ${fs.statSync(file).size} bytes`);
  assert.ok(Number.isFinite(duration), 'the file has a duration');
  assert.ok(Math.abs(duration - expected) < 0.3, 'duration matches the time recorded');
  // Every frame decodes.
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
  assert.ok(!bubble.isOpen(), 'the bubble closed at stop');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('camera e2e: all checks passed');
}

app.whenReady().then(run).then(() => app.exit(0), (err) => {
  console.error(err);
  app.exit(1);
});
