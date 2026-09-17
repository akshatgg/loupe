// Layer 4: click ripples and the cursor. The capture never contains the
// cursor; it is drawn back from cursor.bin, as a crisp vector arrow (the same
// shape Render.swift drew) so it stays sharp at any zoom.

import { cursorPosition, cursorOpacity, prepareCursor } from '../cursor.js';

export const name = 'cursor';

export const RIPPLE_SECONDS = 0.5;

const prepared = new WeakMap();
function preparedFor(track) {
  if (!prepared.has(track)) prepared.set(track, prepareCursor(track));
  return prepared.get(track);
}

// The arrow outline at (x, y) for scale s, in canvas pixels.
export function arrowPoints(x, y, s) {
  return [
    [x, y], [x, y + 17 * s], [x + 4.5 * s, y + 13 * s], [x + 7.5 * s, y + 19 * s],
    [x + 10.5 * s, y + 17.5 * s], [x + 7.5 * s, y + 11.5 * s], [x + 12 * s, y + 11.5 * s]
  ];
}

export function drawArrow(ctx, x, y, s, alpha = 1) {
  const pts = arrowPoints(x, y, s);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 3 * s;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 1 * s;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.lineWidth = 1.2 * s;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

export function drawRipple(ctx, x, y, age, s) {
  const progress = age / RIPPLE_SECONDS;
  if (progress < 0 || progress > 1) return;
  const radius = (6 + 34 * progress) * s;
  ctx.save();
  ctx.strokeStyle = `rgba(59, 130, 245, ${(0.55 * (1 - progress)).toFixed(3)})`;
  ctx.lineWidth = 2.5 * s;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawHighlight(ctx, state, x, y, alpha) {
  const { highlight, size } = state.project.style.cursor;
  const { content, unit } = state;
  if (highlight === 'spotlight') {
    // Dim everything but a soft-edged circle around the cursor.
    const r = 90 * unit * size;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.beginPath();
    ctx.rect(content.x, content.y, content.w, content.h);
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill('evenodd');
    ctx.restore();
  } else if (highlight === 'ring') {
    const r = 24 * unit * size;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(255, 214, 10, 0.3)';
    ctx.strokeStyle = 'rgba(255, 214, 10, 0.9)';
    ctx.lineWidth = 3 * unit;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

export function draw(ctx, state) {
  const style = state.project.style.cursor;
  const { t, meta, toCanvas, pointScale } = state;
  if (style.clicks) {
    for (const c of meta.clicks) {
      if (t < c.t || t - c.t > RIPPLE_SECONDS) continue;
      const p = toCanvas(c.x, c.y);
      drawRipple(ctx, p.x, p.y, t - c.t, pointScale);
    }
  }
  const track = state.assets.cursors?.[state.source];
  if (!style.show || !track || track.length === 0) return;
  const cur = preparedFor(track);
  const pos = cursorPosition(cur, t, style.smooth);
  const alpha = style.hideWhenIdle ? cursorOpacity(cur, t, meta.clicks) : 1;
  if (!pos || alpha <= 0) return;
  const p = toCanvas(pos.x, pos.y);
  drawHighlight(ctx, state, p.x, p.y, alpha);
  // The cursor is part of the picture: it has the size it had on screen and
  // grows with the zoom, times the chosen size.
  drawArrow(ctx, p.x, p.y, pointScale * style.size, alpha);
}
