// Burned-in captions: layer 8 of compose.js (docs/EDITOR-V2.md §5).
//
//   draw(ctx, state)   the compose.js layer: project.captions at state.outT,
//                      over the whole output frame, when captions.show is on
//   drawCaptions(ctx, area, segmentsAtTime, style, t) -> box | null
//
// ctx             a CanvasRenderingContext2D or OffscreenCanvasRenderingContext2D
// area            { x, y, w, h } in canvas pixels: the rectangle captions sit
//                 in. compose.js passes the whole output frame, so captions
//                 stay put and readable while the picture zooms and pans.
// segmentsAtTime  the cues showing at this moment ([{ text }]), normally
//                 segmentsAt(captionsToOutput(segments, tl), outT); usually
//                 zero or one, several are stacked in order.
// style           project.captions.style: { size: 0.5..2, position: "bottom"|"top",
//                 box: true (dark box behind the words) | false (outlined words) }
//                 plus font, color, activeColor and animation (captions/style.js).
//                 Without those it draws white words in the system font, whole
//                 lines at a time, as it always has.
// t               the frame's time on the cues' clock (output time). With an
//                 animation and a cue that has `words` ([{ text, start, end }],
//                 same clock), words are drawn one by one: the spoken one in
//                 activeColor ("highlight"), larger too ("pop"), or only the
//                 ones spoken so far ("typewriter"). A cue without words, or
//                 no t, draws its whole line.
//
// Returns the drawn box { x, y, w, h } (for hit-testing in the editor), or
// null when there was nothing to draw. ctx state is restored afterwards.
//
// Sizes follow the SHORT side of the area, 1080 px being the reference: at
// 1080p and 4K the text covers the same share of the frame, and in a 9:16
// video it is sized for the narrow width rather than overflowing it.

import { captionsToOutput } from '../captions/timeline.js';
import { segmentsAt } from '../captions/model.js';
import { wordsMatchText, activeWordIndex, wordScale, UPCOMING_ALPHA } from '../captions/words.js';
import { canvasFont, DEFAULT_FONT } from '../fonts.js';
import { visibleAnnotations, opacityAt } from './annotations.js';

export const name = 'captions';

export const CAPTION_FONT = '600 {px}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const BASE_FONT_PX = 46;
const LINE_HEIGHT = 1.28;
const MAX_WIDTH = 0.86;
const MARGIN = 0.07;
const MAX_LINES = 4;
const WHITE = '#ffffff';

// The system font keeps the exact string it always had.
function captionFont(style, px) {
  if (!style.font || style.font === DEFAULT_FONT) return CAPTION_FONT.replace('{px}', String(px));
  return canvasFont(style.font, px, 600);
}

const animationOf = (style) => (style.animation && style.animation !== 'none' ? style.animation : null);

