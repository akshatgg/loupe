// One composed frame as a list of what was drawn, in a form that can be kept
// in a file and compared later: every call and property write on the fake
// context, with the context's state at each call that puts ink down.
//
// test/fixtures/text-captions-baseline.json was written with this from the
// code as it was before caption presets and text styling existed.

import { buildTimeline } from '../../src/core/timeline.js';
import { drawFrame, exportSize } from '../../src/core/compose.js';
import { mockContext } from './mock-canvas.mjs';

const FRAME = { displayWidth: 3200, displayHeight: 2000 };
const DRAWS = new Set(['fillText', 'strokeText', 'fill', 'stroke', 'fillRect', 'drawImage', 'clip']);

const clean = (v) => {
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clean);
  return '[object]';
};

export function recordFrame(project, outT) {
  const ctx = mockContext();
  const tl = buildTimeline(project);
  drawFrame(ctx, { project, tl, outT, frames: { main: FRAME }, size: exportSize(project), assets: {} });
  return ctx.calls.map((c) => {
    const out = [c.name, clean(c.args)];
    if (DRAWS.has(c.name)) out.push(Object.fromEntries(Object.entries(c.state).map(([k, v]) => [k, clean(v)])));
    return out;
  });
}
