// Keyframes: a property changing over time (src/core/keyframes.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { valueAt, setKeyframe, removeKeyframe, keyframeAt, neighbours } from '../src/core/keyframes.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('a property with no keyframes is its value; with some it glides between them, eased', () => {
  assert.equal(valueAt(undefined, 2, 0.5), 0.5);
  assert.equal(valueAt([], 2, 0.5), 0.5);
  const kf = [{ t: 1, v: 0 }, { t: 3, v: 1 }];
  assert.equal(valueAt(kf, 0, 9), 0, 'before the first: its value');
  assert.equal(valueAt(kf, 5, 9), 1, 'after the last: its value');
  near(valueAt(kf, 2, 9), 0.5, 1e-9);
  assert.ok(valueAt(kf, 1.5, 9) < 0.25, 'eased: slow to start');
  const linear = [{ t: 1, v: 0 }, { t: 3, v: 1, ease: 'linear' }];
  near(valueAt(linear, 1.5, 9), 0.25);
});

test('setting, finding and removing keyframes; the ones either side of a moment', () => {
  let kf = setKeyframe([], 2, 0.5);
  kf = setKeyframe(kf, 1, 0.1);
  kf = setKeyframe(kf, 2.0004, 0.7); // the same moment: replaced
  assert.deepEqual(kf.map((k) => [k.t, k.v]), [[1, 0.1], [2, 0.7]]);
  assert.equal(keyframeAt(kf, 1.0003)?.v, 0.1);
  assert.equal(keyframeAt(kf, 1.5), null);
  assert.deepEqual(neighbours(kf, 1.5), { prev: kf[0], next: kf[1] });
  assert.deepEqual(neighbours(kf, 1), { prev: null, next: kf[1] }, 'strictly before and after');
  kf = removeKeyframe(kf, 1);
  assert.deepEqual(kf.map((k) => k.t), [2]);
});
