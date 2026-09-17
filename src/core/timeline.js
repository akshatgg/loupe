// The output timeline: the project's clips played in order, each clip's
// source range retimed by the `speed` segments inside it. Everything that
// turns "a moment of the video" into "a moment of a recording" (and back)
// goes through here -- the player, the exporter's frame plan and its audio
// stretch -- so they can never disagree.
//
// Speed ramps behave exactly as src/main/timemap.js: a segment eases from 1x
// to its rate over its first RAMP_SECONDS and back over its last (a
// smoothstep, kept inside the segment so neighbours never influence each
// other). timemap.js integrates the whole recording on a 1ms table; here only
// the ramps need a table (the rest is a constant rate, integrated exactly),
// so an hour-long recording costs a few kilobytes instead of megabytes.

export const RAMP_SECONDS = 0.2;
// timemap.js's integration step, kept so ramps come out the same length.
const RAMP_STEP = 0.001;
// A ramp is approximated by this many constant-rate audio slices, as
// speed.js does (audio can only be stretched by a constant per slice).
export const RAMP_SLICES = 10;
const EPS = 1e-9;

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

// Cumulative output time across a ramp, one entry per integration step.
function rampTable(length, rate, up) {
  const n = Math.max(1, Math.ceil(length / RAMP_STEP - 1e-9));
  const h = length / n;
  const table = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const u = (i - 0.5) / n;
    const k = smoothstep(up ? u : 1 - u);
    table[i] = table[i - 1] + h / (1 + (rate - 1) * k);
  }
  return table;
}

// One source's speed segments turned into consecutive pieces covering
// 0..duration, each either a constant rate or a ramp, with its output span.
export function buildSpeedMap(segments, duration) {
  const sorted = segments
    .map((s) => ({ start: Math.max(0, s.start), end: Math.min(duration, s.end), rate: s.rate }))
    .filter((s) => s.end - s.start > EPS)
    .sort((a, b) => a.start - b.start);
  const pieces = [];
  let out = 0;
  let at = 0;
  const push = (piece) => {
    const len = piece.b - piece.a;
    if (len <= EPS) return;
    const outLen = piece.table ? piece.table[piece.table.length - 1] : len / piece.rate;
    pieces.push({ ...piece, outA: out, outB: out + outLen });
    out += outLen;
  };
  for (const seg of sorted) {
    // Overlapping segments can't come from paintSpeed; if one does, the
    // earlier segment wins, the same as timemap.js's rateAt.
    const start = Math.max(seg.start, at);
    if (seg.end - start <= EPS) continue;
    push({ a: at, b: start, rate: 1 });
    const ramp = Math.min(RAMP_SECONDS, (seg.end - start) / 2);
    if (ramp > 0 && seg.rate !== 1) {
      push({ a: start, b: start + ramp, rate: seg.rate, table: rampTable(ramp, seg.rate, true) });
      push({ a: start + ramp, b: seg.end - ramp, rate: seg.rate });
      push({ a: seg.end - ramp, b: seg.end, rate: seg.rate, table: rampTable(ramp, seg.rate, false) });
    } else {
      push({ a: start, b: seg.end, rate: seg.rate });
    }
    at = seg.end;
  }
  push({ a: at, b: duration, rate: 1 });
  if (!pieces.length) pieces.push({ a: 0, b: duration, rate: 1, outA: 0, outB: 0 });
  return { pieces, duration, outputDuration: out };
}

// The last piece whose `key` edge is at or before `value`.
function findPiece(pieces, value, key) {
  let l = 0;
  let h = pieces.length - 1;
  while (l < h) {
    const mid = (l + h + 1) >> 1;
    if (pieces[mid][key] <= value) l = mid;
    else h = mid - 1;
  }
  return pieces[l];
}

// Source seconds -> output seconds within one source's speed map.
export function mapToOutput(map, t) {
  if (t <= 0) return 0;
  if (t >= map.duration) return map.outputDuration;
  const p = findPiece(map.pieces, t, 'a');
  if (!p.table) return p.outA + (Math.min(t, p.b) - p.a) / p.rate;
  const n = p.table.length - 1;
  const pos = Math.min(n, ((t - p.a) / (p.b - p.a)) * n);
  const i = Math.min(n - 1, Math.floor(pos));
  return p.outA + p.table[i] + (p.table[i + 1] - p.table[i]) * (pos - i);
}

