// Mixing: every audio track of an export (mic, system audio, voiceovers,
// music) summed into one stereo buffer at the export rate.
//
//   mixTracks(tracks, { sampleRate = 48000, duration }) ->
//     { channels: [L, R], sampleRate, peak, limited }
//
// A track is
//   {
//     channels: Float32Array[],   // 1 (mono, sent to both sides) or 2+
//     sampleRate,                 // resampled to the mix rate if different
//     startOffset: 0,             // output seconds where `offset` lands
//     offset: 0,                  // seconds into the track to start from
//     duration,                   // seconds to use (default: to its end)
//     volume: 1,                  // linear
//     gain: null,                 // optional gain curve, see below
//     muted: false
//   }
//
// A gain curve is { rate, start = 0, values } -- linear gains sampled `rate`
// times per second, the first at OUTPUT time `start`. It is interpolated
// linearly and holds its first/last value outside its range. duck.js and
// music.js produce these; anything else that wants automation can too.
//
// Placement is sample-exact: the track's first sample lands on output sample
// round(startOffset * sampleRate). If the sum would clip, a lookahead limiter
// (ceiling -1 dBFS by default) brings the peaks down smoothly instead of
// letting the encoder hard-clip them; a mix that doesn't reach the ceiling is
// returned untouched, bit for bit.

import { limit, resample } from './util.js';

export const MIX_RATE = 48000;

export function gainAt(curve, t) {
  if (!curve) return 1;
  const { rate, start = 0, values } = curve;
  if (!values?.length) return 1;
  const x = (t - start) * rate;
  if (x <= 0) return values[0];
  const last = values.length - 1;
  if (x >= last) return values[last];
  const i = Math.floor(x);
  const f = x - i;
  return values[i] + (values[i + 1] - values[i]) * f;
}

export function validateCurve(curve) {
  if (curve === null || curve === undefined) return;
  if (!(Number.isFinite(curve.rate) && curve.rate > 0)
      || !(curve.values instanceof Float32Array || Array.isArray(curve.values))
      || (curve.start !== undefined && !Number.isFinite(curve.start))) {
    throw new TypeError('gain curve must be { rate > 0, start?, values }');
  }
}

function trackEnd(track) {
  const len = track.channels[0].length / track.sampleRate;
  const offset = track.offset ?? 0;
  const dur = Math.min(track.duration ?? Infinity, len - offset);
  return (track.startOffset ?? 0) + Math.max(0, dur);
}

export function mixTracks(tracks, {
  sampleRate = MIX_RATE, duration, protect = 'limit', ceilingDb = -1
} = {}) {
  const active = tracks.filter((t) => t && !t.muted && (t.volume ?? 1) !== 0);
  for (const t of active) {
    if (!Array.isArray(t.channels) || !t.channels.length
        || !t.channels.every((c) => c instanceof Float32Array)) {
      throw new TypeError('track.channels must be an array of Float32Array');
    }
    if (!(Number.isFinite(t.sampleRate) && t.sampleRate > 0)) {
      throw new RangeError('track.sampleRate must be a positive number');
    }
    validateCurve(t.gain);
  }
  const total = duration ?? active.reduce((m, t) => Math.max(m, trackEnd(t)), 0);
  const n = Math.max(0, Math.round(total * sampleRate));
  const L = new Float32Array(n);
  const R = new Float32Array(n);

  for (const t of active) {
    const rate = t.sampleRate;
    const srcLen = t.channels[0].length;
    const from = Math.max(0, Math.min(srcLen, Math.round((t.offset ?? 0) * rate)));
    const to = t.duration === undefined
      ? srcLen
      : Math.max(from, Math.min(srcLen, from + Math.round(t.duration * rate)));
    let chans = t.channels.map((c) => c.subarray(from, to));
    if (rate !== sampleRate) chans = chans.map((c) => resample(c, rate, sampleRate));
    const left = chans[0];
    const right = chans.length > 1 ? chans[1] : chans[0];
    const len = left.length;
    const startSample = Math.round((t.startOffset ?? 0) * sampleRate);
    // Clip the track to [0, n) of the output.
    const i0 = Math.max(0, -startSample);
    const i1 = Math.min(len, n - startSample);
    const volume = t.volume ?? 1;
    if (!t.gain) {
      for (let i = i0; i < i1; i++) {
        L[startSample + i] += left[i] * volume;
        R[startSample + i] += right[i] * volume;
      }
      continue;
    }
    for (let i = i0; i < i1; i++) {
      const o = startSample + i;
      const g = volume * gainAt(t.gain, o / sampleRate);
      L[o] += left[i] * g;
      R[o] += right[i] * g;
    }
  }

  const channels = [L, R];
  let peak = 0;
  for (const c of channels) for (let i = 0; i < n; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
  if (protect === 'none' || n === 0) return { channels, sampleRate, peak, limited: false };
  if (protect === 'clip') {
    for (const c of channels) for (let i = 0; i < n; i++) c[i] = Math.max(-1, Math.min(1, c[i]));
    return { channels, sampleRate, peak, limited: peak > 1 };
  }
  const { channels: out, reductionDb } = limit(channels, sampleRate, { ceilingDb });
  return { channels: out, sampleRate, peak, limited: reductionDb > 0 };
}
