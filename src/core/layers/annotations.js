// Layer 5: annotations (project.annotations) -- text, title cards, arrows,
// boxes and hidden areas.
//
// Where each kind lives, so it stays on what it points at:
//  - arrow, box, blur: x/y/w/h/x2/y2 are fractions of the RECORDING's picture
//    (0..1 of its width and height), drawn through the camera. A zoom moves
//    and grows them with the screen, so a hidden password stays hidden.
//    A blur with a `path` ([{ t, x, y }], core/track.js) follows what it
//    hides: its top-left corner is taken from the path at that moment.
//  - text: x/y is the centre of the text as fractions of the content area,
//    which a zoom doesn't move (a caption-like label).
//  - title: a full-frame card over everything (background colour `color`),
//    fading in and out -- an intro or outro.
//
// An annotation shows while its source moment is on screen (start..end in
// source time), fading in and out briefly, except a hidden area, which is
// fully hidden for every frame it covers.
//
// Text and title cards can be styled (font, weight, alignment, an outline, the
// backing's colour) and can arrive and leave with an animation: see
// ../text-style.js. One with none of that set draws as it always has.
//
// compose.js registers this layer unclipped: title cards cover the whole
// output, everything else is clipped to the rounded content area here.

import { roundedRectPath } from './frame.js';
import { positionAt } from '../track.js';
import { fontStack, DEFAULT_FONT } from '../fonts.js';
import {
  textAnimationAt, revealLines, isClear, TEXT_FONT_WEIGHT, TITLE_FONT_WEIGHTS, FADE_SECONDS, TITLE_FADE_SECONDS
} from '../text-style.js';

export const name = 'annotations';

export { FADE_SECONDS, TITLE_FADE_SECONDS };
// Reference sizes at 1080p, times the annotation's `size`.
export const TEXT_PX = 44;
export const TITLE_PX = 84;
export const LINE_PX = 7;
export const BLOCK_PX = 14;
const FONT = '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// The opacity of annotation `a` at source time t (0 when not showing).
export function opacityAt(a, t) {
  if (t < a.start || t >= a.end) return 0;
  if (a.type === 'blur') return 1;
  if (a.type === 'text' || a.type === 'title') return textAnimationAt(a, t).alpha;
  const len = a.end - a.start;
  const fade = Math.min(a.type === 'title' ? TITLE_FADE_SECONDS : FADE_SECONDS, len / 3);
  if (fade <= 0) return 1;
  return clamp01(Math.min((t - a.start) / fade, (a.end - t) / fade));
}

export function visibleAnnotations(state) {
  return state.project.annotations.filter((a) => a.source === state.source && opacityAt(a, state.t) > 0);
}

// A point given as fractions of the recording, in canvas pixels.
function recordingPoint(state, fx, fy) {
  return state.toCanvas(fx * state.meta.width, fy * state.meta.height);
}

// Canvas pixels -> fractions of the recording (the inverse of the above).
export function recordingFraction(state, px, py) {
  const { content, rect, meta } = state;
  const x = rect.x + ((px - content.x) / content.w) * rect.width;
  const y = rect.y + ((py - content.y) / content.h) * rect.height;
  return { x: x / meta.width, y: y / meta.height };
}

// Canvas pixels -> fractions of the content area.
export function contentFraction(state, px, py) {
  const { content } = state;
  return { x: (px - content.x) / content.w, y: (py - content.y) / content.h };
}

const familyOf = (a) => (a.font && a.font !== DEFAULT_FONT ? fontStack(a.font) : FONT);

// The ctx.font of a text annotation at `px`.
export function textFont(a, px) {
  return `${TEXT_FONT_WEIGHT[a.weight] ?? 600} ${px}px ${familyOf(a)}`;
}

export function textLines(text) {
  const lines = String(text ?? '').split('\n');
  return lines.length ? lines : [''];
}

