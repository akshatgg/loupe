'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { performance } = require('node:perf_hooks');
const {
  denoise, denoiseWithInfo, spectralGate, RNNOISE_DELAY
} = require('../src/core/audio/denoise.js');
const { loadRnnoise, RNNOISE_FRAME } = require('../src/core/audio/rnnoise.js');
const {
  whiteNoise, sine, speechLike, snrDb, correlation, rmsDb, macVoice
} = require('./audio-fixtures');

const SR = 48000;

// Tone bursts (on half a second, off half a second) in white noise at about
// 0 dB SNR -- the gaps are what a gate learns the noise from.
function toneInNoise(seconds, sampleRate) {
  const n = seconds * sampleRate;
  const clean = sine(n, sampleRate, 440, 0.3);
  for (let i = 0; i < n; i++) if (Math.floor((i / sampleRate) * 2) % 2) clean[i] = 0;
  const noise = whiteNoise(n, 0.35, 11);
  const noisy = clean.map((v, i) => v + noise[i]);
  return { clean, noisy };
}

function realtime(seconds, ms) {
  return (seconds * 1000) / ms;
}

test('the vendored RNNoise loads and processes 480-sample frames', async () => {
  const rn = await loadRnnoise();
  const st = rn.createState();
  const frame = whiteNoise(RNNOISE_FRAME, 0.1, 5);
  const vad = st.process(frame);
  assert.ok(vad >= 0 && vad <= 1, `voice probability in [0,1], got ${vad}`);
  assert.ok(frame.every(Number.isFinite));
  st.destroy();
  assert.throws(() => st.process(frame));
});

test('RNNOISE_DELAY matches the model: output lines up with the input', async () => {
  // Process a clean voice-like signal with no compensation and find the lag
  // with the highest correlation.
  const rn = await loadRnnoise();
  const st = rn.createState();
  const x = speechLike(3, SR, { seed: 9 });
  const y = new Float32Array(x.length);
  const f = new Float32Array(RNNOISE_FRAME);
  for (let i = 0; i + RNNOISE_FRAME <= x.length; i += RNNOISE_FRAME) {
    f.set(x.subarray(i, i + RNNOISE_FRAME));
    st.process(f);
    y.set(f, i);
  }
  st.destroy();
  let best = -1;
  let bestLag = 0;
  for (let lag = 0; lag <= 1500; lag += 1) {
    const c = correlation(x.subarray(0, x.length - 2000), y.subarray(lag, lag + x.length - 2000));
    if (c > best) { best = c; bestLag = lag; }
  }
  // The peak can fall between two samples; either neighbour is a match.
  assert.ok(Math.abs(bestLag - RNNOISE_DELAY) <= 1, `best lag ${bestLag}`);
});

test('spectral gate: improves SNR of a tone in noise by a wide margin', (t) => {
  const { clean, noisy } = toneInNoise(10, SR);
  const t0 = performance.now();
  const [out] = spectralGate([noisy], SR, { strength: 1 });
  const ms = performance.now() - t0;
  const before = snrDb(clean, noisy);
  const after = snrDb(clean, out);
  t.diagnostic(`spectral gate: SNR ${before.toFixed(1)} -> ${after.toFixed(1)} dB; ${realtime(10, ms).toFixed(0)}x realtime (mono 48 kHz)`);
  assert.strictEqual(out.length, noisy.length);
  assert.ok(after - before >= 12, `SNR gain ${(after - before).toFixed(1)} dB`);
});

test('RNNoise: improves SNR of a tone in noise', async (t) => {
  const { clean, noisy } = toneInNoise(10, SR);
  const t0 = performance.now();
  const { channels: [out], engine } = await denoiseWithInfo([noisy], SR, { engine: 'rnnoise' });
  const ms = performance.now() - t0;
  const before = snrDb(clean, noisy);
  const after = snrDb(clean, out);
  t.diagnostic(`rnnoise (tone): SNR ${before.toFixed(1)} -> ${after.toFixed(1)} dB; ${realtime(10, ms).toFixed(0)}x realtime (mono 48 kHz)`);
  assert.strictEqual(engine, 'rnnoise');
  assert.ok(after - before >= 5, `SNR gain ${(after - before).toFixed(1)} dB`);
});

test('both engines keep a speech-like signal intact and remove the noise around it', async (t) => {
  const clean = speechLike(10, SR, { amplitude: 0.4 });
  const noise = whiteNoise(clean.length, 0.03, 21);
  const noisy = clean.map((v, i) => v + noise[i]);
  for (const engine of ['rnnoise', 'spectral']) {
    const [out] = await denoise([noisy], SR, { engine });
    const before = snrDb(clean, noisy);
    const after = snrDb(clean, out);
    const corr = correlation(clean, out);
    t.diagnostic(`${engine} (speech-like): SNR ${before.toFixed(1)} -> ${after.toFixed(1)} dB, correlation with clean ${corr.toFixed(3)}`);
    assert.ok(after > before + 3, `${engine}: SNR gain ${(after - before).toFixed(1)} dB`);
    assert.ok(corr > 0.9, `${engine}: correlation ${corr.toFixed(3)}`);
  }
});

