import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import { solveCamera, cameraAt } from '../src/core/camera.js';

const base = () => {
  let p = P.createProject({ main: { width: 1920, height: 1080, duration: 20 }, createdAt: 0 });
  p = P.splitAt(p, 5);
  p = P.splitAt(p, 10);
  p = P.addZoom(p, { start: 1, end: 3 });
  return P.addZoom(p, { start: 6, end: 8 });
};

test('removeItems removes a mix in one edit', () => {
  const p = base();
  const next = P.removeItems(p, [{ kind: 'zoom', id: 'z1' }, { kind: 'zoom', id: 'z2' }, { kind: 'clip', id: p.clips[1].id }]);
  assert.equal(next.zooms.length, 0);
  assert.equal(next.clips.length, 2);
  assert.equal(P.validateProject(next).clips.length, 2);
});

test('removeItems refuses to remove every clip, nothing, or an unknown kind', () => {
  const p = base();
  assert.throws(() => P.removeItems(p, p.clips.map((c) => ({ kind: 'clip', id: c.id }))), /at least one clip/);
  assert.throws(() => P.removeItems(p, []), /Select something/);
  assert.throws(() => P.removeItems(p, [{ kind: 'spaceship', id: 'x' }]), /delete/);
});

test('removeItems puts a speed stretch back to normal', () => {
  const p = P.paintSpeed(base(), { start: 12, end: 14, rate: 2 });
  const s = p.speed[0];
  const next = P.removeItems(p, [{ kind: 'speed', source: s.source, start: s.start, end: s.end }]);
  assert.equal(next.speed.length, 0);
});

test('a disabled zoom validates, round-trips and can be switched back on', () => {
  const p = P.updateZoom(base(), 'z1', { disabled: true });
  assert.equal(p.zooms[0].disabled, true);
  assert.equal(P.validateProject(JSON.parse(JSON.stringify(p))).zooms[0].disabled, true);
  assert.equal(P.updateZoom(p, 'z1', { disabled: false }).zooms[0].disabled, false);
  assert.throws(() => P.updateZoom(p, 'z1', { disabled: 'yes' }), /true or false/);
});

test('a disabled zoom does not move the camera; an enabled one does', () => {
  const p = base();
  const solve = (zooms) => solveCamera({ zooms, cursorTrack: [{ t: 0, x: 960, y: 540 }], duration: 20, width: 1920, height: 1080 });
  const on = cameraAt(solve(p.zooms), 2, { width: 1920, height: 1080 });
  assert.ok(on.zoom > 1.5, `zoomed in: ${on.zoom}`);
  const off = cameraAt(solve(P.updateZoom(p, 'z1', { disabled: true }).zooms), 2, { width: 1920, height: 1080 });
  assert.ok(Math.abs(off.zoom - 1) < 1e-6, `not zoomed: ${off.zoom}`);
  // The other zoom is untouched.
  const later = cameraAt(solve(P.updateZoom(p, 'z1', { disabled: true }).zooms), 7, { width: 1920, height: 1080 });
  assert.ok(later.zoom > 1.5);
});

test('deleting with leaveGap keeps the video the same length, silent there', () => {
  const p = base();
  const before = buildTimeline(p).duration;
  const next = P.deleteClip(p, p.clips[1].id, { leaveGap: true });
  assert.equal(next.clips.length, 3);
  assert.ok(P.isGap(next.clips[1]));
  const tl = buildTimeline(next);
  assert.ok(Math.abs(tl.duration - before) < 1e-9);
  assert.ok(tl.audioPlan().every((s) => s.outStart >= 10 - 1e-9 || s.outStart + (s.srcEnd - s.srcStart) / s.rate <= 5 + 1e-9));
  assert.equal(P.validateProject(JSON.parse(JSON.stringify(next))).clips[1].gap, true);
});

test('a gap can be deleted, closing up; the last real clip cannot be made a gap', () => {
  const p = base();
  const gapped = P.deleteClip(p, p.clips[1].id, { leaveGap: true });
  const closed = P.deleteClip(gapped, gapped.clips[1].id);
  assert.equal(closed.clips.length, 2);
  assert.ok(Math.abs(buildTimeline(closed).duration - 15) < 1e-9);
  const one = P.createProject({ main: { width: 10, height: 10, duration: 5 }, createdAt: 0 });
  assert.throws(() => P.deleteClip(one, one.clips[0].id, { leaveGap: true }), /at least one clip/);
});
