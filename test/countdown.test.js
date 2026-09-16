'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startCountdown } = require('../src/main/countdown');

// Manual timers: each test decides when a second has passed.
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimer: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { pending.delete(id); },
    elapse() {
      const due = [...pending.values()];
      pending.clear();
      for (const { fn, ms } of due) { assert.strictEqual(ms, 1000); fn(); }
    },
    pending
  };
}

test('counts 3, 2, 1 a second apart, then resolves true', async () => {
  const timers = fakeTimers();
  const ticks = [];
  const c = startCountdown({ seconds: 3, onTick: (n) => ticks.push(n), ...timers });
  assert.deepStrictEqual(ticks, [3]);
  timers.elapse();
  assert.deepStrictEqual(ticks, [3, 2]);
  timers.elapse();
  timers.elapse();
  assert.deepStrictEqual(ticks, [3, 2, 1]);
  assert.strictEqual(await c.promise, true);
  assert.strictEqual(c.isRunning(), false);
  assert.strictEqual(timers.pending.size, 0);
});

test('cancel (Esc) resolves false at once and stops the ticking', async () => {
  const timers = fakeTimers();
  const ticks = [];
  const c = startCountdown({ seconds: 3, onTick: (n) => ticks.push(n), ...timers });
  timers.elapse();
  c.cancel();
  assert.strictEqual(await c.promise, false);
  assert.strictEqual(timers.pending.size, 0, 'no timer left behind');
  c.cancel(); // twice is harmless
  assert.deepStrictEqual(ticks, [3, 2]);
});

test('cancelling after it finished changes nothing', async () => {
  const timers = fakeTimers();
  const c = startCountdown({ seconds: 1, ...timers });
  timers.elapse();
  c.cancel();
  assert.strictEqual(await c.promise, true);
});

test('zero seconds resolves straight away', async () => {
  const timers = fakeTimers();
  const c = startCountdown({ seconds: 0, onTick: () => assert.fail('no ticks'), ...timers });
  assert.strictEqual(await c.promise, true);
});

test('a failing tick handler does not stop the countdown', async () => {
  const timers = fakeTimers();
  const c = startCountdown({ seconds: 2, onTick: () => { throw new Error('bar closed'); }, ...timers });
  timers.elapse();
  timers.elapse();
  assert.strictEqual(await c.promise, true);
});
