'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createLineSplitter, spawnHelper, stopHelper } = require('../src/main/helpers');

test('emits one line per newline', () => {
  const seen = [];
  const push = createLineSplitter((l) => seen.push(l));
  push('a\nb\nc\n');
  assert.deepStrictEqual(seen, ['a', 'b', 'c']);
});

test('reassembles a line split across two chunks', () => {
  const seen = [];
  const push = createLineSplitter((l) => seen.push(l));
  push('{"type":"zo');
  push('om","dy":3}\n');
  assert.deepStrictEqual(seen, ['{"type":"zoom","dy":3}']);
});

test('does not emit a trailing line that has no newline yet', () => {
  const seen = [];
  const push = createLineSplitter((l) => seen.push(l));
  push('complete\nincomplete');
  assert.deepStrictEqual(seen, ['complete']);
});

test('skips blank lines', () => {
  const seen = [];
  const push = createLineSplitter((l) => seen.push(l));
  push('a\n\n\nb\n');
  assert.deepStrictEqual(seen, ['a', 'b']);
});

test('spawnHelper parses NDJSON into objects', async () => {
  const messages = [];
  const script = 'process.stdout.write(\'{"type":"a"}\\n{"ty\'); process.stdout.write(\'pe":"b"}\\n\');';
  await new Promise((resolve) => {
    spawnHelper(process.execPath, ['-e', script], {
      onMessage: (m) => messages.push(m),
      onMalformed: () => {},
      onExit: resolve
    });
  });
  assert.deepStrictEqual(messages, [{ type: 'a' }, { type: 'b' }]);
});

test('spawnHelper reports malformed lines without throwing', async () => {
  const bad = [];
  await new Promise((resolve) => {
    spawnHelper(process.execPath, ['-e', 'process.stdout.write("not json\\n")'], {
      onMessage: () => {},
      onMalformed: (line) => bad.push(line),
      onExit: resolve
    });
  });
  assert.deepStrictEqual(bad, ['not json']);
});

test('stopHelper resolves with the exit code', async () => {
  const child = spawnHelper(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    onMessage: () => {}, onMalformed: () => {}, onExit: () => {}
  });
  const code = await stopHelper(child, 2000);
  assert.strictEqual(typeof code, 'number');
});

test('spawnHelper reports a failed spawn through onError without throwing', async () => {
  const errors = [];
  await new Promise((resolve) => {
    spawnHelper('/no/such/binary-loupe-helper', [], {
      onMessage: () => {},
      onMalformed: () => {},
      onExit: resolve,
      onError: (err) => errors.push(err)
    });
  });
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0] instanceof Error);
});

test('spawnHelper survives a failed spawn with no onError supplied', async () => {
  await new Promise((resolve) => {
    spawnHelper('/no/such/binary-loupe-helper', [], {
      onMessage: () => {},
      onMalformed: () => {},
      onExit: resolve
    });
  });
  // reaching here without throwing/crashing is the assertion
  assert.ok(true);
});

test("stopHelper waits for 'close', not 'exit', even once exitCode is already set", async () => {
  // A minimal fake child that reproduces the exact ordering Node guarantees
  // for a real ChildProcess: 'exit' (the process has been reaped) fires
  // strictly before 'close' (its stdio has finished draining to us). Real
  // helpers.test.js coverage of this below uses an actual OS process, but a
  // real process's exit-to-close gap is a handful of microseconds -- too
  // small to assert against deterministically. This fake makes the gap
  // explicit and controllable, and is what actually pins down the fix:
  // stopHelper must not resolve merely because exitCode/signalCode are set.
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    setTimeout(() => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
      // 'close' -- and therefore the moment the real helper's last stdout
      // line would have been parsed -- arrives in a later tick.
      setTimeout(() => child.emit('close', 0), 0);
    }, 0);
  };

  const order = [];
  child.once('exit', () => order.push('exit'));
  const resolved = stopHelper(child, 2000).then((code) => { order.push('resolved'); return code; });
  const code = await resolved;
  assert.deepStrictEqual(order, ['exit', 'resolved'], "'close' must fire before stopHelper resolves");
  assert.strictEqual(code, 0);
});

