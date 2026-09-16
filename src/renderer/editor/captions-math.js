// The arithmetic behind the Captions panel and the captions track, kept free
// of the DOM so it can be unit-tested (test/editor-captions-math.test.mjs).
//
// Captions are stored in SOURCE time (core/captions/model.js), like zooms: the
// track draws each one once per clip it overlaps, the transcript lists them in
// the order they play, and a drag converts output positions back to source
// moments. Captions of one recording never overlap each other, so a drag is
// kept inside the gap its neighbours leave.

import { captionsToOutput } from '../../core/captions/timeline.js';
import { segmentsAt, MIN_SEGMENT_SECONDS, sortSegments } from '../../core/captions/model.js';
import { rangePieces, clipIndexAt, sourceInClip, clamp } from './timeline-math.js';

const EPS = 1e-6;

export function captionPieces(project, layout) {
  return project.captions.segments.flatMap((seg) =>
    rangePieces(project, layout, seg.source, seg.start, seg.end).map((p) => ({ ...p, seg })));
}

// The transcript, in the order it plays: [{ seg, outStart, outEnd }], with
// captions whose moment was cut from the video last (outStart null).
export function transcriptRows(project, layout) {
  const rows = project.captions.segments.map((seg) => {
    const pieces = rangePieces(project, layout, seg.source, seg.start, seg.end);
    if (!pieces.length) return { seg, outStart: null, outEnd: null };
    const first = pieces.reduce((a, b) => (b.outStart < a.outStart ? b : a));
    return { seg, outStart: first.outStart, outEnd: first.outEnd };
  });
  return rows.sort((a, b) => {
    if (a.outStart === null || b.outStart === null) {
      return (a.outStart === null) - (b.outStart === null) || a.seg.start - b.seg.start;
    }
    return a.outStart - b.outStart;
  });
}

// Output-time cues per segments array and timeline (both change identity on
// every edit), so asking on every frame of playback costs nothing.
const cueCache = new WeakMap();
function cuesFor(segments, tl) {
  let byTl = cueCache.get(segments);
  if (!byTl) cueCache.set(segments, (byTl = new WeakMap()));
  if (!byTl.has(tl)) byTl.set(tl, captionsToOutput(segments, tl));
  return byTl.get(tl);
}

// The id of the caption on screen at output time outT, or null.
export function captionIdAt(project, tl, outT) {
  return segmentsAt(cuesFor(project.captions.segments, tl), outT)[0]?.id ?? null;
}

// The free source time a caption can use: between the one before it and the
// one after it (same recording), inside the recording.
export function captionRoom(project, seg) {
  let lo = 0;
  let hi = project.sources[seg.source]?.duration ?? Infinity;
  for (const s of project.captions.segments) {
    if (s.source !== seg.source || s.id === seg.id) continue;
    if (s.end <= seg.start + EPS) lo = Math.max(lo, s.end);
    else if (s.start >= seg.end - EPS) hi = Math.min(hi, s.start);
    else if (s.start < seg.start) lo = Math.max(lo, s.end); // already overlapping: keep it from getting worse
    else hi = Math.min(hi, s.start);
  }
  return { lo, hi: Math.max(lo, hi) };
}

// One edge of a caption dragged to source moment t.
export function resizedCaption(project, seg, edge, t) {
  const room = captionRoom(project, seg);
  if (edge === 'start') {
    return { start: clamp(t, room.lo, Math.max(room.lo, seg.end - MIN_SEGMENT_SECONDS)) };
  }
  return { end: clamp(t, Math.min(room.hi, seg.start + MIN_SEGMENT_SECONDS), room.hi) };
}

// A caption moved to start at source moment `start`, keeping its length.
export function movedCaption(project, seg, start) {
  const room = captionRoom(project, seg);
  const length = seg.end - seg.start;
  const s = clamp(start, room.lo, Math.max(room.lo, room.hi - length));
  return { start: s, end: Math.min(room.hi, s + length) };
}

// A new, empty-room caption at output time outT: up to `length` seconds from
// the playhead, inside its clip and the gap between captions. Null when the
// playhead is on a caption already or there's no room.
export function newCaptionRange(project, layout, outT, length = 2) {
  if (!layout.length) return null;
  const i = clipIndexAt(layout, outT);
  const { clip } = layout[i];
  const t = sourceInClip(project, layout, i, outT);
  let lo = clip.start;
  let hi = clip.end;
  for (const s of project.captions.segments) {
    if (s.source !== clip.source) continue;
    if (s.start <= t + EPS && t < s.end - EPS) return null;
    if (s.end <= t + EPS) lo = Math.max(lo, s.end);
    else hi = Math.min(hi, s.start);
  }
  let start = t;
  const end = Math.min(hi, t + length);
  if (end - start < length) start = Math.max(lo, end - length);
  if (end - start < MIN_SEGMENT_SECONDS - EPS) return null;
  return { source: clip.source, start, end };
}

// Captions from a fresh transcription of some recordings, replacing what
// those recordings had and keeping the captions of any others.
export function replaceSegments(segments, sources, fresh) {
  const keep = segments.filter((s) => !sources.includes(s.source));
  return sortSegments([...keep, ...fresh]);
}
