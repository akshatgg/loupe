import test from 'node:test';
import assert from 'node:assert/strict';
import { autoZoomRanges, LEAD_IN, HOLD_AFTER } from '../src/core/auto-zoom.js';
import * as P from '../src/core/project.js';
import { noteText } from '../src/renderer/editor/auto-zoom-note.js';

const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
const clicks = (...ts) => ts.map((t) => ({ t, x: 100, y: 100, button: 'left' }));

test('a lone click makes one zoom, from a little before to a little after', () => {
  const [z, ...rest] = autoZoomRanges(clicks(5), 20);
  assert.equal(rest.length, 0);
  near(z.start, 5 - LEAD_IN, 'start');
  near(z.end, 5 + HOLD_AFTER, 'end');
  assert.equal(z.level, 2);
});

test('clicks close together share a zoom; clicks far apart get their own', () => {
  const zooms = autoZoomRanges(clicks(5, 6, 7.5, 12), 20);
  assert.equal(zooms.length, 2);
  near(zooms[0].start, 5 - LEAD_IN, 'first start');
  near(zooms[0].end, 7.5 + HOLD_AFTER, 'first end');
  assert.equal(zooms[0].clicks, 3);
  near(zooms[1].start, 12 - LEAD_IN, 'second start');
});

test('strength: subtle skips lone clicks and zooms less; intense zooms closer', () => {
  const c = clicks(2, 2.8, 10);
  const subtle = autoZoomRanges(c, 20, { strength: 'subtle' });
  assert.equal(subtle.length, 1);
  assert.equal(subtle[0].level, 1.5);
  const intense = autoZoomRanges(c, 20, { strength: 'intense' });
  assert.equal(intense.length, 2);
  assert.equal(intense[0].level, 2.5);
  assert.throws(() => autoZoomRanges(c, 20, { strength: 'huge' }), /strength/);
});

test('zooms stay inside the recording, never overlap, and are at least a second', () => {
  const zooms = autoZoomRanges(clicks(0.1, 19.9, 3, 5.6, 8.2), 20);
  for (const z of zooms) {
    assert.ok(z.start >= 0 && z.end <= 20, `inside: ${z.start}..${z.end}`);
    assert.ok(z.end - z.start >= 1 - 1e-9, `long enough: ${z.end - z.start}`);
  }
  for (let i = 1; i < zooms.length; i++) assert.ok(zooms[i].start >= zooms[i - 1].end - 1e-9, 'no overlap');
  near(zooms.at(-1).end, 20, 'the last one ends with the recording');
});

test('no clicks, clicks out of range and junk make nothing', () => {
  assert.deepEqual(autoZoomRanges([], 20), []);
  assert.deepEqual(autoZoomRanges(undefined, 20), []);
  assert.deepEqual(autoZoomRanges([{ t: -1 }, { t: 99 }, { t: NaN }, null], 20), []);
});

test('a zoom someone made there wins', () => {
  const zooms = autoZoomRanges(clicks(5, 12), 20, { taken: [{ start: 4, end: 6 }] });
  assert.equal(zooms.length, 1);
  near(zooms[0].start, 12 - LEAD_IN, 'only the free one');
});

const project = (cl) => P.createProject({ main: { width: 1920, height: 1080, duration: 20, clicks: cl }, createdAt: 0 });

test('applyAutoZooms adds automatic zooms that follow the cursor, around hand-made ones', () => {
  let p = P.addZoom(project(clicks(5, 12)), { start: 4, end: 6, level: 3 });
  p = P.applyAutoZooms(p);
  assert.equal(p.zooms.length, 2);
  const auto = p.zooms.filter((z) => z.auto);
  assert.equal(auto.length, 1);
  assert.equal(auto[0].follow, true);
  assert.equal(auto[0].recorded, false);
  assert.equal(P.autoZoomCount(p), 1);
  assert.equal(new Set(p.zooms.map((z) => z.id)).size, 2, 'ids are unique');
  P.validateProject(JSON.parse(JSON.stringify(p)));
});

test('applying again replaces the automatic zooms; removing takes only them', () => {
  let p = P.addZoom(project(clicks(2, 2.5, 9, 15)), { start: 17, end: 19 });
  p = P.applyAutoZooms(p, { strength: 'moderate' });
  assert.equal(P.autoZoomCount(p), 3);
  p = P.applyAutoZooms(p, { strength: 'subtle' });
  assert.equal(P.autoZoomCount(p), 1);
  assert.equal(p.zooms.find((z) => z.auto).level, 1.5);
  p = P.removeAutoZooms(p);
  assert.deepEqual(p.zooms.map((z) => [z.start, z.end]), [[17, 19]]);
});

test('"Make it mine" keeps a zoom when they are remade', () => {
  let p = P.applyAutoZooms(project(clicks(5, 12)));
  const first = p.zooms[0];
  p = P.updateZoom(p, first.id, { auto: false, level: 4 });
  p = P.applyAutoZooms(p, { strength: 'intense' });
  assert.equal(p.zooms.find((z) => z.id === first.id).level, 4);
  assert.equal(P.autoZoomCount(p), 1);
});

test('the note is set and cleared, survives validation, and goes when the zooms are answered', () => {
  let p = P.setAutoZoomNote(P.applyAutoZooms(project(clicks(5))), true);
  assert.equal(P.validateProject(JSON.parse(JSON.stringify(p))).autoZoomNote, true);
  assert.equal('autoZoomNote' in P.applyAutoZooms(p, { strength: 'subtle' }), false);
  assert.equal('autoZoomNote' in P.removeAutoZooms(p), false);
  assert.equal('autoZoomNote' in P.setAutoZoomNote(p, false), false);
  p = { ...p, autoZoomNote: 'yes' };
  assert.equal('autoZoomNote' in P.validateProject(p), false, 'a hand-edited value is dropped');
});

test('hasClicks, and an imported video has none', () => {
  assert.equal(P.hasClicks(project(clicks(5))), true);
  assert.equal(P.hasClicks(project([])), false);
});

test('the note counts in plain words', () => {
  assert.equal(noteText(1), 'Loupe added 1 zoom where you clicked.');
  assert.equal(noteText(6), 'Loupe added 6 zooms where you clicked.');
});

test('while recording, a click zooms the frame in at once, held until a moment after it', async () => {
  const { liveClickZoom, RECORDING_STRENGTH } = await import('../src/core/auto-zoom.js');
  assert.equal(RECORDING_STRENGTH, 'moderate');
  assert.equal(liveClickZoom(0), 2, 'at the click: the level the video will zoom to');
  assert.equal(liveClickZoom(HOLD_AFTER - 0.01), 2, 'still in just before the zoom ends');
  assert.equal(liveClickZoom(HOLD_AFTER + 0.01), 1, 'out once the video zooms out');
  assert.equal(liveClickZoom(Infinity), 1, 'no click yet');
  assert.equal(liveClickZoom(-0.5), 1, 'a click from the future is no click');
});
