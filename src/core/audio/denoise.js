// Noise removal for voice ("Clean up audio" in the editor; project field
// audio.mic.cleanUp).
//
//   await denoise(channels, sampleRate, { strength }) -> channels
//
// Two engines:
//   - RNNoise (vendored wasm, src/vendor/rnnoise/): a small recurrent network
//     trained on speech. Removes fans, hiss, keyboard clatter and room noise
//     far better than any fixed filter, but it expects speech -- music or
//     tones in the mic track are treated as noise.
//   - spectralGate: a classic spectral noise gate in plain JS. Learns the
//     steady background noise from the quietest moments and turns each
//     frequency down by how far it sits above that floor. Used when the wasm
//     cannot be loaded, and available on its own (engine: 'spectral').
//
// Both return new arrays of the same length and rate as the input, time
// aligned with it (RNNoise's internal delay is removed).

import { assertChannels, dbToGain, fft, resample } from './util.js';
import { loadRnnoise, RNNOISE_FRAME, RNNOISE_RATE } from './rnnoise.js';

// Samples RNNoise's output lags its input (measured, see denoise.test.js).
export const RNNOISE_DELAY = 960;

let enginePromise = null;

// strength 0..1: how much of the cleaned signal replaces the original. 1 is
// full clean-up; lower values leave a little of the room in, which some
// people prefer to the "studio vacuum" sound.
export async function denoise(channels, sampleRate, options = {}) {
  return (await denoiseWithInfo(channels, sampleRate, options)).channels;
}

// Same as denoise(), also reporting which engine ran (for logs/tests).
export async function denoiseWithInfo(channels, sampleRate, {
  strength = 1, engine = 'auto', wasm, onProgress
} = {}) {
  assertChannels(channels, sampleRate);
  const s = clamp01(strength);
  if (s === 0) return { channels: channels.map((c) => new Float32Array(c)), engine: 'none' };
  if (engine === 'spectral') {
    return { channels: spectralGate(channels, sampleRate, { strength: s }), engine: 'spectral' };
  }
  let rn;
  try {
    if (wasm) rn = await loadRnnoise({ wasm });
    else rn = await (enginePromise ??= loadRnnoise());
  } catch (err) {
    enginePromise = null;
    if (engine === 'rnnoise') throw err;
    return { channels: spectralGate(channels, sampleRate, { strength: s }), engine: 'spectral' };
  }
  return { channels: rnnoiseDenoise(rn, channels, sampleRate, s, onProgress), engine: 'rnnoise' };
}

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);

function rnnoiseDenoise(rn, channels, sampleRate, strength, onProgress) {
  const total = channels.length * channels[0].length;
  let done = 0;
  return channels.map((input) => {
    const at48 = sampleRate === RNNOISE_RATE ? input : resample(input, sampleRate, RNNOISE_RATE);
    const n = at48.length;
    // Feed enough extra silence to flush the delayed tail out of the model.
    const frames = Math.ceil((n + RNNOISE_DELAY) / RNNOISE_FRAME);
    const wet = new Float32Array(frames * RNNOISE_FRAME);
    const frame = new Float32Array(RNNOISE_FRAME);
    const state = rn.createState();
    try {
      for (let f = 0; f < frames; f++) {
        const start = f * RNNOISE_FRAME;
        frame.fill(0);
        if (start < n) frame.set(at48.subarray(start, Math.min(n, start + RNNOISE_FRAME)));
        state.process(frame);
        wet.set(frame, start);
      }
    } finally {
      state.destroy();
    }
    const aligned = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const w = wet[i + RNNOISE_DELAY];
      aligned[i] = strength === 1 ? w : w * strength + at48[i] * (1 - strength);
    }
    done += input.length;
    onProgress?.(done / total);
    return sampleRate === RNNOISE_RATE ? aligned : fitLength(resample(aligned, RNNOISE_RATE, sampleRate), input.length);
  });
}

function fitLength(a, n) {
  if (a.length === n) return a;
  const o = new Float32Array(n);
  o.set(a.subarray(0, Math.min(n, a.length)));
  return o;
}

// ---------------------------------------------------------------------------
// Spectral gate.
//
// STFT with a Hann window at 75% overlap. The noise profile is the per-bin
// power of the quietest frames: a low percentile over (a sample of) all
// frames, after smoothing across neighbouring bins to tame its variance, then
// scaled up by NOISE_SCALE. (For white noise the true mean is 3.6x that
// percentile, but estimating the noise that high also eats into quiet parts
// of the voice: on real speech 2.5x keeps ~1.5 dB more SNR while still taking the
// pauses down by over 20 dB -- see test/audio-denoise.test.js.) A screen
// recording almost always has pauses between sentences, which is what this
// relies on.
//
// Per frame, each bin gets a Wiener gain from a "decision-directed" estimate
// of its speech-to-noise ratio (Ephraim & Malah): it blends the previous
// frame's cleaned estimate with the current excess over the noise, which is
// what stops the warbling "musical noise" a plain spectral subtraction makes.
// The gain never drops below a floor set by `strength`, and all channels
// share one gain so stereo stays put.

