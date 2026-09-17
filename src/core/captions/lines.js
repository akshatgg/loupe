// Turning a stream of timed words into captions people can read.
//
// The limits are the usual subtitle ones (BBC/Netflix guides): about 42
// characters a line, at most two lines on screen, each caption up long enough
// to read but short enough to stay with the speech. A caption also ends at a
// pause and, once it has some length, at the end of a sentence, so it never
// straddles two thoughts.

import { createCaptionId, joinWords } from './model.js';

export const LINE_DEFAULTS = Object.freeze({
  maxCharsPerLine: 42,
  maxLines: 2,
  minDuration: 1,
  maxDuration: 6,
  // A silence longer than this always starts a new caption.
  maxGap: 1,
  // Captions never touch: a hair of space lets players tell them apart.
  minGap: 0.04
});

const SENTENCE_END = /[.?!。！？؟।]["')\]”’]*$/;

// Scripts written without spaces between words get broken anywhere.
function tokens(line) {
  return /\s/.test(line) ? line.split(/\s+/).filter(Boolean) : [...line];
}

function greedy(words, maxChars, sep) {
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + sep + w : w;
    if (cur && next.length > maxChars) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Lines of at most `maxChars` (a single longer word keeps its own line).
// Explicit newlines typed by the user are kept. Text that fits in two lines is
// split where the two lines come out closest in length, which reads better
// than a full line over a one-word line.
export function wrapText(text, maxChars = LINE_DEFAULTS.maxCharsPerLine) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const line = para.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (line.length <= maxChars) { out.push(line); continue; }
    const spaced = /\s/.test(line);
    const words = tokens(line);
    const sep = spaced ? ' ' : '';
    const g = greedy(words, maxChars, sep);
    if (g.length !== 2) { out.push(...g); continue; }
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(sep);
      const b = words.slice(i).join(sep);
      if (a.length > maxChars || b.length > maxChars) continue;
      const score = Math.abs(a.length - b.length);
      if (!best || score < best.score) best = { score, lines: [a, b] };
    }
    out.push(...(best ? best.lines : g));
  }
  return out;
}

export function fitsLines(text, maxChars, maxLines) {
  return wrapText(text, maxChars).length <= maxLines;
}

// Words ([{ text, start, end }], sorted, source time) -> caption segments.
export function buildSegments(words, options = {}) {
  const o = { ...LINE_DEFAULTS, ...options };
  const source = o.source ?? 'main';
  const newId = o.idFactory ?? createCaptionId;
  const groups = [];
  let group = [];

  const flush = () => { if (group.length) groups.push(group); group = []; };

  const capacity = o.maxCharsPerLine * o.maxLines;
  const tooBig = (g) => !fitsLines(joinWords(g), o.maxCharsPerLine, o.maxLines) ||
    g[g.length - 1].end - g[0].start > o.maxDuration;

  for (const w of words) {
    if (!w || !w.text || !w.text.trim()) continue;
    if (group.length) {
      const prev = group[group.length - 1];
      const soFar = joinWords(group);
      if (w.start - prev.end > o.maxGap ||
          (SENTENCE_END.test(prev.text.trim()) && soFar.length >= capacity * 0.3 &&
            prev.end - group[0].start >= o.minDuration * 0.5)) {
        flush();
      } else if (tooBig([...group, w])) {
        // Full: rather than cut mid-phrase, end the caption at the last
        // comma (or other clause break) if that leaves a reasonable caption
        // on both sides, and carry the rest over.
        let cut = -1;
        for (let k = group.length - 2; k >= 0; k--) {
          if (/[,;:、，]["')\]]*$/.test(group[k].text.trim()) &&
              joinWords(group.slice(0, k + 1)).length >= capacity * 0.2) { cut = k; break; }
        }
        const rest = cut >= 0 ? group.slice(cut + 1) : [];
        if (cut >= 0 && !tooBig([...rest, w])) {
          group = group.slice(0, cut + 1);
          flush();
          group = rest;
        } else {
          flush();
        }
      }
    }
    group.push(w);
  }
  flush();

  const segs = groups.map((g) => ({
    id: newId(),
    source,
    start: g[0].start,
    end: Math.max(g[g.length - 1].end, g[0].start),
    text: joinWords(g),
    words: g.map(({ text, start, end }) => ({ text, start, end }))
  }));

  // Stretch captions that flash by, without running into the next one.
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const next = segs[i + 1];
    const limit = next ? next.start - o.minGap : Infinity;
    if (s.end - s.start < o.minDuration) s.end = Math.max(s.end, Math.min(s.start + o.minDuration, limit));
    if (s.end <= s.start) s.end = s.start + 0.1;
  }
  return segs;
}
