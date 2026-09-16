// Shared building blocks for the audio modules: decibels, resampling, an FFT
// and a lookahead peak limiter. Pure; every function works on Float32Array
// channels (one array per channel, samples in [-1, 1]).

export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);

export function assertChannels(channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length === 0
      || !channels.every((c) => c instanceof Float32Array)) {
    throw new TypeError('channels must be a non-empty array of Float32Array');
  }
  const n = channels[0].length;
  if (!channels.every((c) => c.length === n)) {
    throw new RangeError('all channels must have the same length');
  }
  if (!(Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 384000)) {
    throw new RangeError(`unsupported sample rate: ${sampleRate}`);
  }
}

export function peak(channels) {
  let p = 0;
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) {
      const a = Math.abs(c[i]);
      if (a > p) p = a;
    }
  }
  return p;
}

export function rms(samples, start = 0, end = samples.length) {
  let s = 0;
  for (let i = start; i < end; i++) s += samples[i] * samples[i];
  return end > start ? Math.sqrt(s / (end - start)) : 0;
}

// ---------------------------------------------------------------------------
// Resampling: windowed-sinc interpolation from a precomputed table of filter
// phases. Linear interpolation is audibly dull and aliases on 44.1 -> 48 kHz,
// the conversion every imported song goes through; a full polyphase design is
// overkill for offline export. 16 zero crossings with a Kaiser window keeps
// the passband flat to ~20 kHz at 48 kHz and costs ~32 taps per sample.

const ZERO_CROSSINGS = 16;
const PHASES = 256;

function besselI0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 40; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

const tableCache = new Map();

// cutoff is a fraction of the INPUT Nyquist (1 when upsampling). The table
// holds PHASES+1 rows so interpolating between phases never reads past it.
function sincTable(cutoff) {
  const key = cutoff.toFixed(6);
  if (tableCache.has(key)) return tableCache.get(key);
  const taps = ZERO_CROSSINGS * 2;
  const beta = 8.6;
  const i0b = besselI0(beta);
  const table = new Float32Array((PHASES + 1) * taps);
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      // Tap k sits at input offset (k - ZERO_CROSSINGS + 1) from floor(pos).
      const x = k - ZERO_CROSSINGS + 1 - frac;
      const w = Math.abs(x) >= ZERO_CROSSINGS ? 0
        : besselI0(beta * Math.sqrt(1 - (x / ZERO_CROSSINGS) ** 2)) / i0b;
      const s = x === 0 ? 1 : Math.sin(Math.PI * x * cutoff) / (Math.PI * x * cutoff);
      const v = w * s * cutoff;
      table[p * taps + k] = v;
      sum += v;
    }
    // Normalise each phase so DC passes at exactly unity gain.
    for (let k = 0; k < taps; k++) table[p * taps + k] /= sum;
  }
  tableCache.set(key, table);
  return table;
}

// Output length is round(n * to / from). Sample j of the output is taken at
// input position j * from / to, so sample 0 stays sample 0 (no delay).
export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return new Float32Array(samples);
  const ratio = fromRate / toRate;
  const outLen = Math.round(samples.length / ratio);
  const out = new Float32Array(outLen);
  const cutoff = Math.min(1, toRate / fromRate) * 0.97;
  const table = sincTable(cutoff);
  const taps = ZERO_CROSSINGS * 2;
  const n = samples.length;
  const last = n - 1;
  for (let j = 0; j < outLen; j++) {
    const pos = j * ratio;
    const base = Math.floor(pos);
    const fp = (pos - base) * PHASES;
    const pi = Math.floor(fp);
    const pf = fp - pi;
    const r0 = pi * taps;
    const r1 = r0 + taps;
    let acc = 0;
    const first = base - ZERO_CROSSINGS + 1;
    if (first >= 0 && first + taps <= n) {
      for (let k = 0; k < taps; k++) {
        const c = table[r0 + k] + (table[r1 + k] - table[r0 + k]) * pf;
        acc += c * samples[first + k];
      }
    } else {
      // Near the edges, repeat the end samples rather than reading zeros, so
      // a clip that starts loud doesn't get a click-shaped dip.
      for (let k = 0; k < taps; k++) {
        const idx = Math.min(last, Math.max(0, first + k));
        const c = table[r0 + k] + (table[r1 + k] - table[r0 + k]) * pf;
        acc += c * samples[idx];
      }
    }
    out[j] = acc;
  }
  return out;
}

export const resampleChannels = (channels, fromRate, toRate) =>
  channels.map((c) => resample(c, fromRate, toRate));

// ---------------------------------------------------------------------------
// In-place radix-2 FFT (real/imag arrays). Plans are cached per size.

