// Editing the video by its words: cutting what was said out of the clips,
// putting it back, and the two switches that do it wholesale -- filler words
// ("um", "uh") and long silences between words.
//
// A cut here takes a stretch of a recording out of the clips that play it,
// leaving the clips either side (no black, no gap). It is put back by
// joining those two clips again, so a cut can be restored long after it was
// made -- as long as the clips around it are still as the cut left them.
//
// The switches remember what they cut in `project.transcript.cuts`
// ([{ source, start, end, reason: 'filler' | 'silence' }]) so that switching
// one off restores exactly those.

import { MIN_CLIP_SECONDS, nextId, validateProject } from './project.js';

const fail = (message) => { throw new Error(message); };
const EPS = 1e-6;
// Two clip edges this close are the same moment of the recording.
const SAME = 2e-3;

const plays = (clip) => !(clip.hold > 0) && !clip.reverse;

// Takes [start, end] of recording `source` out of every clip that plays it.
// A sliver that would be left at a clip's edge goes too. Returns the project
// unchanged when nothing plays that stretch.
export function cutSource(project, source, start, end) {
  if (!project.sources[source]) fail(`Unknown recording ${JSON.stringify(source)}`);
  if (!(end - start > EPS)) fail('Select some words to cut');
  const clips = [];
  const ids = project.clips.slice();
  let transitions = project.transitions;
  let changed = false;
  for (const clip of project.clips) {
    if (clip.source !== source || !plays(clip) || clip.end <= start + EPS || clip.start >= end - EPS) {
      clips.push(clip);
      continue;
    }
    changed = true;
    const before = start - clip.start >= MIN_CLIP_SECONDS ? { ...clip, end: start } : null;
    const after = clip.end - end >= MIN_CLIP_SECONDS ? { ...clip, start: end } : null;
    if (before) clips.push(before);
    if (after) {
      const piece = before ? { ...after, id: nextId('c', ids) } : after;
      ids.push(piece);
      clips.push(piece);
      // The clip's transition stays at its end, now the second piece's.
      if (before) transitions = transitions.map((t) => (t.after === clip.id ? { ...t, after: piece.id } : t));
    }
  }
  if (!changed) return project;
  if (!clips.some((c) => !c.gap)) fail('Can’t cut the whole video');
  const kept = new Set(clips.map((c) => c.id));
  return validateProject({ ...project, clips, transitions: transitions.filter((t) => kept.has(t.after)) });
}

// Whether two clips look the same apart from which part they play (so that
// joining them changes nothing but the cut).
function sameLook(a, b) {
  const look = (c) => JSON.stringify([c.transform ?? null, c.color ?? null, c.keyframes ?? null, Boolean(c.detached)]);
  return look(a) === look(b);
}

// Puts back the cut stretch of `source` that holds moment `t`: the two clips
// either side of it become one again. Throws when the video around it has
// been changed since (undo is then the way back).
export function restoreSource(project, source, t) {
  const { clips } = project;
  for (let i = 0; i < clips.length - 1; i++) {
    const a = clips[i];
    const b = clips[i + 1];
    if (a.source !== source || b.source !== source || !plays(a) || !plays(b)) continue;
    if (!(a.end - SAME <= t && t <= b.start + SAME) || b.start - a.end < EPS) continue;
    if (!sameLook(a, b)) fail('The clips around that part were changed, so it can’t be put back here. Undo still can.');
    const merged = { ...a, end: b.end };
    const next = [...clips.slice(0, i), merged, ...clips.slice(i + 2)];
    // The join is gone, and with it a transition there; one after the second
    // clip now follows the merged one.
    const transitions = project.transitions.filter((x) => x.after !== a.id).map((x) => (x.after === b.id ? { ...x, after: a.id } : x));
    return validateProject({ ...project, clips: next, transitions });
  }
  fail('That part can’t be put back here: the video around it has changed. Undo still can.');
  return project;
}

// Whether moment `t` of a recording is cut from between two clips that
// could be joined again.
export function canRestore(project, source, t) {
  try {
    restoreSource(project, source, t);
    return true;
  } catch {
    return false;
  }
}

// ---- filler words

const FILLERS = new Set(['um', 'umm', 'uhm', 'uh', 'uhh', 'er', 'erm', 'ah', 'ahh', 'eh', 'hm', 'hmm', 'mm', 'mmm', 'mhm']);
// Said as a filler only when there is a pause either side.
const SOMETIMES = [['you', 'know'], ['i', 'mean'], ['like']];
const PAUSE = 0.25;

