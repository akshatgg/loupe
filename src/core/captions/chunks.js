// Cutting long audio into pieces the speech model can take.
//
// Whisper listens to at most 30 seconds at a time. Cutting blindly every 30 s
// splits words in half (both halves then come out wrong), so each cut goes at
// the quietest moment in the last few seconds before the limit, which in
// speech is almost always a pause between words. Stretches with no sound at
// all are marked so they can be skipped: the model is known to invent text
// ("Thank you.") for silence.

export const CHUNK_DEFAULTS = Object.freeze({
  maxSeconds: 28,
  searchSeconds: 8,
  frameSeconds: 0.05,
  // Full-scale RMS. A quiet room through a laptop mic sits around 0.001-0.003;
  // soft speech is well above 0.01.
  silenceRms: 0.004
});

export function frameRms(samples, frameLen) {
  const n = Math.ceil(samples.length / frameLen);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const a = f * frameLen;
    const b = Math.min(samples.length, a + frameLen);
    let sum = 0;
    for (let i = a; i < b; i++) sum += samples[i] * samples[i];
    out[f] = Math.sqrt(sum / Math.max(1, b - a));
  }
  return out;
}

// -> [{ start, end, silent }] in samples, contiguous and covering everything.
export function planChunks(samples, sampleRate, options = {}) {
  const o = { ...CHUNK_DEFAULTS, ...options };
  const total = samples.length;
  if (!total) return [];
  const frameLen = Math.max(1, Math.round(o.frameSeconds * sampleRate));
  const rms = frameRms(samples, frameLen);
  const maxLen = Math.round(o.maxSeconds * sampleRate);
  const searchLen = Math.min(maxLen - frameLen, Math.round(o.searchSeconds * sampleRate));

  const chunks = [];
  let pos = 0;
  while (pos < total) {
    let end;
    if (total - pos <= maxLen) {
      end = total;
    } else {
      const firstF = Math.ceil((pos + maxLen - searchLen) / frameLen);
      const lastF = Math.floor((pos + maxLen) / frameLen) - 1;
      let best = lastF;
      // Ties go to the later frame: longer chunks mean fewer model runs.
      for (let f = lastF; f >= firstF; f--) if (rms[f] < rms[best]) best = f;
      end = Math.min(total, Math.max(pos + frameLen, best * frameLen + (frameLen >> 1)));
    }
    let loud = 0;
    for (let f = Math.floor(pos / frameLen); f < Math.ceil(end / frameLen); f++) loud = Math.max(loud, rms[f]);
    chunks.push({ start: pos, end, silent: loud < o.silenceRms });
    pos = end;
  }
  return chunks;
}
