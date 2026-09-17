// Where the pictures along a clip go (timeline-math.js stripTiles/thumbStep),
// the first-run card's memory (first-run.js) and appending a recording with
// the core, the way the editor's Add recording does.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import { stripTiles, thumbStep } from '../src/renderer/editor/timeline-math.js';
import { createFirstRunHint, HINT_LINES } from '../src/renderer/editor/first-run.js';

test('a clip is tiled with pictures from its left edge, only where the view is', () => {
  // 0..10 s at 50 px/s with 16 px before 0:00: the clip spans 16..516 px.
  const all = stripTiles({ outStart: 0, outEnd: 10, pps: 50, tileWidth: 100, viewStart: -1000, viewEnd: 5000, pad: 16 });
  assert.deepEqual(all.map((t) => t.x), [0, 100, 200, 300, 400]);
  assert.deepEqual(all.map((t) => t.outT), [1, 3, 5, 7, 9]);

  // A clip that starts later, with only part of it in view.
  const some = stripTiles({ outStart: 10, outEnd: 30, pps: 50, tileWidth: 100, viewStart: 800, viewEnd: 1000, pad: 16 });
  assert.deepEqual(some.map((t) => t.x), [200, 300, 400]);
  assert.equal(some[0].outT, 10 + 250 / 50);

  // The last tile is cut by the clip's end: its picture is from inside the clip.
  const short = stripTiles({ outStart: 0, outEnd: 2.5, pps: 50, tileWidth: 100, viewStart: 0, viewEnd: 1000, pad: 0 });
  assert.equal(short.length, 2);
  assert.equal(short[1].outT, 2.5);

  assert.deepEqual(stripTiles({ outStart: 0, outEnd: 10, pps: 50, tileWidth: 100, viewStart: 5000, viewEnd: 6000 }), []);
  assert.deepEqual(stripTiles({ outStart: 5, outEnd: 5, pps: 50, tileWidth: 100, viewStart: 0, viewEnd: 1000 }), []);
});

test('picture spacing is a nice step, so nearby timeline zooms share pictures', () => {
  assert.equal(thumbStep(0.05), 0.1);
  assert.equal(thumbStep(1.6), 2);
  assert.equal(thumbStep(1.4), 2);
  assert.equal(thumbStep(7), 10);
  assert.equal(thumbStep(10000), 300);
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('the first-run card says three short things', () => {
  assert.equal(HINT_LINES.length, 3);
  for (const line of HINT_LINES) assert.ok(line.text.length <= 48, line.text);
});

test('the first-run card is not shown again once dismissed, and a broken storage never throws', () => {
  const storage = memoryStorage();
  storage.setItem('loupe.editor.firstRunHintSeen', '1');
  const hint = createFirstRunHint({ parent: null, storage });
  assert.equal(hint.show(), false, 'seen before: nothing to show (and no DOM needed)');
  assert.equal(hint.open, false);
  hint.reset();
  assert.equal(storage.getItem('loupe.editor.firstRunHintSeen'), null);

  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.doesNotThrow(() => createFirstRunHint({ parent: null, storage: broken }).reset());
});

test('appending a recording adds its clips at the end and keeps the timeline in order', () => {
  const p = P.createProject({ main: { width: 1000, height: 600, duration: 20, video: 'raw.mov' }, createdAt: 0 });
  const other = { dir: '/recordings/2', width: 1280, height: 800, duration: 8, video: 'raw.mov', mic: true };
  let next = P.appendRecording(p, 'src2', other);
  next = P.addZoom(next, { source: 'src2', start: 2, end: 4, level: 2, follow: true, x: 0, y: 0 });
  assert.deepEqual(next.clips.map((c) => [c.source, c.start, c.end]), [['main', 0, 20], ['src2', 0, 8]]);
  const tl = buildTimeline(next);
  assert.equal(tl.duration, 28);
  assert.deepEqual(tl.toSource(21), { clipIndex: 1, source: 'src2', t: 1 });
  assert.equal(tl.toOutput('src2', 3), 23);
});
