'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createRecorder } = require('../src/main/recorder');

// A fake helper pair: capture and inputtap are driven manually by the test.
function harness({ onError } = {}) {
  const sinks = {};
  const children = {};
  const spawnHelper = (bin, args, opts) => {
    // The helper name is the binary (macOS) or its first argument (Windows).
    const name = bin.endsWith('capture') || args[0] === 'capture' ? 'capture' : 'inputtap';
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

  const { recording: project } = await rec.stop();
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

  const { recording: project } = await rec.stop();
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

test('clicks and cursor samples are rebased to source-local coordinates using the source origin', async () => {
  const { rec, sinks } = harness();
  // A window sitting at (400, 200) in global display space, as it would if
  // it were not on the primary display's origin.
  await rec.start({ source: 'window:1', mic: false, dir: '/tmp/x', x: 400, y: 200 });
  sinks.capture({ type: 'started', clock: 100 });
  sinks.inputtap({ type: 'click', clock: 101, x: 450, y: 260, button: 'left' });
  sinks.inputtap({ type: 'cursor', clock: 101.5, x: 500, y: 300, shape: 'arrow' });

  const s = rec.state();
  assert.strictEqual(s.clicks[0].x, 50, 'global 450 minus origin 400 must be 50');
  assert.strictEqual(s.clicks[0].y, 60, 'global 260 minus origin 200 must be 60');
  assert.strictEqual(s.cursorTrack[0].x, 100, 'global 500 minus origin 400 must be 100');
  assert.strictEqual(s.cursorTrack[0].y, 100, 'global 300 minus origin 200 must be 100');
});

test('zoom keyframe cursor positions are also rebased to the source origin', async () => {
  const { rec, sinks } = harness();
  await rec.start({ source: 'window:1', mic: false, dir: '/tmp/x', x: 400, y: 200 });
  sinks.capture({ type: 'started', clock: 0 });
  sinks.inputtap({ type: 'zoom', clock: 1, dy: 10, x: 450, y: 260 });

  const kf = rec.state().zoomKeyframes;
  assert.strictEqual(kf.length, 1);
  assert.strictEqual(kf[0].cx, 50);
  assert.strictEqual(kf[0].cy, 60);
});

test('a source with no origin (or a display at the primary origin) leaves coordinates unchanged', async () => {
  const { rec, sinks } = harness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });
  sinks.capture({ type: 'started', clock: 0 });
  sinks.inputtap({ type: 'cursor', clock: 1, x: 30, y: 40, shape: 'arrow' });

  assert.strictEqual(rec.state().cursorTrack[0].x, 30);
  assert.strictEqual(rec.state().cursorTrack[0].y, 40);
});

test('a negative source origin (a display left of or above the primary) is subtracted correctly', async () => {
  const { rec, sinks } = harness();
  // A secondary display placed to the left of the primary has a negative x
  // origin in global space; recorded coordinates must come out larger than
  // the raw global value, not clamped to zero.
  await rec.start({ source: 'display:2', mic: false, dir: '/tmp/x', x: -1920, y: 0 });
  sinks.capture({ type: 'started', clock: 0 });
  sinks.inputtap({ type: 'cursor', clock: 1, x: -1000, y: 50, shape: 'arrow' });

  assert.strictEqual(rec.state().cursorTrack[0].x, 920, '-1000 minus origin -1920 must be 920');
  assert.strictEqual(rec.state().cursorTrack[0].y, 50);
});

test("stop() records the source's origin onto project.source", async () => {
  const { rec, sinks } = harness();
  await rec.start({
    source: 'window:1', mic: false, dir: '/tmp/x',
    width: 800, height: 600, title: 'Notes', x: 400, y: 200
  });
  sinks.capture({ type: 'started', clock: 0 });
  sinks.capture({ type: 'stopped', duration: 1 });

  const { recording: project } = await rec.stop();
  assert.strictEqual(project.source.originX, 400);
  assert.strictEqual(project.source.originY, 200);
});

test('a helper-reported capture error (not a spawn failure) reaches state().error and stops recording', async () => {
  const { rec, sinks, stopped } = harness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x', zoomEnabled: true });
  sinks.capture({ type: 'started', clock: 0 });

  // The capture helper is still alive (unlike a spawn failure) but has just
  // reported a fatal writer problem via its one {"type":"error"} line.
  sinks.capture({ type: 'error', message: 'video append failed, writer status 3: disk full' });

  const s = rec.state();
  assert.ok(s.error, 'expected an error to be recorded');
  assert.strictEqual(s.error.source, 'capture');
  assert.strictEqual(s.error.message, 'video append failed, writer status 3: disk full');
  assert.strictEqual(s.recording, false, 'a reported writer failure should stop the recording');
  assert.ok(stopped.includes('inputtap'), 'an orphaned inputtap should be torn down');
});

