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

import { solveCamera, cameraAt, viewRect } from './camera.js';
import * as background from './layers/background.js';
import * as frame from './layers/frame.js';
import * as cursor from './layers/cursor.js';
import * as annotations from './layers/annotations.js';
import * as keystrokes from './layers/keystrokes.js';
import * as webcam from './layers/webcam.js';
import * as captions from './layers/captions.js';
import * as transitions from './layers/transitions.js';

export const REFERENCE_HEIGHT = 1080;

// The draw order. `clip: true` layers are drawn inside the rounded content
// area (and only there); the rest on the whole output. A feature adds its
// drawing by filling in its layer module, not by editing this list.
export const LAYERS = [
  { layer: background, clip: false },
  { layer: { name: 'shadow', draw: frame.drawShadow }, clip: false },
  { layer: frame, clip: true },
  { layer: cursor, clip: true },
  { layer: annotations, clip: true },
  { layer: keystrokes, clip: false },
  { layer: webcam, clip: false },
  { layer: captions, clip: false },
  { layer: transitions, clip: false }
];

const EXPORT_HEIGHTS = { '720p': 720, '1080p': 1080, '1440p': 1440, '4k': 2160 };

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
    const main = project.sources[project.clips[0].source];
    return { width: even((main.width * target) / main.height), height: even(target) };
  }
  if (ratio >= 1) return { width: even(target * ratio), height: even(target) };
  return { width: even(target), height: even(target / ratio) };
}

// Where the recording goes in a `size` output: the output inset by the
// padding on every side, with rounded corners.
export function layout(project, size) {
  const { width, height } = size;
  const short = Math.min(width, height);
  const unit = short / REFERENCE_HEIGHT;
  const padding = Math.round(project.style.padding * short);
  const content = {
    x: padding, y: padding,
    w: Math.max(1, width - 2 * padding), h: Math.max(1, height - 2 * padding)
  };
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
  const track = solveCamera({
    zooms, cursorTrack: cursorTrack ?? [], duration: meta.duration,
    width: meta.width, height: meta.height, aspect
  });
  byKey.set(key, { zooms, track });
  return track;
}

// Everything a layer needs for this frame. Layers only read it.
export function frameState({ project, tl, outT, frames = {}, size, assets = {} }) {
  const at = tl.toSource(outT);
  const meta = project.sources[at.source];
  const geo = layout(project, size);
  const { content } = geo;
  // The view has the content area's shape; camera.js treats a shape within
  // a hair of the recording's own as that shape.
  const aspect = project.style.aspect === 'source' && project.style.padding === 0
    ? null : content.w / content.h;
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

export function drawFrame(ctx, options) {
  const state = frameState(options);
  let clipped = false;
  for (const { layer, clip } of LAYERS) {
    if (clip && !clipped) {
      ctx.save();
      frame.roundedRectPath(ctx, state.content, state.radius);
      ctx.clip();
      clipped = true;
    } else if (!clip && clipped) {
      ctx.restore();
      clipped = false;
    }
    layer.draw(ctx, state);
  }
  if (clipped) ctx.restore();
  return state;
}
