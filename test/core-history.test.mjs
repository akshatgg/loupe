import test from 'node:test';
import assert from 'node:assert';
import * as H from '../src/core/history.js';

const p = (n) => ({ n });

test('undo and redo walk through committed snapshots', () => {
  let h = H.createHistory(p(0));
  assert.strictEqual(H.canUndo(h), false);
  h = H.commit(h, p(1), { now: 0 });
  h = H.commit(h, p(2), { now: 10 });
  assert.strictEqual(h.present.n, 2);
  h = H.undo(h);
  assert.strictEqual(h.present.n, 1);
  h = H.undo(h);
  assert.strictEqual(h.present.n, 0);
  assert.strictEqual(H.undo(h), h, 'nothing left to undo');
  h = H.redo(h);
  h = H.redo(h);
  assert.strictEqual(h.present.n, 2);
  assert.strictEqual(H.redo(h), h, 'nothing left to redo');
});

test('a new edit after undo discards the redo branch', () => {
  let h = H.createHistory(p(0));
  h = H.commit(h, p(1), { now: 0 });
  h = H.undo(h);
  h = H.commit(h, p(9), { now: 5 });
  assert.strictEqual(H.canRedo(h), false);
  assert.deepStrictEqual(h.past.map((x) => x.n), [0]);
});

test('committing the same object is not a step', () => {
  const h = H.createHistory(p(0));
  assert.strictEqual(H.commit(h, h.present), h);
});

test('the oldest steps fall off past the cap', () => {
  let h = H.createHistory(p(0), { limit: 3 });
  for (let i = 1; i <= 10; i++) h = H.commit(h, p(i), { now: i * 5000 });
  assert.deepStrictEqual(h.past.map((x) => x.n), [7, 8, 9]);
  while (H.canUndo(h)) h = H.undo(h);
  assert.strictEqual(h.present.n, 7);
  assert.throws(() => H.createHistory(p(0), { limit: 0 }), /limit/);
});

test('a drag is one undo step: same gesture within the window coalesces', () => {
  let h = H.createHistory(p(0));
  h = H.commit(h, p(1), { gesture: 'drag:z1', now: 1000 });
  h = H.commit(h, p(2), { gesture: 'drag:z1', now: 1100 });
  h = H.commit(h, p(3), { gesture: 'drag:z1', now: 1900 });
  assert.deepStrictEqual(h.past.map((x) => x.n), [0]);
  assert.strictEqual(h.present.n, 3);
  h = H.undo(h);
  assert.strictEqual(h.present.n, 0);
});

test('a different gesture, a pause or endGesture starts a new step', () => {
  let h = H.createHistory(p(0));
  h = H.commit(h, p(1), { gesture: 'a', now: 0 });
  h = H.commit(h, p(2), { gesture: 'b', now: 10 });
  h = H.commit(h, p(3), { gesture: 'b', now: 10 + H.GESTURE_WINDOW_MS + 1 });
  h = H.endGesture(h);
  h = H.commit(h, p(4), { gesture: 'b', now: 20 + H.GESTURE_WINDOW_MS });
  h = H.commit(h, p(5), { now: 30 + H.GESTURE_WINDOW_MS });
  h = H.commit(h, p(6), { now: 31 + H.GESTURE_WINDOW_MS });
  assert.deepStrictEqual(h.past.map((x) => x.n), [0, 1, 2, 3, 4, 5]);
});

test('undo ends a gesture so the next drag is its own step', () => {
  let h = H.createHistory(p(0));
  h = H.commit(h, p(1), { gesture: 'g', now: 0 });
  h = H.commit(h, p(2), { gesture: 'g', now: 1 });
  h = H.undo(h);
  h = H.commit(h, p(3), { gesture: 'g', now: 2 });
  assert.deepStrictEqual(h.past.map((x) => x.n), [0]);
  h = H.commit(h, p(4), { gesture: 'g', now: 3 });
  assert.deepStrictEqual(h.past.map((x) => x.n), [0]);
  assert.strictEqual(h.present.n, 4);
});
