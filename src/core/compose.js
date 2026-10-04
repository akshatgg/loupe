// Draws one output frame (docs/EDITOR-V2.md section 5). The editor preview
// and every export call this same function, so what you see is what you get.
//
// drawFrame(ctx, { project, tl, outT, frames, size, assets })
//  - ctx: a 2D canvas context (canvas, OffscreenCanvas).
//  - tl: buildTimeline(project).
//  - outT: output time in seconds.
//  - frames: { [sourceKey]: image } -- the decoded frame of each source needed
//    at outT (VideoFrame, ImageBitmap, HTMLVideoElement...).
//  - size: { width, height } of the output in pixels.
//  - assets: { cursors: { [sourceKey]: parsed cursor.bin track },
//              background: loaded background image,
//              cameras: { [sourceKey]: camera track } (optional; solved and
//              cached here when absent) }.
//
// Sizes are in "units" of the output's short side at 1080 pixels, so 1080p,
// 4K and a 9:16 export look alike.

import { solveCamera, cameraAt, viewRect, SAME_ASPECT_TOLERANCE } from './camera.js';
import * as background from './layers/background.js';
import * as frame from './layers/frame.js';
import * as cursor from './layers/cursor.js';
import * as annotations from './layers/annotations.js';
import * as keystrokes from './layers/keystrokes.js';
import * as webcam from './layers/webcam.js';
import * as captions from './layers/captions.js';
import * as transitions from './layers/transitions.js';
import * as overlays from './layers/overlays.js';
import { clipTransform, clipColor, cssFilter, tintOf, isPlain, transformMatrix } from './look.js';
import { valueAt } from './keyframes.js';
import { earlierTimes, viewShift, MIN_SHIFT_PX } from './motion-blur.js';

export const REFERENCE_HEIGHT = 1080;

// The draw order. `clip: true` layers are drawn inside the rounded content
// area (and only there); the rest on the whole output. A feature adds its
// drawing by filling in its layer module, not by editing this list.
export const LAYERS = [
  { layer: background, clip: false },
  { layer: { name: 'shadow', draw: frame.drawShadow }, clip: false },
  { layer: frame, clip: true },
  { layer: cursor, clip: true },
  // Pictures and videos on the rows above the main video.
  { layer: overlays, clip: false },
  // Unclipped: title cards cover the whole output; the layer clips the rest.
  { layer: annotations, clip: false },
  { layer: keystrokes, clip: false },
  { layer: webcam, clip: false },
  { layer: captions, clip: false },
  { layer: transitions, clip: false }
];

const EXPORT_HEIGHTS = { '720p': 720, '1080p': 1080, '1440p': 1440, '4k': 2160 };
// The widest frame H.264, HEVC and VP9 hardware encoders reliably accept.
const MAX_EXPORT_WIDTH = 4096;

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

// Numeric width / height of an aspect setting, or null for 'source'.
export function aspectRatio(aspect) {
  if (aspect === 'source') return null;
  const m = /^(\d+):(\d+)$/.exec(aspect ?? '');
  if (!m) throw new Error(`Unknown aspect ratio: ${JSON.stringify(aspect)}`);
  return Number(m[1]) / Number(m[2]);
}

// The export's pixel size. With the source's shape, the preset is the height
// and the width follows the recording (as v1's resolveExportSize did, so a
// migrated project exports at the same size); with a chosen shape, the
// preset is the short side ("1080p" 9:16 is 1080x1920).
export function exportSize(project, resolution = project.export.resolution) {
  const target = EXPORT_HEIGHTS[resolution];
  if (!target) throw new Error(`Unknown export resolution: ${JSON.stringify(resolution)}`);
  const ratio = aspectRatio(project.style.aspect);
  if (ratio === null) {
    // The main recording decides the shape, not whichever clip was moved to
    // the front: an added recording is fitted inside it like any other.
    const main = project.sources.main ?? project.sources[project.clips[0].source];
    const width = (main.width * target) / main.height;
    // A very wide strip of screen (1470x81) would otherwise ask for a
    // 19600-pixel-wide video no encoder makes: the width is capped at twice
    // the preset's 16:9 width and at what encoders accept, the height
    // following the shape.
    const maxWidth = Math.min(MAX_EXPORT_WIDTH, (target * 32) / 9);
    if (width > maxWidth) return { width: even(maxWidth), height: even((maxWidth * main.height) / main.width) };
    return { width: even(width), height: even(target) };
  }
  if (ratio >= 1) return { width: even(target * ratio), height: even(target) };
  return { width: even(target), height: even(target / ratio) };
}

