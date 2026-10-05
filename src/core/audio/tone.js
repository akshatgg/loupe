// The finer tools for one sound: where it sits between left and right, a
// three-band equalizer, and a compressor. An audio clip, the microphone and
// the computer sound each carry these settings (all optional):
//
//   pan         -1 (left) .. 1 (right), 0 in the middle
//   eq          { low, mid, high } in dB, -12..12: a shelf below 200 Hz, a
//               wide bell around 1 kHz, a shelf above 4 kHz
//   compressor  { on, threshold (dB, -60..0), ratio (1..20), attack (s),
//                 release (s), makeup (dB) }
//
//   applyTone(channels, sampleRate, settings) -> channels
//
// With every setting at its default the channels given come straight back
// (the same array, nothing copied), so a sound nobody touched is mixed bit
// for bit as it was before these tools existed. Otherwise new arrays are
// returned -- the input is never written to -- in this order: equalizer,
// compressor, pan. Pan makes a one-channel sound two-channel; nothing else
// changes the channel count.
//
// The filters are the Audio EQ Cookbook's (Robert Bristow-Johnson) biquads.

export const EQ_LOW_HZ = 200;
export const EQ_MID_HZ = 1000;
export const EQ_HIGH_HZ = 4000;
// About two octaves wide: "the middle", not a notch.
const EQ_MID_Q = 0.7;

// The range of each setting: [lowest, highest, default].
export const TONE_LIMITS = {
  pan: [-1, 1, 0],
  eq: [-12, 12, 0],
  threshold: [-60, 0, -24],
  ratio: [1, 20, 4],
  attack: [0.001, 0.5, 0.01],
  release: [0.01, 2, 0.2],
  makeup: [0, 24, 0]
};

export function defaultTone() {
  const d = (k) => TONE_LIMITS[k][2];
  return {
    pan: d('pan'),
    eq: { low: d('eq'), mid: d('eq'), high: d('eq') },
    compressor: {
      on: false, threshold: d('threshold'), ratio: d('ratio'), attack: d('attack'), release: d('release'), makeup: d('makeup')
    }
  };
}

const pick = (v, key) => {
  const [lo, hi, def] = TONE_LIMITS[key];
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
};

// The settings of a clip, the microphone or the computer sound, whole: what
// is missing (an older project) or isn't a number gets its default, and
// numbers are kept in range, so a hand-edited file can't make noise of the mix.
export function toneOf(settings) {
  const eq = settings?.eq ?? {};
  const c = settings?.compressor ?? {};
  return {
    pan: pick(settings?.pan, 'pan'),
    eq: { low: pick(eq.low, 'eq'), mid: pick(eq.mid, 'eq'), high: pick(eq.high, 'eq') },
    compressor: {
      on: c.on === true,
      threshold: pick(c.threshold, 'threshold'),
      ratio: pick(c.ratio, 'ratio'),
      attack: pick(c.attack, 'attack'),
      release: pick(c.release, 'release'),
      makeup: pick(c.makeup, 'makeup')
    }
  };
}

// Whether these settings leave a sound exactly as it is.
export function isNeutralTone(settings) {
  const t = toneOf(settings);
  return t.pan === 0 && t.eq.low === 0 && t.eq.mid === 0 && t.eq.high === 0 && !t.compressor.on;
}

// ---- equalizer

// Biquad coefficients, normalised (a0 = 1): { b0, b1, b2, a1, a2 }.
function normalised(b0, b1, b2, a0, a1, a2) {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// A shelf with slope 1 (the steepest that doesn't overshoot).
export function shelf(kind, gainDb, freq, sampleRate) {
  const A = 10 ** (gainDb / 40);
  const w = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
  const cos = Math.cos(w);
  const alpha = (Math.sin(w) / 2) * Math.SQRT2;
  const k = 2 * Math.sqrt(A) * alpha;
  if (kind === 'low') {
    return normalised(
      A * ((A + 1) - (A - 1) * cos + k), 2 * A * ((A - 1) - (A + 1) * cos), A * ((A + 1) - (A - 1) * cos - k),
      (A + 1) + (A - 1) * cos + k, -2 * ((A - 1) + (A + 1) * cos), (A + 1) + (A - 1) * cos - k
    );
  }
  return normalised(
    A * ((A + 1) + (A - 1) * cos + k), -2 * A * ((A - 1) + (A + 1) * cos), A * ((A + 1) + (A - 1) * cos - k),
    (A + 1) - (A - 1) * cos + k, 2 * ((A - 1) - (A + 1) * cos), (A + 1) - (A - 1) * cos - k
  );
}

export function peaking(gainDb, freq, sampleRate, q = EQ_MID_Q) {
  const A = 10 ** (gainDb / 40);
  const w = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  return normalised(1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A);
}

// One biquad over `samples`, in place (transposed direct form II, in
// doubles; the result is rounded to the array's floats).
function filter(samples, { b0, b1, b2, a1, a2 }) {
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    samples[i] = y;
  }
}