const bare = (text) => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

// Every word with a timing, in the order it was said: [{ source, start, end, text }].
export function timedWords(project) {
  const out = [];
  for (const seg of project.captions?.segments ?? []) {
    for (const w of seg.words ?? []) {
      if (Number.isFinite(w?.start) && Number.isFinite(w?.end) && w.end > w.start) out.push({ source: seg.source, start: w.start, end: w.end, text: w.text });
    }
  }
  return out.sort((a, b) => (a.source === b.source ? a.start - b.start : a.source < b.source ? -1 : 1));
}

// The stretches that are filler words: [{ source, start, end }], merged
// where they touch.
export function fillerRanges(project) {
  const words = timedWords(project);
  const out = [];
  const add = (source, start, end) => {
    const last = out.at(-1);
    if (last && last.source === source && start - last.end < 0.05) last.end = Math.max(last.end, end);
    else out.push({ source, start, end });
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const text = bare(w.text);
    if (FILLERS.has(text)) { add(w.source, w.start, w.end); continue; }
    for (const phrase of SOMETIMES) {
      const run = words.slice(i, i + phrase.length);
      if (run.length < phrase.length || run.some((x, k) => x.source !== w.source || bare(x.text) !== phrase[k])) continue;
      const prev = words[i - 1];
      const next = words[i + phrase.length];
      // In the middle of talking, with a pause either side: at the start or
      // end of what was said, the same words are usually meant.
      const pauseBefore = prev && prev.source === w.source && w.start - prev.end >= PAUSE;
      const pauseAfter = next && next.source === w.source && next.start - run.at(-1).end >= PAUSE;
      if (pauseBefore && pauseAfter) {
        add(w.source, w.start, run.at(-1).end);
        i += phrase.length - 1;
      }
      break;
    }
  }
  return out;
}

export const SILENCE_LONGER_THAN = 1;
export const SILENCE_KEEP = 0.4;

// The middles of the long pauses between words: what is cut to shorten each
// to `keep` seconds. [{ source, start, end }]
export function silenceRanges(project, { longerThan = SILENCE_LONGER_THAN, keep = SILENCE_KEEP } = {}) {
  const words = timedWords(project);
  const out = [];
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1];
    const b = words[i];
    if (a.source !== b.source) continue;
    const gap = b.start - a.end;
    if (gap <= longerThan + EPS || gap - keep < MIN_CLIP_SECONDS) continue;
    out.push({ source: a.source, start: a.end + keep / 2, end: b.start - keep / 2 });
  }
  return out;
}

// ---- the switches

const cutsOf = (project) => project.transcript?.cuts ?? [];
export const hasCuts = (project, reason) => cutsOf(project).some((c) => c.reason === reason);

// Only what a clip is playing can be cut (the rest is cut already).
function isPlayed(project, r) {
  return project.clips.some((c) => c.source === r.source && plays(c) && c.start < r.end - EPS && c.end > r.start + EPS);
}

function switchCuts(project, reason, on, ranges) {
  let p = project;
  const others = cutsOf(project).filter((c) => c.reason !== reason);
  if (!on) {
    for (const c of cutsOf(project).filter((x) => x.reason === reason)) {
      // One the person has since changed around stays as they left it.
      try { p = restoreSource(p, c.source, (c.start + c.end) / 2); } catch { /* left as it is */ }
    }
    return validateProject({ ...p, transcript: { ...(project.transcript ?? {}), cuts: others } });
  }
  const made = [];
  for (const r of ranges) {
    if (!isPlayed(p, r)) continue;
    const next = cutSource(p, r.source, r.start, r.end);
    if (next === p) continue;
    p = next;
    made.push({ ...r, reason });
  }
  if (!made.length) return project;
  return validateProject({ ...p, transcript: { ...(project.transcript ?? {}), cuts: [...others, ...made] } });
}

// Cuts every filler word, or (off) puts them back.
export function setFillersCut(project, on) {
  return switchCuts(project, 'filler', on, on ? fillerRanges(project) : []);
}

// Shortens every long pause, or (off) puts them back.
export function setSilencesCut(project, on, options) {
  return switchCuts(project, 'silence', on, on ? silenceRanges(project, options) : []);
}
