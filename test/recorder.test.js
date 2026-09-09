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
  const stopped = [];
  const stopHelper = async (child) => {
    stopped.push(child.name);
    child._exit?.(0);
    return 0;
  };
  const rec = createRecorder({ binDir: '/fake', spawnHelper, stopHelper });
  return { rec, sinks, children, stopped };
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

test('duration from a prior recording does not leak into the next one', async () => {
  const { rec, sinks } = harness();

  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });
  sinks.capture({ type: 'started', clock: 0 });
  sinks.capture({ type: 'stopped', duration: 42 });
  await rec.stop();

  // Second recording: capture starts but never emits 'stopped' before stop()
  // is called (e.g. the process died). duration must not still read 42.
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/y' });
  assert.strictEqual(rec.state().duration, 0, 'duration should reset on start()');
  sinks.capture({ type: 'started', clock: 0 });

  const { project } = await rec.stop();
  assert.strictEqual(project.capture.duration, 0);
});

test('inputChild is not a stale reference from a previous recording once zoom is disabled', async () => {
  const { rec, sinks, stopped } = harness();

  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x', zoomEnabled: true });
  sinks.capture({ type: 'started', clock: 0 });
  await rec.stop();

  stopped.length = 0;
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/y', zoomEnabled: false });
  sinks.capture({ type: 'started', clock: 0 });
  await rec.stop();

  assert.ok(!stopped.includes('inputtap'), 'no inputtap child should exist to stop in a zoom-disabled session');
});

test('start then start again resets clicks, cursor track and tap re-enable count', async () => {
  const { rec, sinks } = harness();

  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });
  sinks.capture({ type: 'started', clock: 0 });
  sinks.inputtap({ type: 'click', clock: 1, x: 1, y: 1, button: 'left' });
  sinks.inputtap({ type: 'tap_reenabled', clock: 1 });
  await rec.stop();

  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/y' });
  const s = rec.state();
  assert.strictEqual(s.clicks.length, 0);
  assert.strictEqual(s.cursorTrack.length, 0);
  assert.strictEqual(s.tapReenables, 0);
});

test('stop() before start() is a clean no-op rather than throwing', async () => {
  const { rec } = harness();
  const result = await rec.stop();
  assert.strictEqual(result, null, 'nothing to stop should resolve to null');
  assert.strictEqual(rec.state().recording, false);
});

test('a capture spawn failure tears down an already-running inputtap so it is not orphaned', async () => {
  const captureErr = new Error('ENOENT capture');
  const { rec, stopped } = harness({ onError: { capture: captureErr } });

  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x', zoomEnabled: true });

  // Allow the queued timer (simulating the async 'error' event) to run.
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(stopped.includes('inputtap'), 'inputtap should be stopped when capture fails to spawn');

  // stop() afterwards must not misbehave (e.g. double-stop / throw).
  await assert.doesNotReject(rec.stop());
});

// A fake for the three new tests below where timing must be driven by the
// test itself rather than a fixed setTimeout(0): each spawnHelper() call is
// recorded (with its opts, so the test can invoke onMessage/onError/onExit
// whenever it chooses) and each stopHelper() call returns a promise the test
// controls the resolution of.
function controllableHarness({ onError } = {}) {
  const spawns = []; // { name, opts, child }
  const stopCalls = []; // { child, resolve }
  const spawnHelper = (bin, args, opts) => {
    const name = bin.endsWith('capture') ? 'capture' : 'inputtap';
    const child = {
      name, kill() {}, exitCode: null, signalCode: null,
      once(evt, cb) { if (evt === 'exit') this._exit = cb; }
    };
    spawns.push({ name, opts, child });
    return child;
  };
  const stopHelper = (child) => new Promise((resolve) => {
    stopCalls.push({ child, resolve });
  });
  const rec = createRecorder({ binDir: '/fake', spawnHelper, stopHelper, onError });
  return { rec, spawns, stopCalls };
}

