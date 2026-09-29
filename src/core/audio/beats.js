// Beat marks for a song, as CapCut's "Beats" shows them: the song's tempo
// and a steady grid of beats lined up with its hits.
//
//   detectBeats({ channels, sampleRate }) -> { bpm, beats: [seconds] }
//   (bpm null and no beats when the song has no steady pulse)
//
// How: the loudness is measured every 10 ms and each sudden rise (an
// onset: a drum hit, a plucked note) scored; the tempo is the spacing at
// which that onset curve best matches itself (autocorrelation), leaning
// toward common tempos; the grid is then slid to where the most onsets
// fall on it. A steady grid rather than every onset: cuts that land on the
// beat are what the marks are for.

const FRAME_RATE = 100; // onset curve samples per second
const MIN_BPM = 60;
const MAX_BPM = 190;

export function detectBeats({ channels, sampleRate }, { minBpm = MIN_BPM, maxBpm = MAX_BPM } = {}) {
  const none = { bpm: null, beats: [] };
  const n = channels?.[0]?.length ?? 0;
  if (!n || !(sampleRate > 0)) return none;
  const hop = Math.max(1, Math.round(sampleRate / FRAME_RATE));
  const frames = Math.floor(n / hop);
  if (frames < FRAME_RATE * 2) return none;

  // Energy per frame (two hops wide), all channels together.
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = f * hop;
    const b = Math.min(n, a + 2 * hop);
    let e = 0;
    for (const c of channels) for (let i = a; i < b; i++) e += c[i] * c[i];
    energy[f] = e / ((b - a) * channels.length);
  }

  // Onsets: rises in log energy, above the local average (so a loud
  // passage doesn't count as a hit in itself).
  const flux = new Float64Array(frames);
  for (let f = 1; f < frames; f++) {
    flux[f] = Math.max(0, Math.log10(1e-10 + energy[f]) - Math.log10(1e-10 + energy[f - 1]));
  }
  const half = Math.round(FRAME_RATE * 0.25);
  const onset = new Float64Array(frames);
  let sum = 0;
  for (let f = 0; f < Math.min(frames, half); f++) sum += flux[f];
  for (let f = 0; f < frames; f++) {
    if (f + half < frames) sum += flux[f + half];
    if (f - half - 1 >= 0) sum -= flux[f - half - 1];
    const count = Math.min(frames - 1, f + half) - Math.max(0, f - half) + 1;
    onset[f] = Math.max(0, flux[f] - sum / count);
  }
  let peak = 0;
  let total = 0;
  for (const v of onset) { peak = Math.max(peak, v); total += v; }
  // No clear hits (silence, a held note): no pulse to mark.
  if (peak < 0.2 || total / frames > peak * 0.2) return none;

  // Tempo: the lag where the onset curve best matches itself, weighted
  // toward ~120 BPM so a half or double tempo doesn't win on a tie.
  const minLag = Math.floor((60 / maxBpm) * FRAME_RATE);
  const maxLag = Math.ceil((60 / minBpm) * FRAME_RATE);
  const score = new Float64Array(maxLag + 2);
  let bestLag = 0;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let f = 0; f + lag < frames; f++) s += onset[f] * onset[f + lag];
    s /= frames - lag;
    const w = Math.exp(-0.5 * (Math.log2(lag / (FRAME_RATE / 2)) / 1.2) ** 2);
    score[lag] = s * w;
    if (score[lag] > best) { best = score[lag]; bestLag = lag; }
  }
  if (!bestLag || best <= 0) return none;
  // Between whole frames: a parabola through the peak and its neighbours.
  const y0 = score[bestLag - 1] ?? 0;
  const y1 = score[bestLag];
  const y2 = score[bestLag + 1] ?? 0;
  const denom = y0 - 2 * y1 + y2;
  const lag = bestLag + (denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0);
  const period = lag / FRAME_RATE;

  // Phase: slide the grid to where the onsets fall on it.
  const seconds = n / sampleRate;
  const near = (t) => {
    const f = Math.round(t * FRAME_RATE);
    let m = 0;
    for (let d = -1; d <= 1; d++) if (f + d >= 0 && f + d < frames) m = Math.max(m, onset[f + d]);
    return m;
  };
  let offset = 0;
  let bestFit = -1;
  for (let o = 0; o < period; o += 1 / FRAME_RATE) {
    let fit = 0;
    for (let t = o; t < seconds; t += period) fit += near(t);
    if (fit > bestFit) { bestFit = fit; offset = o; }
  }
  // Onsets are found at the start of the rise's frame; the hit is half a
  // hop later on average.
  offset += hop / sampleRate / 2;
  const beats = [];
  for (let t = offset; t < seconds; t += period) beats.push(Math.round(t * 1000) / 1000);
  return { bpm: Math.round((60 / period) * 10) / 10, beats };
}