test('a helper-reported inputtap error reaches state().error without stopping the recording', async () => {
  const { rec, sinks } = harness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x', zoomEnabled: true });
  sinks.capture({ type: 'started', clock: 0 });

  sinks.inputtap({ type: 'error', message: 'could not recreate the event tap' });

  const s = rec.state();
  assert.ok(s.error, 'expected an error to be recorded');
  assert.strictEqual(s.error.source, 'inputtap');
  assert.strictEqual(s.error.message, 'could not recreate the event tap');
  assert.strictEqual(s.recording, true, 'losing the gesture hook should not stop recording');
});

test("a helper-reported error calls the host's onError callback, not just state()", async () => {
  const seen = [];
  const sinks = {};
  const rec = createRecorder({
    binDir: '/fake',
    spawnHelper: (bin, args, opts) => {
      const name = bin.endsWith('capture') ? 'capture' : 'inputtap';
      sinks[name] = opts.onMessage;
      return { name, kill() {}, exitCode: null, signalCode: null, once() {} };
    },
    stopHelper: async () => 0,
    onError: (e) => seen.push(e)
  });
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });
  sinks.capture({ type: 'started', clock: 0 });
  sinks.capture({ type: 'error', message: 'writer failed' });

  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].source, 'capture');
  assert.strictEqual(seen[0].message, 'writer failed');
});

test('start() rejects while a recording is already in progress, without touching the live children', async () => {
  const { rec, sinks, children } = harness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x' });
  sinks.capture({ type: 'started', clock: 0 });
  const firstCapture = children.capture;
  const firstInput = children.inputtap;

  await assert.rejects(
    rec.start({ source: 'display:2', mic: false, dir: '/tmp/y' }),
    /already in progress/
  );

  // The first session's children must be untouched: no orphaning, no
  // silently-replaced references.
  assert.strictEqual(children.capture, firstCapture);
  assert.strictEqual(children.inputtap, firstInput);
  assert.strictEqual(rec.state().recording, true);
});

test('a non-zero inputtap exit is surfaced in state().error without stopping the recording', async () => {
  const { rec, spawns } = controllableHarness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x', zoomEnabled: true });
  const capture = spawns.find((s) => s.name === 'capture');
  capture.opts.onMessage({ type: 'started', clock: 0 });
  const inputtap = spawns.find((s) => s.name === 'inputtap');

  // InputTap.swift's fail() path: emits {"type":"error"} then exit(1). Only
  // the exit is simulated here to prove the exit code alone (with no prior
  // error message) is enough to surface something -- the message-based path
  // is already covered above.
  inputtap.opts.onExit(1, null);

  const s = rec.state();
  assert.ok(s.error, 'expected an error to be recorded from the bare exit code');
  assert.strictEqual(s.error.source, 'inputtap');
  assert.strictEqual(s.recording, true, 'losing the gesture hook should not stop recording');
});

test('a signal-terminated inputtap exit (normal shutdown) does not report a spurious error', async () => {
  const { rec, spawns } = controllableHarness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x', zoomEnabled: true });
  const inputtap = spawns.find((s) => s.name === 'inputtap');

  // stop()/onCaptureError's cleanup both SIGTERM the child: code is null,
  // not 0, so this must never be confused with a crash.
  inputtap.opts.onExit(null, 'SIGTERM');

  assert.strictEqual(rec.state().error, null);
});

test('an exit-code error does not clobber a more specific inputtap error message already recorded', async () => {
  const { rec, spawns } = controllableHarness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x', zoomEnabled: true });
  const inputtap = spawns.find((s) => s.name === 'inputtap');

  inputtap.opts.onMessage({ type: 'error', message: 'could not recreate the event tap' });
  inputtap.opts.onExit(1, null);

  assert.strictEqual(rec.state().error.message, 'could not recreate the event tap');
});

