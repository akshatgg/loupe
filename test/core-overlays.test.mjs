// Overlays: pictures and videos on rows above the main video (V2, V3...):
// src/core/project.js edits, src/core/layers/overlays.js placement.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/core/project.js';
import { overlaysAt, overlayPlacement, overlayMediaTime } from '../src/core/layers/overlays.js';

const project = () => P.createProject({ main: { width: 1920, height: 1080, duration: 20 } });
const near = (a, b, eps = 1e-6, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} vs ${b}`);

test('adding overlays: a picture for 5 s, a video for its length, each on the first free row', () => {
  let p = project();
  p = P.addOverlay(p, { kind: 'image', file: 'media/logo.png', start: 2 });
  p = P.addOverlay(p, { kind: 'video', file: 'media/broll.mp4', start: 3, fileDuration: 4 });
  const [a, b] = p.overlays;
  assert.deepEqual([a.id, a.length, a.lane, a.scale, a.x, a.y, a.opacity], ['o1', 5, 0, 0.35, 0.3, 0.3, 1]);
  assert.deepEqual([b.id, b.length, b.lane, b.from], ['o2', 4, 1, 0]);
  assert.throws(() => P.addOverlay(p, { kind: 'gif', file: 'media/x.gif', start: 0 }), /kind/);
  assert.throws(() => P.addOverlay(p, { kind: 'image', file: '../x.png', start: 0 }), /media folder/);
  p = P.updateOverlay(p, 'o1', { opacity: 0.5, scale: 1, x: 0, y: 0, start: 10 });
  assert.equal(p.overlays[0].opacity, 0.5);
  assert.throws(() => P.updateOverlay(p, 'o1', { opacity: 2 }), /Opacity/);
  p = P.removeOverlay(p, 'o2');
  assert.deepEqual(p.overlays.map((o) => o.id), ['o1']);
});

test('which overlays show at a moment, lower rows first; a video plays its own time from where it starts', () => {
  let p = project();
  p = P.addOverlay(p, { kind: 'video', file: 'media/a.mp4', start: 2, fileDuration: 10 });
  p = P.updateOverlay(p, 'o1', { from: 1, length: 3 });
  p = P.addOverlay(p, { kind: 'image', file: 'media/b.png', start: 3 });
  assert.deepEqual(overlaysAt(p, 1).map((o) => o.id), []);
  assert.deepEqual(overlaysAt(p, 3.5).map((o) => o.id), ['o1', 'o2']);
  assert.deepEqual(overlaysAt(p, 5.5).map((o) => o.id), ['o2'], 'the video ended at 5');
  near(overlayMediaTime(p.overlays[0], 3.5), 2.5, 1e-9, 'from 1 s into the file, 1.5 s later');
});

test('placement: fitted into the video, scaled, moved from the middle; fades and keyframes change it over time', () => {
  let p = project();
  p = P.addOverlay(p, { kind: 'image', file: 'media/logo.png', start: 0 });
  p = P.updateOverlay(p, 'o1', { scale: 0.5, x: 0.25, y: 0, fadeIn: 1, length: 10 });
  const size = { width: 1920, height: 1080 };
  // A square picture fits the video's height (1080), at half size 540.
  const place = overlayPlacement(p.overlays[0], 5, size, { w: 100, h: 100 });
  near(place.w, 540); near(place.h, 540);
  near(place.cx, 960 + 480, 1e-9, 'a quarter of the width right');
  near(place.cy, 540);
  assert.equal(place.alpha, 1);
  near(overlayPlacement(p.overlays[0], 0.5, size, { w: 100, h: 100 }).alpha, 0.5, 1e-9, 'fading in');
  // Keyframes: it grows from half size at 2 s to full at 4 s.
  p = P.setOverlayKeyframe(p, 'o1', 'scale', 2, 0.5);
  p = P.setOverlayKeyframe(p, 'o1', 'scale', 4, 1);
  near(overlayPlacement(p.overlays[0], 1, size, { w: 100, h: 100 }).w, 540, 1e-9, 'before: half');
  near(overlayPlacement(p.overlays[0], 5, size, { w: 100, h: 100 }).w, 1080, 1e-9, 'after: full');
  near(overlayPlacement(p.overlays[0], 3, size, { w: 100, h: 100 }).w, 810, 1e-9, 'halfway');
  assert.throws(() => P.setOverlayKeyframe(p, 'o1', 'colour', 1, 1), /can’t be animated/);
  p = P.removeOverlayKeyframe(p, 'o1', 'scale', 2);
  assert.equal(p.overlays[0].keyframes.scale.length, 1);
});

test('a main clip’s position animates with keyframes in its recording time', () => {
  let p = project();
  const id = p.clips[0].id;
  p = P.setClipKeyframe(p, id, 'scale', 1, 1);
  p = P.setClipKeyframe(p, id, 'scale', 3, 0.5);
  assert.deepEqual(p.clips[0].keyframes.scale.map((k) => [k.t, k.v]), [[1, 1], [3, 0.5]]);
  assert.throws(() => P.setClipKeyframe(p, id, 'scale', 30, 1), /inside the clip/);
  p = P.removeClipKeyframe(p, id, 'scale', 1);
  assert.equal(p.clips[0].keyframes.scale.length, 1);
});