const PROFILE_PERCENTILE = 0.1;
const NOISE_SCALE = 2.5;
const DD_ALPHA = 0.96;
const MAX_PROFILE_FRAMES = 4000;

export function spectralGate(channels, sampleRate, { strength = 1 } = {}) {
  assertChannels(channels, sampleRate);
  const s = clamp01(strength);
  const n = channels[0].length;
  const size = 2 ** Math.round(Math.log2(sampleRate * 0.02));
  const hop = size / 4;
  const bins = size / 2 + 1;
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  // Hann analysis + Hann synthesis at hop size/4 sums to 1.5.
  const olaScale = 1 / 1.5;
  // Pad so every real sample is covered by 4 full frames.
  const pad = size;
  const frames = Math.ceil((n + pad) / hop) + 1;
  const floor = dbToGain(-(8 + 22 * s));

  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const frameAt = (ch, f) => {
    const start = f * hop - pad;
    for (let i = 0; i < size; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < n ? ch[idx] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
  };

  // --- Pass 1: noise profile from a sample of frames.
  const step = Math.max(1, Math.ceil(frames / MAX_PROFILE_FRAMES));
  const sampled = [];
  for (let f = 0; f < frames; f += step) {
    const start = f * hop - pad;
    // Skip frames that lie mostly in the padding: they are silence and would
    // drag the profile to zero.
    if (start < 0 || start + size > n) continue;
    const power = new Float32Array(bins);
    for (const ch of channels) {
      frameAt(ch, f);
      for (let b = 0; b < bins; b++) power[b] += (re[b] * re[b] + im[b] * im[b]) / channels.length;
    }
    const smooth = new Float32Array(bins);
    for (let b = 0; b < bins; b++) {
      const lo = Math.max(0, b - 1);
      const hi = Math.min(bins - 1, b + 1);
      let acc = 0;
      for (let k = lo; k <= hi; k++) acc += power[k];
      smooth[b] = acc / (hi - lo + 1);
    }
    sampled.push(smooth);
  }
  const noise = new Float32Array(bins);
  if (sampled.length === 0) {
    // Too short to learn anything from -- nothing sensible to remove.
    return channels.map((c) => new Float32Array(c));
  }
  const column = new Float32Array(sampled.length);
  const q = Math.floor(PROFILE_PERCENTILE * (sampled.length - 1));
  for (let b = 0; b < bins; b++) {
    for (let f = 0; f < sampled.length; f++) column[f] = sampled[f][b];
    column.sort();
    noise[b] = Math.max(column[q] * NOISE_SCALE, 1e-20);
  }

  // --- Pass 2: gains per frame, applied to every channel.
  const out = channels.map(() => new Float32Array(n + 2 * size));
  const spectraRe = channels.map(() => new Float64Array(size));
  const spectraIm = channels.map(() => new Float64Array(size));
  const power = new Float32Array(bins);
  const gain = new Float32Array(bins);
  const smoothGain = new Float32Array(bins);
  const prevClean = new Float32Array(bins); // previous |G|^2 * post SNR
  for (let f = 0; f < frames; f++) {
    power.fill(0);
    for (let c = 0; c < channels.length; c++) {
      frameAt(channels[c], f);
      spectraRe[c].set(re);
      spectraIm[c].set(im);
      for (let b = 0; b < bins; b++) power[b] += (re[b] * re[b] + im[b] * im[b]) / channels.length;
    }
    for (let b = 0; b < bins; b++) {
      const post = power[b] / noise[b];
      const prior = DD_ALPHA * prevClean[b] + (1 - DD_ALPHA) * Math.max(post - 1, 0);
      const g = prior / (1 + prior);
      gain[b] = g;
      prevClean[b] = g * g * post;
    }
    // Light smoothing across frequency: isolated single-bin gains are what
    // remaining noise "chirps" are made of.
    for (let b = 0; b < bins; b++) {
      const l = gain[Math.max(0, b - 1)];
      const r = gain[Math.min(bins - 1, b + 1)];
      smoothGain[b] = Math.max(floor, 0.25 * l + 0.5 * gain[b] + 0.25 * r);
    }
    const start = f * hop - pad;
    for (let c = 0; c < channels.length; c++) {
      const sr = spectraRe[c];
      const si = spectraIm[c];
      for (let b = 0; b < bins; b++) {
        const g = smoothGain[b];
        sr[b] *= g; si[b] *= g;
        if (b > 0 && b < size / 2) {
          sr[size - b] *= g; si[size - b] *= g;
        }
      }
      fft(sr, si, true);
      const o = out[c];
      for (let i = 0; i < size; i++) {
        const idx = start + i + pad; // out has `pad` samples of head room
        if (idx >= 0 && idx < o.length) o[idx] += sr[i] * win[i] * olaScale;
      }
    }
  }
  return out.map((o) => o.slice(pad, pad + n));
}
