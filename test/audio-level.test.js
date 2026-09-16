'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { performance } = require('node:perf_hooks');
const {
  measureLoudness, level, kWeightingCoefficients, VOICE_TARGET_LUFS
} = require('../src/core/audio/level.js');
const { dbToGain, peak } = require('../src/core/audio/util.js');
const { sine, speechLike, whiteNoise, macVoice, correlation } = require('./audio-fixtures');

const SR = 48000;

function stereoSine(seconds, dbfs, sr = SR, freq = 997) {
  const a = dbToGain(dbfs);
  return [sine(seconds * sr, sr, freq, a), sine(seconds * sr, sr, freq, a)];
}

function concat(...parts) {
  return parts[0].map((_, c) => {
    const out = new Float32Array(parts.reduce((n, p) => n + p[c].length, 0));
    let at = 0;
    for (const p of parts) { out.set(p[c], at); at += p[c].length; }
    return out;
  });
}

const scaled = (channels, db) => channels.map((c) => c.map((v) => v * dbToGain(db)));

test('K-weighting at 48 kHz reproduces the coefficients published in BS.1770', () => {
  const { shelf, highpass } = kWeightingCoefficients(48000);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} vs ${b}`);
  close(shelf.b[0], 1.53512485958697);
  close(shelf.b[1], -2.69169618940638);
  close(shelf.b[2], 1.19839281085285);
  close(shelf.a[1], -1.69065929318241);
  close(shelf.a[2], 0.73248077421585);
  close(highpass.a[1], -1.99004745483398);
  close(highpass.a[2], 0.99007225036621);
});

test('EBU Tech 3341 cases: stereo 1 kHz sine at -23 and -33 dBFS', () => {
  assert.ok(Math.abs(measureLoudness(stereoSine(20, -23), SR).integrated + 23) < 0.1);
  assert.ok(Math.abs(measureLoudness(stereoSine(20, -33), SR).integrated + 33) < 0.1);
});

test('EBU Tech 3341 gating case: -36 / -23 / -36 dBFS reads -23 LUFS', () => {
  const x = concat(stereoSine(10, -36), stereoSine(60, -23), stereoSine(10, -36));
  const l = measureLoudness(x, SR).integrated;
  assert.ok(Math.abs(l + 23) < 0.1, `got ${l}`);
});

test('absolute gate: silence around the tone is ignored', () => {
  const silence = [new Float32Array(SR * 10), new Float32Array(SR * 10)];
  const x = concat(silence, stereoSine(10, -23), silence);
  // Blocks straddling the edges are partly silent and a couple pass the
  // relative gate, hence a slightly wider tolerance than the steady cases.
  const l = measureLoudness(x, SR).integrated;
  assert.ok(Math.abs(l + 23) < 0.2, `got ${l}`);
});

test('loudness is rate independent (44.1 kHz) and silence is -Infinity', () => {
  const l = measureLoudness(stereoSine(10, -23, 44100), 44100).integrated;
  assert.ok(Math.abs(l + 23) < 0.1, `got ${l}`);
  assert.strictEqual(measureLoudness([new Float32Array(SR)], SR).integrated, -Infinity);
  assert.strictEqual(measureLoudness([new Float32Array(100)], SR).integrated, -Infinity);
});

test('levelling hits -16 LUFS within 1 LU for quiet and loud voice, peaks under -1 dBFS', (t) => {
  const base = speechLike(30, SR, { amplitude: 0.5, seed: 12 });
  const baseL = measureLoudness([base], SR).integrated;
  for (const want of [-38, -28, -16, -8]) {
    const input = [base.map((v) => v * dbToGain(want - baseL))];
    // A loud take really does clip-level peaks; let it.
    const inL = measureLoudness(input, SR).integrated;
    const t0 = performance.now();
    const res = level(input, SR);
    const ms = performance.now() - t0;
    const p = peak(res.channels);
    t.diagnostic(`input ${inL.toFixed(1)} LUFS (peak ${(20 * Math.log10(peak(input))).toFixed(1)} dBFS) -> `
      + `${res.outputLoudness.toFixed(2)} LUFS, peak ${(20 * Math.log10(p)).toFixed(2)} dBFS, gain ${res.gainDb.toFixed(1)} dB; `
      + `${((30 * 1000) / ms).toFixed(0)}x realtime`);
    assert.ok(Math.abs(res.outputLoudness - VOICE_TARGET_LUFS) <= 1, `output ${res.outputLoudness}`);
    // Independent re-measurement agrees with what level() reported.
    assert.ok(Math.abs(measureLoudness(res.channels, SR).integrated - res.outputLoudness) < 1e-9);
    assert.ok(p <= dbToGain(-1) + 1e-6, `peak ${p}`);
    assert.ok(correlation(input[0], res.channels[0]) > 0.95, 'still the same voice');
  }
});

test('levelling real speech (macOS say), stereo, quiet and loud', (t) => {
  const voice = macVoice('Welcome back. In this video I will show you how to set up a project, invite your team, and publish your first page.');
  if (!voice) { t.skip('say/afconvert not available'); return; }
  const mono = voice.channels[0];
  const stereo = [mono, new Float32Array(mono)];
  for (const db of [-22, +8]) {
    const input = scaled(stereo, db);
    const res = level(input, SR);
    t.diagnostic(`say voice ${res.inputLoudness.toFixed(1)} LUFS -> ${res.outputLoudness.toFixed(2)} LUFS, peak ${(20 * Math.log10(peak(res.channels))).toFixed(2)} dBFS`);
    assert.ok(Math.abs(res.outputLoudness - -16) <= 1);
    assert.ok(peak(res.channels) <= dbToGain(-1) + 1e-6);
  }
});

test('custom target, and a noisy-but-steady signal', () => {
  const x = [whiteNoise(SR * 10, 0.05, 3)];
  const res = level(x, SR, { target: -23 });
  assert.ok(Math.abs(res.outputLoudness + 23) <= 1);
});

test('silence stays silent; very quiet input is not raised past maxGainDb', () => {
  const silent = level([new Float32Array(SR * 2)], SR);
  assert.strictEqual(silent.gainDb, 0);
  assert.ok(silent.channels[0].every((v) => v === 0));
  const whisper = [speechLike(10, SR, { amplitude: 0.0005 })];
  const res = level(whisper, SR, { maxGainDb: 20 });
  assert.ok(res.gainDb <= 20);
  assert.ok(res.outputLoudness < -30);
});

test('streamed K-weighting gives the same loudness as filtering whole copies', () => {
  // Reference: the textbook form, each biquad run over the whole track.
  const biquad = (x, { b, a }) => {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      y[i] = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = y[i];
    }
    return y;
  };
  for (const sr of [48000, 44100]) {
    const ch = [speechLike(6, sr, { seed: 9 }), whiteNoise(6 * sr, 0.05, 2)];
    const { shelf, highpass } = kWeightingCoefficients(sr);
    const hop = Math.round(0.1 * sr);
    const k = ch.map((c) => biquad(biquad(c, shelf), highpass));
    const blocks = Math.floor((ch[0].length - 4 * hop) / hop) + 1;
    const powers = [];
    for (let j = 0; j < blocks; j++) {
      let acc = 0;
      for (const kc of k) for (let i = j * hop; i < j * hop + 4 * hop; i++) acc += kc[i] * kc[i];
      powers.push(acc / Math.round(0.4 * sr));
    }
    const lufs = (p) => -0.691 + 10 * Math.log10(p);
    const abs = powers.filter((p) => lufs(p) > -70);
    const rel = lufs(abs.reduce((s, p) => s + p, 0) / abs.length) - 10;
    const kept = abs.filter((p) => lufs(p) > rel);
    const expected = lufs(kept.reduce((s, p) => s + p, 0) / kept.length);
    const got = measureLoudness(ch, sr).integrated;
    assert.ok(Math.abs(got - expected) < 1e-6, `${sr}: ${got} vs ${expected}`);
  }
});
