// A clip's look: where its picture sits and how it is coloured, as a video
// editor's inspector sets per clip (clip.transform, clip.color).
//
//   transform: { x, y, scale, rotate, flipH, flipV,
//                crop: { left, top, right, bottom } }
//     x, y     the picture's middle moved by this much of the content area's
//              width / height (-1..1); scale 0.1..5; rotate in degrees,
//              clockwise; flips; crop: each side's share cut off (0..0.45).
//   color:     { brightness, contrast, saturation, filter, lut, lutMix }
//     -1..1 each (0 = as recorded), a preset look from COLOR_FILTERS, and a
//     .cube LUT copied into the project ('luts/<file>', or null) applied at
//     lutMix (0..1) -- graded on the GPU by layers/lut-gl.js. And the finer
//     tools of grade.js: temperature, tint, highlights, shadows, curve,
//     sharpen (the same GPU pass) and vignette (drawn over the picture).
//
// compose.js applies the transform to the recording and what sits on it
// (the cursor, its clicks) -- not to captions, titles or the webcam, which
// have their own places -- and the colour as a canvas filter when drawing
// the recording's frame, plus a tint for the warm and cool looks.

import { needsGrade } from './grade.js';

export const COLOR_FILTERS = ['none', 'bw', 'sepia', 'vivid', 'warm', 'cool', 'faded', 'dramatic'];

const DEFAULT_TRANSFORM = { x: 0, y: 0, scale: 1, rotate: 0, flipH: false, flipV: false };
const DEFAULT_CROP = { left: 0, top: 0, right: 0, bottom: 0 };
const DEFAULT_COLOR = {
  brightness: 0, contrast: 0, saturation: 0, filter: 'none', lut: null, lutMix: 1,
  temperature: 0, tint: 0, highlights: 0, shadows: 0, vignette: 0, sharpen: 0, curve: null
};

export function clipTransform(clip) {
  const t = clip?.transform ?? {};
  return { ...DEFAULT_TRANSFORM, ...t, crop: { ...DEFAULT_CROP, ...(t.crop ?? {}) } };
}

export function clipColor(clip) {
  return { ...DEFAULT_COLOR, ...(clip?.color ?? {}) };
}

const round = (v) => Math.round(v * 1000) / 1000;

// The preset looks, as canvas filter functions.
const PRESETS = {
  none: '',
  bw: 'grayscale(1)',
  sepia: 'sepia(0.8)',
  vivid: 'saturate(1.5) contrast(1.1)',
  warm: 'saturate(1.1)',
  cool: 'saturate(0.95)',
  faded: 'contrast(0.8) saturate(0.7) brightness(1.08)',
  dramatic: 'contrast(1.35) saturate(0.85) brightness(0.95)'
};

// The canvas filter (ctx.filter) for a colour, or 'none'.
export function cssFilter(color) {
  const c = { ...DEFAULT_COLOR, ...color };
  const parts = [];
  if (c.brightness) parts.push(`brightness(${round(1 + c.brightness)})`);
  if (c.contrast) parts.push(`contrast(${round(1 + c.contrast)})`);
  if (c.saturation) parts.push(`saturate(${round(1 + c.saturation)})`);
  if (PRESETS[c.filter]) parts.push(PRESETS[c.filter]);
  return parts.length ? parts.join(' ') : 'none';
}

// The warm and cool looks: a colour laid over the picture in soft light.
export function tintOf(color) {
  if (color?.filter === 'warm') return { color: 'rgba(255, 150, 60, 0.28)', blend: 'soft-light' };
  if (color?.filter === 'cool') return { color: 'rgba(0, 120, 255, 0.28)', blend: 'soft-light' };
  return null;
}

export function isPlain(clip) {
  const t = clipTransform(clip);
  const c = clipColor(clip);
  return t.x === 0 && t.y === 0 && t.scale === 1 && t.rotate === 0 && !t.flipH && !t.flipV &&
    !t.crop.left && !t.crop.top && !t.crop.right && !t.crop.bottom &&
    !c.brightness && !c.contrast && !c.saturation && c.filter === 'none' && !c.lut &&
    !c.vignette && !needsGrade(c);
}

// The canvas transform [a, b, c, d, e, f] (setTransform order) that places
// the picture: about the content area's middle, flipped, scaled, rotated,
// then moved.
export function transformMatrix(t, content) {
  const cx = content.x + content.w / 2;
  const cy = content.y + content.h / 2;
  const th = (t.rotate * Math.PI) / 180;
  const sx = t.scale * (t.flipH ? -1 : 1);
  const sy = t.scale * (t.flipV ? -1 : 1);
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  // R * S, then translated so the middle lands at (cx + x*w, cy + y*h).
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  const tx = cx + t.x * content.w;
  const ty = cy + t.y * content.h;
  const clean = (v) => (Math.abs(v) < 1e-12 ? 0 : v);
  return [clean(a), clean(b), clean(c), clean(d), tx - a * cx - c * cy, ty - b * cx - d * cy].map(clean);
}
