// Overlays: pictures and videos over the main video, on rows V2, V3, ...
// (project.overlays) -- a logo, B-roll, picture-in-picture -- drawn above
// the recording and its cursor, below annotations, keystrokes, the webcam
// and captions. Each overlay is
//
//   { id, kind: 'image' | 'video', file: 'media/<name>', name, start, from,
//     length, fileDuration, lane, x, y, scale, rotate, opacity, fadeIn,
//     fadeOut, keyframes: { x|y|scale|rotate|opacity: [{ t, v }] },
//     blend, mask, key }
//
// start/length in output seconds; from: seconds into a video; x, y move its
// middle from the video's middle by that share of the width / height; scale
// 1 fits it inside the video; keyframe times are seconds from its start.
// blend, mask and key (optional; overlay-effects.js): how it mixes with the
// picture under it, a shape it is cut to, and a green screen.
// The caller hands each one's picture as frames[overlayFrameKey(id)].

import { valueAt } from '../keyframes.js';
import { overlayEffects, compositeOf } from '../overlay-effects.js';
import { keyFrame } from './key-gl.js';

export const name = 'overlays';
export const ANIMATABLE = ['x', 'y', 'scale', 'rotate', 'opacity'];

export const overlayFrameKey = (id) => `@overlay:${id}`;

// The overlays showing at output time outT, lower rows first (drawn under).
export function overlaysAt(project, outT) {
  return (project.overlays ?? [])
    .filter((o) => outT >= o.start - 1e-9 && outT < o.start + o.length - 1e-9)
    .sort((a, b) => a.lane - b.lane);
}

// The moment of a video overlay's file shown at output time outT.
export function overlayMediaTime(o, outT) {
  return o.from + (outT - o.start);
}

// Where and how it is drawn at outT on a `size` output, for a picture of
// `media` pixels: { cx, cy, w, h, rotate, alpha }.
export function overlayPlacement(o, outT, { width, height }, media) {
  const local = outT - o.start;
  const at = (prop) => valueAt(o.keyframes?.[prop], local, o[prop]);
  const fit = Math.min(width / media.w, height / media.h);
  const scale = at('scale');
  let alpha = Math.max(0, Math.min(1, at('opacity')));
  if (o.fadeIn > 0 && local < o.fadeIn) alpha *= Math.max(0, local / o.fadeIn);
  const left = o.length - local;
  if (o.fadeOut > 0 && left < o.fadeOut) alpha *= Math.max(0, left / o.fadeOut);
  return {
    cx: width / 2 + at('x') * width,
    cy: height / 2 + at('y') * height,
    w: media.w * fit * scale,
    h: media.h * fit * scale,
    rotate: at('rotate'),
    alpha
  };
}

function mediaSize(frame) {
  const w = frame?.displayWidth ?? frame?.videoWidth ?? frame?.naturalWidth ?? frame?.width;
  const h = frame?.displayHeight ?? frame?.videoHeight ?? frame?.naturalHeight ?? frame?.height;
  return w > 0 && h > 0 ? { w, h } : null;
}

// The picture cut to its mask with a soft edge (overlay-effects.js
// maskAlpha, as gradients), on a spare canvas the size it is drawn at; null
// where there is no spare canvas (the caller then cuts a hard edge).
const MAX_MASK_SIDE = 4096;
let maskCanvas = null;
function feathered(image, p, mask) {
  if (typeof globalThis.OffscreenCanvas !== 'function') return null;
  const w = Math.max(1, Math.min(MAX_MASK_SIDE, Math.ceil(p.w)));
  const h = Math.max(1, Math.min(MAX_MASK_SIDE, Math.ceil(p.h)));
  if (!maskCanvas) maskCanvas = new globalThis.OffscreenCanvas(w, h);
  if (maskCanvas.width !== w || maskCanvas.height !== h) {
    maskCanvas.width = w;
    maskCanvas.height = h;
  }
  const c = maskCanvas.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'copy';
  c.drawImage(image, 0, 0, w, h);
  c.globalCompositeOperation = 'destination-in';
  const f = mask.feather;
  const stops = (g, list) => { for (const [at, a] of list) g.addColorStop(at, `rgba(0, 0, 0, ${a})`); return g; };
  if (mask.shape === 'ellipse') {
    // A unit circle stretched over the box: solid to 1 - f, gone at 1.
    c.setTransform(w / 2, 0, 0, h / 2, w / 2, h / 2);
    c.fillStyle = stops(c.createRadialGradient(0, 0, Math.max(0, 1 - f), 0, 0, 1), [[0, 1], [1, 0]]);
    c.fillRect(-1, -1, 2, 2);
  } else {
    // Across, then down: each side fades over f of the way to the middle.
    const edge = [[0, 0], [f / 2, 1], [1 - f / 2, 1], [1, 0]];
    c.fillStyle = stops(c.createLinearGradient(0, 0, w, 0), edge);
    c.fillRect(0, 0, w, h);
    c.fillStyle = stops(c.createLinearGradient(0, 0, 0, h), edge);
    c.fillRect(0, 0, w, h);
  }
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  return maskCanvas;
}

export function draw(ctx, state) {
  for (const o of overlaysAt(state.project, state.outT)) {
    const frame = state.frames?.[overlayFrameKey(o.id)];
    const media = mediaSize(frame);
    if (!media) continue;
    const p = overlayPlacement(o, state.outT, state.size, media);
    if (p.alpha <= 0 || p.w <= 0) continue;
    ctx.save();
    ctx.globalAlpha = p.alpha;
    ctx.translate(p.cx, p.cy);
    if (p.rotate) ctx.rotate((p.rotate * Math.PI) / 180);
    const fx = overlayEffects(o);
    // Its green screen first (on the GPU; without one, the picture as it is).
    const image = (fx.key.on && keyFrame(frame, fx.key)) || frame;
    if (fx.blend !== 'normal') ctx.globalCompositeOperation = compositeOf(fx.blend);
    const { shape, feather } = fx.mask;
    const soft = shape !== 'none' && feather > 0 ? feathered(image, p, fx.mask) : null;
    if (shape === 'ellipse' && !soft) {
      ctx.beginPath();
      ctx.ellipse(0, 0, p.w / 2, p.h / 2, 0, 0, Math.PI * 2);
      ctx.clip();
    }
    ctx.drawImage(soft ?? image, -p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
}