test('stopHelper does not resolve before all buffered stdout has been parsed (real process)', async () => {
  // A real-process companion to the fake-timeline test above: writes a
  // large NDJSON line via fs.writeSync (synchronous, so nothing here is
  // lost to buffering the way process.stdout.write()+process.exit() could
  // lose it) and lets the script exit naturally. At this size the child's
  // 'exit' reliably fires before its stdout has finished draining to us --
  // verified empirically while writing this test -- exercising the same
  // race the fake-timeline test pins down, but through the real spawn/pipe
  // machinery end to end.
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const scriptPath = path.join(os.tmpdir(), `loupe-stophelper-test-${process.pid}.js`);
  fs.writeFileSync(scriptPath, [
    "const fs = require('fs');",
    "const padding = 'x'.repeat(8 * 1024 * 1024);",
    "fs.writeSync(1, JSON.stringify({type:'padding', big: padding}) + '\\n');",
    "fs.writeSync(1, JSON.stringify({type:'stopped', duration: 7}) + '\\n');"
  ].join('\n'));

  try {
    const messages = [];
    let resolveExited;
    const exited = new Promise((resolve) => { resolveExited = resolve; });
    const child = spawnHelper(process.execPath, [scriptPath], {
      onMessage: (m) => messages.push(m),
      onMalformed: () => {},
      onExit: () => resolveExited()
    });
    // Let the script run and exit on its own -- this is what puts the child
    // into the "already exited, stdio maybe still draining" state that
    // matters here. Calling stopHelper() immediately (no wait) would instead
    // SIGTERM the process before Node has even finished starting it, which
    // proves nothing about the drain race.
    await exited;
    await stopHelper(child, 5000);
    const stopped = messages.find((m) => m.type === 'stopped');
    assert.ok(stopped, 'the final NDJSON line should have been parsed before stopHelper resolved');
    assert.strictEqual(stopped.duration, 7);
  } finally {
    fs.unlinkSync(scriptPath);
  }
});

test('a kill() failure on an already-running child does not suppress its real exit code', async () => {
  // Simulates ChildProcess emitting 'error' well after a successful spawn
  // (e.g. stopHelper()'s child.kill() failing) rather than the classic
  // ENOENT-before-spawn case. The exit handler must still see the real exit
  // code afterwards, not the onExit(null, null) fallback meant only for a
  // process that never started.
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  // The 20ms delay before the real exit gives the test room to spawn, wait
  // for 'spawn', and inject the fake kill() failure before the process
  // actually terminates -- racing child.once('exit', ...) directly against
  // an instant process.exit() risks missing the event entirely since
  // EventEmitter never replays a past emission.
  const child = spawnHelper(process.execPath, ['-e', 'setTimeout(() => process.exit(3), 20)'], {
    onMessage: () => {},
    onMalformed: () => {},
    onExit: (...args) => resolveExit(args),
    onError: () => {}
  });
  await new Promise((resolve) => child.once('spawn', resolve));
  child.emit('error', new Error('simulated kill() failure'));
  const exitArgs = await exited;
  assert.deepStrictEqual(exitArgs, [3, null]);
});

test('spawnHelper notifies the caller exactly once on a failed spawn', async () => {
  let exitCalls = 0;
  await new Promise((resolve) => {
    spawnHelper('/no/such/binary-loupe-helper', [], {
      onMessage: () => {},
      onMalformed: () => {},
      onExit: (...args) => {
        exitCalls += 1;
        resolve(args);
      },
      onError: () => {}
    });
  });
  // give any late/duplicate event a chance to fire before asserting
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(exitCalls, 1);
});
