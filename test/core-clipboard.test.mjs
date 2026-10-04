import test from 'node:test';
import assert from 'node:assert/strict';
import { copyItems, pasteItems, moveItems, itemsEnd } from '../src/core/clipboard.js';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';

const near = (a, b, what, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
const base = () => {
  let p = P.createProject({ main: { width: 1920, height: 1080, duration: 30 }, createdAt: 0 });
  p = P.addZoom(p, { start: 2, end: 4, level: 3 });
  p = P.addAnnotation(p, { type: 'text', start: 3, end: 5, text: 'Look here' });
  p = P.addMarker(p, { t: 6, label: 'Step' });
  return P.addAudioClip(p, { file: 'music/a.m4a', start: 1, fileDuration: 4, length: 4 });
};

test('nothing that can be copied gives null', () => {
  const p = base();
  assert.equal(copyItems(p, []), null);
  assert.equal(copyItems(p, [{ kind: 'speed', source: 'main', start: 1, end: 2 }]), null);
  assert.equal(copyItems(p, [{ kind: 'zoom', id: 'gone' }]), null);
});

test('a zoom pastes at the playhead with its level and length, under a new id', () => {
  const p = base();
  const clip = copyItems(p, [{ kind: 'zoom', id: 'z1' }]);
  const { project: next, items } = pasteItems(p, clip, 10);
  assert.equal(next.zooms.length, 2);
  assert.equal(items.length, 1);
  const z = next.zooms.find((q) => q.id === items[0].id);
  assert.notEqual(z.id, 'z1');
  near(z.start, 10, 'start');
  near(z.end, 12, 'end');
  assert.equal(z.level, 3);
  assert.equal(z.recorded, false);
});

test('several things keep their distances from the earliest', () => {
  const p = base();
  const sel = [{ kind: 'zoom', id: 'z1' }, { kind: 'annotation', id: p.annotations[0].id }, { kind: 'marker', id: p.markers[0].id }, { kind: 'audio', id: p.audio.clips[0].id }];
  const { project: next, items } = pasteItems(p, copyItems(p, sel), 15);
  assert.equal(items.length, 4);
  // The audio clip (at 1) was earliest: it lands at 15, the zoom (2) at 16...
  near(next.audio.clips.at(-1).start, 15, 'audio');
  near(next.zooms.find((z) => z.id === items.find((i) => i.kind === 'zoom').id).start, 16, 'zoom');
  near(next.annotations.at(-1).start, 17, 'annotation');
  assert.equal(next.annotations.at(-1).text, 'Look here');
  near(next.markers.find((m) => m.id === items.find((i) => i.kind === 'marker').id).t, 20, 'marker');
  P.validateProject(JSON.parse(JSON.stringify(next)));
});

test('a paste that can’t land changes nothing and says why', () => {
  const p = base();
  const clip = copyItems(p, [{ kind: 'zoom', id: 'z1' }]);
  assert.throws(() => pasteItems(p, clip, 3), /overlap/);
  assert.throws(() => pasteItems(p, clip, 30), /no room/);
  assert.throws(() => pasteItems(p, null, 3), /Copy something/);
});

test('a clip pastes at the playhead, splitting the clip there; the video grows by its length', () => {
  let p = P.splitAt(base(), 10);
  p = P.setClipLook(p, p.clips[0].id, { color: { brightness: 0.3 } });
  const clip = copyItems(p, [{ kind: 'clip', id: p.clips[0].id }]);
  const { project: next, items } = pasteItems(p, clip, 20);
  assert.equal(next.clips.length, 4, 'split at 20, with the copy between');
  assert.equal(next.clips[2].id, items[0].id);
  assert.equal(next.clips[2].color.brightness, 0.3, 'its look comes too');
  near(buildTimeline(next).duration, 40, 'ten seconds longer');
  assert.equal(new Set(next.clips.map((c) => c.id)).size, 4);
  // At a join it goes between, without a sliver.
  const atJoin = pasteItems(p, clip, 10).project;
  assert.equal(atJoin.clips.length, 3);
  // At the very end it goes last.
  assert.equal(pasteItems(p, clip, 30).project.clips.at(-1).start, 0);
});

test('pasting into a part played at double speed puts the zoom on the right moment', () => {
  const p = P.paintSpeed(base(), { start: 10, end: 20, rate: 2, });
  const tl = buildTimeline(p);
  const o = tl.toOutput('main', 22);
  const { project: next, items } = pasteItems(p, copyItems(p, [{ kind: 'zoom', id: 'z1' }]), o);
  near(next.zooms.find((z) => z.id === items[0].id).start, 22, 'source moment', 1e-3);
});

test('itemsEnd is where the selection stops playing', () => {
  const p = base();
  near(itemsEnd(p, [{ kind: 'zoom', id: 'z1' }, { kind: 'annotation', id: p.annotations[0].id }]), 5, 'end');
  near(itemsEnd(p, [{ kind: 'audio', id: p.audio.clips[0].id }]), 5, 'audio end');
});

test('moveItems slides everything by the same amount', () => {
  const p = base();
  const sel = [{ kind: 'zoom', id: 'z1' }, { kind: 'annotation', id: p.annotations[0].id }, { kind: 'marker', id: p.markers[0].id }, { kind: 'audio', id: p.audio.clips[0].id }];
  const next = moveItems(p, sel, 2.5);
  near(next.zooms[0].start, 4.5, 'zoom');
  near(next.zooms[0].end, 6.5, 'zoom end');
  near(next.annotations[0].start, 5.5, 'annotation');
  near(next.markers[0].t, 8.5, 'marker');
  near(next.audio.clips[0].start, 3.5, 'audio');
  assert.equal(moveItems(p, sel, 0), p, 'no distance: the same project');
});

test('two neighbouring zooms move together without tripping over each other', () => {
  const p = P.addZoom(base(), { start: 4, end: 6 });
  const sel = p.zooms.map((z) => ({ kind: 'zoom', id: z.id }));
  const later = moveItems(p, sel, 1.5);
  assert.deepEqual(later.zooms.map((z) => [z.start, z.end]), [[3.5, 5.5], [5.5, 7.5]]);
  const earlier = moveItems(p, sel, -1.5);
  assert.deepEqual(earlier.zooms.map((z) => [z.start, z.end]), [[0.5, 2.5], [2.5, 4.5]]);
});

test('a move off the video, or onto an unselected zoom, is refused whole', () => {
  const p = P.addZoom(base(), { start: 8, end: 9 });
  const sel = [{ kind: 'zoom', id: 'z1' }, { kind: 'annotation', id: p.annotations[0].id }];
  assert.throws(() => moveItems(p, sel, -5), /off the video/);
  assert.throws(() => moveItems(p, sel, 5), /overlap/);
  assert.throws(() => moveItems(p, [{ kind: 'audio', id: p.audio.clips[0].id }], -3), /before the start/);
});

test('clips in the selection stay where they are', () => {
  const p = base();
  const next = moveItems(p, [{ kind: 'clip', id: p.clips[0].id }, { kind: 'zoom', id: 'z1' }], 1);
  assert.equal(next.clips, p.clips);
  near(next.zooms[0].start, 3, 'the zoom moved');
});