// -> new channels with each band that isn't 0 dB applied.
export function equalize(channels, sampleRate, eq) {
  const bands = [];
  if (eq.low) bands.push(shelf('low', eq.low, EQ_LOW_HZ, sampleRate));
  if (eq.mid) bands.push(peaking(eq.mid, EQ_MID_HZ, sampleRate));
  if (eq.high) bands.push(shelf('high', eq.high, EQ_HIGH_HZ, sampleRate));
  return channels.map((c) => {
    const out = c.slice();
    for (const band of bands) filter(out, band);
    return out;
  });
}

// ---- compressor
//
// Feed-forward: the level of the input (the louder side, so a stereo sound
// keeps its balance) decides how far to turn it down -- every dB over the
// threshold becomes 1/ratio dB. That amount follows the sound's peaks (it
// rises at once and falls over the release time, so it doesn't wobble with
// each wave of a tone) and is then smoothed over the attack time.
// Under the threshold, with no makeup, samples come out exactly as they were.
export function compress(channels, sampleRate, settings) {
  const { threshold, ratio, attack, release, makeup } = toneOf({ compressor: settings }).compressor;
  const n = channels[0].length;
  const out = channels.map((c) => new Float32Array(c.length));
  const slope = 1 - 1 / ratio;
  const keepAttack = Math.exp(-1 / (attack * sampleRate));
  const keepRelease = Math.exp(-1 / (release * sampleRate));
  const floor = 10 ** (threshold / 20);
  const lift = 10 ** (makeup / 20);
  let held = 0; // dB to turn down, following the peaks
  let reduction = 0; // the same, smoothed: what is applied
  for (let i = 0; i < n; i++) {
    let level = 0;
    for (const c of channels) { const a = c[i] < 0 ? -c[i] : c[i]; if (a > level) level = a; }
    const target = level > floor ? (20 * Math.log10(level) - threshold) * slope : 0;
    held = Math.max(target, keepRelease * held + (1 - keepRelease) * target);
    reduction = keepAttack * reduction + (1 - keepAttack) * held;
    // Too little to hear: let go completely, so quiet sound is left exact.
    if (held < 1e-3) { held = 0; if (reduction < 1e-3) reduction = 0; }
    const gain = reduction === 0 ? lift : lift * 10 ** (-reduction / 20);
    for (let c = 0; c < channels.length; c++) out[c][i] = gain === 1 ? channels[c][i] : channels[c][i] * gain;
  }
  return out;
}

// ---- pan
//
// Equal power: as loud wherever it sits. In the middle both sides play it
// untouched; fully to one side that side carries the power of both (+3 dB)
// and the other is silent. A stereo sound keeps what is on each side and is
// turned towards one of them.
export function panChannels(channels, pan) {
  const p = pick(pan, 'pan');
  const angle = ((p + 1) * Math.PI) / 4;
  const gl = p >= 1 ? 0 : Math.SQRT2 * Math.cos(angle);
  const gr = p <= -1 ? 0 : Math.SQRT2 * Math.sin(angle);
  const left = channels[0];
  const right = channels.length > 1 ? channels[1] : channels[0];
  const L = new Float32Array(left.length);
  const R = new Float32Array(right.length);
  for (let i = 0; i < left.length; i++) L[i] = left[i] * gl;
  for (let i = 0; i < right.length; i++) R[i] = right[i] * gr;
  return [L, R];
}

export function applyTone(channels, sampleRate, settings) {
  const t = toneOf(settings);
  if (isNeutralTone(t) || !channels?.length) return channels;
  let out = channels;
  if (t.eq.low || t.eq.mid || t.eq.high) out = equalize(out, sampleRate, t.eq);
  if (t.compressor.on) out = compress(out, sampleRate, t.compressor);
  if (t.pan !== 0) out = panChannels(out, t.pan);
  return out;
}