// Measured layout of a text annotation (a block of lines on a soft backing,
// centred on its point), in canvas pixels. `ctx` only measures. `textX` is
// where each line is anchored for its alignment.
export function textLayout(ctx, state, a) {
  const px = Math.max(6, TEXT_PX * state.unit * a.size);
  const lines = textLines(a.text || ' ');
  ctx.save();
  ctx.font = textFont(a, px);
  const width = Math.max(px, ...lines.map((l) => ctx.measureText(l).width));
  ctx.restore();
  const lineHeight = px * 1.25;
  const padX = px * 0.55;
  const padY = px * 0.32;
  const cx = state.content.x + a.x * state.content.w;
  const cy = state.content.y + a.y * state.content.h;
  const w = width + 2 * padX;
  const h = lines.length * lineHeight + 2 * padY;
  const align = a.align === 'left' || a.align === 'right' ? a.align : 'center';
  const textX = align === 'left' ? cx - width / 2 : align === 'right' ? cx + width / 2 : cx;
  return { px, lines, lineHeight, cx, cy, align, textX, box: { x: cx - w / 2, y: cy - h / 2, w, h } };
}

// Where an annotation is on the canvas, for drawing and for the editor's
// handles: { box } for every kind, plus { x1, y1, x2, y2, width } for arrows.
export function annotationGeometry(ctx, state, a) {
  if (a.type === 'title') return { box: { x: 0, y: 0, w: state.size.width, h: state.size.height } };
  if (a.type === 'text') return textLayout(ctx, state, a);
  if (a.type === 'arrow') {
    const p1 = recordingPoint(state, a.x, a.y);
    const p2 = recordingPoint(state, a.x2, a.y2);
    const width = Math.max(2, LINE_PX * state.unit * a.size);
    const pad = width * 2.5;
    return {
      x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, width,
      box: {
        x: Math.min(p1.x, p2.x) - pad, y: Math.min(p1.y, p2.y) - pad,
        w: Math.abs(p2.x - p1.x) + 2 * pad, h: Math.abs(p2.y - p1.y) + 2 * pad
      }
    };
  }
  // A hidden area that follows what's under it is where its path puts it now.
  const at = a.type === 'blur' && a.path?.length ? positionAt(a.path, state.t) : a;
  const p1 = recordingPoint(state, at.x, at.y);
  const p2 = recordingPoint(state, at.x + a.w, at.y + a.h);
  return {
    box: { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) }
  };
}

// Black or white, whichever reads better on `hex`.
export function inkFor(hex) {
  const m = /^#?([0-9a-f]{3,8})$/i.exec(hex ?? '');
  let v = m ? m[1] : '000000';
  if (v.length <= 4) v = [...v.slice(0, 3)].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.3 ? '#111114' : '#ffffff';
}

function softShadow(ctx, unit, strength = 1) {
  ctx.shadowColor = `rgba(0, 0, 0, ${(0.35 * strength).toFixed(3)})`;
  ctx.shadowBlur = 14 * unit;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4 * unit;
}

// Moves and sizes what follows about (cx, cy) for a slide or a pop. At rest
// it does nothing at all.
function animateAbout(ctx, anim, cx, cy, px) {
  if (anim.slide === 0 && anim.scale === 1) return;
  ctx.translate(cx, cy + anim.slide * px * 0.9);
  ctx.scale(anim.scale, anim.scale);
  ctx.translate(-cx, -cy);
}

// One line of a block. `part` is what shows of `full`; when the typewriter
// is part-way through a line, the letters stay where they will end up.
function putLine(ctx, how, full, part, x, y, align) {
  if (part === full) {
    ctx[how](full, x, y);
    return;
  }
  if (!part) return;
  const w = ctx.measureText(full).width;
  const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
  ctx.save();
  ctx.textAlign = 'left';
  ctx[how](part, left, y);
  ctx.restore();
}