// Where the recording goes in a `size` output: the output inset by the
// padding on every side, with rounded corners. With the 'source' shape the
// inset box no longer has the recording's shape (the same padding is taken
// off a long and a short side), so the recording is fitted inside it and
// centred rather than cropped: nobody asked to lose the top of their screen.
// `meta` is the recording being drawn; without it the box is used as is.
export function layout(project, size, meta = null) {
  const { width, height } = size;
  const short = Math.min(width, height);
  const unit = short / REFERENCE_HEIGHT;
  const padding = Math.round(project.style.padding * short);
  const content = {
    x: padding, y: padding,
    w: Math.max(1, width - 2 * padding), h: Math.max(1, height - 2 * padding)
  };
  if (project.style.aspect === 'source' && meta && meta.width > 0 && meta.height > 0) {
    const src = meta.width / meta.height;
    // Within a hair of the recording's shape (even-pixel rounding) it fills
    // the box, as v1 did; a migrated project keeps its exact picture.
    if (Math.abs(content.w / content.h / src - 1) >= SAME_ASPECT_TOLERANCE) {
      const w = Math.min(content.w, Math.round(content.h * src));
      const h = Math.min(content.h, Math.round(content.w / src));
      content.x = Math.round((width - w) / 2);
      content.y = Math.round((height - h) / 2);
      content.w = Math.max(1, w);
      content.h = Math.max(1, h);
    }
  }
  const radius = Math.min(project.style.radius * unit, content.w / 2, content.h / 2);
  return { unit, padding, content, radius };
}

// Solved camera tracks, cached per cursor track (or per source metadata when
// there is none) and per view shape; recomputed when that source's zooms
// change. Edits share untouched arrays (project.js), so anything but a zoom
// edit keeps the cache.
const cameraCache = new WeakMap();

export function cameraTrackFor(project, source, cursorTrack, aspect) {
  const meta = project.sources[source];
  const owner = cursorTrack ?? meta;
  if (!cameraCache.has(owner)) cameraCache.set(owner, new Map());
  const byKey = cameraCache.get(owner);
  const key = `${source}|${aspect === null ? 'source' : aspect.toFixed(4)}|${meta.width}x${meta.height}|${meta.duration}`;
  const zooms = project.zooms.filter((z) => z.source === source);
  const hit = byKey.get(key);
  if (hit && hit.zooms.length === zooms.length && hit.zooms.every((z, i) => z === zooms[i])) return hit.track;
  // No cursor (an imported video): a zoom that follows it holds the middle.
  const cursor = cursorTrack?.length ? cursorTrack : [{ t: 0, x: meta.width / 2, y: meta.height / 2 }];
  const track = solveCamera({
    zooms, cursorTrack: cursor, duration: meta.duration,
    width: meta.width, height: meta.height, aspect
  });
  byKey.set(key, { zooms, track });
  return track;
}

// Everything a layer needs for this frame. Layers only read it.
export function frameState({ project, tl, outT, frames = {}, size, assets = {} }) {
  const at = tl.toSource(outT);
  const meta = project.sources[at.source];
  const geo = layout(project, size, meta);
  const { content } = geo;
  // The view has the content area's shape. With the 'source' shape that is
  // the recording's own (layout fitted it); camera.js also treats a chosen
  // shape within a hair of the recording's as that shape.
  const aspect = project.style.aspect === 'source' ? null : content.w / content.h;
  const track = assets.cameras?.[at.source] ??
    cameraTrackFor(project, at.source, assets.cursors?.[at.source], aspect);
  const camera = cameraAt(track, at.t, meta);
  const rect = viewRect(camera, meta.width, meta.height, aspect);
  const sx = content.w / rect.width;
  const sy = content.h / rect.height;
  return {
    project, tl, outT, size, assets, frames,
    source: at.source, t: at.t, clipIndex: at.clipIndex, meta,
    frame: frames[at.source] ?? null,
    ...geo, camera, rect,
    // Canvas pixels per source point.
    pointScale: sx,
    toCanvas: (x, y) => ({ x: content.x + (x - rect.x) * sx, y: content.y + (y - rect.y) * sy })
  };
}

// Spare canvases per output context: one for a transition's other picture,
// one for a copy of this one (a slide, zoom or blur moves or filters it).
const blendCanvases = new WeakMap();
const copyCanvases = new WeakMap();
function spareCanvas(cache, ctx, { width, height }) {
  if (typeof globalThis.OffscreenCanvas !== 'function') return null;
  let c = cache.get(ctx);
  if (!c || c.canvas.width !== width || c.canvas.height !== height) {
    const canvas = new globalThis.OffscreenCanvas(width, height);
    c = { canvas, ctx: canvas.getContext('2d', { alpha: false }) };
    cache.set(ctx, c);
  }
  return c;
}
const blendCanvasFor = (ctx, size) => spareCanvas(blendCanvases, ctx, size);

