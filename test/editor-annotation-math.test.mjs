// The editor's annotation arithmetic (src/renderer/editor/annotation-math.js).
import test from 'node:test';
import assert from 'node:assert';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import { clipLayout } from '../src/renderer/editor/timeline-math.js';
import {
  newAnnotation, annotationPieces, stackLanes, movedRange, resizedRange, movedBy, resizedBox, annotationLabel
} from '../src/renderer/editor/annotation-math.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);
const project = () => P.createProject({ main: { width: 1600, height: 1000, duration: 10 } });
const layoutOf = (p) => clipLayout(p, buildTimeline(p));

test('a new annotation starts at the playhead inside its clip, sliding back near the end', () => {
  const p = P.cutRange(project(), 4, 6);
  const L = layoutOf(p);
  const a = newAnnotation(p, L, 1, 'text');
  assert.deepStrictEqual([a.source, a.start, a.end, a.type], ['main', 1, 4, 'text']);
  const late = newAnnotation(p, L, 3.5, 'arrow');
  assert.deepStrictEqual([late.start, late.end], [1, 4]);
  // After the cut, output 5 is recording 7.
  const after = newAnnotation(p, L, 5, 'box');
  assert.deepStrictEqual([after.start, after.end], [7, 10]);
  // A title near the start starts at the start.
  assert.strictEqual(newAnnotation(p, L, 0.6, 'title').start, 0);
  assert.doesNotThrow(() => P.addAnnotation(p, a));
});

test('pieces per clip, stacked in lanes when they overlap', () => {
  let p = project();
  p = P.addAnnotation(p, { type: 'text', start: 1, end: 4 });
  p = P.addAnnotation(p, { type: 'box', start: 2, end: 5 });
  p = P.addAnnotation(p, { type: 'blur', start: 4.5, end: 6 });
  const pieces = annotationPieces(p, layoutOf(p));
  assert.strictEqual(stackLanes(pieces), 2);
  assert.deepStrictEqual(pieces.map((q) => q.lane), [0, 1, 0]);
  assert.strictEqual(stackLanes([]), 1);
});

test('moving and resizing in time stays inside the recording', () => {
  const p = project();
  const a = { source: 'main', start: 2, end: 5 };
  assert.deepStrictEqual(movedRange(p, a, 9), { start: 7, end: 10 });
  assert.deepStrictEqual(movedRange(p, a, -3), { start: 0, end: 3 });
  near(resizedRange(p, a, 'start', 4.99).start, 4.9);
  assert.deepStrictEqual(resizedRange(p, a, 'end', 20), { start: 2, end: 10 });
});

test('dragging positions: text, arrows as a whole, boxes by a corner', () => {
  assert.deepStrictEqual(movedBy({ type: 'text', x: 0.5, y: 0.5 }, 0.8, -0.1), { x: 0.98, y: 0.4 });
  const arrow = movedBy({ type: 'arrow', x: 0.1, y: 0.2, x2: 0.9, y2: 0.4 }, 0.3, 0);
  near(arrow.x, 0.2);
  near(arrow.x2, 1);
  const box = { type: 'box', x: 0.2, y: 0.2, w: 0.3, h: 0.2 };
  const r = resizedBox(box, 'bottom-right', 0.6, 0.5);
  near(r.w, 0.4);
  near(r.h, 0.3);
  assert.deepStrictEqual([r.x, r.y], [0.2, 0.2]);
  const l = resizedBox(box, 'top-left', 0.9, 0.9);
  near(l.x + l.w, 0.5);
  near(l.w, 0.01);
  assert.strictEqual(annotationLabel({ type: 'title', text: 'Hello\nworld' }), 'Hello');
  assert.strictEqual(annotationLabel({ type: 'blur', text: '' }), 'Hide an area');
});
