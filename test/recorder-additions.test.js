'use strict';
// recorder.js's recording additions: keystrokes, pause ranges, computer
// sound and the webcam's offset, with fake helpers and a fake main-process
// clock deliberately far from the helpers' clock (as on a Mac that has
// slept), so every mapping has to go through clock-sync.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRecorder } = require('../src/main/recorder');

// Main clock = helper clock + OFFSET, and lines arrive DELAY later.
const OFFSET = 225902;
const DELAY = 0.0005;

function harness({ platform = 'darwin' } = {}) {
  const sinks = {};
  const argsFor = {};
  let local = 0;
  const spawnHelper = (bin, args, opts) => {
    const name = bin.endsWith('capture') || args[0] === 'capture' ? 'capture' : 'inputtap';
    sinks[name] = opts.onMessage;
    argsFor[name] = args;
    return { name, kill() {}, exitCode: null, signalCode: null, once() {} };
  };
  const rec = createRecorder({
    binDir: '/fake', spawnHelper, stopHelper: async () => 0, platform, now: () => local
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-rec-'));
  // Delivers a helper line written at helper time `at`, and advances the
  // main clock to its arrival.
  const deliver = (name, msg, at) => {
    local = at + OFFSET + DELAY;
    sinks[name](msg);
  };
  const setLocalFromHelper = (helperTime) => { local = helperTime + OFFSET; };
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { rec, sinks, argsFor, deliver, setLocalFromHelper, dir, cleanup };
}

async function startAt(h, opts = {}, clock = 1000) {
  await h.rec.start({ source: 'display:1', mic: false, dir: h.dir, width: 800, height: 600, ...opts });
  h.deliver('capture', { type: 'started', clock, now: clock }, clock);
}

test('keystrokes are asked for, rebased like clicks and written to keys.json', async () => {
  const h = harness();
  await startAt(h, { keys: true });
  assert.deepStrictEqual(h.argsFor.inputtap.slice(-2), ['--keys', '1']);

  h.deliver('inputtap', { type: 'key', clock: 999, label: '⌘C' }, 999); // before the first frame
  h.deliver('inputtap', { type: 'key', clock: 1002.5, label: '⇧⌘K' }, 1002.5);
  h.deliver('inputtap', { type: 'key', clock: 1003, label: '' }, 1003);          // not a label
  h.deliver('inputtap', { type: 'key', clock: 1003, label: 'a\nb' }, 1003);      // not a label
  h.deliver('capture', { type: 'stopped', duration: 5, now: 1005 }, 1005);
  assert.deepStrictEqual(h.rec.state().keys, [{ t: 2.5, label: '⇧⌘K' }]);

  const { recording: project } = await h.rec.stop();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(h.dir, 'keys.json'), 'utf8')),
    [{ t: 2.5, label: '⇧⌘K' }]);
  assert.strictEqual(project.sources.main.keys, 'keys.json');
  h.cleanup();
});

test('without the keys option inputtap is not asked for them and none are kept', async () => {
  const h = harness();
  await startAt(h);
  assert.ok(!h.argsFor.inputtap.includes('--keys'));
  h.deliver('inputtap', { type: 'key', clock: 1001, label: '⌘C' }, 1001);
  const { recording: project } = await h.rec.stop();
  assert.deepStrictEqual(h.rec.state().keys, []);
  assert.strictEqual(project.sources.main.keys, null);
  assert.ok(!fs.existsSync(path.join(h.dir, 'keys.json')));
  h.cleanup();
});

test('keystrokes need the input hook: no zoom permission, no keys', async () => {
  const h = harness();
  await startAt(h, { keys: true, zoomEnabled: false });
  assert.strictEqual(h.argsFor.inputtap, undefined);
  const { recording: project } = await h.rec.stop();
  assert.strictEqual(project.sources.main.keys, null);
  h.cleanup();
});

test('computer sound: the flag reaches capture, and the reported file lands in the project', async () => {
  const h = harness();
  await startAt(h, { systemAudio: true });
  assert.deepStrictEqual(h.argsFor.capture.slice(-2), ['--system-audio', '1']);
  h.deliver('capture', { type: 'system_audio', file: 'system.m4a' }, 1000.1);
  h.deliver('capture', { type: 'stopped', duration: 3, now: 1003 }, 1003);
  assert.strictEqual(h.rec.state().systemAudio, 'system.m4a');
  const { recording: project } = await h.rec.stop();
  assert.strictEqual(project.sources.main.systemAudio, 'system.m4a');
  h.cleanup();
});

