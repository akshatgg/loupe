// Layers 2 and 3: the recording itself. The content area gets its drop
// shadow here; compose.js then clips to the rounded content area and this
// layer draws the source frame cropped to the camera's view.

export const name = 'frame';

// A rounded rect path built from arcTo, which every 2D context (and the
// test mock) has, unlike roundRect.
export function roundedRectPath(ctx, { x, y, w, h }, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (radius === 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export function drawShadow(ctx, state) {
  const { shadow } = state.project.style;
  if (!(shadow > 0) || state.padding <= 0) return;
  ctx.save();
  ctx.shadowColor = `rgba(0, 0, 0, ${(0.6 * shadow).toFixed(3)})`;
  ctx.shadowBlur = 60 * state.unit * shadow;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 18 * state.unit * shadow;
  ctx.fillStyle = '#000000';
  roundedRectPath(ctx, state.content, state.radius);
  ctx.fill();
  ctx.restore();
}

// The pixel size of anything drawImage accepts.
export function frameSize(frame) {
  const w = frame?.displayWidth ?? frame?.videoWidth ?? frame?.naturalWidth ?? frame?.width;
  const h = frame?.displayHeight ?? frame?.videoHeight ?? frame?.naturalHeight ?? frame?.height;
  return w > 0 && h > 0 ? { w, h } : null;
}

export function draw(ctx, state) {
  const { content, rect, meta } = state;
  // Under the frame, and in its place until the frame has been decoded.
  ctx.fillStyle = '#000000';
  ctx.fillRect(content.x, content.y, content.w, content.h);
  const px = frameSize(state.frame);
  if (!px) return;
  // Camera math is in points; the video is in pixels (2x on a Retina screen).
  const kx = px.w / meta.width;
  const ky = px.h / meta.height;
  ctx.drawImage(state.frame, rect.x * kx, rect.y * ky, rect.width * kx, rect.height * ky,
    content.x, content.y, content.w, content.h);
}
