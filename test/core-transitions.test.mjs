// More transitions (src/core/layers/transitions.js transitionPlan): where
// each picture goes at each moment of a wipe, slide, circle, zoom or blur.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import { transitionAt, transitionPlan, needsOtherPicture } from '../src/core/layers/transitions.js';

const SIZE = { width: 200, height: 100 };
const near = (a, b, eps = 1e-6, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} vs ${b}`);

function at(type, outT) {
  let p = P.createProject({ main: { width: 200, height: 100, duration: 8 } });
  p = P.splitAt(p, 4);
  p = P.setTransition(p, p.clips[0].id, type, 2); // 3..5 around the join at 4
  const tl = buildTimeline(p);
  return { tr: transitionAt(p, tl, outT), outT };
}

test('every transition type is accepted, and the two-picture ones ask for the other side', () => {
  for (const t of P.TRANSITION_TYPES) assert.ok(at(t, 4).tr, t);
  assert.equal(needsOtherPicture('crossfade'), true);
  assert.equal(needsOtherPicture('wipe-left'), true);
  assert.equal(needsOtherPicture('fade'), false);
  assert.equal(needsOtherPicture('blur'), false);
});

test('a wipe: the next clip’s picture grows across from its side', () => {
  // Before the join the other picture is the next clip, coming in.
  let { tr, outT } = at('wipe-left', 3.5); // a quarter through
  let plan = transitionPlan(tr, outT, SIZE);
  assert.equal(plan.mode, 'clip');
  assert.deepEqual(plan.rect, { x: 150, y: 0, w: 50, h: 100 }, 'the right quarter');
  // After it, the other picture is the clip that is going: what is left of it.
  ({ tr, outT } = at('wipe-left', 4.5)); // three quarters through
  plan = transitionPlan(tr, outT, SIZE);
  assert.deepEqual(plan.rect, { x: 0, y: 0, w: 50, h: 100 }, 'the left quarter still showing the old clip');
  plan = transitionPlan(at('wipe-down', 3.5).tr, 3.5, SIZE);
  assert.deepEqual(plan.rect, { x: 0, y: 0, w: 200, h: 25 }, 'from the top');
});

test('a slide pushes the old picture out as the new one comes in', () => {
  const { tr } = at('slide-left', 3.5);
  const plan = transitionPlan(tr, 3.5, SIZE);
  assert.equal(plan.mode, 'slide');
  near(plan.current.dx, -50, 1e-9, 'the old picture a quarter out to the left');
  near(plan.other.dx, 150, 1e-9, 'the new one a quarter in from the right');
});

test('a circle opens from the middle; zoom grows the old picture; blur and dip-to-white need only one', () => {
  let plan = transitionPlan(at('circle', 4).tr, 4, SIZE);
  assert.equal(plan.mode, 'circle');
  near(plan.r, Math.hypot(200, 100) / 4, 1e-9, 'halfway: half the corner distance');
  plan = transitionPlan(at('zoom', 3.5).tr, 3.5, SIZE);
  assert.equal(plan.mode, 'zoom');
  near(plan.outgoingScale, 1.125, 1e-9);
  near(plan.incomingAlpha, 0.25, 1e-9);
  plan = transitionPlan(at('blur', 4).tr, 4, SIZE);
  assert.deepEqual(plan, { mode: 'blur', px: 24 }, 'strongest at the join');
  assert.equal(transitionPlan(at('dip-white', 4).tr, 4, SIZE).mode, 'layer');
});