function drawText(ctx, state, a, alpha) {
  const L = textLayout(ctx, state, a);
  const anim = textAnimationAt(a, state.t);
  ctx.save();
  ctx.globalAlpha = alpha;
  animateAbout(ctx, anim, L.cx, L.cy, L.px);
  softShadow(ctx, state.unit);
  // No backing: the words keep the shadow, to stand out on their own.
  if (!isClear(a.background)) {
    ctx.fillStyle = a.background ?? 'rgba(17, 17, 20, 0.72)';
    roundedRectPath(ctx, L.box, L.px * 0.4);
    ctx.fill();
    ctx.shadowColor = 'rgba(0, 0, 0, 0)';
  }
  ctx.fillStyle = a.color;
  ctx.font = textFont(a, L.px);
  ctx.textAlign = L.align;
  ctx.textBaseline = 'middle';
  const top = L.cy - ((L.lines.length - 1) * L.lineHeight) / 2;
  const shown = revealLines(L.lines, anim.reveal);
  if (a.outline > 0) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, a.outline * L.px * 0.24);
    ctx.strokeStyle = inkFor(a.color);
    L.lines.forEach((line, i) => putLine(ctx, 'strokeText', line, shown[i], L.textX, top + i * L.lineHeight, L.align));
    ctx.shadowColor = 'rgba(0, 0, 0, 0)';
  }
  L.lines.forEach((line, i) => putLine(ctx, 'fillText', line, shown[i], L.textX, top + i * L.lineHeight, L.align));
  ctx.restore();
}

function drawTitle(ctx, state, a, alpha) {
  const { width, height } = state.size;
  const anim = textAnimationAt(a, state.t);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = a.color;
  ctx.fillRect(0, 0, width, height);
  const ink = inkFor(a.color);
  const lines = textLines(a.text);
  const shown = revealLines(lines, anim.reveal);
  const big = Math.max(8, TITLE_PX * state.unit * a.size);
  const small = big * 0.45;
  const align = a.align === 'left' || a.align === 'right' ? a.align : 'center';
  const x = align === 'left' ? width * 0.08 : align === 'right' ? width * 0.92 : width / 2;
  const [heavy, light] = TITLE_FONT_WEIGHTS[a.weight] ?? TITLE_FONT_WEIGHTS.medium;
  // The card stays put; only the words slide or pop.
  animateAbout(ctx, anim, width / 2, height / 2, big);
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ink;
  const total = big * 1.2 + (lines.length - 1) * small * 1.45;
  let y = height / 2 - total / 2 + big * 0.6;
  ctx.font = `${heavy} ${big}px ${familyOf(a)}`;
  putLine(ctx, 'fillText', lines[0], shown[0], x, y, align);
  y += big * 0.6 + small * 0.95;
  ctx.font = `${light} ${small}px ${familyOf(a)}`;
  ctx.globalAlpha = alpha * 0.75;
  for (let i = 1; i < lines.length; i++) {
    putLine(ctx, 'fillText', lines[i], shown[i], x, y, align);
    y += small * 1.45;
  }
  ctx.restore();
}

