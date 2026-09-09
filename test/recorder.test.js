'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createRecorder } = require('../src/main/recorder');

// A fake helper pair: capture and inputtap are driven manually by the test.
function harness({ onError } = {}) {
  const sinks = {};
  const children = {};
  const spawnHelper = (bin, args, opts) => {
    const name = bin.endsWith('capture') ? 'capture' : 'inputtap';
    sinks[name] = opts.onMessage;
    if (onError && onError[name]) {
      // Simulate spawnHelper's real contract: onError fires, then onExit(null, null) exactly once.
      const err = onError[name];
      setTimeout(() => {
        opts.onError ? opts.onError(err) : null;
        opts.onExit(null, null);
      }, 0);
    }
    const child = {
      name, kill() {}, exitCode: null, signalCode: null,
      once(evt, cb) { if (evt === 'exit') this._exit = cb; }
    };
    children[name] = child;
    return child;
  };
  const stopHelper = async (child) => { child._exit?.(0); return 0; };
  const rec = createRecorder({ binDir: '/fake', spawnHelper, stopHelper });
  return { rec, sinks, children };
}

test('gesture events arriving before the first frame are rebased, not lost', async () => {
  const { rec, sinks } = harness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });

  sinks.inputtap({ type: 'zoom', clock: 1000.5, dy: 10, x: 100, y: 100 });
  sinks.capture({ type: 'started', clock: 1000.0 });

  const kf = rec.state().zoomKeyframes;
  assert.strictEqual(kf.length, 1);
  assert.ok(Math.abs(kf[0].t - 0.5) < 1e-9, `t was ${kf[0].t}`);
});

test('events from before the first frame are discarded', async () => {
  const { rec, sinks } = harness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });

  sinks.inputtap({ type: 'zoom', clock: 999.0, dy: 10, x: 100, y: 100 });
  sinks.capture({ type: 'started', clock: 1000.0 });

  assert.strictEqual(rec.state().zoomKeyframes.length, 0);
});

test('clicks and cursor samples are rebased to source time', async () => {
  const { rec, sinks } = harness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });
  sinks.capture({ type: 'started', clock: 100 });
  sinks.inputtap({ type: 'click', clock: 102.5, x: 10, y: 20, button: 'left' });
  sinks.inputtap({ type: 'cursor', clock: 103, x: 30, y: 40, shape: 'ibeam' });

  const s = rec.state();
  assert.strictEqual(s.clicks[0].t, 2.5);
  assert.strictEqual(s.cursorTrack[0].t, 3);
  assert.strictEqual(s.cursorTrack[0].shape, 'ibeam');
});

test('tap re-enable events are counted rather than treated as gestures', async () => {
  const { rec, sinks } = harness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });
  sinks.capture({ type: 'started', clock: 0 });
  sinks.inputtap({ type: 'tap_reenabled', clock: 1 });
  assert.strictEqual(rec.state().tapReenables, 1);
  assert.strictEqual(rec.state().zoomKeyframes.length, 0);
});

test('recording proceeds when the input tap never becomes ready', async () => {
  const { rec, sinks } = harness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x', zoomEnabled: false });
  sinks.capture({ type: 'started', clock: 0 });
  assert.strictEqual(rec.state().zoomEnabled, false);
  assert.strictEqual(rec.state().recording, true);
});

test('stop() records the real source width, height and title on project.source', async () => {
  const { rec, sinks } = harness();
  await rec.start({
    source: 'display:1', mic: false, dir: '/tmp/x',
    width: 1920, height: 1080, title: 'Built-in Display'
  });
  sinks.capture({ type: 'started', clock: 0 });
  sinks.capture({ type: 'stopped', duration: 5 });

  const { project } = await rec.stop();
  assert.strictEqual(project.source.width, 1920);
  assert.strictEqual(project.source.height, 1080);
  assert.strictEqual(project.source.title, 'Built-in Display');
});

test('a capture helper spawn failure is surfaced distinctly from an inputtap failure', async () => {
  const captureErr = new Error('ENOENT capture');
  const { rec } = harness({ onError: { capture: captureErr } });
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });

  // Allow the queued timer (simulating the async 'error' event) to run.
  await new Promise((r) => setTimeout(r, 10));

  const s = rec.state();
  assert.ok(s.error, 'expected an error to be recorded');
  assert.strictEqual(s.error.source, 'capture');
  assert.strictEqual(s.recording, false, 'losing capture should stop the recording');
});

test('an inputtap spawn failure is surfaced but does not stop the recording', async () => {
  const tapErr = new Error('ENOENT inputtap');
  const { rec } = harness({ onError: { inputtap: tapErr } });
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });

  await new Promise((r) => setTimeout(r, 10));

  const s = rec.state();
  assert.ok(s.error, 'expected an error to be recorded');
  assert.strictEqual(s.error.source, 'inputtap');
  assert.strictEqual(s.recording, true, 'losing the gesture hook should not stop recording');
});
