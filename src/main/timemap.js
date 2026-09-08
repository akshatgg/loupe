'use strict';

const STEP_SECONDS = 0.001;

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

// Playback rate at a source time. Ramps live INSIDE the segment, so
// non-overlapping segments never influence each other.
function rateAt(tSrc, segments, rampMs = 200) {
  const rampSeconds = rampMs / 1000;
  for (const seg of segments) {
    if (tSrc < seg.srcStart || tSrc > seg.srcEnd) continue;
    const ramp = Math.min(rampSeconds, (seg.srcEnd - seg.srcStart) / 2);
    let k = 1;
    if (ramp > 0) {
      const into = tSrc - seg.srcStart;
      const outOf = seg.srcEnd - tSrc;
      if (into < ramp) k = smoothstep(into / ramp);
      else if (outOf < ramp) k = smoothstep(outOf / ramp);
    }
    return 1 + (seg.rate - 1) * k;
  }
  return 1;
}

function buildMap(segments, duration, rampMs = 200) {
  // Validate that all segment rates are finite and strictly positive
  for (const seg of segments) {
    if (!Number.isFinite(seg.rate) || seg.rate <= 0) {
      throw new Error(`Segment rate must be finite and > 0, got ${seg.rate}`);
    }
  }
  const count = Math.ceil(duration / STEP_SECONDS) + 1;
  const table = new Float64Array(count);
  let acc = 0;
  for (let i = 1; i < count; i++) {
    const midpoint = (i - 0.5) * STEP_SECONDS;
    acc += STEP_SECONDS / rateAt(midpoint, segments, rampMs);
    table[i] = acc;
  }
  return { table, step: STEP_SECONDS, duration, outputDuration: acc };
}

function toOutput(map, tSrc) {
  const { table, step } = map;
  if (tSrc <= 0) return 0;
  const last = table.length - 1;
  const pos = tSrc / step;
  if (pos >= last) return table[last];
  const i = Math.floor(pos);
  return table[i] + (table[i + 1] - table[i]) * (pos - i);
}

function toSource(map, tOut) {
  const { table, step } = map;
  const last = table.length - 1;
  if (tOut <= 0) return 0;
  if (tOut >= table[last]) return last * step;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid] <= tOut) lo = mid;
    else hi = mid;
  }
  const span = table[hi] - table[lo];
  const frac = span === 0 ? 0 : (tOut - table[lo]) / span;
  return (lo + frac) * step;
}

module.exports = { buildMap, toOutput, toSource, rateAt };