const fftPlans = new Map();

function fftPlan(n) {
  let plan = fftPlans.get(n);
  if (plan) return plan;
  if (n & (n - 1)) throw new RangeError('FFT size must be a power of two');
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  plan = { rev, cos, sin };
  fftPlans.set(n, plan);
  return plan;
}

// inverse=true computes the inverse transform, including the 1/n scale.
export function fft(re, im, inverse = false) {
  const n = re.length;
  const { rev, cos, sin } = fftPlan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sign = inverse ? -1 : 1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const c = cos[k * step];
        const s = sign * sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * c + im[b] * s;
        const ti = im[b] * c - re[b] * s;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

// ---------------------------------------------------------------------------
// Lookahead peak limiter, offline. Because the whole signal is available the
// gain can be computed first and applied to the same sample indices, so there
// is no latency to compensate for.
//
// For each sample the required gain is ceiling / (estimated true peak). A
// running minimum over +-L samples followed by a centred moving average of
// the same width can never exceed the required gain at a peak (every value
// averaged is <= it), so the ceiling holds exactly while the gain moves
// smoothly over ~2L samples instead of jumping. A one-pole release then lets
// the gain recover gently after dense peaks. Channels share one gain so the
// stereo image doesn't wander.
//
// "True peak" is estimated cheaply by also checking the midpoint between
// neighbouring samples with a 4-point cubic; that catches most of the
// inter-sample overs a D/A converter or AAC encoder would produce.
//
// inPlace: true scales `channels` themselves instead of copies, for callers
// that own a buffer they no longer need unlimited (the mix, levelling).

export function limit(channels, sampleRate, {
  ceilingDb = -1, lookaheadMs = 5, releaseMs = 80, inPlace = false
} = {}) {
  const n = channels[0].length;
  const ceiling = dbToGain(ceilingDb);
  // req holds the required gain per sample, and is then overwritten with the
  // gain actually applied: an hour of 48 kHz audio is 173 million samples,
  // so every extra full-length array here costs the export ~700 MB.
  const req = new Float32Array(n);
  let over = false;
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const c of channels) {
      const a = Math.abs(c[i]);
      if (a > p) p = a;
      if (i + 2 < n && i >= 1) {
        const mid = (-c[i - 1] + 9 * c[i] + 9 * c[i + 1] - c[i + 2]) / 16;
        const m = Math.abs(mid);
        if (m > p) p = m;
      }
    }
    req[i] = p > ceiling ? ceiling / p : 1;
    if (req[i] < 1) over = true;
  }
  const output = () => (inPlace ? channels : channels.map((c) => new Float32Array(c)));
  if (!over) return { channels: output(), reductionDb: 0 };

  const L = Math.max(1, Math.round((lookaheadMs / 1000) * sampleRate));
  const minned = slidingMin(req, L);
  // Centred moving average of width 2L+1 as a running sum (truncated at the
  // ends -- the bound above holds for any subset of the window). Rounding in
  // the running sum could leave the average a hair above the required gain,
  // so it is clamped to req[i], which the exact average never exceeds; req[i]
  // is read before this loop overwrites it.
  let sum = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n, i + L + 1);
    while (b < hi) sum += minned[b++];
    const lo = Math.max(0, i - L);
    while (a < lo) sum -= minned[a++];
    const avg = sum / (b - a);
    req[i] = avg < req[i] ? avg : req[i];
  }
  const gain = req;
  const rel = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  let g = 1;
  let minGain = 1;
  for (let i = 0; i < n; i++) {
    // Falling gain follows immediately (it is already smooth); rising gain is
    // slowed by the release.
    g = gain[i] < g ? gain[i] : gain[i] + (g - gain[i]) * rel;
    gain[i] = g;
    if (g < minGain) minGain = g;
  }
  const out = output();
  for (const o of out) {
    for (let i = 0; i < n; i++) o[i] *= gain[i];
  }
  return { channels: out, reductionDb: -gainToDb(minGain) };
}

// Minimum over the window [i-L, i+L], O(n) with a monotonic deque. The deque
// never holds more than the window, so it is a ring of 2L+2 slots rather than
// a full-length array.
export function slidingMin(values, L) {
  const n = values.length;
  const out = new Float32Array(n);
  const cap = 2 * L + 2;
  const dq = new Int32Array(cap);
  let head = 0; // ring index of the front
  let size = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + L);
    while (next <= hi) {
      while (size > 0 && values[dq[(head + size - 1) % cap]] >= values[next]) size--;
      dq[(head + size) % cap] = next++;
      size++;
    }
    while (dq[head] < i - L) { head = (head + 1) % cap; size--; }
    out[i] = values[dq[head]];
  }
  return out;
}
