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
