// Layer 9: the transition between two clips (project.transitions).
//
// A transition belongs to the clip it follows and is centred on the join:
// with duration d it runs from d/2 before the join to d/2 after (shortened
// to half of either clip if one is short).
//
//  - fade: the recording fades out to the background and the next fades in
//  - dip: the whole picture dips to black and back
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

export function draw(ctx, state) {
  const tr = transitionAt(state.project, state.tl, state.outT);
  if (!tr || tr.strength <= 0) return;
  if (tr.type === 'dip') {
    ctx.save();
    ctx.globalAlpha = tr.strength;
    ctx.fillStyle = '#000000';
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