test('real voice (macOS say): noise removed, voice kept', async (t) => {
  const voice = macVoice('Hi! This is a quick demo of the editor. Press record, talk through what you are doing, and Loupe zooms in on the part that matters.');
  if (!voice) { t.skip('say/afconvert not available'); return; }
  const clean = voice.channels[0];
  const seconds = clean.length / SR;
  const noise = whiteNoise(clean.length, 0.04, 33);
  // A steady low hum as well, like a fan or a laptop's own noise.
  const hum = sine(clean.length, SR, 120, 0.02);
  const noisy = clean.map((v, i) => v + noise[i] + hum[i]);
  const before = snrDb(clean, noisy);

  // Speech-active stretches, for "the voice is still there" checks.
  const frame = SR / 50;
  const active = [];
  for (let s = 0; s + frame <= clean.length; s += frame) {
    if (rmsDb(clean, s, s + frame) > -30) active.push(s);
  }
  assert.ok(active.length > 50, 'the test voice has speech in it');

  for (const engine of ['rnnoise', 'spectral']) {
    const t0 = performance.now();
    const [out] = await denoise([noisy], SR, { engine });
    const ms = performance.now() - t0;
    const after = snrDb(clean, out);
    const corr = correlation(clean, out);
    let cleanE = 0;
    let outE = 0;
    let noiseBefore = 0;
    let noiseAfter = 0;
    let quiet = 0;
    for (let s = 0; s + frame <= clean.length; s += frame) {
      if (active.includes(s)) {
        for (let i = s; i < s + frame; i++) { cleanE += clean[i] ** 2; outE += out[i] ** 2; }
      } else if (rmsDb(clean, s, s + frame) < -60) {
        for (let i = s; i < s + frame; i++) { noiseBefore += noisy[i] ** 2; noiseAfter += out[i] ** 2; }
        quiet++;
      }
    }
    const speechKeptDb = 10 * Math.log10(outE / cleanE);
    const noiseDropDb = quiet ? 10 * Math.log10(noiseBefore / noiseAfter) : NaN;
    t.diagnostic(`${engine} (real voice, ${seconds.toFixed(1)} s): SNR ${before.toFixed(1)} -> ${after.toFixed(1)} dB, `
      + `correlation ${corr.toFixed(3)}, speech level ${speechKeptDb.toFixed(1)} dB, noise in pauses -${noiseDropDb.toFixed(1)} dB, `
      + `${realtime(seconds, ms).toFixed(0)}x realtime`);
    // SNR also counts any change to the voice's own tone as "noise", which
    // is why its gain is modest next to the drop in the pauses.
    assert.ok(after > before + 3, `${engine}: SNR gain ${(after - before).toFixed(1)} dB`);
    assert.ok(corr > 0.9, `${engine}: correlation ${corr.toFixed(3)}`);
    assert.ok(speechKeptDb > -3, `${engine}: speech level changed by ${speechKeptDb.toFixed(1)} dB`);
    assert.ok(noiseDropDb > 20, `${engine}: noise in pauses only down ${noiseDropDb.toFixed(1)} dB`);
  }
});

test('non-48 kHz input is resampled for RNNoise and comes back at its own rate and length', async () => {
  const sr = 44100;
  const clean = speechLike(4, sr, { amplitude: 0.4, seed: 4 });
  const noise = whiteNoise(clean.length, 0.03, 8);
  const noisy = clean.map((v, i) => v + noise[i]);
  const [out] = await denoise([noisy], sr, { engine: 'rnnoise' });
  assert.strictEqual(out.length, noisy.length);
  assert.ok(correlation(clean, out) > 0.9);
  assert.ok(snrDb(clean, out) > snrDb(clean, noisy) + 3);
});

test('stereo: every channel processed, lengths kept', async () => {
  const l = speechLike(2, SR, { seed: 1 });
  const r = speechLike(2, SR, { seed: 2 });
  for (const engine of ['rnnoise', 'spectral']) {
    const out = await denoise([l, r], SR, { engine });
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].length, l.length);
    assert.ok(correlation(l, out[0]) > 0.9 && correlation(r, out[1]) > 0.9, engine);
  }
});

test('strength scales the effect; 0 returns the input unchanged', async () => {
  const { clean, noisy } = toneInNoise(4, SR);
  const zero = await denoiseWithInfo([noisy], SR, { strength: 0 });
  assert.strictEqual(zero.engine, 'none');
  assert.deepStrictEqual(zero.channels[0], noisy);
  assert.notStrictEqual(zero.channels[0], noisy, 'a copy, not the input array');
  for (const engine of ['rnnoise', 'spectral']) {
    const [half] = await denoise([noisy], SR, { engine, strength: 0.4 });
    const [full] = await denoise([noisy], SR, { engine, strength: 1 });
    const s0 = snrDb(clean, noisy);
    const sh = snrDb(clean, half);
    const sf = snrDb(clean, full);
    assert.ok(s0 < sh && sh < sf, `${engine}: ${s0.toFixed(1)} < ${sh.toFixed(1)} < ${sf.toFixed(1)}`);
  }
});

test('auto falls back to the spectral gate when the wasm cannot load', async () => {
  const { noisy } = toneInNoise(2, SR);
  const res = await denoiseWithInfo([noisy], SR, { wasm: new Uint8Array([0, 1, 2, 3]) });
  assert.strictEqual(res.engine, 'spectral');
  await assert.rejects(denoise([noisy], SR, { engine: 'rnnoise', wasm: new Uint8Array([0, 1, 2, 3]) }));
});

test('does not modify its input and rejects bad arguments', async () => {
  const x = whiteNoise(SR, 0.1, 2);
  const copy = new Float32Array(x);
  await denoise([x], SR);
  spectralGate([x], SR);
  assert.deepStrictEqual(x, copy);
  await assert.rejects(denoise([], SR));
  await assert.rejects(denoise([x], 0));
  await assert.rejects(denoise([x, new Float32Array(3)], SR));
});

test('very short input passes through safely', async () => {
  const x = whiteNoise(100, 0.1, 2);
  assert.strictEqual(spectralGate([x], SR)[0].length, 100);
  assert.strictEqual((await denoise([x], SR))[0].length, 100);
});
