// Overlays: pictures and videos over the main video, on rows V2, V3, ...
// (project.overlays) -- a logo, B-roll, picture-in-picture -- drawn above
// the recording and its cursor, below annotations, keystrokes, the webcam
// and captions. Each overlay is
//
//   { id, kind: 'image' | 'video', file: 'media/<name>', name, start, from,
//     length, fileDuration, lane, x, y, scale, rotate, opacity, fadeIn,
//     fadeOut, keyframes: { x|y|scale|rotate|opacity: [{ t, v }] } }
//
// start/length in output seconds; from: seconds into a video; x, y move its
// middle from the video's middle by that share of the width / height; scale
// 1 fits it inside the video; keyframe times are seconds from its start.
// The caller hands each one's picture as frames[overlayFrameKey(id)].

import { valueAt } from '../keyframes.js';

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
    ctx.drawImage(frame, -p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
}
