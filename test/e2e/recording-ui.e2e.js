'use strict';
// The recording additions' UI in real Electron windows: the control bar's
// countdown, recording and paused views, and the picker's new choices. The
// real pages and preload are loaded; main's IPC handlers are replaced by
// small stand-ins that record what the page asked for, so no helper runs.
// Screenshots go to test/e2e/out/ for a look.
//
//   node_modules/.bin/electron test/e2e/recording-ui.e2e.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { DEFAULT_SETTINGS } = require('../../src/main/settings');
const {
  RECORDING_DEFAULTS, applyRecordingSettingsPatch
} = require('../../src/main/recording-settings');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const PRELOAD = path.join(ROOT, 'src', 'preload', 'preload.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const calls = [];
let recordingSettings = { ...RECORDING_DEFAULTS };
function handle(channel, fn = () => undefined) {
  ipcMain.handle(channel, (_e, ...args) => {
    calls.push({ channel, args });
    return fn(...args);
  });
}

async function waitFor(win, expression, what) {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await win.webContents.executeJavaScript(expression)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
}

// Destroying a window and loading the next page at once can abort that load
// (the page's renderer process is still being torn down): wait for it.
function closeWindow(win) {
  return new Promise((resolve) => { win.once('closed', resolve); win.close(); });
}

const visible = (id) => `!document.getElementById(${JSON.stringify(id)}).hidden`;
const text = (id) => `document.getElementById(${JSON.stringify(id)}).textContent`;

async function barChecks() {
  const win = new BrowserWindow({
    width: 420, height: 96, show: false, frame: false, backgroundColor: '#000000',
    webPreferences: { preload: PRELOAD }
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'bar', 'index.html'));
  const send = (d) => win.webContents.send('bar:update', d);
  const js = (e) => win.webContents.executeJavaScript(e);
  const armed = { state: 'armed', sourceLabel: 'Display 1', canPickArea: true,
    sourceKind: 'display', areaMode: 'full', cameraOn: false, cameraError: null,
    pauseShortcut: 'Control+Alt+P' };

  // A camera that was wanted but is not allowed is said on the armed bar.
  send({ ...armed, cameraError: 'Loupe is not allowed to use the camera' });
  await waitFor(win, `${text('armedNote')}.includes('not allowed')`, 'the camera note');
  await shot(win, 'bar-armed-camera-note');

  // 3-2-1: the number is shown, the other views are hidden, Cancel asks main.
  for (const count of [3, 2, 1]) {
    send({ ...armed, state: 'countdown', count });
    await waitFor(win, `${text('count')} === '${count}'`, `count ${count}`);
  }
  assert.ok(await js(visible('countdown')), 'countdown view shown');
  assert.ok(!(await js(visible('armed'))) && !(await js(visible('recording'))));
  assert.ok((await js(text('countdown'))).includes('Press Esc to cancel'));
  await shot(win, 'bar-countdown');
  await js('document.getElementById("cancelCountdown").click()');
  await waitFor(win, 'true', 'click');
  await sleep(100);
  assert.ok(calls.some((c) => c.channel === 'bar:cancelCountdown'), 'Cancel reached main');

  // Recording: Pause button with its shortcut in the tooltip.
  const recording = { ...armed, state: 'recording', zoom: 1, zoomEnabled: true, tapReenables: 0,
    hasMic: false, micRequested: false, elapsed: 65.4, paused: false, warnings: [] };
  send(recording);
  await waitFor(win, visible('recording'), 'the recording view');
  assert.strictEqual(await js(text('time')), '1:05');
  const expectedKeys = process.platform === 'win32' ? 'Ctrl+Alt+P' : '⌃⌥P';
  assert.strictEqual(await js('document.getElementById("pause").title'), `Pause (${expectedKeys})`);
  assert.ok(!(await js(visible('pausedLabel'))));
  assert.ok(await js('getComputedStyle(document.getElementById("pauseIcon")).display !== "none"'));
  assert.ok(await js('getComputedStyle(document.getElementById("resumeIcon")).display === "none"'));
  await shot(win, 'bar-recording');
  await js('document.getElementById("pause").click()');
  await sleep(100);
  assert.ok(calls.some((c) => c.channel === 'bar:pause'), 'Pause reached main');

  // Paused: label, resume icon, amber dot, and the button now resumes.
  send({ ...recording, paused: true });
  await waitFor(win, visible('pausedLabel'), 'the paused label');
  // Drawn or not, as the page shows it (an SVG's .hidden is not the attribute).
  const shown = (id) => js(`getComputedStyle(document.getElementById(${JSON.stringify(id)})).display !== 'none'`);
  assert.ok(await shown('resumeIcon'), 'resume icon shown');
  assert.ok(!(await shown('pauseIcon')), 'pause icon hidden');
  assert.strictEqual(await js('document.getElementById("recDot").className'), 'dot paused');
  assert.strictEqual(await js('document.getElementById("pause").title'), `Resume (${expectedKeys})`);
  await shot(win, 'bar-paused');
  await js('document.getElementById("pause").click()');
  await sleep(100);
  assert.ok(calls.some((c) => c.channel === 'bar:resume'), 'Resume reached main');

  // Computer sound that failed shows as a short warning.
  send({ ...recording, warnings: ['computer sound stopped recording'] });
  await waitFor(win, `${text('warn')} === 'computer sound off'`, 'the computer sound warning');
  await closeWindow(win);
}

async function pickerChecks() {
  const win = new BrowserWindow({
    width: 940, height: 800, show: false, webPreferences: { preload: PRELOAD }
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'picker', 'index.html'));
  const js = (e) => win.webContents.executeJavaScript(e);
  const checked = (id) => js(`document.getElementById(${JSON.stringify(id)}).checked`);

  await waitFor(win, 'document.getElementById("countdown").checked', 'saved choices shown');
  assert.strictEqual(await checked('systemAudio'), false);
  assert.strictEqual(await checked('recordKeys'), true);
  assert.strictEqual(await checked('camera'), false);
  const labels = await js('[...document.querySelectorAll(".optionrow label")].map((l) => l.textContent.trim())');
  for (const want of ['Record computer sound', 'Camera', 'Show keyboard shortcuts I press (never what I type)',
    'Count down 3, 2, 1 before recording']) {
    assert.ok(labels.some((l) => l.endsWith(want)), `row "${want}" in ${JSON.stringify(labels)}`);
  }

  // Each switch is saved as soon as it changes.
  await js('document.getElementById("systemAudio").click()');
  await js('document.getElementById("countdown").click()');
  await waitFor(win, 'true', 'clicks');
  await sleep(200);
  assert.strictEqual(recordingSettings.systemAudio, true);
  assert.strictEqual(recordingSettings.countdown, false);

  // Camera on: permission asked, a (fake) camera found, the choice saved.
  await js('document.getElementById("camera").click()');
  const deadline = Date.now() + 5000;
  while (!recordingSettings.camera) {
    if (Date.now() > deadline) throw new Error('camera choice never saved');
    await sleep(50);
  }
  assert.ok(calls.some((c) => c.channel === 'permissions:requestCamera'));
  assert.strictEqual(await checked('camera'), true);
  await js('window.scrollTo(0, document.body.scrollHeight)');
  await shot(win, 'picker-recording-choices');

  // Camera refused: the switch goes back off with a way to the settings.
  cameraAllowed = false;
  await js('document.getElementById("camera").click()'); // off
  await sleep(100);
  await js('document.getElementById("camera").click()'); // on again, refused
  await waitFor(win, '!document.getElementById("banner").hidden', 'the camera banner');
  assert.strictEqual(await checked('camera'), false);
  assert.ok((await js(text('banner'))).includes('permission to use the camera'));
  assert.strictEqual(recordingSettings.camera, false);
  await shot(win, 'picker-camera-refused');
  await closeWindow(win);
}

let cameraAllowed = true;

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  handle('sources:list', () => [{
    source: 'display:1', kind: 'display', title: 'Display 1', width: 1470, height: 956, x: 0, y: 0
  }]);
  handle('permissions:status', () => ({
    screenRecording: true, accessibility: true, microphone: 'granted', canRecord: true, canZoom: true
  }));
  handle('permissions:open');
  handle('settings:get', () => ({ ...DEFAULT_SETTINGS }));
  handle('settings:set', (patch) => ({ ...DEFAULT_SETTINGS, ...patch }));
  handle('recordingSettings:get', () => recordingSettings);
  handle('recordingSettings:set', (patch) => {
    recordingSettings = applyRecordingSettingsPatch(recordingSettings, patch);
    return recordingSettings;
  });
  handle('permissions:requestCamera', () => cameraAllowed);
  for (const c of ['bar:pause', 'bar:resume', 'bar:cancelCountdown', 'bar:start', 'record:stop',
    'bar:setAreaMode', 'bar:arm']) handle(c);

  await barChecks();
  await pickerChecks();
  console.log(`recording UI e2e: all checks passed (screenshots in ${OUT})`);
}

app.whenReady().then(run).then(() => app.exit(0), (err) => {
  console.error(err);
  app.exit(1);
});
