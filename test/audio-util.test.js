'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  resample, fft, limit, slidingMin, dbToGain, gainToDb, peak
} = require('../src/core/audio/util.js');
const { sine, whiteNoise, rmsDb } = require('./audio-fixtures');

test('dB helpers round-trip', () => {
  assert.ok(Math.abs(dbToGain(-6.0206) - 0.5) < 1e-4);
  assert.ok(Math.abs(gainToDb(0.5) + 6.0206) < 1e-3);
  assert.strictEqual(gainToDb(0), -Infinity);
});

test('resample 44.1 -> 48 kHz: length exact, a 1 kHz sine stays clean', () => {
  const x = sine(44100, 44100, 1000, 0.5);
  const y = resample(x, 44100, 48000);
  assert.strictEqual(y.length, 48000);
  const ref = sine(48000, 48000, 1000, 0.5);
  // Ignore the filter's edge region at each end.
  let err = 0;
  let sig = 0;
  for (let i = 1000; i < 47000; i++) { err += (y[i] - ref[i]) ** 2; sig += ref[i] ** 2; }
  const snr = 10 * Math.log10(sig / err);
  assert.ok(snr > 60, `resampling SNR ${snr.toFixed(1)} dB`);
});

test('resample keeps time: an impulse at 1 s stays at 1 s', () => {
  const x = new Float32Array(44100 * 2);
  x[44100] = 1;
  const y = resample(x, 44100, 48000);
  let best = 0;
  for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[best])) best = i;
  assert.strictEqual(best, 48000);
});

test('resample down 48 -> 16 kHz removes content above the new Nyquist', () => {
  const hi = sine(48000, 48000, 12000, 0.5); // above 8 kHz: must not alias down
  const lo = sine(48000, 48000, 1000, 0.5);
  const yHi = resample(hi, 48000, 16000);
  const yLo = resample(lo, 48000, 16000);
  assert.strictEqual(yHi.length, 16000);
  const hiDb = rmsDb(yHi, 500, 15500);
  const loDb = rmsDb(yLo, 500, 15500);
  assert.ok(loDb - hiDb > 40, `stop-band ${(loDb - hiDb).toFixed(1)} dB`);
  assert.ok(Math.abs(loDb - rmsDb(lo)) < 0.1, 'passband level kept');
});

test('resample at equal rates copies', () => {
  const x = whiteNoise(100, 0.5);
  const y = resample(x, 48000, 48000);
  assert.deepStrictEqual(y, x);
  assert.notStrictEqual(y, x);
});

test('fft then inverse fft recovers the signal; a bin-centred sine lands in its bin', () => {
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 37 * i) / n);
  const orig = Float64Array.from(re);
  fft(re, im);
  const mag = (k) => Math.hypot(re[k], im[k]);
  assert.ok(Math.abs(mag(37) - n / 2) < 1e-6);
  assert.ok(mag(36) < 1e-6 && mag(38) < 1e-6);
  fft(re, im, true);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-9);
  assert.throws(() => fft(new Float64Array(100), new Float64Array(100)));
});

test('slidingMin matches a brute-force minimum', () => {
  const v = whiteNoise(500, 1, 4);
  const L = 7;
  const got = slidingMin(v, L);
  for (let i = 0; i < v.length; i++) {
    let m = Infinity;
    for (let j = Math.max(0, i - L); j <= Math.min(v.length - 1, i + L); j++) m = Math.min(m, v[j]);
    assert.strictEqual(got[i], m);
  }
});

test('limiter: holds the ceiling, leaves quiet material bit-exact', () => {
  const sr = 48000;
  const quiet = [sine(sr, sr, 440, 0.5)];
  const q = limit(quiet, sr, { ceilingDb: -1 });
  assert.strictEqual(q.reductionDb, 0);
  assert.deepStrictEqual(q.channels[0], quiet[0]);

  // Bursts well over the ceiling on top of a moderate signal.
  const loud = [sine(sr, sr, 440, 0.5), sine(sr, sr, 660, 0.5)];
  for (let i = 20000; i < 20500; i++) { loud[0][i] *= 3; loud[1][i] *= 2.5; }
  const out = limit(loud, sr, { ceilingDb: -1 });
  const ceiling = dbToGain(-1);
  assert.ok(peak(out.channels) <= ceiling + 1e-6, `peak ${peak(out.channels)}`);
  assert.ok(out.reductionDb > 4, `reduction ${out.reductionDb}`); // 1.5 peak -> -1 dBFS is 4.5 dB
  // Far from the burst, the signal is untouched (gain back to ~1).
  assert.ok(Math.abs(out.channels[0][5000] - loud[0][5000]) < 1e-6);
  assert.ok(Math.abs(out.channels[0][45000] - loud[0][45000]) < 1e-3);
});

test('slidingMin: ring-buffer deque matches brute force for tiny and window-wider-than-input L', () => {
  for (const [len, L] of [[300, 1], [300, 3], [50, 600], [1, 5], [1000, 128]]) {
    const v = whiteNoise(len, 1, len + L);
    const got = slidingMin(v, L);
    for (let i = 0; i < len; i++) {
      let m = Infinity;
      for (let j = Math.max(0, i - L); j <= Math.min(len - 1, i + L); j++) m = Math.min(m, v[j]);
      assert.strictEqual(got[i], m, `len ${len} L ${L} i ${i}`);
    }
  }
});

test('limiter: inPlace scales the given arrays and matches the copying result', () => {
  const sr = 48000;
  // Dense overs everywhere, long enough for the running sum to be exercised.
  const make = () => [whiteNoise(sr * 20, 1.8, 5), whiteNoise(sr * 20, 1.2, 6)];
  const copy = limit(make(), sr, { ceilingDb: -1 });
  const input = make();
  const inPlace = limit(input, sr, { ceilingDb: -1, inPlace: true });
  assert.strictEqual(inPlace.channels[0], input[0], 'same array back');
  assert.deepStrictEqual(inPlace.channels, copy.channels);
  assert.strictEqual(inPlace.reductionDb, copy.reductionDb);
  assert.ok(peak(inPlace.channels) <= dbToGain(-1) + 1e-6, `peak ${peak(inPlace.channels)}`);
  // Nothing over the ceiling: inPlace leaves the arrays untouched.
  const quiet = [sine(sr, sr, 440, 0.5)];
  const before = Float32Array.from(quiet[0]);
  const q = limit(quiet, sr, { inPlace: true });
  assert.strictEqual(q.channels[0], quiet[0]);
  assert.deepStrictEqual(quiet[0], before);
});