// Resolves stopHelper() calls as stop() queues them (it awaits them one at a
// time, so a fixed number of "resolve whatever is pending, then yield twice"
// rounds is enough to drain a normal two-child stop() to completion) and
// returns its settled result.
async function finishStop(stopCalls, promise) {
  const resolved = new Set();
  for (let round = 0; round < 6; round++) {
    for (const call of stopCalls) {
      if (!resolved.has(call)) {
        resolved.add(call);
        call.resolve(0);
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  return promise;
}

test('a delayed error from a previous session does not tear down the current session or misattribute state', async () => {
  const seen = [];
  const { rec, spawns, stopCalls } = controllableHarness({ onError: (e) => seen.push(e) });

  // Session 1: start and cleanly stop it.
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });
  const session1Capture = spawns.find((s) => s.name === 'capture');
  session1Capture.opts.onMessage({ type: 'started', clock: 0 });
  session1Capture.opts.onMessage({ type: 'stopped', duration: 1 });

  const stopSession1 = rec.stop();
  await finishStop(stopCalls, stopSession1);

  // Session 2: a different recording, now in progress.
  await rec.start({ source: 'display:2', mic: false, dir: '/tmp/y' });
  const session2Capture = spawns.filter((s) => s.name === 'capture').pop();
  session2Capture.opts.onMessage({ type: 'started', clock: 0 });

  // A delayed 'error' event from session 1's long-dead capture process
  // arrives only now, after session 2 has started.
  session1Capture.opts.onError(new Error('late failure from session 1'));

  const s = rec.state();
  assert.strictEqual(s.error, null, 'session 2 state must not be overwritten by session 1 error');
  assert.strictEqual(s.recording, true, 'session 2 must still be recording');
  assert.strictEqual(seen.length, 0, "the caller's onError must not fire for a stale session");
});

test('stop() called twice after a successful recording saves once and the second call is falsy', async () => {
  const { rec, spawns, stopCalls } = controllableHarness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });
  const capture = spawns.find((s) => s.name === 'capture');
  capture.opts.onMessage({ type: 'started', clock: 0 });
  capture.opts.onMessage({ type: 'stopped', duration: 5 });

  const stopPromise = rec.stop();
  const first = await finishStop(stopCalls, stopPromise);
  assert.ok(first && first.project, 'first stop() should succeed and return the saved project');

  const second = await rec.stop();
  assert.strictEqual(second, null, 'second stop() should be a clean no-op');
});

test("a delayed capture error during stop()'s await does not double-stop the same inputtap child", async () => {
  const { rec, spawns, stopCalls } = controllableHarness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });
  const capture = spawns.find((s) => s.name === 'capture');
  capture.opts.onMessage({ type: 'started', clock: 0 });

  const stopPromise = rec.stop();
  // stop() has synchronously reached and called stopHelper(inputChild); it is
  // now suspended on that await, with captureChild's stopHelper not yet called.
  assert.strictEqual(stopCalls.length, 1);
  assert.strictEqual(stopCalls[0].child.name, 'inputtap');

  // Fire the delayed capture 'error' while stop() is mid-await on the very
  // child it is already tearing down.
  capture.opts.onError(new Error('late capture failure'));

  // Let stop() finish: resolve the input stopHelper call, then whatever
  // capture-side call follows.
  await finishStop(stopCalls, stopPromise);

  const inputStopCount = stopCalls.filter((c) => c.child.name === 'inputtap').length;
  assert.strictEqual(inputStopCount, 1, 'inputtap must be stopped exactly once, not raced');
});

test('an optional onError callback fires immediately, without waiting for a state() poll', async () => {
  const tapErr = new Error('ENOENT inputtap');
  const sinks = {};
  const spawnHelper = (bin, args, opts) => {
    const name = bin.endsWith('capture') ? 'capture' : 'inputtap';
    sinks[name] = opts.onMessage;
    if (name === 'inputtap') {
      setTimeout(() => { opts.onError(tapErr); opts.onExit(null, null); }, 0);
    }
    return { name, kill() {}, exitCode: null, signalCode: null, once() {} };
  };
  const stopHelper = async () => 0;

  const seen = [];
  const rec = createRecorder({ binDir: '/fake', spawnHelper, stopHelper, onError: (e) => seen.push(e) });
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });

  await new Promise((r) => setTimeout(r, 10));

  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].source, 'inputtap');
});
