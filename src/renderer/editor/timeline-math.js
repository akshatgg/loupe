// The arithmetic behind the editor's timeline, kept free of the DOM so it can
// be unit-tested (test/editor-timeline-math.test.mjs).
//
// The timeline shows the OUTPUT video: clips one after another, each as long
// as it plays after speed changes. Zooms and speed stretches are stored in
// SOURCE time (docs/EDITOR-V2.md section 3), so each is drawn wherever its
// recording moment plays -- once per clip it overlaps, and not at all where
// it was cut out. Dragging converts back: an output position inside a clip is
// a source moment of that clip.

import { buildSpeedMap, mapToOutput, mapToSource } from '../../core/timeline.js';
import { MIN_RANGE_SECONDS } from '../../core/project.js';

const EPS = 1e-6;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Speed maps per project (edits share untouched parts, so a new project
// object is a new cache entry; the old one is collected with it).
const mapCache = new WeakMap();
function mapFor(project, source) {
  if (!mapCache.has(project)) mapCache.set(project, new Map());
  const byKey = mapCache.get(project);
  if (!byKey.has(source)) {
    const meta = project.sources[source];
    byKey.set(source, buildSpeedMap(project.speed.filter((s) => s.source === source), meta.duration));
  }
  return byKey.get(source);
}

// [{ clipIndex, clip, outStart, outEnd }] in play order.
export function clipLayout(project, tl) {
  return tl.clipBounds().map((b) => ({ ...b, clip: project.clips[b.clipIndex] }));
}

// Output time at which source moment t (clamped to the clip) plays in clip i.
// (A freeze frame's is its start; a reversed clip plays its moments from
// its end, so they are mirrored.)
export function outputInClip(project, layout, i, t) {
  const { clip, outStart, outEnd } = layout[i];
  if (clip.hold > 0) return outStart;
  const map = mapFor(project, clip.source);
  const local = mapToOutput(map, clamp(t, clip.start, clip.end)) - mapToOutput(map, clip.start);
  return clip.reverse ? outEnd - local : outStart + local;
}

// The same without the clamp: where source moment t would sit if clip i ran
// on past its ends. A trim edge dragged over the part being cut, or back
// over a part cut earlier, is drawn here.
export function outputAtSource(project, layout, i, t) {
  const { clip, outStart } = layout[i];
  const map = mapFor(project, clip.source);
  return outStart + mapToOutput(map, t) - mapToOutput(map, clip.start);
}

// Source moment of clip i playing at output time outT (clamped to the clip).
export function sourceInClip(project, layout, i, outT) {
  const { clip, outStart, outEnd } = layout[i];
  if (clip.hold > 0) return clip.start;
  const map = mapFor(project, clip.source);
  const local = clamp(outT - outStart, 0, outEnd - outStart);
  const o = mapToOutput(map, clip.start) + (clip.reverse ? outEnd - outStart - local : local);
  return clamp(mapToSource(map, o), clip.start, clip.end);
}

// The clip playing at output time outT (the last one at the very end).
export function clipIndexAt(layout, outT) {
  const i = layout.findIndex((l) => outT < l.outEnd);
  return i < 0 ? layout.length - 1 : i;
}

// Where a source range shows on the output timeline: one piece per clip it
// overlaps, [{ clipIndex, outStart, outEnd, srcStart, srcEnd }].
export function rangePieces(project, layout, source, start, end) {
  const pieces = [];
  layout.forEach((l, i) => {
    if (l.clip.source !== source) return;
    const a = Math.max(start, l.clip.start);
    const b = Math.min(end, l.clip.end);
    if (b - a <= EPS) return;
    // A reversed clip shows the range's end first.
    const oa = outputInClip(project, layout, i, a);
    const ob = outputInClip(project, layout, i, b);
    pieces.push({ clipIndex: i, srcStart: a, srcEnd: b, outStart: Math.min(oa, ob), outEnd: Math.max(oa, ob) });
  });
  return pieces;
}

// How long a range plays in the video: its pieces' output lengths, so a zoom
// reaching over a cut doesn't count the time that was cut out.
export function shownLength(pieces) {
  return pieces.reduce((n, p) => n + Math.max(0, p.outEnd - p.outStart), 0);
}

export function zoomPieces(project, layout) {
  return project.zooms.flatMap((zoom) =>
    rangePieces(project, layout, zoom.source, zoom.start, zoom.end).map((p) => ({ ...p, zoom })));
}

export function speedPieces(project, layout) {
  return project.speed.flatMap((seg) =>
    rangePieces(project, layout, seg.source, seg.start, seg.end).map((p) => ({ ...p, seg })));
}

// The free source time around moment t for a zoom (other zooms of the same
// source can't overlap it): { lo, hi }. `ignoreId` is the zoom being moved.
export function zoomRoom(project, source, t, ignoreId = null) {
  let lo = 0;
  let hi = project.sources[source].duration;
  for (const z of project.zooms) {
    if (z.source !== source || z.id === ignoreId) continue;
    if (z.end <= t + EPS) lo = Math.max(lo, z.end);
    else if (z.start >= t - EPS) hi = Math.min(hi, z.start);
    else return null; // t is inside another zoom
  }
  return { lo, hi };
}

// A new zoom from a drag across output times a..b (or a click at a, when
// b is null: `length` seconds from there). Kept inside the clip the drag
// started in and out of other zooms; null if there's no room.
export function newZoomRange(project, layout, a, b = null, length = 2) {
  if (!layout.length) return null;
  const i = clipIndexAt(layout, a);
  const { clip } = layout[i];
  const s0 = sourceInClip(project, layout, i, a);
  const room = zoomRoom(project, clip.source, s0);
  if (!room) return null;
  let start;
  let end;
  if (b === null) {
    start = s0;
    end = s0 + length;
  } else {
    const s1 = sourceInClip(project, layout, i, b);
    start = Math.min(s0, s1);
    end = Math.max(s0, s1);
  }
  const lo = Math.max(room.lo, clip.start);
  const hi = Math.min(room.hi, clip.end);
  start = clamp(start, lo, hi);
  end = clamp(end, lo, hi);
  // A click near the end of the room: slide back rather than come out short.
  if (b === null && end - start < length) start = Math.max(lo, end - length);
  if (end - start < MIN_RANGE_SECONDS - EPS) return null;
  return { source: clip.source, start, end };
}

// Moves zoom `zoom` so it starts at source moment `start`, keeping its length,
// inside its free room.
export function movedZoom(project, zoom, start) {
  const length = zoom.end - zoom.start;
  const room = zoomRoom(project, zoom.source, (zoom.start + zoom.end) / 2, zoom.id) ??
    { lo: 0, hi: project.sources[zoom.source].duration };
  const s = clamp(start, room.lo, Math.max(room.lo, room.hi - length));
  return { start: s, end: Math.min(room.hi, s + length) };
}

// One edge of a zoom dragged to source moment t.
export function resizedZoom(project, zoom, edge, t) {
  const room = zoomRoom(project, zoom.source, (zoom.start + zoom.end) / 2, zoom.id) ??
    { lo: 0, hi: project.sources[zoom.source].duration };
  if (edge === 'start') return { start: clamp(t, room.lo, zoom.end - MIN_RANGE_SECONDS), end: zoom.end };
  return { start: zoom.start, end: clamp(t, zoom.start + MIN_RANGE_SECONDS, room.hi) };
}

// The value snapped to the nearest candidate within `tolerance`, or itself.
export function snap(value, candidates, tolerance) {
  let best = value;
  let dist = tolerance;
  for (const c of candidates) {
    const d = Math.abs(c - value);
    if (d <= dist) { best = c; dist = d; }
  }
  return best;
}

// Output times worth snapping to: the start and end, clip edges, the
// playhead, and zoom and speed edges (minus the thing being dragged).
export function snapPoints(project, layout, { playhead = null, exceptZoom = null } = {}) {
  const points = [0];
  for (const l of layout) points.push(l.outStart, l.outEnd);
  if (playhead !== null) points.push(playhead);
  for (const p of zoomPieces(project, layout)) {
    if (p.zoom.id !== exceptZoom) points.push(p.outStart, p.outEnd);
  }
  for (const p of speedPieces(project, layout)) points.push(p.outStart, p.outEnd);
  return points;
}

// Where a clip dragged to output time outT lands: the index it would take
// in the reordered list.
export function insertionIndex(layout, from, outT) {
  let to = 0;
  layout.forEach((l, i) => {
    if (i === from) return;
    if (outT > (l.outStart + l.outEnd) / 2) to++;
  });
  return to;
}

// Ruler spacing: a "nice" step (seconds) whose labels are at least minPx
// apart, and how many minor ticks split it.
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
export function tickStep(pxPerSecond, minPx = 72) {
  const major = STEPS.find((s) => s * pxPerSecond >= minPx) ?? STEPS.at(-1);
  const minor = [1, 2, 5, 10, 15, 30, 60, 300, 600].includes(major) ? major / (major >= 60 ? 6 : 5) : major / 2;
  return { major, minor };
}

// "0:07", "1:05", "1:02:03"; with `fraction`, tenths too ("0:07.4").
export function formatTime(seconds, { fraction = false } = {}) {
  let s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (!fraction) s = Math.floor(s + 1e-6);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s - h * 3600 - m * 60;
  const whole = Math.floor(rest + 1e-6);
  let sec = String(whole).padStart(2, '0');
  if (fraction) sec += `.${Math.min(9, Math.floor((rest - whole) * 10 + 1e-6))}`;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// A time typed by a person: "90", "1:30", "1:30.5", "0:01:30" (a comma
// works as the decimal point too). Seconds, or null when it isn't a time.
export function parseTime(text) {
  const parts = String(text ?? '').trim().replace(',', '.').split(':');
  if (parts.length > 3) return null;
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    if (!(last ? /^\d+(\.\d+)?$/ : /^\d+$/).test(parts[i])) return null;
    const n = Number(parts[i]);
    // Minutes and seconds after the first part stop at 59.
    if (i > 0 && n >= 60) return null;
    total = total * 60 + n;
  }
  return total;
}

// Near enough to the end of the video to mean the end (a typed time is
// rounded -- formatTime to a tenth -- and the video's length rarely is).
const END_SLACK = 0.1;

// The output ranges to cut away (latest first, so each cut leaves the
// earlier times where they were) for "Remove this part" (`mode` 'remove')
// or "Keep only this part" ('keep') of from..to. { ranges } or { error }.
export function cutRanges(duration, from, to, mode) {
  if (from === null || !Number.isFinite(from)) return { error: 'Type the From time as 1:30 or 90.' };
  if (to === null || !Number.isFinite(to)) return { error: 'Type the To time as 1:30 or 90.' };
  if (to > duration + END_SLACK) {
    const fraction = duration % 1 > END_SLACK && duration % 1 < 1 - END_SLACK;
    return { error: `The video is only ${formatTime(duration, { fraction })} long.` };
  }
  const b = Math.min(to, duration);
  if (b - from < 1e-3) return { error: 'The To time needs to be after the From time.' };
  const atStart = from < 1e-3;
  const atEnd = b > duration - END_SLACK;
  if (mode === 'remove') {
    if (atStart && atEnd) return { error: 'That’s the whole video. A video needs something left in it.' };
    return { ranges: [[from, atEnd ? duration : b]] };
  }
  if (atStart && atEnd) return { error: 'That’s already the whole video.' };
  const ranges = [];
  if (!atEnd) ranges.push([b, duration]);
  if (!atStart) ranges.push([0, from]);
  return { ranges };
}

// Playback speed (source seconds per output second) at output time outT.
export function rateAt(project, layout, outT) {
  if (!layout.length) return 1;
  const i = clipIndexAt(layout, outT);
  const { outStart, outEnd } = layout[i];
  const h = 0.01;
  const a = clamp(outT, outStart, outEnd - h);
  if (outEnd - outStart <= h) return 1;
  const r = (sourceInClip(project, layout, i, a + h) - sourceInClip(project, layout, i, a)) / h;
  return r > 0 ? r : 1;
}

// Clip pictures (thumbnails.js): where the pictures along a clip go.
// A clip from output time outStart to outEnd, drawn at `pps` px per second,
// is tiled with pictures `tileWidth` px wide; only tiles within the visible
// stretch [viewStart, viewEnd] (px, timeline content coordinates, `pad` px
// before 0:00) are wanted. Returns [{ x, outT }]: each tile's left edge inside
// the clip and the output moment its picture shows (the tile's middle).
export function stripTiles({ outStart, outEnd, pps, tileWidth, viewStart, viewEnd, pad = 0 }) {
  const tiles = [];
  const width = (outEnd - outStart) * pps;
  if (!(width > 0) || !(tileWidth > 0) || !(pps > 0)) return tiles;
  const left = pad + outStart * pps;
  const first = Math.max(0, Math.floor((viewStart - left) / tileWidth));
  const last = Math.min(Math.ceil(width / tileWidth) - 1, Math.floor((viewEnd - left) / tileWidth));
  for (let i = first; i <= last; i++) {
    const x = i * tileWidth;
    const mid = Math.min(width, x + tileWidth / 2);
    tiles.push({ x, outT: outStart + mid / pps });
  }
  return tiles;
}

// How finely pictures are kept apart, in source seconds, for tiles that each
// cover about `seconds`: a "nice" step, so nearby zoom levels share pictures,
// and at most half a tile, so a picture is never more than a quarter of a
// tile from its tile's moment (camera video changes too fast for more).
const THUMB_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
export function thumbStep(seconds) {
  return THUMB_STEPS.find((s) => s >= seconds * 0.25) ?? THUMB_STEPS.at(-1);
}

// What a selection box takes in: every item whose rectangle it overlaps
// (touching edges don't count). rects: [{ item, x0, x1, y0, y1 }]; the box
// has the same shape, its corners in any order.
export function boxHits(rects, box) {
  const bx0 = Math.min(box.x0, box.x1);
  const bx1 = Math.max(box.x0, box.x1);
  const by0 = Math.min(box.y0, box.y1);
  const by1 = Math.max(box.y0, box.y1);
  if (bx1 - bx0 <= 0 || by1 - by0 <= 0) return [];
  return rects.filter((r) => r.x0 < bx1 && r.x1 > bx0 && r.y0 < by1 && r.y1 > by0).map((r) => r.item);
}
