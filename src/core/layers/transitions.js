// Layer 9: the transition between two clips (project.transitions).
//
// A transition belongs to the clip it follows and is centred on the join:
// with duration d it runs from d/2 before the join to d/2 after (shortened
// to half of either clip if one is short).
//
//  - fade: the recording fades out to the background and the next fades in
//  - dip / dip-white: the whole picture dips to black (white) and back
//  - blur: the picture blurs out into the next clip and back in
//  - wipe-left/right/up/down, slide-left/right, circle, zoom: two pictures,
//    as crossfade (below), placed by transitionPlan: the next clip wipes
//    across, pushes the old one out, opens in a circle from the middle, or
//    comes in while the old one grows
//  - crossfade: the two clips blend. Output time only ever belongs to one
//    clip, so the other side is a held picture: before the join, the next
//    clip's first frame fades in over this one; after it, the previous
//    clip's last frame fades out. compose.js draws that other picture as a
//    whole second frame (caller passes it as frames[TRANSITION_FRAME]) and
//    blends it in; this layer draws fade and dip.

import { roundedRectPath } from './frame.js';
import * as background from './background.js';

export const name = 'transitions';

export const TRANSITION_FRAME = '@transition';
// Output time just before a join, which belongs to the clip that ends there.
const BEFORE = 1e-4;

// The transition in effect at output time outT, or null:
// { type, after, join, half, progress (0..1 over the transition),
//   strength (0 at its edges, 1 at the join),
//   other: { source, t, outT } -- the held picture of the other side }
export function transitionAt(project, tl, outT) {
  if (!project.transitions.length) return null;
  const bounds = tl.clipBounds();
  for (const tr of project.transitions) {
    const i = project.clips.findIndex((c) => c.id === tr.after);
    if (i < 0 || i >= bounds.length - 1) continue;
    const a = bounds[i];
    const b = bounds[i + 1];
    const join = a.outEnd;
    const half = Math.min(tr.duration / 2, (a.outEnd - a.outStart) / 2, (b.outEnd - b.outStart) / 2);
    if (!(half > 0) || outT < join - half || outT >= join + half) continue;
    const progress = (outT - (join - half)) / (2 * half);
    const otherOut = outT < join ? join : Math.max(a.outStart, join - BEFORE);
    const at = tl.toSource(otherOut);
    return {
      type: tr.type, after: tr.after, join, half, progress,
      strength: 1 - Math.abs(outT - join) / half,
      other: { source: at.source, t: at.t, outT: otherOut }
    };
  }
  return null;
}

// How much of the other side's picture shows in a crossfade.
export function crossfadeMix(tr, outT) {
  return outT < tr.join ? tr.progress : 1 - tr.progress;
}

const TWO_PICTURES = new Set(['crossfade', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down', 'slide-left', 'slide-right', 'circle', 'zoom']);

// Whether a transition shows the other side's picture (the caller then
// supplies it as frames[TRANSITION_FRAME]).
export function needsOtherPicture(type) {
  return TWO_PICTURES.has(type);
}

// How compose.js puts the transition's pictures together at outT, on a
// `size` output. `current` is the picture of the clip outT belongs to,
// `other` the held picture of the other side: before the join that is the
// next clip (coming in), after it the previous one (going out).
//   { mode: 'alpha', alpha }                 other drawn over at alpha
//   { mode: 'clip', rect }                   other drawn inside rect
//   { mode: 'slide', current: {dx, dy}, other: {dx, dy} }
//   { mode: 'circle', cx, cy, r, inside }    other inside (or outside) a circle
//   { mode: 'zoom', outgoingScale, incomingAlpha }
//   { mode: 'blur', px }                     the one picture blurred
//   { mode: 'layer' }                        drawn by draw() below
export function transitionPlan(tr, outT, { width: W, height: H }) {
  const p = tr.progress;
  const otherComesIn = outT < tr.join;
  const pick = (incoming, outgoing) => (otherComesIn ? incoming : outgoing);
  switch (tr.type) {
    case 'crossfade': return { mode: 'alpha', alpha: crossfadeMix(tr, outT) };
    case 'wipe-left': return { mode: 'clip', rect: pick({ x: W * (1 - p), y: 0, w: W * p, h: H }, { x: 0, y: 0, w: W * (1 - p), h: H }) };
    case 'wipe-right': return { mode: 'clip', rect: pick({ x: 0, y: 0, w: W * p, h: H }, { x: W * p, y: 0, w: W * (1 - p), h: H }) };
    case 'wipe-up': return { mode: 'clip', rect: pick({ x: 0, y: H * (1 - p), w: W, h: H * p }, { x: 0, y: 0, w: W, h: H * (1 - p) }) };
    case 'wipe-down': return { mode: 'clip', rect: pick({ x: 0, y: 0, w: W, h: H * p }, { x: 0, y: H * p, w: W, h: H * (1 - p) }) };
    case 'slide-left':
    case 'slide-right': {
      const dir = tr.type === 'slide-left' ? -1 : 1;
      const outgoing = { dx: dir * W * p, dy: 0 };
      const incoming = { dx: -dir * W * (1 - p), dy: 0 };
      return { mode: 'slide', current: pick(outgoing, incoming), other: pick(incoming, outgoing) };
    }
    case 'circle': return { mode: 'circle', cx: W / 2, cy: H / 2, r: (Math.hypot(W, H) / 2) * p, inside: otherComesIn };
    case 'zoom': return { mode: 'zoom', outgoingScale: 1 + 0.5 * p, incomingAlpha: p };
    case 'blur': return { mode: 'blur', px: Math.round(24 * tr.strength * 100) / 100 };
    default: return { mode: 'layer' };
  }
}

export function draw(ctx, state) {
  const tr = transitionAt(state.project, state.tl, state.outT);
  if (!tr || tr.strength <= 0) return;
  if (tr.type === 'dip' || tr.type === 'dip-white') {
    ctx.save();
    ctx.globalAlpha = tr.strength;
    ctx.fillStyle = tr.type === 'dip' ? '#000000' : '#ffffff';
    ctx.fillRect(0, 0, state.size.width, state.size.height);
    ctx.restore();
  } else if (tr.type === 'fade') {
    // The background drawn again over the content area, more solid towards
    // the join: the recording seems to fade away into it.
    ctx.save();
    roundedRectPath(ctx, state.content, state.radius);
    ctx.clip();
    ctx.globalAlpha = tr.strength;
    background.draw(ctx, state);
    ctx.restore();
  }
}
