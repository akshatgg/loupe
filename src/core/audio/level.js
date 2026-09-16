// Volume levelling ("Even out volume" in the editor; project field
// audio.mic.level).
//
//   measureLoudness(channels, sampleRate) -> { integrated, blocks, range }
//   level(channels, sampleRate, { target, ... }) -> { channels, inputLoudness,
//                                                     outputLoudness, gainDb }
//
// Loudness is ITU-R BS.1770-4 integrated loudness (what streaming sites and
// podcast apps normalise to), in LUFS. Levelling is three steps:
//   1. a gentle compressor (2:1 above the speech level, slow-ish detector),
//      so the loud and quiet parts of a take sit closer together;
//   2. one static gain that brings the result to the target loudness
//      (-16 LUFS, the usual target for spoken content);
//   3. a peak limiter at -1 dBFS so that gain never clips.
// If the limiter had to work hard enough to pull the loudness under target,
// steps 2-3 repeat once from the compressed signal.

import { assertChannels, dbToGain, limit } from './util.js';

export const VOICE_TARGET_LUFS = -16;

// ---------------------------------------------------------------------------
// K-weighting: a high shelf (+4 dB above ~1.7 kHz, the head's acoustic effect)
// then a high-pass (~38 Hz). BS.1770 only publishes 48 kHz coefficients; these
// are the analogue prototypes behind them, re-derived for any rate with the
// bilinear transform (the same parametrisation libebur128 uses). At 48 kHz
// they reproduce the published numbers (see level.test.js).

export function kWeightingCoefficients(sampleRate) {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0]
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const highpass = {
    b: [1, -2, 1],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0]
  };
  return { shelf, highpass };
}

// Channel weights: L, R, C at 1; the surround pair (indices 3, 4 in the
// 5-channel layout BS.1770 assumes) at +1.5 dB. Mono and stereo -- all a
// screen recording has -- are just 1s.
const channelWeight = (i) => (i >= 3 ? 1.41 : 1);

const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = -10;

const toLufs = (power) => (power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity);

// Integrated loudness over 400 ms blocks with 75% overlap, gated first at
// -70 LUFS absolute (silence) and then at 10 LU below the level of what is
// left (pauses and breaths), so the number describes the speech itself.
// Returns -Infinity for silence or signals shorter than one block.
export function measureLoudness(channels, sampleRate) {
  assertChannels(channels, sampleRate);
  const { shelf, highpass } = kWeightingCoefficients(sampleRate);
  const blockLen = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const n = channels[0].length;
  if (n < blockLen) return { integrated: -Infinity, blocks: 0, range: 0 };
  const blocks = Math.floor((n - blockLen) / hop) + 1;
  // Per-block mean-square, summed across channels with their weights. Built
  // from 100 ms sub-block sums so each sample is squared once.
  const subBlocks = Math.floor(n / hop);
  const sub = new Float64Array(subBlocks);
  channels.forEach((ch, c) => {
    const w = channelWeight(c);
    // The two biquads run sample by sample into the sums rather than into
    // filtered copies of the track: those copies were two 64-bit arrays per
    // channel, ~2.8 GB for an hour of mono.
    const sb = shelf.b, sa = shelf.a, hb = highpass.b, ha = highpass.a;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
    for (let s = 0; s < subBlocks; s++) {
      let acc = 0;
      const end = (s + 1) * hop;
      for (let i = s * hop; i < end; i++) {
        const x = ch[i];
        const y = sb[0] * x + sb[1] * x1 + sb[2] * x2 - sa[1] * y1 - sa[2] * y2;
        x2 = x1; x1 = x;
        const k = hb[0] * y + hb[1] * y1 + hb[2] * y2 - ha[1] * z1 - ha[2] * z2;
        y2 = y1; y1 = y;
        z2 = z1; z1 = k;
        acc += k * k;
      }
      sub[s] += acc * w;
    }
  });
  const power = new Float64Array(blocks);
  const per = blockLen / hop; // 4
  for (let j = 0; j < blocks; j++) {
    let acc = 0;
    for (let s = j; s < j + per; s++) acc += sub[s];
    power[j] = acc / blockLen;
  }
  let sum = 0;
  let count = 0;
  const heard = new Float32Array(blocks);
  for (let j = 0; j < blocks; j++) {
    const l = toLufs(power[j]);
    if (l > ABSOLUTE_GATE) { sum += power[j]; heard[count++] = l; }
  }
  if (count === 0) return { integrated: -Infinity, blocks, range: 0 };
  const relative = toLufs(sum / count) + RELATIVE_GATE;
  // range: how far the loudest moments (99th percentile block) rise above
  // the quiet floor (10th percentile). Speech with its pauses spans 8-15 LU;
  // a fan, hum or hiss on its own stays within about 1 LU.
  const sorted = heard.subarray(0, count).sort();
  const range = sorted[Math.floor(0.99 * (count - 1))] - sorted[Math.floor(0.1 * (count - 1))];
  sum = 0;
  count = 0;
  for (let j = 0; j < blocks; j++) {
    const l = toLufs(power[j]);
    if (l > ABSOLUTE_GATE && l > relative) { sum += power[j]; count++; }
  }
  return { integrated: count ? toLufs(sum / count) : -Infinity, blocks, range };
}

