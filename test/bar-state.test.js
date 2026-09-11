'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { transition } = require('../src/main/bar-state');

test('armed + start -> recording', () => {
  assert.strictEqual(transition('armed', 'start'), 'recording');
});

test('armed + back -> closed', () => {
  assert.strictEqual(transition('armed', 'back'), 'closed');
});

test('recording + stop -> closed', () => {
  assert.strictEqual(transition('recording', 'stop'), 'closed');
});

test('recording cannot start (already started)', () => {
  assert.throws(() => transition('recording', 'start'), /Cannot 'start' from bar state 'recording'/);
});

test('recording cannot back out (there is nothing to back out to)', () => {
  assert.throws(() => transition('recording', 'back'), /Cannot 'back' from bar state 'recording'/);
});

test('armed cannot stop (nothing is recording yet)', () => {
  assert.throws(() => transition('armed', 'stop'), /Cannot 'stop' from bar state 'armed'/);
});

test('closed accepts no further actions', () => {
  assert.throws(() => transition('closed', 'start'), /Unknown bar state/);
  assert.throws(() => transition('closed', 'back'), /Unknown bar state/);
  assert.throws(() => transition('closed', 'stop'), /Unknown bar state/);
});

test('an unrecognised action in a valid state is rejected', () => {
  assert.throws(() => transition('armed', 'stop'), /Cannot 'stop' from bar state 'armed'/);
  assert.throws(() => transition('recording', 'back'), /Cannot 'back' from bar state 'recording'/);
});
