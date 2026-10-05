import test from 'node:test';
import assert from 'node:assert/strict';
import { earlierTimes, shutterSeconds, viewShift, MAX_SHUTTER, SAMPLES } from '../src/core/motion-blur.js';
import * as P from '../src/core/project.js';

const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-12, `${what}: ${a} vs ${b}`);

test('no blur: no earlier moments', () => {
  assert.deepEqual(earlierTimes(5, 0), []);
  assert.equal(shutterSeconds(0), 0);
  assert.equal(shutterSeconds(undefined), 0);
});

test('full blur looks back over the whole shutter, in equal steps, nearest first', () => {
  const times = earlierTimes(5, 1);
  assert.equal(times.length, SAMPLES - 1);
  near(times.at(-1), 5 - MAX_SHUTTER, 'the furthest is one shutter back');
  near(times[0], 5 - MAX_SHUTTER / (SAMPLES - 1), 'the nearest one step back');
  near(shutterSeconds(0.5), MAX_SHUTTER / 2, 'half strength, half the shutter');
  near(shutterSeconds(7), MAX_SHUTTER, 'never more than full');
});

test('at the very start of the video it never looks before 0', () => {
  assert.deepEqual(earlierTimes(0, 1), []);
  assert.ok(earlierTimes(0.01, 1).every((t) => t >= 0));
});

test('viewShift is the furthest any corner moved', () => {
  const state = (dx, scale) => ({ meta: { width: 100, height: 50 }, toCanvas: (x, y) => ({ x: x * scale + dx, y: y * scale }) });
  assert.equal(viewShift(state(0, 1), state(0, 1)), 0);
  assert.equal(viewShift(state(0, 1), state(3, 1)), 3);
  near(viewShift(state(0, 1), state(0, 1.1)), Math.hypot(10, 5), 'a zoom moves the far corner most');
});

test('a new video starts with a little blur; one from before has none; a style that says so is kept', () => {
  const main = { width: 1920, height: 1080, duration: 5 };
  assert.equal(P.createProject({ main, createdAt: 0 }).style.motionBlur, P.NEW_MOTION_BLUR);
  assert.equal(P.createProject({ main, createdAt: 0, style: { motionBlur: 0 } }).style.motionBlur, 0);
  assert.equal(P.createProject({ main, createdAt: 0, style: { padding: 0.1 } }).style.motionBlur, P.NEW_MOTION_BLUR);
  const old = JSON.parse(JSON.stringify(P.createProject({ main, createdAt: 0 })));
  delete old.style.motionBlur;
  delete old.style.motionBlurCursor;
  const loaded = P.validateProject(old);
  assert.equal(loaded.style.motionBlur, 0);
  assert.equal(loaded.style.motionBlurCursor, true);
  assert.throws(() => P.setStyle(loaded, { motionBlur: 3 }), /Motion blur/);
});
