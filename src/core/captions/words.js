// Word timings for captions that move as they are spoken.
//
// A segment's `words` ([{ text, start, end }]) are in source time, like the
// segment. For drawing they are mapped to output time with the same
// `tl.toOutput(source, t)` the segment's own edges use (timeline.js), so a
// word lights up at the moment it is heard whatever was cut before it and
// however fast that part plays. Which word is "being spoken" is then a
// question about the frame's output time alone, never the clock on the wall,
// so the preview and every export agree.

export const POP_SECONDS = 0.12;
export const POP_SCALE = 0.16;
// How much fainter the words still to come are in a highlighted line.
export const UPCOMING_ALPHA = 0.45;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Whether `words` really are the words of `text`: an edit to the text drops
// them, but a project edited by hand might not.
export function wordsMatchText(words, text) {
  if (!Array.isArray(words) || !words.length) return false;
  if (!words.every((w) => w && typeof w.text === 'string' && w.text.trim() && isNum(w.start) && isNum(w.end))) return false;
  const joined = words.map((w) => w.text).join('').replace(/\s+/g, ' ').trim();
  return joined === String(text ?? '').replace(/\s+/g, ' ').trim();
}

// The words of one output cue. `run` is the stretch of the segment this cue
// plays: source s..e at output os..oe. A word outside the run (cut away, or
// playing in another cue) is pinned to the edge it is beyond: before the run
// it counts as already spoken, after it as never spoken.
export function wordsToOutput(words, source, tl, run) {
  const { s, e, os, oe } = run;
  const at = (t) => {
    if (t <= s) return os;
    if (t >= e) return oe;
    const o = tl.toOutput(source, t);
    return o === null || o === undefined ? (t - s < e - t ? os : oe) : Math.min(oe, Math.max(os, o));
  };
  return words.map((w) => {
    const start = at(w.start);
    return { text: w.text, start, end: Math.max(start, at(w.end)) };
  });
}

// The index of the word being spoken at time t (the same clock as the
// words'): the last one that has started. -1 before the first word. A word
// stays the spoken one through the pause after it, until the next begins.
export function activeWordIndex(words, t) {
  let active = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].start <= t) active = i;
    else break;
  }
  return active;
}

const easeOut = (p) => 1 - (1 - p) * (1 - p);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// How large word i is drawn at time t in the "pop" animation: the spoken
// word grows quickly, and the one before it settles back as quickly.
export function wordScale(words, i, t) {
  const active = activeWordIndex(words, t);
  if (active < 0) return 1;
  const p = easeOut(clamp01((t - words[active].start) / POP_SECONDS));
  if (i === active) return 1 + POP_SCALE * p;
  if (i === active - 1) return 1 + POP_SCALE * (1 - p);
  return 1;
}