test('computer sound that never started is null, and a warning does not stop the recording', async () => {
  const h = harness();
  await startAt(h, { systemAudio: true });
  h.deliver('capture', { type: 'warning', message: 'computer sound stopped recording: x' }, 1001);
  const s = h.rec.state();
  assert.strictEqual(s.recording, true);
  assert.strictEqual(s.error, null);
  assert.deepStrictEqual(s.warnings, ['computer sound stopped recording: x']);
  const { recording: project } = await h.rec.stop();
  assert.strictEqual(project.sources.main.systemAudio, null);
  h.cleanup();
});

test('an unexpected computer-sound file name is not trusted', async () => {
  const h = harness({ platform: 'win32' });
  await startAt(h, { systemAudio: true });
  h.deliver('capture', { type: 'system_audio', file: '../../evil.m4a' }, 1001);
  const { recording: project } = await h.rec.stop();
  assert.strictEqual(project.sources.main.systemAudio, null);
  assert.strictEqual(project.sources.main.video, 'raw.mp4');
  h.cleanup();
});

test('computer sound is not asked for unless chosen', async () => {
  const h = harness();
  await startAt(h);
  assert.ok(!h.argsFor.capture.includes('--system-audio'));
  h.deliver('capture', { type: 'system_audio', file: 'system.m4a' }, 1001);
  assert.strictEqual(h.rec.state().systemAudio, null);
  h.cleanup();
});

test('pauses are measured on the main clock and saved in source time, cut out of the clips', async () => {
  const h = harness();
  await startAt(h, {}, 1000);
  // Cursor lines keep the clock mapping fresh, as in a real recording.
  h.deliver('inputtap', { type: 'cursor', clock: 1001, x: 1, y: 1, shape: 'arrow' }, 1001);

  h.setLocalFromHelper(1002);
  assert.strictEqual(h.rec.pause(), true);
  assert.strictEqual(h.rec.pause(), false, 'already paused');
  h.setLocalFromHelper(1004.5);
  assert.strictEqual(h.rec.state().paused, true);
  assert.ok(Math.abs(h.rec.state().pausedSeconds - 2.5) < 1e-9);
  assert.strictEqual(h.rec.resume(), true);
  assert.strictEqual(h.rec.state().paused, false);

  h.setLocalFromHelper(1007);
  h.rec.pause(); // still paused when Stop is pressed at 1008
  h.deliver('capture', { type: 'stopped', duration: 9, now: 1008 }, 1008 - DELAY);
  h.setLocalFromHelper(1008);

  const { recording: project } = await h.rec.stop();
  const pauses = project.sources.main.pauses;
  assert.strictEqual(pauses.length, 2);
  // Off by at most the quickest line delivery (DELAY).
  const near = (a, b) => Math.abs(a - b) <= DELAY + 1e-6;
  assert.ok(near(pauses[0].start, 2) && near(pauses[0].end, 4.5), JSON.stringify(pauses));
  assert.ok(near(pauses[1].start, 7) && near(pauses[1].end, 8), JSON.stringify(pauses));
  assert.deepStrictEqual(project.clips.map((c) => c.source), ['main', 'main', 'main']);
  assert.ok(near(project.clips[0].end, 2) && near(project.clips[1].start, 4.5));
  assert.ok(near(project.clips[2].start, 8) && project.clips[2].end === 9);
  h.cleanup();
});

test('pause and resume do nothing when not recording', async () => {
  const h = harness();
  assert.strictEqual(h.rec.pause(), false);
  assert.strictEqual(h.rec.resume(), false);
  h.cleanup();
});

