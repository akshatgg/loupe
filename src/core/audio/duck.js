// Background-music ducking ("Lower music while talking"; project field
// audio.music.duck).
//
//   voiceActivity(channels, sampleRate) -> { rate, active: Uint8Array, threshold }
//   duckingCurve(voiceTracks, duration, options) -> gain curve (see mix.js)
//
// Pass the voice tracks after clean-up (denoise.js): on a raw track, noise
// that swells and fades can read as talking and hold the music down.
//
// Voice tracks use the mix.js track shape, so the same objects handed to
// mixTracks() (mic, voiceovers) can be passed here; the curve comes back in
// output time, ready to be the music track's `gain`.
//
// How it behaves: music sits at full volume, dips by `amountDb` shortly
// BEFORE someone starts talking (the curve looks ahead by the attack time, so
// the first word is never buried), stays down through short pauses (`hold`),
// and comes back up slowly (`release`) once the talking stops. Ramps are
// linear in decibels, which is how a person on a mixing desk would move it.

const FRAME_SECONDS = 0.02;

// Voice activity from short-term level. The threshold adapts to the track:
// 10 dB over its noise floor (the quiet end of its level distribution), but
// never above "clearly loud" for this track and never below `minDb`, so a
// silent or cleaned-up track doesn't flag its own hiss as speech.
export function voiceActivity(channels, sampleRate, { minDb = -45, marginDb = 10 } = {}) {
  const frame = Math.max(1, Math.round(FRAME_SECONDS * sampleRate));
  const n = channels[0].length;
  const frames = Math.floor(n / frame);
  const levels = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    const start = f * frame;
    for (const c of channels) {
      for (let i = start; i < start + frame; i++) acc += c[i] * c[i];
    }
    const ms = acc / (frame * channels.length);
    levels[f] = ms > 1e-12 ? 10 * Math.log10(ms) : -120;
  }
  const sorted = Float32Array.from(levels).sort();
  const pct = (p) => (frames ? sorted[Math.min(frames - 1, Math.floor(p * (frames - 1)))] : -120);
  const threshold = Math.max(minDb, Math.min(pct(0.1) + marginDb, pct(0.95) - 3));
  const active = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) active[f] = levels[f] > threshold ? 1 : 0;
  return { rate: 1 / FRAME_SECONDS, active, threshold };
}

export function duckingCurve(voiceTracks, duration, {
  amountDb = -12, attack = 0.2, release = 0.8, hold = 0.5, rate = 100
} = {}) {
  const steps = Math.max(1, Math.ceil(duration * rate) + 1);
  const talking = new Uint8Array(steps);
  for (const t of voiceTracks) {
    if (!t || t.muted || t.volume === 0) continue;
    const r = t.sampleRate;
    const from = Math.max(0, Math.round((t.offset ?? 0) * r));
    const to = t.duration === undefined
      ? t.channels[0].length
      : Math.min(t.channels[0].length, from + Math.round(t.duration * r));
    if (to <= from) continue;
    const va = voiceActivity(t.channels.map((c) => c.subarray(from, to)), r);
    const start = t.startOffset ?? 0;
    for (let f = 0; f < va.active.length; f++) {
      if (!va.active[f]) continue;
      // Mark every curve step this 20 ms frame overlaps.
      const s0 = Math.floor((start + f / va.rate) * rate);
      const s1 = Math.ceil((start + (f + 1) / va.rate) * rate);
      for (let s = Math.max(0, s0); s <= Math.min(steps - 1, s1); s++) talking[s] = 1;
    }
  }

  // Widen each talking stretch: `hold` after (bridges pauses between words)
  // and `attack` before (the lookahead, so the dip is complete on time).
  const holdSteps = Math.round(hold * rate);
  const leadSteps = Math.round(attack * rate);
  const wanted = new Uint8Array(steps);
  let lastOn = -Infinity;
  for (let s = 0; s < steps; s++) {
    if (talking[s]) lastOn = s;
    if (s - lastOn <= holdSteps) wanted[s] = 1;
  }
  let nextOn = Infinity;
  for (let s = steps - 1; s >= 0; s--) {
    if (talking[s]) nextOn = s;
    if (nextOn - s <= leadSteps) wanted[s] = 1;
  }

  // Slew-limited in dB: down at |amount|/attack per second, up at
  // |amount|/release per second.
  const depth = Math.abs(amountDb);
  const down = depth / Math.max(1e-3, attack) / rate;
  const up = depth / Math.max(1e-3, release) / rate;
  const values = new Float32Array(steps);
  let db = wanted[0] ? -depth : 0;
  for (let s = 0; s < steps; s++) {
    const target = wanted[s] ? -depth : 0;
    if (db > target) db = Math.max(target, db - down);
    else if (db < target) db = Math.min(target, db + up);
    values[s] = Math.pow(10, db / 20);
  }
  return { rate, start: 0, values };
}
