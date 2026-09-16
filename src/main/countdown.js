'use strict';

// The 3-2-1 before capture starts. main.js shows each number on the bar
// (onTick) and starts capture when the promise resolves true; Esc, Back or
// quitting cancel it, resolving false, and nothing has been recorded.
//
// Timers are injectable so the sequence is testable without waiting three
// real seconds (test/countdown.test.js).
function startCountdown({ seconds = 3, onTick, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  let settled = false;
  let resolve;
  const promise = new Promise((r) => { resolve = r; });

  const finish = (completed) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    resolve(completed);
  };

  const tick = (n) => {
    if (settled) return;
    if (n <= 0) { finish(true); return; }
    try {
      onTick?.(n);
    } catch {
      // A bar that has gone away must not wedge the countdown.
    }
    timer = setTimer(() => tick(n - 1), 1000);
  };

  tick(Math.max(0, Math.floor(seconds)));
  return { promise, cancel: () => finish(false), isRunning: () => !settled };
}

module.exports = { startCountdown };