test("the webcam's offset is its first frame's main-clock moment in source time", async () => {
  const h = harness();
  await startAt(h, {}, 5000);
  h.deliver('capture', { type: 'progress', frames: 60, bytes: 1, now: 5001 }, 5001);
  // The camera's first frame was taken 0.12 s before the first screen frame
  // (the bubble starts recording just before capture does).
  const webcam = { file: 'webcam.webm', startLocal: 5000 - 0.12 + OFFSET, width: 640, height: 480 };
  h.deliver('capture', { type: 'stopped', duration: 2, now: 5002 }, 5002);
  const { recording: project } = await h.rec.stop({ webcam });
  const cam = project.sources.main.webcam;
  assert.strictEqual(cam.file, 'webcam.webm');
  assert.strictEqual(cam.width, 640);
  assert.strictEqual(cam.height, 480);
  assert.ok(Math.abs(cam.offset - -0.12) <= DELAY + 1e-6, `offset was ${cam.offset}`);
  h.cleanup();
});

test('stop() writes a version-2 project.json from the recording', async () => {
  const h = harness();
  await h.rec.start({
    source: 'window:7', mic: true, dir: h.dir, width: 800, height: 600, title: 'Notes', x: 10, y: 20
  });
  h.deliver('capture', { type: 'started', clock: 1, now: 1 }, 1);
  h.deliver('inputtap', { type: 'click', clock: 2, x: 15, y: 25, button: 'left' }, 2);
  h.deliver('capture', { type: 'stopped', duration: 4, now: 5 }, 5);
  const { recording, project } = await h.rec.stop();

  assert.strictEqual(recording.capture.file, 'raw.mov');
  assert.deepStrictEqual(recording.sources.main, {
    dir: '.', kind: 'window', id: 'window:7', title: 'Notes', width: 800, height: 600,
    originX: 10, originY: 20, video: 'raw.mov', duration: 4, fps: 60, mic: true,
    systemAudio: null, webcam: null, cursor: 'cursor.bin', keys: null,
    clicks: [{ t: 1, x: 5, y: 5, button: 'left' }], pauses: []
  });
  assert.strictEqual(project.version, 2);
  assert.deepStrictEqual(project.sources.main, recording.sources.main);
  assert.deepStrictEqual(project.clips, [{ id: 'c1', source: 'main', start: 0, end: 4 }]);
  // A new recording gets the new look, not a migrated v1 one.
  assert.strictEqual(project.style.background.type, 'gradient');
  const saved = JSON.parse(fs.readFileSync(path.join(h.dir, 'project.json'), 'utf8'));
  assert.deepStrictEqual(saved, project);
  h.cleanup();
});

test('stop() starts the project from the default preset, and keeps zooms and pauses', async () => {
  const h = harness();
  await startAt(h, {}, 1000);
  h.setLocalFromHelper(1002);
  h.rec.pause();
  h.setLocalFromHelper(1004);
  h.rec.resume();
  h.deliver('capture', { type: 'stopped', duration: 9, now: 1009 }, 1009);
  const style = { background: { type: 'color', value: '#112233' }, padding: 0.1 };
  const { project } = await h.rec.stop({ style });
  assert.strictEqual(project.version, 2);
  assert.deepStrictEqual(project.style.background, { type: 'color', value: '#112233' });
  assert.strictEqual(project.style.padding, 0.1);
  assert.strictEqual(project.style.aspect, 'source', 'the rest keeps its defaults');
  assert.strictEqual(project.clips.length, 2, 'the pause is cut out');
  assert.ok(Math.abs(project.clips[0].end - 2) < 0.01 && Math.abs(project.clips[1].start - 4) < 0.01);
  h.cleanup();
});

test('a preset that is not a valid style never loses the recording', async () => {
  const h = harness();
  await startAt(h, {}, 1000);
  h.deliver('capture', { type: 'stopped', duration: 3, now: 1003 }, 1003);
  const { project } = await h.rec.stop({ style: { padding: 'lots' } });
  assert.strictEqual(project.version, 2);
  assert.strictEqual(project.style.padding, 0.06);
  h.cleanup();
});

test('the microphone chosen in Settings is passed to capture by name, only with the mic on', async () => {
  const h = harness();
  await h.rec.start({ source: 'display:1', mic: true, micName: 'USB Mic', dir: h.dir, width: 800, height: 600 });
  const args = h.argsFor.capture;
  assert.strictEqual(args[args.indexOf('--mic-name') + 1], 'USB Mic');
  h.cleanup();

  const off = harness();
  await off.rec.start({ source: 'display:1', mic: false, micName: 'USB Mic', dir: off.dir, width: 800, height: 600 });
  assert.ok(!off.argsFor.capture.includes('--mic-name'));
  off.cleanup();
});