test('a stopped message delivered right before its stopHelper call resolves is reflected in project.capture.duration', async () => {
  // Models the contract the real stopHelper()'s 'close' (not 'exit') fix
  // guarantees: by the time the promise recorder.stop() awaits actually
  // resolves, every NDJSON line the helper will ever write -- including a
  // final {"type":"stopped",...} -- has already been parsed off stdout and
  // handed to onMessage. Delivering 'stopped' immediately before resolving
  // the fake stopHelper call, rather than before calling stop() at all
  // (which is all the older tests above do), is what makes this different
  // from the existing coverage: it proves recorder.js reads `duration` at
  // the right time relative to that guarantee, not just that it reads it
  // eventually.
  const { rec, spawns, stopCalls } = controllableHarness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x', zoomEnabled: false });
  const capture = spawns.find((s) => s.name === 'capture');
  capture.opts.onMessage({ type: 'started', clock: 0 });

  const stopPromise = rec.stop();
  assert.strictEqual(stopCalls.length, 1);
  assert.strictEqual(stopCalls[0].child.name, 'capture');

  capture.opts.onMessage({ type: 'stopped', duration: 12 });
  stopCalls[0].resolve(0);

  const { project } = await stopPromise;
  assert.strictEqual(project.capture.duration, 12);
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

test('the zoom-trigger flags reach inputtap, and inputtap only', async () => {
  const argsFor = {};
  const spawnHelper = (bin, args) => {
    argsFor[bin.endsWith('capture') ? 'capture' : 'inputtap'] = args;
    return { kill() {}, exitCode: null, signalCode: null, once() {} };
  };
  const rec = createRecorder({ binDir: '/fake', spawnHelper, stopHelper: async () => 0 });
  const inputTapArgs = ['--zoom-triggers', 'control,mouse-side'];
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x', inputTapArgs });

  assert.deepStrictEqual(argsFor.inputtap, inputTapArgs);
  assert.ok(!argsFor.capture.includes('--zoom-triggers'));
});

test('stop() keeps an untouched copy of the recorded zooms for the editor to restore from', async () => {
  const { rec, sinks } = harness();
  await rec.start({ source: 'display:1', mic: false, dir: '/tmp/x', width: 1000, height: 800 });
  sinks.capture({ type: 'started', clock: 0 });
  sinks.inputtap({ type: 'zoom', clock: 1, dy: 40, x: 100, y: 100 });
  sinks.capture({ type: 'stopped', duration: 5 });

  const { recording: project } = await rec.stop();
  assert.strictEqual(project.zoomKeyframes.length, 1);
  assert.deepStrictEqual(project.recordedZoomKeyframes, project.zoomKeyframes);
  assert.notStrictEqual(project.recordedZoomKeyframes, project.zoomKeyframes, 'a copy, not the same array');
  assert.deepStrictEqual(project.removedZooms, []);
});

test('a capture that fails before its first frame writes no project and says so', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-failed-'));
  const { rec, sinks } = harness();
  await rec.start({ source: 'display:1', mic: false, dir });
  sinks.capture({ type: 'error', message: 'display not found: display:1' });
  const result = await rec.stop();
  assert.deepStrictEqual(result, { dir, failed: true, message: 'display not found: display:1' });
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'no project.json, cursor.bin or keys.json');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a capture that fails after it started keeps what was recorded', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-failed-'));
  const { rec, sinks } = harness();
  await rec.start({ source: 'display:1', mic: false, dir });
  sinks.capture({ type: 'started', clock: 10 });
  sinks.capture({ type: 'error', message: 'writer failed' });
  const result = await rec.stop();
  assert.ok(!result.failed);
  assert.ok(fs.existsSync(path.join(dir, 'project.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('capture gets time to finish its file when stopped; inputtap the usual few seconds', async () => {
  const { CAPTURE_STOP_MS } = require('../src/main/recorder');
  const grace = {};
  const spawnHelper = (bin, args, opts) => ({ name: bin.endsWith('capture') ? 'capture' : 'inputtap', opts, kill() {} });
  const stopHelper = async (child, timeoutMs) => { grace[child.name] = timeoutMs; return 0; };
  const rec = createRecorder({ binDir: '/fake', spawnHelper, stopHelper });
  await rec.start({ source: 'display:1', mic: false, dir: require('node:os').tmpdir() + '/loupe-grace', zoomEnabled: true });
  require('node:fs').mkdirSync(require('node:os').tmpdir() + '/loupe-grace', { recursive: true });
  await rec.stop();
  assert.ok(CAPTURE_STOP_MS >= 30000);
  assert.strictEqual(grace.capture, CAPTURE_STOP_MS);
  assert.strictEqual(grace.inputtap, undefined, 'inputtap keeps the default');
  require('node:fs').rmSync(require('node:os').tmpdir() + '/loupe-grace', { recursive: true, force: true });
});
