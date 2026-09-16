// Layer 7: the webcam bubble (sources.<key>.webcam, style.webcam).
//
// webcam.webm starts `offset` seconds into its recording (negative when the
// camera started first), so the camera picture for source time t is the one
// at t - offset. The caller decodes it and passes it as
// frames[webcamFrameKey(source)]; with no picture there (before the camera
// started, after it stopped, or not loaded yet) nothing is drawn.
//
// The bubble sits in a corner of the content area, `size` of the output's
// short side across, as a circle or a rounded square, with a thin light rim
// and a soft shadow. The recording is drawn unmirrored, as recorded.

import { frameSize, roundedRectPath } from './frame.js';
import { coverCrop } from './background.js';

export const name = 'webcam';

export const MARGIN_PX = 28;

// Frame keys can't collide with recording names (letters, digits, _ and -).
export const webcamFrameKey = (source) => `${source}:webcam`;

// Seconds into webcam.webm for source time t, or null without a webcam.
export function webcamTime(meta, t) {
  if (!meta?.webcam) return null;
  return t - (meta.webcam.offset ?? 0);
}

// The bubble's square in output pixels: { x, y, d }.
export function bubbleRect(state) {
  const style = state.project.style.webcam;
  const { content, size, unit } = state;
  const short = Math.min(size.width, size.height);
  const d = Math.max(8, Math.min(style.size * short, content.w, content.h));
  const margin = MARGIN_PX * unit;
  const left = style.corner.endsWith('left');
  const top = style.corner.startsWith('top');
  const x = left ? content.x + margin : content.x + content.w - margin - d;
  const y = top ? content.y + margin : content.y + content.h - margin - d;
  return {
    x: Math.max(0, Math.min(size.width - d, x)),
    y: Math.max(0, Math.min(size.height - d, y)),
    d
  };
}

function shapePath(ctx, shape, { x, y, d }) {
  if (shape === 'circle') {
    ctx.beginPath();
    ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
    ctx.closePath();
  } else {
    roundedRectPath(ctx, { x, y, w: d, h: d }, d * 0.2);
  }
}

export function draw(ctx, state) {
  const style = state.project.style.webcam;
  if (!style.show || !state.meta.webcam) return;
  const picture = state.frames[webcamFrameKey(state.source)];
  const px = frameSize(picture);
  if (!px) return;
  const r = bubbleRect(state);
  const { unit } = state;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 30 * unit;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 10 * unit;
  ctx.fillStyle = '#1f1f23';
  shapePath(ctx, style.shape, r);
  ctx.fill();
  ctx.restore();

  ctx.save();
  shapePath(ctx, style.shape, r);
  ctx.clip();
  const { sx, sy, sw, sh } = coverCrop(px.w, px.h, r.d, r.d);
  ctx.drawImage(picture, sx, sy, sw, sh, r.x, r.y, r.d, r.d);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = Math.max(1, 3 * unit);
  shapePath(ctx, style.shape, r);
  ctx.stroke();
  ctx.restore();
}
