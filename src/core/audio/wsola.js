// Time-stretching audio so a sped-up or slowed-down stretch keeps its pitch:
// WSOLA (overlap-add of short windows, each nudged to where it best
// continues the last one). A port of native-win/AudioStretch.cs, which the
// native Windows export used, so a v1 project sounds the same.
//
//   stretch(channels, sampleRate, sourceAt, outputFrames, { preservePitch })
//     -> Float32Array[] (one per channel, outputFrames long)
//
// `sourceAt(seconds)` is the recording time (seconds into `channels`) heard
// at `seconds` into the output. It may be any increasing map -- a constant
// rate, or the piecewise-linear map of a speed ramp -- and is sampled once
// per window, so the pace can change smoothly within one call.
//
// Pure: no DOM, no Node. Everything is Float32Array.

// ~21ms windows at 48kHz, the size AudioStretch.cs used. Scaled with the
// sample rate so a 44.1kHz file gets the same length in time.
export function windowSizeFor(sampleRate) {
  return 2 ** Math.max(8, Math.round(Math.log2((sampleRate * 1024) / 48000)));
}

export function stretch(channels, sampleRate, sourceAt, outputFrames, { preservePitch = true } = {}) {
  const count = Math.max(0, Math.floor(outputFrames));
  const output = channels.map(() => new Float32Array(count));
  const sourceFrames = channels[0]?.length ?? 0;
  if (sourceFrames === 0 || count === 0) return output;
  if (preservePitch) wsola(channels, sourceFrames, sampleRate, sourceAt, output, count);
  else resampleAlong(channels, sourceFrames, sampleRate, sourceAt, output, count);
  return output;
}

// Tape-speed: read the recording at the mapped position, linearly
// interpolated. Pitch follows the pace.
function resampleAlong(src, frames, rate, sourceAt, dst, count) {
  for (let j = 0; j < count; j++) {
    const pos = sourceAt(j / rate) * rate;
    const i = Math.floor(pos);
    const frac = pos - i;
    for (let c = 0; c < src.length; c++) {
      const a = i >= 0 && i < frames ? src[c][i] : 0;
      const b = i + 1 >= 0 && i + 1 < frames ? src[c][i + 1] : 0;
      dst[c][j] = a * (1 - frac) + b * frac;
    }
  }
}

const hannCache = new Map();
// Periodic Hann: at 50% overlap the windows sum to exactly 1, so wherever the
// pace is 1x the sound comes through unchanged.
function hann(size) {
  if (!hannCache.has(size)) {
    const w = new Float32Array(size);
    for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    hannCache.set(size, w);
  }
  return hannCache.get(size);
}

function wsola(src, frames, rate, sourceAt, dst, count) {
  const size = windowSizeFor(rate);
  const hop = size / 2;
  const window = hann(size);
  const ch = src.length;

  // Alignment listens to the channels summed; one choice per window keeps
  // the stereo image intact.
  let mono = src[0];
  if (ch > 1) {
    mono = new Float32Array(frames);
    for (let c = 0; c < ch; c++) {
      const s = src[c];
      for (let i = 0; i < frames; i++) mono[i] += s[i] / ch;
    }
  }

  let previous = null;
  // Start one hop early so the first samples get a full pair of windows.
  for (let o = -hop; o < count; o += hop) {
    // Where this window "should" come from: the recording time at its centre.
    const nominal = Math.round(sourceAt((o + size / 2) / rate) * rate) - size / 2;
    let chosen = nominal;
    if (previous !== null) {
      const natural = previous + hop; // seamless continuation of the last window
      chosen = Math.abs(natural - nominal) <= 1 ? natural : bestAlignment(mono, frames, natural, nominal, size, hop);
    }
    previous = chosen;

    const i0 = Math.max(0, -o, -chosen);
    const i1 = Math.min(size, count - o, frames - chosen);
    for (let c = 0; c < ch; c++) {
      const s = src[c];
      const d = dst[c];
      for (let i = i0; i < i1; i++) d[o + i] += s[chosen + i] * window[i];
    }
  }
}

// The offset near `nominal` whose opening half best matches what would have
// followed the previous window (`natural`). Coarse search on every 4th
// sample, then refined.
function bestAlignment(mono, frames, natural, nominal, size, hop) {
  const overlap = size - hop;
  const tolerance = size / 2;
  let best = nominal;
  let bestScore = -Infinity;
  for (let d = -tolerance; d <= tolerance; d += 4) {
    const score = correlation(mono, frames, natural, nominal + d, overlap, 4);
    if (score > bestScore) { bestScore = score; best = nominal + d; }
  }
  const coarse = best;
  for (let d = -3; d <= 3; d++) {
    const score = correlation(mono, frames, natural, coarse + d, overlap, 1);
    if (score > bestScore) { bestScore = score; best = coarse + d; }
  }
  return best;
}

function correlation(mono, frames, a, b, length, step) {
  let sum = 0;
  let energy = 1e-9;
  for (let i = 0; i < length; i += step) {
    const x = a + i >= 0 && a + i < frames ? mono[a + i] : 0;
    const y = b + i >= 0 && b + i < frames ? mono[b + i] : 0;
    sum += x * y;
    energy += y * y;
  }
  return sum / Math.sqrt(energy);
}