// ---------------------------------------------------------------------------
// Compressor: feed-forward, RMS detector (attack 10 ms, release 200 ms),
// soft 6 dB knee, 2:1 above a threshold placed a few dB over the speech's own
// loudness -- it only touches the louder syllables and shouts, never the
// quiet words, so it can't pump the noise floor up. Channels share the gain.

function compress(channels, sampleRate, { thresholdDb, ratio = 2, kneeDb = 6, attackMs = 10, releaseMs = 200 }) {
  const n = channels[0].length;
  const att = Math.exp(-1 / ((attackMs / 1000) * sampleRate));
  const rel = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  const out = channels.map(() => new Float32Array(n));
  let env = 0; // mean-square envelope
  const slope = 1 - 1 / ratio;
  const halfKnee = kneeDb / 2;
  for (let i = 0; i < n; i++) {
    let ms = 0;
    for (const c of channels) ms += c[i] * c[i];
    ms /= channels.length;
    env = ms > env ? att * env + (1 - att) * ms : rel * env + (1 - rel) * ms;
    // RMS dB of a sine is 3 dB under its peak; +3 puts the detector on the
    // same footing as the (sine-calibrated) loudness scale.
    const levelDb = env > 1e-12 ? 10 * Math.log10(env) + 3 : -120;
    const over = levelDb - thresholdDb;
    let reduction = 0;
    if (over > halfKnee) reduction = slope * over;
    else if (over > -halfKnee) reduction = (slope * (over + halfKnee) ** 2) / (2 * kneeDb);
    const g = reduction > 0 ? dbToGain(-reduction) : 1;
    for (let c = 0; c < channels.length; c++) out[c][i] = channels[c][i] * g;
  }
  return out;
}

const scale = (channels, g) => channels.map((c) => {
  const o = new Float32Array(c.length);
  for (let i = 0; i < c.length; i++) o[i] = c[i] * g;
  return o;
});

// Below this range a track has nothing rising above its background: the mic
// was left on but nobody spoke. See measureLoudness(). Kept low on purpose:
// a real take with speech half-buried in fan noise measured 3.8 LU, and
// holding back a voice is worse than raising a steady hum a little.
const MIN_VOICE_RANGE = 3;

// maxGainDb caps how far a very quiet take is raised: past ~30 dB the result
// is mostly room noise, and a silent track should stay silent. A track with
// no voice in it (steady fan or hiss only) is never raised at all -- turning
// it up to speech level would fill the video with noise.
export function level(channels, sampleRate, {
  target = VOICE_TARGET_LUFS, ceilingDb = -1, compressor = true, maxGainDb = 30
} = {}) {
  assertChannels(channels, sampleRate);
  const measured = measureLoudness(channels, sampleRate);
  const inputLoudness = measured.integrated;
  if (measured.range < MIN_VOICE_RANGE) maxGainDb = Math.min(maxGainDb, 0);
  if (!Number.isFinite(inputLoudness)) {
    return { channels: channels.map((c) => new Float32Array(c)), inputLoudness, outputLoudness: inputLoudness, gainDb: 0 };
  }
  const shaped = compressor
    ? compress(channels, sampleRate, { thresholdDb: inputLoudness + 4 })
    : channels;
  const shapedLoudness = compressor ? measureLoudness(shaped, sampleRate).integrated : inputLoudness;
  let gainDb = Math.min(maxGainDb, target - shapedLoudness);
  let result = limit(scale(shaped, dbToGain(gainDb)), sampleRate, { ceilingDb, inPlace: true }).channels;
  let outputLoudness = measureLoudness(result, sampleRate).integrated;
  // Limiting lowers loudness a little on peaky material; make up the
  // shortfall once (more gain pushes more into the limiter, so the second
  // correction slightly overshoots the first -- close enough in one step).
  const shortfall = target - outputLoudness;
  if (shortfall > 0.3 && gainDb < maxGainDb) {
    gainDb = Math.min(maxGainDb, gainDb + shortfall);
    result = null; // let the first attempt be freed before the second is built
    result = limit(scale(shaped, dbToGain(gainDb)), sampleRate, { ceilingDb, inPlace: true }).channels;
    outputLoudness = measureLoudness(result, sampleRate).integrated;
  }
  return { channels: result, inputLoudness, outputLoudness, gainDb };
}
