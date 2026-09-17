// A recording's sound laid along the output timeline: timeline.audioPlan()
// slices, stretched with WSOLA (pitch kept), turned into mix.js tracks.
//
//   audioRuns(plan)  -> [{ source, outStart, outEnd, slices }]
//   followPlan(plan, audio, options) -> mix.js tracks
//
// audioPlan() cuts a speed ramp into several constant-rate slices. Stretching
// each slice on its own would put a seam (and often a click) at every slice
// edge, so neighbouring slices that continue each other -- same recording,
// no jump in either timeline -- form one run, stretched in one pass along
// its piecewise-linear time map. Only a real jump (a cut, a reordered clip,
// another recording) starts a new run, and those edges get a few
// milliseconds of fade so the jump doesn't click.

import { stretch } from './wsola.js';

const EPS = 1e-6;
export const EDGE_FADE_SECONDS = 0.005;

export function audioRuns(plan) {
  const runs = [];
  for (const s of plan) {
    const outEnd = s.outStart + (s.srcEnd - s.srcStart) / s.rate;
    const slice = { srcStart: s.srcStart, srcEnd: s.srcEnd, outStart: s.outStart, outEnd, rate: s.rate };
    const last = runs.at(-1);
    const prev = last?.slices.at(-1);
    if (last && last.source === s.source && Math.abs(prev.srcEnd - s.srcStart) < EPS &&
        Math.abs(prev.outEnd - s.outStart) < EPS) {
      last.slices.push(slice);
      last.outEnd = outEnd;
    } else {
      runs.push({ source: s.source, outStart: s.outStart, outEnd, slices: [slice] });
    }
  }
  return runs;
}

// Output seconds (absolute) -> recording seconds along a run. Before and
// after the run it carries on at the first/last slice's rate, which is what
// the stretcher reads for its windows that hang over the ends.
export function runTimeMap(run) {
  const { slices } = run;
  return (o) => {
    let lo = 0;
    let hi = slices.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (slices[mid].outStart <= o) lo = mid;
      else hi = mid - 1;
    }
    const s = slices[lo];
    return s.srcStart + (o - s.outStart) * s.rate;
  };
}

function fadeEdges(channels, frames, fadeIn, fadeOut) {
  for (const c of channels) {
    const n = Math.min(frames, c.length >> 1);
    for (let i = 0; i < Math.min(fadeIn, n); i++) c[i] *= i / fadeIn;
    for (let i = 0; i < Math.min(fadeOut, n); i++) c[c.length - 1 - i] *= i / fadeOut;
  }
}

// `audio` is { [sourceKey]: { channels: Float32Array[], sampleRate } } -- the
// decoded track of each recording, sample 0 at recording time 0; a source
// missing from it is silent. `track` is copied onto each result (volume,
// muted, ...), so the caller decides how loud this sound is in the mix.
export function followPlan(plan, audio, { preservePitch = true, fadeSeconds = EDGE_FADE_SECONDS, track = {} } = {}) {
  const runs = audioRuns(plan);
  const tracks = [];
  runs.forEach((run, i) => {
    const pcm = audio[run.source];
    if (!pcm || !pcm.channels?.length) return;
    const rate = pcm.sampleRate;
    const first = Math.round(run.outStart * rate);
    const frames = Math.round(run.outEnd * rate) - first;
    if (frames <= 0) return;
    const start = first / rate;
    const map = runTimeMap(run);
    const channels = stretch(pcm.channels, rate, (o) => map(start + o), frames, { preservePitch });
    // A run that joins straight onto the last one's sound (nothing was cut
    // between them) needs no fade; anything else is a jump.
    const prev = runs[i - 1];
    const next = runs[i + 1];
    const joinsPrev = prev && prev.source === run.source && Math.abs(prev.slices.at(-1).srcEnd - run.slices[0].srcStart) < EPS;
    const joinsNext = next && next.source === run.source && Math.abs(run.slices.at(-1).srcEnd - next.slices[0].srcStart) < EPS;
    const fade = Math.round(fadeSeconds * rate);
    fadeEdges(channels, frames, joinsPrev || run.slices[0].srcStart < EPS ? 0 : fade, joinsNext ? 0 : fade);
    tracks.push({ ...track, source: run.source, channels, sampleRate: rate, startOffset: start });
  });
  return tracks;
}