// This picture, copied aside and the canvas cleared to black, ready to be
// drawn back moved, scaled or filtered.
function liftPicture(ctx, size) {
  const copy = spareCanvas(copyCanvases, ctx, size);
  if (!copy || !ctx.canvas) return null;
  copy.ctx.drawImage(ctx.canvas, 0, 0);
  ctx.save();
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.restore();
  return copy.canvas;
}

function drawScaled(ctx, image, scale, { width, height }, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(width / 2, height / 2);
  ctx.scale(scale, scale);
  ctx.drawImage(image, -width / 2, -height / 2);
  ctx.restore();
}

export function drawFrame(ctx, options) {
  const state = drawLayers(ctx, options);
  if (options.nested) return state;
  const tr = transitions.transitionAt(state.project, state.tl, state.outT);
  if (!tr || !ctx.canvas) return state;
  const { size } = state;
  const plan = transitions.transitionPlan(tr, state.outT, size);
  if (plan.mode === 'blur') {
    const picture = liftPicture(ctx, size);
    if (picture && plan.px > 0) {
      ctx.save();
      ctx.filter = `blur(${(plan.px * size.height) / 1080}px)`;
      ctx.drawImage(picture, 0, 0);
      ctx.restore();
    } else if (picture) ctx.drawImage(picture, 0, 0);
    return state;
  }
  // Two pictures: the other side's held picture (transitions.js), drawn as a
  // whole frame of its own and put with this one as the plan says.
  const other = options.frames?.[transitions.TRANSITION_FRAME];
  if (!other || !transitions.needsOtherPicture(tr.type)) return state;
  const blend = blendCanvasFor(ctx, size);
  if (!blend) return state;
  drawLayers(blend.ctx, {
    ...options, outT: tr.other.outT, nested: true,
    frames: { ...options.frames, [tr.other.source]: other }
  });
  const otherPicture = blend.canvas;
  if (plan.mode === 'alpha') {
    ctx.save();
    ctx.globalAlpha = plan.alpha;
    ctx.drawImage(otherPicture, 0, 0);
    ctx.restore();
  } else if (plan.mode === 'clip' || plan.mode === 'circle') {
    ctx.save();
    ctx.beginPath();
    if (plan.mode === 'clip') ctx.rect(plan.rect.x, plan.rect.y, plan.rect.w, plan.rect.h);
    else {
      if (!plan.inside) ctx.rect(0, 0, size.width, size.height);
      ctx.moveTo(plan.cx + plan.r, plan.cy);
      ctx.arc(plan.cx, plan.cy, Math.max(0, plan.r), 0, Math.PI * 2);
    }
    ctx.clip('evenodd');
    ctx.drawImage(otherPicture, 0, 0);
    ctx.restore();
  } else if (plan.mode === 'slide') {
    const picture = liftPicture(ctx, size);
    if (picture) {
      ctx.drawImage(picture, plan.current.dx, plan.current.dy);
      ctx.drawImage(otherPicture, plan.other.dx, plan.other.dy);
    }
  } else if (plan.mode === 'zoom') {
    // The old clip grows as the new one comes up over it.
    if (state.outT < tr.join) {
      const picture = liftPicture(ctx, size);
      if (picture) drawScaled(ctx, picture, plan.outgoingScale, size);
      ctx.save();
      ctx.globalAlpha = plan.incomingAlpha;
      ctx.drawImage(otherPicture, 0, 0);
      ctx.restore();
    } else {
      drawScaled(ctx, otherPicture, plan.outgoingScale, size, 1 - plan.incomingAlpha);
    }
  }
  return state;
}

// The clip's look (look.js) on the recording's layers: moved, scaled,
// rotated and cropped, and the colour for the frame layer to draw with.
function applyLook(ctx, state) {
  const clip = state.project.clips[state.clipIndex];
  state.look = null;
  const animated = clip?.keyframes && Object.values(clip.keyframes).some((k) => k?.length);
  if (!clip || (isPlain(clip) && !animated)) return;
  const t = clipTransform(clip);
  // Keyframed position and size, at this moment of the recording.
  for (const prop of ['x', 'y', 'scale', 'rotate']) t[prop] = valueAt(clip.keyframes?.[prop], state.t, t[prop]);
  const color = clipColor(clip);
  ctx.transform(...transformMatrix(t, state.content));
  const { content: c } = state;
  const crop = {
    x: c.x + t.crop.left * c.w, y: c.y + t.crop.top * c.h,
    w: c.w * (1 - t.crop.left - t.crop.right), h: c.h * (1 - t.crop.top - t.crop.bottom)
  };
  ctx.beginPath();
  ctx.rect(crop.x, crop.y, crop.w, crop.h);
  ctx.clip();
  state.look = { filter: cssFilter(color), tint: tintOf(color), crop, lut: color.lut, lutMix: color.lutMix, color };
}

