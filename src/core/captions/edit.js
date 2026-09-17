// Transcript edits. Each is pure: it takes the segments array and returns a
// new, sorted one (inputs are never mutated), so every edit is one undo step
// in history.js. Unknown ids leave the segments unchanged rather than throw:
// the editor can race a delete against a pending edit and neither should crash.

import { createCaptionId, joinWords, sortSegments, MIN_SEGMENT_SECONDS } from './model.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function copy(seg) {
  const c = { ...seg };
  if (seg.words) c.words = seg.words.map((w) => ({ ...w }));
  return c;
}

export function addSegment(segments, { source = 'main', start, end, text, id }) {
  if (!isNum(start) || !isNum(end)) throw new Error('A caption needs a start and an end time');
  const s = Math.max(0, Math.min(start, end));
  const e = Math.max(s + MIN_SEGMENT_SECONDS, Math.max(start, end));
  const seg = { id: id ?? createCaptionId(), source, start: s, end: e, text: String(text ?? '').trim() };
  return sortSegments([...segments.map(copy), seg]);
}

export function removeSegment(segments, id) {
  return segments.filter((s) => s.id !== id).map(copy);
}

// New text for one caption. The word timings describe the old text, so they
// go unless the words are unchanged (e.g. only spacing changed).
export function editText(segments, id, text) {
  const t = String(text ?? '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  return segments.map((s) => {
    if (s.id !== id) return copy(s);
    const c = copy(s);
    c.text = t;
    if (c.words && joinWords(c.words) !== t.replace(/\n/g, ' ')) delete c.words;
    return c;
  });
}

// Merge a caption with the one right after it (same source), e.g. when a
// sentence was split at an odd place.
export function mergeWithNext(segments, id) {
  const sorted = sortSegments(segments.map(copy));
  const i = sorted.findIndex((s) => s.id === id);
  if (i < 0) return sorted;
  const j = sorted.findIndex((s, k) => k > i && s.source === sorted[i].source);
  if (j < 0) return sorted;
  return mergeSegments(sorted, sorted[i].id, sorted[j].id);
}

export function mergeSegments(segments, idA, idB) {
  const a = segments.find((s) => s.id === idA);
  const b = segments.find((s) => s.id === idB);
  if (!a || !b || a === b || a.source !== b.source) return sortSegments(segments.map(copy));
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  const merged = {
    id: first.id,
    source: first.source,
    start: Math.min(first.start, second.start),
    end: Math.max(first.end, second.end),
    text: `${first.text} ${second.text}`.replace(/\s+/g, ' ').trim()
  };
  if (first.words && second.words) merged.words = [...first.words, ...second.words].map((w) => ({ ...w }));
  return sortSegments([
    ...segments.filter((s) => s !== a && s !== b).map(copy),
    merged
  ]);
}

// Split one caption in two. `at` is either { index } (a character position in
// the text, what a cursor in the transcript editor gives) or { time } (source
// seconds, what the playhead gives). The split time comes from the word
// timings when there are any, and otherwise from how far into the text the
// split falls, which is close enough for evenly paced speech.
export function splitSegment(segments, id, at, newId = createCaptionId) {
  const seg = segments.find((s) => s.id === id);
  if (!seg) return sortSegments(segments.map(copy));
  const text = seg.text;
  const dur = seg.end - seg.start;
  let leftText; let rightText; let time; let leftWords; let rightWords;

  if (at && isNum(at.index)) {
    const idx = Math.max(0, Math.min(text.length, Math.round(at.index)));
    leftText = text.slice(0, idx).trim();
    rightText = text.slice(idx).trim();
    if (seg.words) {
      // Count the words before the cursor to find the timing boundary.
      const n = leftText ? leftText.split(/\s+/).length : 0;
      if (joinWords(seg.words) === text.replace(/\n/g, ' ') && n > 0 && n < seg.words.length) {
        leftWords = seg.words.slice(0, n);
        rightWords = seg.words.slice(n);
        time = (leftWords[n - 1].end + rightWords[0].start) / 2;
      }
    }
    if (time === undefined) time = seg.start + dur * (idx / Math.max(1, text.length));
  } else if (at && isNum(at.time)) {
    time = at.time;
    if (seg.words && joinWords(seg.words) === text.replace(/\n/g, ' ')) {
      const n = seg.words.filter((w) => (w.start + w.end) / 2 < time).length;
      leftWords = seg.words.slice(0, n);
      rightWords = seg.words.slice(n);
      leftText = joinWords(leftWords);
      rightText = joinWords(rightWords);
    } else {
      const frac = Math.max(0, Math.min(1, (time - seg.start) / (dur || 1)));
      const words = text.split(/\s+/);
      const n = Math.round(words.length * frac);
      leftText = words.slice(0, n).join(' ');
      rightText = words.slice(n).join(' ');
    }
  } else {
    throw new Error('splitSegment needs { index } or { time }');
  }

  if (!leftText || !rightText) return sortSegments(segments.map(copy));
  time = Math.max(seg.start + MIN_SEGMENT_SECONDS, Math.min(seg.end - MIN_SEGMENT_SECONDS, time));
  if (dur < MIN_SEGMENT_SECONDS * 2) return sortSegments(segments.map(copy));

  const left = { id: seg.id, source: seg.source, start: seg.start, end: time, text: leftText };
  const right = { id: newId(), source: seg.source, start: time, end: seg.end, text: rightText };
  if (leftWords && leftWords.length && rightWords && rightWords.length) {
    left.words = leftWords.map((w) => ({ ...w }));
    right.words = rightWords.map((w) => ({ ...w }));
  }
  return sortSegments([...segments.filter((s) => s !== seg).map(copy), left, right]);
}

// Nudge captions earlier or later (all of them when `ids` is null, which is
// how "captions are a bit late" gets fixed in one go). Nothing moves before 0.
export function shiftTiming(segments, ids, delta) {
  if (!isNum(delta)) throw new Error('Shift must be a number of seconds');
  const pick = ids ? new Set(ids) : null;
  return sortSegments(segments.map((s) => {
    const c = copy(s);
    if (pick && !pick.has(s.id)) return c;
    const d = Math.max(delta, -s.start);
    c.start += d;
    c.end += d;
    if (c.words) c.words = c.words.map((w) => ({ ...w, start: Math.max(0, w.start + d), end: Math.max(0, w.end + d) }));
    return c;
  }));
}

// Set one caption's start and/or end (dragging its edges on the timeline).
export function setTiming(segments, id, { start, end } = {}) {
  return sortSegments(segments.map((s) => {
    const c = copy(s);
    if (s.id !== id) return c;
    const ns = isNum(start) ? Math.max(0, start) : s.start;
    const ne = isNum(end) ? end : s.end;
    if (ne - ns < MIN_SEGMENT_SECONDS) {
      // Keep whichever edge was not dragged where it was.
      if (isNum(start) && !isNum(end)) c.start = Math.max(0, s.end - MIN_SEGMENT_SECONDS);
      else if (!isNum(start) && isNum(end)) c.end = s.start + MIN_SEGMENT_SECONDS;
      else { c.start = ns; c.end = ns + MIN_SEGMENT_SECONDS; }
    } else {
      c.start = ns;
      c.end = ne;
    }
    if (c.words) c.words = c.words.filter((w) => w.end > c.start && w.start < c.end);
    if (c.words && !c.words.length) delete c.words;
    return c;
  }));
}