function drawArrow(ctx, state, a, alpha) {
  const g = annotationGeometry(ctx, state, a);
  const dx = g.x2 - g.x1;
  const dy = g.y2 - g.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len;
  const uy = dy / len;
  const head = Math.min(len * 0.6, g.width * 4.2);
  const back = { x: g.x2 - ux * head, y: g.y2 - uy * head };
  ctx.save();
  ctx.globalAlpha = alpha;
  softShadow(ctx, state.unit);
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = g.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(g.x1, g.y1);
  ctx.lineTo(back.x + ux * head * 0.3, back.y + uy * head * 0.3);
  ctx.stroke();
  const wing = head * 0.62;
  ctx.beginPath();
  ctx.moveTo(g.x2, g.y2);
  ctx.lineTo(back.x - uy * wing, back.y + ux * wing);
  ctx.lineTo(back.x + uy * wing, back.y - ux * wing);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBox(ctx, state, a, alpha) {
  const { box } = annotationGeometry(ctx, state, a);
  const width = Math.max(2, LINE_PX * 0.85 * state.unit * a.size);
  ctx.save();
  ctx.globalAlpha = alpha;
  softShadow(ctx, state.unit);
  ctx.strokeStyle = a.color;
  ctx.lineWidth = width;
  roundedRectPath(ctx, box, Math.min(12 * state.unit, box.w / 2, box.h / 2));
  ctx.stroke();
  ctx.restore();
}

// Two scratch canvases per drawing context, reused frame to frame.
const scratches = new WeakMap();
function scratchFor(ctx, w, h) {
  if (typeof globalThis.OffscreenCanvas !== 'function') return null;
  let s = scratches.get(ctx);
  if (!s || s[0].canvas.width < w || s[0].canvas.height < h) {
    const cw = Math.max(w, s?.[0].canvas.width ?? 0);
    const ch = Math.max(h, s?.[0].canvas.height ?? 0);
    const make = () => {
      const canvas = new globalThis.OffscreenCanvas(cw, ch);
      return { canvas, ctx: canvas.getContext('2d') };
    };
    s = [make(), make()];
    scratches.set(ctx, s);
  }
  return s;
}

// Pixelates the region: what's under it is shrunk to blocks a few dozen
// pixels across and stretched back without smoothing, so no letter survives.
// The shrinking halves the picture a step at a time, so each block is the
// average of what it covers (one big step would just pick a few pixels).
function drawBlur(ctx, state, a) {
  const { box } = annotationGeometry(ctx, state, a);
  const { content } = state;
  const x0 = Math.max(Math.floor(box.x), Math.floor(content.x));
  const y0 = Math.max(Math.floor(box.y), Math.floor(content.y));
  const x1 = Math.min(Math.ceil(box.x + box.w), Math.ceil(content.x + content.w));
  const y1 = Math.min(Math.ceil(box.y + box.h), Math.ceil(content.y + content.h));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const block = Math.max(4, BLOCK_PX * state.unit * a.size);
  const cols = Math.max(1, Math.ceil(w / block));
  const rows = Math.max(1, Math.ceil(h / block));
  const pair = ctx.canvas ? scratchFor(ctx, w, h) : null;
  ctx.save();
  if (pair) {
    let [src, dst] = pair;
    src.ctx.globalCompositeOperation = 'copy';
    src.ctx.drawImage(ctx.canvas, x0, y0, w, h, 0, 0, w, h);
    let cw = w;
    let ch = h;
    while (cw > cols || ch > rows) {
      const nw = Math.max(cols, Math.ceil(cw / 2));
      const nh = Math.max(rows, Math.ceil(ch / 2));
      dst.ctx.globalCompositeOperation = 'copy';
      dst.ctx.imageSmoothingEnabled = true;
      dst.ctx.imageSmoothingQuality = 'high';
      dst.ctx.drawImage(src.canvas, 0, 0, cw, ch, 0, 0, nw, nh);
      [src, dst] = [dst, src];
      cw = nw;
      ch = nh;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src.canvas, 0, 0, cols, rows, x0, y0, w, h);
  } else {
    // Nothing to read the picture back from: cover it instead.
    ctx.fillStyle = '#5f6368';
    ctx.fillRect(x0, y0, w, h);
  }
  ctx.restore();
}

const ORDER = { blur: 0, box: 1, arrow: 2, text: 3, title: 4 };

export function draw(ctx, state) {
  const shown = visibleAnnotations(state);
  if (!shown.length) return;
  shown.sort((p, q) => ORDER[p.type] - ORDER[q.type]);
  let clipped = false;
  for (const a of shown) {
    const alpha = opacityAt(a, state.t);
    if (a.type === 'title') {
      if (clipped) { ctx.restore(); clipped = false; }
      drawTitle(ctx, state, a, alpha);
      continue;
    }
    if (!clipped) {
      ctx.save();
      roundedRectPath(ctx, state.content, state.radius);
      ctx.clip();
      clipped = true;
    }
    if (a.type === 'blur') drawBlur(ctx, state, a);
    else if (a.type === 'box') drawBox(ctx, state, a, alpha);
    else if (a.type === 'arrow') drawArrow(ctx, state, a, alpha);
    else drawText(ctx, state, a, alpha);
  }
  if (clipped) ctx.restore();
}