// What still shows over a gap (a deleted clip's place, left black): things
// placed on the video's own time, not the recording's.
const OVER_A_GAP = new Set([overlays, transitions]);

function drawLayers(ctx, options) {
  const state = frameState(options);
  if (state.project.clips[state.clipIndex]?.gap) {
    ctx.save();
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, state.size.width, state.size.height);
    ctx.restore();
    for (const { layer } of LAYERS) if (OVER_A_GAP.has(layer)) layer.draw(ctx, state);
    return state;
  }
  let clipped = false;
  for (const { layer, clip } of LAYERS) {
    if (clip && !clipped) {
      ctx.save();
      frame.roundedRectPath(ctx, state.content, state.radius);
      ctx.clip();
      clipped = true;
      applyLook(ctx, state);
    } else if (!clip && clipped) {
      ctx.restore();
      clipped = false;
    }
    if (layer === frame || layer === cursor) drawMoving(ctx, options, state, layer);
    else layer.draw(ctx, state);
  }
  if (clipped) ctx.restore();
  return state;
}

// Spare canvases for motion blur: one earlier moment at a time is drawn
// there, then laid over the picture part-transparent.
const blurCanvases = new WeakMap();
const spriteCanvases = new WeakMap();
function spriteCanvas(ctx, { width, height }) {
  if (typeof globalThis.OffscreenCanvas !== 'function') return null;
  let c = spriteCanvases.get(ctx);
  if (!c || c.canvas.width !== width || c.canvas.height !== height) {
    const canvas = new globalThis.OffscreenCanvas(width, height);
    c = { canvas, ctx: canvas.getContext('2d') };
    spriteCanvases.set(ctx, c);
  }
  return c;
}

// The frame states of the moments just before this one that motion blur
// averages in (motion-blur.js), nearest first: only moments of the same
// clip, showing the same decoded frame. Worked out once per frame.
function earlierStates(options, state) {
  if (state.earlier) return state.earlier;
  const amount = state.project.style.motionBlur ?? 0;
  const out = [];
  for (const t of earlierTimes(state.outT, amount)) {
    const at = state.tl.toSource(t);
    if (!at || at.clipIndex !== state.clipIndex) break;
    const s = frameState({ ...options, outT: t });
    s.look = state.look;
    s.frame = state.frame;
    out.push(s);
  }
  state.earlier = out;
  return out;
}

// The recording or the cursor, smeared along its movement when it moved
// enough over the last moments to show; otherwise drawn plainly.
function drawMoving(ctx, options, state, layer) {
  const earlier = earlierStates(options, state);
  if (!earlier.length || !ctx.canvas) { layer.draw(ctx, state); return; }
  const last = earlier.at(-1);
  if (layer === frame) {
    const spare = viewShift(state, last) >= MIN_SHIFT_PX ? spareCanvas(blurCanvases, ctx, state.size) : null;
    layer.draw(ctx, state);
    if (!spare) return;
    // A running average: the k-th earlier moment at 1/(k+1) over the rest.
    earlier.forEach((s, k) => {
      layer.draw(spare.ctx, s);
      ctx.save();
      ctx.globalAlpha = 1 / (k + 2);
      ctx.drawImage(spare.canvas, 0, 0);
      ctx.restore();
    });
    return;
  }
  // The cursor (with its highlight and click ripples): each moment drawn on
  // its own, see-through, and laid down at an equal share.
  if (state.project.style.motionBlurCursor === false) { layer.draw(ctx, state); return; }
  const a = cursor.cursorPoint(state);
  const b = cursor.cursorPoint(last);
  const moved = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  const sprite = moved >= MIN_SHIFT_PX ? spriteCanvas(ctx, state.size) : null;
  if (!sprite) { layer.draw(ctx, state); return; }
  const all = [state, ...earlier];
  for (const s of all) {
    sprite.ctx.clearRect(0, 0, state.size.width, state.size.height);
    layer.draw(sprite.ctx, s);
    ctx.save();
    ctx.globalAlpha = 1 / all.length;
    ctx.drawImage(sprite.canvas, 0, 0);
    ctx.restore();
  }
}
