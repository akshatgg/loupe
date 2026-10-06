// Zooms made from the clicks of a recording: where someone clicked is what
// the viewer should see up close. Pure; project.js applies the result.
//
// Clicks close together are one zoom, which starts a little before the
// first and holds a little after the last. The strength picks the level and
// how readily a lone click earns a zoom.

export const AUTO_ZOOM_STRENGTHS = ['subtle', 'moderate', 'intense'];

const LEVEL = { subtle: 1.5, moderate: 2, intense: 2.5 };
// The fewest clicks that make a zoom: a lone click is skipped when subtle.
const MIN_CLICKS = { subtle: 2, moderate: 1, intense: 1 };

// Clicks no further apart than this (seconds) share a zoom.
export const CLUSTER_GAP = 2.5;
export const LEAD_IN = 0.4;
export const HOLD_AFTER = 1.2;
export const MIN_SECONDS = 1;
// [{ start, end, level, clicks }] for one recording's clicks ([{ t }], any
// order), kept clear of `taken` ([{ start, end }]: zooms made by hand).
export function autoZoomRanges(clicks, duration, { strength = 'moderate', taken = [] } = {}) {
  if (!AUTO_ZOOM_STRENGTHS.includes(strength)) throw new Error(`Zoom strength must be one of ${AUTO_ZOOM_STRENGTHS.join(', ')}`);
  const times = (clicks ?? []).map((c) => c?.t).filter((t) => Number.isFinite(t) && t >= 0 && t <= duration).sort((a, b) => a - b);
  const clusters = [];
  for (const t of times) {
    const last = clusters.at(-1);
    if (last && t - last.at(-1) <= CLUSTER_GAP) last.push(t);
    else clusters.push([t]);
  }
  const out = [];
  for (const cluster of clusters) {
    if (cluster.length < MIN_CLICKS[strength]) continue;
    let start = Math.max(0, cluster[0] - LEAD_IN);
    let end = Math.min(duration, cluster.at(-1) + HOLD_AFTER);
    // Up against the end of the recording, the room comes from before.
    if (end - start < MIN_SECONDS) start = Math.max(0, end - MIN_SECONDS);
    if (end - start < MIN_SECONDS) end = Math.min(duration, start + MIN_SECONDS);
    if (end - start < MIN_SECONDS - 1e-9) continue;
    // Never into the zoom before it (two clusters are at least a gap apart,
    // but a recording's very start can pull one back onto another).
    const prev = out.at(-1);
    if (prev && start < prev.end) start = prev.end;
    if (end - start < MIN_SECONDS - 1e-9) continue;
    // A zoom someone made there themselves wins.
    if (taken.some((z) => z.start < end - 1e-9 && z.end > start + 1e-9)) continue;
    out.push({ start, end, level: LEVEL[strength], clicks: cluster.length });
  }
  return out;
}
