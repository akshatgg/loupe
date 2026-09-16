// Captions in the project (docs/EDITOR-V2.md §3):
//
//   captions: { show, language, segments: [{ id, source, start, end, text, words? }],
//               style: { size, position } }
//
// Segments are in SOURCE time, like every other attached item, so trimming,
// cutting or speeding up the video never moves a caption off the words it
// belongs to; timeline.js maps them to output time only when something is
// drawn or exported. `words` ([{ text, start, end }], also source time) is
// optional: transcription fills it so a caption can be split at the right
// moment, and an edit to the text drops it because it no longer matches.

export const CAPTION_POSITIONS = ['bottom', 'top'];
export const CAPTION_SIZE_MIN = 0.5;
export const CAPTION_SIZE_MAX = 2;
// Shorter than this a caption cannot be read, and the editor could not grab it.
export const MIN_SEGMENT_SECONDS = 0.1;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

let idCounter = 0;
export function createCaptionId() {
  idCounter = (idCounter + 1) % 1e6;
  return `cap_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function defaultCaptions() {
  return { show: false, language: 'auto', segments: [], style: { size: 1, position: 'bottom' } };
}

export function compareSegments(a, b) {
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.start - b.start || a.end - b.end;
}

export function sortSegments(segments) {
  return [...segments].sort(compareSegments);
}

function cleanWords(words) {
  if (!Array.isArray(words)) return undefined;
  const out = [];
  for (const w of words) {
    if (!w || typeof w.text !== 'string' || !isNum(w.start) || !isNum(w.end)) continue;
    out.push({ text: w.text, start: w.start, end: Math.max(w.start, w.end) });
  }
  return out.length ? out : undefined;
}

// A segment from disk or from the renderer, made safe to use: anything that
// cannot be a caption (no text, no usable times) is dropped rather than
// failing the whole project load.
export function normalizeSegment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { start, end } = raw;
  if (!isNum(start) || !isNum(end)) return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;
  const s = Math.max(0, start);
  const e = Math.max(s + MIN_SEGMENT_SECONDS, end);
  const seg = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createCaptionId(),
    source: typeof raw.source === 'string' && raw.source ? raw.source : 'main',
    start: s,
    end: e,
    text
  };
  const words = cleanWords(raw.words);
  if (words) seg.words = words;
  return seg;
}

export function normalizeCaptions(raw) {
  const d = defaultCaptions();
  if (!raw || typeof raw !== 'object') return d;
  const style = raw.style && typeof raw.style === 'object' ? raw.style : {};
  const seen = new Set();
  const segments = [];
  for (const s of Array.isArray(raw.segments) ? raw.segments : []) {
    const seg = normalizeSegment(s);
    if (!seg) continue;
    // Duplicate ids would make every id-based edit ambiguous.
    if (seen.has(seg.id)) seg.id = createCaptionId();
    seen.add(seg.id);
    segments.push(seg);
  }
  return {
    show: raw.show === true,
    language: typeof raw.language === 'string' && raw.language ? raw.language : d.language,
    segments: sortSegments(segments),
    style: {
      size: isNum(style.size) ? Math.min(CAPTION_SIZE_MAX, Math.max(CAPTION_SIZE_MIN, style.size)) : 1,
      position: CAPTION_POSITIONS.includes(style.position) ? style.position : 'bottom'
    }
  };
}

// transformers.js word chunks ({ text: " Hello,", timestamp: [0.5, 0.9] }) to
// words in source time. The leading space is kept: joining words by plain
// concatenation is then right for languages written without spaces too.
// A missing end (the last word of a chunk sometimes has none) becomes a short
// word rather than one that runs to the end of the recording.
export function wordsFromChunks(chunks, offset = 0, limit = Infinity) {
  const words = [];
  for (const c of Array.isArray(chunks) ? chunks : []) {
    if (!c || typeof c.text !== 'string' || !c.text.trim()) continue;
    const [s, e] = Array.isArray(c.timestamp) ? c.timestamp : [];
    if (!isNum(s)) continue;
    const start = Math.min(limit, offset + s);
    const end = Math.min(limit, Math.max(start, isNum(e) ? offset + e : start + 0.3));
    words.push({ text: c.text, start, end });
  }
  return words;
}

export function joinWords(words) {
  return words.map((w) => w.text).join('').replace(/\s+/g, ' ').trim();
}

// Active cues at a time; `items` may be source-time segments (pass `source`)
// or output-time cues from timeline.js (omit it).
export function segmentsAt(items, t, source = null) {
  const out = [];
  for (const s of items) {
    if (source !== null && s.source !== source) continue;
    if (s.start <= t && t < s.end) out.push(s);
  }
  return out;
}
