// The arithmetic behind adding and moving annotations in the editor, free of
// the DOM so it can be unit-tested (test/editor-annotation-math.test.mjs).
//
// Annotations are stored in source time (docs/EDITOR-V2.md section 3), like
// zooms: added at the playhead's moment of the recording, dragged along the
// annotation track, and shown once per clip they overlap. Unlike zooms they
// may overlap each other, so the track stacks them in lanes.
//
// Positions (core/layers/annotations.js): text in fractions of the content
// area, arrows/boxes/hidden areas in fractions of the recording's picture.

import { MIN_RANGE_SECONDS } from '../../core/project.js';
import { clipIndexAt, sourceInClip, rangePieces, clamp } from './timeline-math.js';

export const DEFAULT_SECONDS = { text: 3, title: 3, arrow: 3, box: 3, blur: 4 };

export const COLOURS = ['#ffffff', '#1f1f23', '#ff453a', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2'];

export const KINDS = [
  { type: 'text', label: 'Text', icon: 'text' },
  { type: 'title', label: 'Title card', icon: 'titleCard' },
  { type: 'arrow', label: 'Arrow', icon: 'arrow' },
  { type: 'box', label: 'Box', icon: 'box' },
  { type: 'blur', label: 'Hide an area', icon: 'blur' }
];

export const kindOf = (type) => KINDS.find((k) => k.type === type) ?? KINDS[0];

const LOOKS = {
  text: { x: 0.5, y: 0.14, text: 'Your text here', color: '#ffffff', size: 1 },
  title: { text: 'Your title\nA few words about this video', color: '#1f1f23', size: 1 },
  arrow: { x: 0.36, y: 0.34, x2: 0.52, y2: 0.5, color: '#ff453a', size: 1 },
  box: { x: 0.36, y: 0.32, w: 0.28, h: 0.24, color: '#ffd60a', size: 1 },
  blur: { x: 0.36, y: 0.4, w: 0.28, h: 0.12, color: '#ffffff', size: 1 }
};

// A new annotation of `type` starting at output time outT, inside the clip
// playing there. A title card near the start of the video starts at 0, the
// usual place for an intro.
export function newAnnotation(project, layout, outT, type) {
  if (!layout.length) return null;
  const i = clipIndexAt(layout, outT);
  const { clip } = layout[i];
  const length = DEFAULT_SECONDS[type] ?? 3;
  let start = sourceInClip(project, layout, i, type === 'title' && outT < 1 ? layout[i].outStart : outT);
  let end = Math.min(clip.end, start + length);
  // Near the end of a clip: slide back rather than come out short.
  if (end - start < length) start = Math.max(clip.start, end - length);
  if (end - start < MIN_RANGE_SECONDS) end = Math.min(project.sources[clip.source].duration, start + MIN_RANGE_SECONDS);
  return { type, source: clip.source, start, end, ...LOOKS[type] };
}

export function annotationPieces(project, layout) {
  return project.annotations.flatMap((a) =>
    rangePieces(project, layout, a.source, a.start, a.end).map((p) => ({ ...p, annotation: a })));
}

// Lanes for overlapping pieces: each piece gets the first lane free at its
// start. Returns the number of lanes (at least 1) and sets piece.lane.
export function stackLanes(pieces) {
  const ends = [];
  const sorted = [...pieces].sort((a, b) => a.outStart - b.outStart || a.outEnd - b.outEnd);
  for (const p of sorted) {
    let lane = ends.findIndex((e) => e <= p.outStart + 1e-6);
    if (lane < 0) { lane = ends.length; ends.push(0); }
    ends[lane] = p.outEnd;
    p.lane = lane;
  }
  return Math.max(1, ends.length);
}

// An annotation moved to start at source moment `start`, keeping its length,
// inside its recording.
export function movedRange(project, a, start) {
  const length = a.end - a.start;
  const duration = project.sources[a.source].duration;
  const s = clamp(start, 0, Math.max(0, duration - length));
  return { start: s, end: s + length };
}

// One edge dragged to source moment t.
export function resizedRange(project, a, edge, t) {
  const duration = project.sources[a.source].duration;
  if (edge === 'start') return { start: clamp(t, 0, a.end - MIN_RANGE_SECONDS), end: a.end };
  return { start: a.start, end: clamp(t, a.start + MIN_RANGE_SECONDS, duration) };
}

// The patch for dragging an annotation by (dx, dy): fractions of its own
// space (content area for text, the recording for the rest). Kept so at
// least a little of it stays in the picture.
export function movedBy(a, dx, dy) {
  const keep = (v, size) => clamp(v, -size + 0.02, 0.98);
  if (a.type === 'text') return { x: clamp(a.x + dx, 0.02, 0.98), y: clamp(a.y + dy, 0.02, 0.98) };
  if (a.type === 'arrow') {
    const ddx = clamp(dx, -Math.min(a.x, a.x2), 1 - Math.max(a.x, a.x2));
    const ddy = clamp(dy, -Math.min(a.y, a.y2), 1 - Math.max(a.y, a.y2));
    return { x: a.x + ddx, y: a.y + ddy, x2: a.x2 + ddx, y2: a.y2 + ddy };
  }
  if (a.type === 'box' || a.type === 'blur') return { x: keep(a.x + dx, a.w), y: keep(a.y + dy, a.h) };
  return {};
}

// A box or hidden area's corner dragged to fraction (fx, fy) of the recording;
// the opposite corner stays put.
export function resizedBox(a, corner, fx, fy) {
  const min = 0.01;
  let x0 = a.x;
  let y0 = a.y;
  let x1 = a.x + a.w;
  let y1 = a.y + a.h;
  if (corner.includes('left')) x0 = Math.min(clamp(fx, -0.5, 1.5), x1 - min);
  else x1 = Math.max(clamp(fx, -0.5, 1.5), x0 + min);
  if (corner.includes('top')) y0 = Math.min(clamp(fy, -0.5, 1.5), y1 - min);
  else y1 = Math.max(clamp(fy, -0.5, 1.5), y0 + min);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// A short name for lists and the timeline.
export function annotationLabel(a) {
  if (a.type === 'text' || a.type === 'title') {
    const first = String(a.text ?? '').split('\n')[0].trim();
    if (first) return first.length > 40 ? `${first.slice(0, 39)}…` : first;
  }
  return kindOf(a.type).label;
}
