// Captions from source time to output time.
//
// Needs only `tl.toOutput(source, t) -> outT | null` (core/timeline.js; null
// where that moment was cut). A caption can come out as several cues: trim
// its middle and the halves play apart; move a clip and they can even swap
// order. So the caption is sampled, the samples are grouped into runs that
// play continuously, and each run's edges are refined by bisection to the
// exact cut. Speed changes are just a steeper or flatter mapping inside a run.

const SAMPLE_STEP = 0.05;
// Faster than the fastest speed paint (8x): a bigger jump between two samples
// means a join between clips, not playback.
const MAX_RATE = 8.5;
// Leftovers shorter than this after a cut are a flicker, not a caption.
const MIN_CUE_SECONDS = 0.15;
const BISECT_STEPS = 12;

// Whether source moments t1 < t2 (at output o1, o2) play one after the other.
function continuous(t1, o1, t2, o2) {
  return o1 !== null && o1 !== undefined && o2 !== null && o2 !== undefined &&
    o2 > o1 && o2 - o1 <= (t2 - t1) * MAX_RATE + 1e-6;
}

// The last moment from keptT towards lostT that still belongs to keptT's run:
// played at all, and continuously with keptT. Handles both a cut (lostT maps
// to null) and a join to another clip (lostT plays somewhere else).
function edge(tl, source, keptT, lostT) {
  const ok = tl.toOutput(source, keptT);
  const belongs = (m) => {
    const o = tl.toOutput(source, m);
    return m > keptT ? continuous(keptT, ok, m, o) : continuous(m, o, keptT, ok);
  };
  let a = keptT; let b = lostT;
  for (let i = 0; i < BISECT_STEPS; i++) {
    const m = (a + b) / 2;
    if (belongs(m)) a = m; else b = m;
  }
  return a;
}

// Output-time cues for one segment: [{ id, start, end, text }].
export function segmentToOutput(seg, tl, step = SAMPLE_STEP) {
  const { source, start, end } = seg;
  if (!(end > start)) return [];
  const n = Math.max(1, Math.ceil((end - start) / step));
  const ts = [];
  for (let k = 0; k <= n; k++) ts.push(k === n ? end - 1e-6 : start + k * ((end - start) / n));
  const outs = ts.map((t) => tl.toOutput(source, t));

  const runs = [];
  let run = null;
  for (let k = 0; k < ts.length; k++) {
    const o = outs[k];
    if (o === null || o === undefined) { run = null; continue; }
    if (run && continuous(ts[k - 1], outs[k - 1], ts[k], o)) {
      run.lastK = k;
    } else {
      run = { firstK: k, lastK: k };
      runs.push(run);
    }
  }

  const cues = [];
  for (const r of runs) {
    let s = ts[r.firstK];
    let e = ts[r.lastK];
    if (r.firstK > 0) s = edge(tl, source, s, ts[r.firstK - 1]);
    if (r.lastK < ts.length - 1) e = edge(tl, source, e, ts[r.lastK + 1]);
    const os = tl.toOutput(source, s);
    const oe = tl.toOutput(source, e);
    if (os === null || oe === null || oe - os < MIN_CUE_SECONDS) continue;
    cues.push({ id: seg.id, start: os, end: oe, text: seg.text });
  }
  return cues;
}

// All captions in output time, sorted, for the preview, burn-in and SRT/VTT.
export function captionsToOutput(segments, tl) {
  const cues = [];
  for (const seg of segments) cues.push(...segmentToOutput(seg, tl));
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues;
}
