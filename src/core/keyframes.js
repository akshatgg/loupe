// Keyframes: a property changing over time, as in any video editor -- a
// list of { t, v, ease? } in time order. Between two keyframes the value
// glides from one to the next (eased in and out, or 'linear'); before the
// first and after the last it holds. `t` is in the item's own time: a
// clip's recording time, an overlay's seconds from its start.

// Two keyframes this close are the same moment.
const SAME = 1e-3;

const smooth = (u) => u * u * (3 - 2 * u);

// The value at t: `base` when there are no keyframes.
export function valueAt(keyframes, t, base) {
  if (!keyframes?.length) return base;
  if (t <= keyframes[0].t) return keyframes[0].v;
  const last = keyframes[keyframes.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 1; i < keyframes.length; i++) {
    const b = keyframes[i];
    if (t > b.t) continue;
    const a = keyframes[i - 1];
    const u = b.t - a.t < 1e-9 ? 1 : (t - a.t) / (b.t - a.t);
    return a.v + (b.v - a.v) * (b.ease === 'linear' ? u : smooth(u));
  }
  return last.v;
}

export function keyframeAt(keyframes, t) {
  return keyframes?.find((k) => Math.abs(k.t - t) < SAME) ?? null;
}

// A keyframe of `v` at t, in time order. One already at that moment is
// replaced but keeps its time, so edits there never make it creep.
export function setKeyframe(keyframes, t, v, ease) {
  const at = keyframeAt(keyframes, t)?.t ?? t;
  const kept = (keyframes ?? []).filter((k) => Math.abs(k.t - t) >= SAME);
  const k = ease ? { t: at, v, ease } : { t: at, v };
  return [...kept, k].sort((a, b) => a.t - b.t);
}

export function removeKeyframe(keyframes, t) {
  return (keyframes ?? []).filter((k) => Math.abs(k.t - t) >= SAME);
}

// The keyframes strictly before and after t, for "previous / next keyframe".
export function neighbours(keyframes, t) {
  const list = keyframes ?? [];
  let prev = null;
  let next = null;
  for (const k of list) {
    if (k.t < t - SAME) prev = k;
    else if (k.t > t + SAME && !next) next = k;
  }
  return { prev, next };
}
