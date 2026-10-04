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

  // Restart sits beside Pause and Stop, and asks on the bar itself first.
  send(recording);
  await waitFor(win, `${text('warn')} === ''`, 'the plain recording view');
  const order = await js('[...document.querySelectorAll("#recording button")].map((b) => b.id)');
  assert.deepStrictEqual(order, ['restart', 'pause', 'stop']);
  assert.strictEqual(await js('document.getElementById("restart").title'), 'Restart');
  await js('document.getElementById("restart").click()');
  await waitFor(win, visible('restartConfirm'), 'the question');
  assert.ok(!(await js(visible('recording'))), 'the question takes the place of the recording view');
  assert.strictEqual(await js(text('restartQuestion')), 'Start over? This recording is thrown away.');
  assert.deepStrictEqual(await js('[...document.querySelectorAll("#restartConfirm button")].map((b) => b.textContent)'),
    ['Keep recording', 'Start over']);
  // The recording carries on underneath: updates do not put the question away.
  send({ ...recording, elapsed: 70 });
  await sleep(100);
  assert.ok(await js(visible('restartConfirm')), 'still asking');
  await shot(win, 'bar-restart-question');
  assert.ok(!calls.some((c) => c.channel === 'bar:restart'), 'nothing is thrown away before the answer');

  // Keep recording: back to the recording view, and main never hears of it.
  await js('document.getElementById("keepRecording").click()');
  await waitFor(win, visible('recording'), 'the recording view again');
  assert.ok(!(await js(visible('restartConfirm'))));
  assert.strictEqual(await js(text('time')), '1:10');
  assert.ok(!calls.some((c) => c.channel === 'bar:restart'));

  // Start over, countdown on: main is asked once, 3-2-1 shows, then the new take.
  let finishRestart;
  restartAnswer = () => new Promise((resolve) => { finishRestart = resolve; });
  await js('document.getElementById("restart").click()');
  await js('document.getElementById("startOver").click()');
  await waitFor(win, `${text('restartQuestion')} === 'Starting over…'`, 'starting over');
  assert.strictEqual(calls.filter((c) => c.channel === 'bar:restart').length, 1);
  assert.ok(await js('document.getElementById("startOver").hidden && document.getElementById("keepRecording").hidden'));
  send({ ...armed, state: 'restarting' });
  await sleep(50);
  assert.ok(await js(visible('restartConfirm')), 'nothing changes while the old take stops');
  await shot(win, 'bar-restart-starting-over');
  send({ ...armed, state: 'countdown', count: 3 });
  await waitFor(win, visible('countdown'), 'the countdown after Restart');
  assert.ok(!(await js(visible('restartConfirm'))));
  send({ ...recording, elapsed: 0 });
  finishRestart({ dir: '/tmp/new-take' });
  await waitFor(win, visible('recording'), 'the new take');
  assert.strictEqual(await js(text('time')), '0:00');
  assert.ok(!(await js(visible('restartConfirm'))) && !(await js(visible('countdown'))));

  // The question can be asked again, and reads as it did the first time.
  await js('document.getElementById("restart").click()');
  assert.strictEqual(await js(text('restartQuestion')), 'Start over? This recording is thrown away.');
  assert.ok(await js('!document.getElementById("startOver").hidden && !document.getElementById("keepRecording").hidden'));

  // Start over, then Esc in the countdown: the armed bar, with Start usable.
  await js('document.getElementById("start").disabled = true'); // as the first Start left it
  restartAnswer = () => new Promise((resolve) => { finishRestart = resolve; });
  await js('document.getElementById("startOver").click()');
  await waitFor(win, `${text('restartQuestion')} === 'Starting over…'`, 'starting over again');
  send({ ...armed, state: 'countdown', count: 3 });
  await waitFor(win, visible('countdown'), 'the countdown');
  send(armed);
  finishRestart({ cancelled: true });
  await waitFor(win, `${visible('armed')} && !document.getElementById("start").disabled`, 'the armed bar with Start ready');
  assert.ok(!(await js(visible('restartConfirm'))) && !(await js(visible('recording'))));

  // The new take could not start: the armed bar says why.
  send(recording);
  await waitFor(win, visible('recording'), 'recording once more');
  restartAnswer = () => { throw new Error('Screen Recording permission is required'); };
  await js('document.getElementById("restart").click()');
  send(armed);
  await js('document.getElementById("startOver").click()');
  await waitFor(win, `${text('sourceLabel')}.startsWith('Could not start recording')`, 'the reason');
  assert.strictEqual(await js(text('sourceLabel')), 'Could not start recording: Screen Recording permission is required');
  assert.ok(await js(visible('armed')));
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
  // One row of six on/off buttons: a short label each, the full wording as
  // the tooltip.
  const toggles = await js(`[...document.querySelectorAll('.options .toggle')].map((l) => ({
    id: l.querySelector('input').id, label: l.textContent.trim(), title: l.title,
    top: Math.round(l.getBoundingClientRect().top) }))`);
  assert.deepStrictEqual(toggles.map((t) => [t.id, t.label, t.title]), [
    ['mic', 'Microphone', 'Record microphone'],
    ['systemAudio', 'Computer sound', 'Record computer sound'],
    ['camera', 'Camera', 'Add yourself to the recording with the camera'],
    ['recordKeys', 'Shortcuts', 'Show keyboard shortcuts I press (never what I type)'],
    ['autoZoom', 'Zoom on clicks', 'Zoom in where I click, once the recording is done. Change or remove the zooms afterwards.'],
    ['countdown', 'Countdown', 'Count down 3, 2, 1 before recording']
  ]);
  assert.strictEqual(new Set(toggles.map((t) => t.top)).size, 1, `all on one row: ${JSON.stringify(toggles)}`);
  // On looks on: the button itself changes, not only the checkbox inside it.
  const background = (id) => `getComputedStyle(document.getElementById(${JSON.stringify(id)}).closest('.toggle')).backgroundColor`;
  await waitFor(win, `${background('countdown')} === 'rgb(138, 180, 248)'`, 'Countdown drawn as on');
  assert.strictEqual(await js(background('systemAudio')), 'rgba(255, 255, 255, 0.1)', 'Computer sound drawn as off');
  // The freed height goes to the sources: the strip is one line, and the
  // list and preview take most of the window.
  const heights = await js(`({ strip: document.querySelector('.options').offsetHeight,
    panel: document.querySelector('.panel').offsetHeight, page: innerHeight })`);
  assert.ok(heights.strip < 50, `a one-line strip: ${JSON.stringify(heights)}`);
  assert.ok(heights.panel > heights.page * 0.6, `the sources fill the window: ${JSON.stringify(heights)}`);
  // The zoom shortcuts are chosen in Settings now; the hint still names them.
  assert.strictEqual(await js('document.querySelectorAll(".capture, .clear").length'), 0);
  const expectedHint = process.platform === 'win32' ? /^Hold Alt or a mouse side button and scroll while recording/
    : /^Hold ⌥ or a mouse side button and scroll while recording/;
  assert.match(await js(text('zoomHelp')), expectedHint);
  await js('document.getElementById("changeZoom").click()');
  await sleep(100);
  assert.deepStrictEqual(calls.find((c) => c.channel === 'shell:openSettings')?.args, ['recording']);

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
// What main answers the bar's Restart with, set by the check in hand.
let restartAnswer = () => ({ dir: '/tmp/new-take' });

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  handle('sources:list', () => [{
    source: 'display:1', kind: 'display', title: 'Display 1', width: 1470, height: 956, x: 0, y: 0
  }]);
  handle('permissions:status', () => ({
    screenRecording: true, accessibility: true, microphone: 'granted', canRecord: true, canZoom: true
  }));
  handle('permissions:open');
  handle('shell:openSettings');
  handle('settings:get', () => ({ ...DEFAULT_SETTINGS }));
  handle('settings:set', (patch) => ({ ...DEFAULT_SETTINGS, ...patch }));
  handle('recordingSettings:get', () => recordingSettings);
  handle('recordingSettings:set', (patch) => {
    recordingSettings = applyRecordingSettingsPatch(recordingSettings, patch);
    return recordingSettings;
  });
  handle('permissions:requestCamera', () => cameraAllowed);
  handle('bar:restart', () => restartAnswer());
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
