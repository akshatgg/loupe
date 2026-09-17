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

// ---- countdown and pause ----------------------------------------------------

test('armed + countdown -> counting, which goes on to recording', () => {
  assert.strictEqual(transition('armed', 'countdown'), 'counting');
  assert.strictEqual(transition('counting', 'go'), 'recording');
});

test('Esc during the countdown goes back to armed; Stop or quit closes the bar', () => {
  assert.strictEqual(transition('counting', 'cancel'), 'armed');
  assert.strictEqual(transition('counting', 'back'), 'closed');
});

test('a countdown cannot be paused, stopped as a recording, or started twice', () => {
  assert.throws(() => transition('counting', 'pause'), /Cannot 'pause' from bar state 'counting'/);
  assert.throws(() => transition('counting', 'stop'), /Cannot 'stop' from bar state 'counting'/);
  assert.throws(() => transition('counting', 'start'), /Cannot 'start' from bar state 'counting'/);
});

test('recording + pause -> paused, resume -> recording, and Stop works while paused', () => {
  assert.strictEqual(transition('recording', 'pause'), 'paused');
  assert.strictEqual(transition('paused', 'resume'), 'recording');
  assert.strictEqual(transition('paused', 'stop'), 'closed');
});

test('pause and resume only make sense in the right state', () => {
  assert.throws(() => transition('paused', 'pause'), /Cannot 'pause' from bar state 'paused'/);
  assert.throws(() => transition('recording', 'resume'), /Cannot 'resume' from bar state 'recording'/);
  assert.throws(() => transition('armed', 'pause'), /Cannot 'pause' from bar state 'armed'/);
  assert.throws(() => transition('paused', 'back'), /Cannot 'back' from bar state 'paused'/);
});

test('an unrecognised action in a valid state is rejected', () => {
  assert.throws(() => transition('armed', 'stop'), /Cannot 'stop' from bar state 'armed'/);
  assert.throws(() => transition('recording', 'back'), /Cannot 'back' from bar state 'recording'/);
});
