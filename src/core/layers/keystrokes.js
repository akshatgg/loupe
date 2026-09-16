// Layer 6: keyboard shortcut badges (sources.<key>.keys, style.keystrokes).
//
// The recorder only writes shortcuts (a key with ⌘/⌃/⌥/Ctrl, or Esc, Tab,
// arrows...), never plain typing. Each press shows as a dark rounded badge
// centred above the bottom (or below the top) of the content area for a
// moment; presses close together line up side by side, newest on the right.
//
// The key list comes in as state.assets.keys[sourceKey] = [{ t, label }],
// t in source time.

import { roundedRectPath } from './frame.js';

export const name = 'keystrokes';

export const SHOW_SECONDS = 1.4;
export const FADE_IN_SECONDS = 0.08;
export const FADE_OUT_SECONDS = 0.3;
export const MAX_BADGES = 3;
export const BADGE_PX = 34;
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

// The presses on screen at source time t, oldest first, each with its opacity.
export function badgesAt(keys, t) {
  if (!Array.isArray(keys) || !keys.length) return [];
  // Keys are in time order; find the newest press at or before t.
  let lo = 0;
  let hi = keys.length - 1;
  if (keys[0].t > t) return [];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  const out = [];
  for (let i = lo; i >= 0 && out.length < MAX_BADGES; i--) {
    const age = t - keys[i].t;
    if (age >= SHOW_SECONDS) break;
    const alpha = Math.min(1, age / FADE_IN_SECONDS, (SHOW_SECONDS - age) / FADE_OUT_SECONDS);
    out.unshift({ label: keys[i].label, alpha: Math.max(0, alpha) });
  }
  return out;
}

// Sorted copy of a keys.json list, dropping anything malformed.
export function normalizeKeys(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((k) => Number.isFinite(k?.t) && typeof k.label === 'string' && k.label.length > 0 && k.label.length <= 40)
    .map((k) => ({ t: k.t, label: k.label }))
    .sort((a, b) => a.t - b.t);
}

export function draw(ctx, state) {
  const style = state.project.style.keystrokes;
  if (!style.show) return;
  const badges = badgesAt(state.assets.keys?.[state.source], state.t);
  if (!badges.length) return;
  const { unit, content, size } = state;
  const px = BADGE_PX * unit;
  const padX = px * 0.6;
  const h = px * 1.8;
  const gap = px * 0.35;
  ctx.save();
  ctx.font = `600 ${px}px ${FONT}`;
  const widths = badges.map((b) => Math.max(h, ctx.measureText(b.label).width + 2 * padX));
  const total = widths.reduce((s, w) => s + w, 0) + gap * (badges.length - 1);
  const margin = 36 * unit;
  let y = style.position === 'top' ? content.y + margin : content.y + content.h - margin - h;
  y = Math.max(8 * unit, Math.min(size.height - h - 8 * unit, y));
  let x = content.x + content.w / 2 - total / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  badges.forEach((b, i) => {
    const w = widths[i];
    const box = { x, y, w, h };
    ctx.globalAlpha = b.alpha;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 16 * unit;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 5 * unit;
    ctx.fillStyle = 'rgba(24, 24, 27, 0.9)';
    roundedRectPath(ctx, box, h * 0.28);
    ctx.fill();
    ctx.shadowColor = 'rgba(0, 0, 0, 0)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = Math.max(1, 1.5 * unit);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(b.label, x + w / 2, y + h / 2 + px * 0.04);
    x += w + gap;
  });
  ctx.restore();
}