// Output seconds -> source seconds, the inverse of mapToOutput.
export function mapToSource(map, o) {
  if (o <= 0) return 0;
  if (o >= map.outputDuration) return map.duration;
  const p = findPiece(map.pieces, o, 'outA');
  const local = o - p.outA;
  if (!p.table) return Math.min(p.b, p.a + local * p.rate);
  const { table } = p;
  let lo = 0;
  let hi = table.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid] <= local) lo = mid;
    else hi = mid;
  }
  const span = table[hi] - table[lo];
  const frac = span === 0 ? 0 : (local - table[lo]) / span;
  return p.a + ((lo + Math.min(1, frac)) / (table.length - 1)) * (p.b - p.a);
}

// The source-time edges of the constant-rate audio slices between a and b.
function audioEdges(map, a, b) {
  const edges = [a];
  for (const p of map.pieces) {
    if (p.b <= a + EPS || p.a >= b - EPS) continue;
    if (p.table) {
      for (let i = 1; i < RAMP_SLICES; i++) {
        const e = p.a + ((p.b - p.a) * i) / RAMP_SLICES;
        if (e > a + EPS && e < b - EPS) edges.push(e);
      }
    }
    if (p.b < b - EPS) edges.push(p.b);
  }
  edges.push(b);
  return edges;
}

export function buildTimeline(project) {
  const maps = new Map();
  const mapFor = (source) => {
    if (!maps.has(source)) {
      const meta = project.sources[source];
      if (!meta) throw new Error(`Unknown source: ${JSON.stringify(source)}`);
      const segs = (project.speed ?? []).filter((s) => s.source === source);
      maps.set(source, buildSpeedMap(segs, meta.duration));
    }
    return maps.get(source);
  };

  const bounds = [];
  let acc = 0;
  project.clips.forEach((clip, clipIndex) => {
    const map = mapFor(clip.source);
    const outA = mapToOutput(map, clip.start);
    const length = Math.max(0, mapToOutput(map, clip.end) - outA);
    bounds.push({ clipIndex, outStart: acc, outEnd: acc + length, mapStart: outA });
    acc += length;
  });
  const duration = acc;

  function toSource(outT) {
    if (!bounds.length) return null;
    const o = Math.min(Math.max(0, outT), duration);
    // Half-open [outStart, outEnd): a boundary belongs to the next clip, and
    // the very end to the last one.
    let i = bounds.findIndex((b) => o < b.outEnd);
    if (i < 0) i = bounds.length - 1;
    const b = bounds[i];
    const clip = project.clips[i];
    const map = mapFor(clip.source);
    const t = mapToSource(map, b.mapStart + (o - b.outStart));
    return { clipIndex: i, source: clip.source, t: Math.min(clip.end, Math.max(clip.start, t)) };
  }

  function toOutput(source, t) {
    for (let i = 0; i < project.clips.length; i++) {
      const clip = project.clips[i];
      if (clip.source !== source || t < clip.start - EPS || t > clip.end + EPS) continue;
      const map = mapFor(source);
      return bounds[i].outStart + mapToOutput(map, t) - bounds[i].mapStart;
    }
    return null;
  }

  function framePlan(fps) {
    if (!(fps > 0)) throw new Error(`Invalid fps: ${JSON.stringify(fps)}`);
    const count = Math.max(1, Math.ceil(duration * fps - 1e-6));
    const plan = new Array(count);
    for (let k = 0; k < count; k++) {
      const s = toSource(k / fps);
      plan[k] = { source: s.source, t: s.t, clipIndex: s.clipIndex };
    }
    return plan;
  }

  function audioPlan() {
    const out = [];
    project.clips.forEach((clip, i) => {
      const map = mapFor(clip.source);
      const edges = audioEdges(map, clip.start, clip.end);
      for (let k = 1; k < edges.length; k++) {
        const a = edges[k - 1];
        const b = edges[k];
        if (b - a <= EPS) continue;
        const oa = bounds[i].outStart + mapToOutput(map, a) - bounds[i].mapStart;
        const ob = bounds[i].outStart + mapToOutput(map, b) - bounds[i].mapStart;
        const rate = (b - a) / (ob - oa);
        const prev = out.at(-1);
        // Neighbouring slices at the same rate are one slice: fewer seams.
        if (prev && prev.source === clip.source && Math.abs(prev.srcEnd - a) < EPS &&
            Math.abs(prev.outStart + (prev.srcEnd - prev.srcStart) / prev.rate - oa) < 1e-7 &&
            Math.abs(prev.rate - rate) < 1e-9) {
          prev.srcEnd = b;
          continue;
        }
        out.push({ source: clip.source, srcStart: a, srcEnd: b, outStart: oa, rate });
      }
    });
    return out;
  }

  function clipBounds() {
    return bounds.map(({ clipIndex, outStart, outEnd }) => ({ clipIndex, outStart, outEnd }));
  }

  return { duration, toSource, toOutput, framePlan, audioPlan, clipBounds };
}