function wrapToWidth(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    const clean = para.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const spaced = /\s/.test(clean);
    const parts = spaced ? clean.split(' ') : [...clean];
    const sep = spaced ? ' ' : '';
    let cur = '';
    for (const w of parts) {
      const next = cur ? cur + sep + w : w;
      if (cur && ctx.measureText(next).width > maxWidth) { lines.push(cur); cur = w; } else cur = next;
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

// The same greedy wrapping, word by word, remembering where each word sits
// in its line: rows of { text, words: [{ i, at, text }] } (`i` the word's
// index in the cue, `at` its first character in the row's text). Every word
// is a place a line may break; a space joins two words when either has one
// at the join, so languages written without spaces wrap too.
function wrapWords(ctx, words, maxWidth) {
  const rows = [];
  let cur = null;
  let trailing = false;
  words.forEach((w, i) => {
    const clean = w.text.replace(/\s+/g, ' ');
    const body = clean.trim();
    const sep = trailing || clean.startsWith(' ') ? ' ' : '';
    trailing = clean.endsWith(' ');
    if (cur) {
      const next = cur.text + sep + body;
      if (ctx.measureText(next).width <= maxWidth) {
        cur.words.push({ i, at: cur.text.length + sep.length, text: body });
        cur.text = next;
        return;
      }
      rows.push(cur);
    }
    cur = { text: body, words: [{ i, at: 0, text: body }] };
  });
  if (cur) rows.push(cur);
  return rows;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

export function layoutCaptions(ctx, area, segmentsAtTime, style = {}) {
  const text = (segmentsAtTime || []).map((s) => (s && s.text) || '').filter((t) => t.trim()).join('\n');
  if (!text || !(area.w > 0) || !(area.h > 0)) return null;
  const size = Number.isFinite(style.size) ? Math.min(2, Math.max(0.5, style.size)) : 1;
  const scale = Math.min(area.w, area.h) / 1080;
  const px = Math.max(8, Math.round(BASE_FONT_PX * size * scale));
  ctx.font = captionFont(style, px);
  // rows: one per line, { text, words, cue } -- `words` only where the line
  // is drawn word by word.
  let rows;
  if (animationOf(style)) {
    rows = (segmentsAtTime || []).flatMap((cue) => {
      if (!cue || !cue.text || !cue.text.trim()) return [];
      if (wordsMatchText(cue.words, cue.text)) return wrapWords(ctx, cue.words, area.w * MAX_WIDTH).map((r) => ({ ...r, cue }));
      return wrapToWidth(ctx, cue.text, area.w * MAX_WIDTH).map((t) => ({ text: t, words: null, cue }));
    });
  } else {
    rows = wrapToWidth(ctx, text, area.w * MAX_WIDTH).map((t) => ({ text: t, words: null, cue: null }));
  }
  // Too much for the screen: keep the end, which is what is being said now.
  if (rows.length > MAX_LINES) rows = rows.slice(-MAX_LINES);
  const lines = rows.map((r) => r.text);
  const lineH = Math.round(px * LINE_HEIGHT);
  const padX = Math.round(px * 0.55);
  const padY = Math.round(px * 0.3);
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const w = Math.min(area.w, Math.ceil(textW + padX * 2));
  const h = lines.length * lineH + padY * 2;
  const x = area.x + (area.w - w) / 2;
  const margin = Math.round(Math.min(area.w, area.h) * MARGIN);
  const y = style.position === 'top' ? area.y + margin : area.y + area.h - margin - h;
  return { x, y, w, h, px, lineH, padY, lines, rows };
}

// Without the box the words must stand out on a light picture too: a dark
// outline all round, then the fill on top.
function strokeWords(ctx, l, text, x, y) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, l.px * 0.16);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.strokeText(text, x, y);
}

// One line, a word at a time. The line is laid out whole, so no word moves
// as the others appear or change colour.
function drawWordRow(ctx, l, row, cx, y, look, t) {
  const { animation, box, color, activeColor } = look;
  const words = row.cue.words;
  const active = activeWordIndex(words, t);
  const x0 = cx - ctx.measureText(row.text).width / 2;
  ctx.save();
  ctx.textAlign = 'left';
  const alpha = ctx.globalAlpha;
  for (const w of row.words) {
    if (animation === 'typewriter' && w.i > active) continue;
    const x = x0 + ctx.measureText(row.text.slice(0, w.at)).width;
    const spoken = w.i === active && animation !== 'typewriter';
    ctx.globalAlpha = animation === 'highlight' && w.i > active ? alpha * UPCOMING_ALPHA : alpha;
    const scale = animation === 'pop' ? wordScale(words, w.i, t) : 1;
    const paint = (px, py) => {
      if (!box) strokeWords(ctx, l, w.text, px, py);
      ctx.fillStyle = spoken ? activeColor : color;
      ctx.fillText(w.text, px, py);
    };
    if (scale !== 1) {
      // Grown about its own middle, so its neighbours stay where they are.
      const half = ctx.measureText(w.text).width / 2;
      ctx.save();
      ctx.translate(x + half, y);
      ctx.scale(scale, scale);
      paint(-half, 0);
      ctx.restore();
    } else {
      paint(x, y);
    }
  }
  ctx.restore();
}

export function drawCaptions(ctx, area, segmentsAtTime, style = {}, t = null) {
  ctx.save();
  try {
    // No time to go by: whole lines.
    const look = Number.isFinite(t) ? style : { ...style, animation: 'none' };
    const l = layoutCaptions(ctx, area, segmentsAtTime, look);
    if (!l) return null;
    const box = style.box !== false;
    const color = style.color || WHITE;
    const words = { animation: animationOf(look), box, color, activeColor: style.activeColor || color };
    if (box) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
      roundRect(ctx, l.x, l.y, l.w, l.h, Math.round(l.px * 0.28));
      ctx.fill();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = l.x + l.w / 2;
    l.rows.forEach((row, i) => {
      const y = l.y + l.padY + l.lineH * (i + 0.5);
      if (row.words) {
        drawWordRow(ctx, l, row, cx, y, words, t);
        return;
      }
      if (!box) strokeWords(ctx, l, row.text, cx, y);
      ctx.fillStyle = color;
      ctx.fillText(row.text, cx, y);
    });
    return { x: l.x, y: l.y, w: l.w, h: l.h };
  } finally {
    ctx.restore();
  }
}

// Output-time cues, recomputed only when the segments or the timeline change
// (edits share untouched arrays, and each timeline is built once per edit), so
// playback and export do not re-map every caption on every frame.
const cueCache = new WeakMap();

function cuesFor(segments, tl) {
  let byTl = cueCache.get(segments);
  if (!byTl) {
    byTl = new WeakMap();
    cueCache.set(segments, byTl);
  }
  let cues = byTl.get(tl);
  if (!cues) {
    cues = captionsToOutput(segments, tl);
    byTl.set(tl, cues);
  }
  return cues;
}

// draw(ctx, state): see compose.js for what `state` holds.
export function draw(ctx, state) {
  const captions = state.project.captions;
  if (!captions?.show || !captions.segments?.length) return;
  // A full-screen title card covers the video, captions included: they
  // fade out as it fades in, rather than sitting on top of its words.
  const cover = visibleAnnotations(state).reduce((m, a) => (a.type === 'title' ? Math.max(m, opacityAt(a, state.t)) : m), 0);
  if (cover >= 1) return;
  const { width, height } = state.size;
  const cues = segmentsAt(cuesFor(captions.segments, state.tl), state.outT);
  ctx.save();
  ctx.globalAlpha *= 1 - cover;
  drawCaptions(ctx, { x: 0, y: 0, w: width, h: height }, cues, captions.style, state.outT);
  ctx.restore();
}
