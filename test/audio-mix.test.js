'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { performance } = require('node:perf_hooks');
const { mixTracks, gainAt, MIX_RATE } = require('../src/core/audio/mix.js');
const { duckingCurve, voiceActivity } = require('../src/core/audio/duck.js');
const { dbToGain, peak } = require('../src/core/audio/util.js');
const { whiteNoise, sine, speechLike, rmsDb } = require('./audio-fixtures');

const SR = MIX_RATE;

test('gainAt interpolates and holds its ends', () => {
  const c = { rate: 10, start: 1, values: new Float32Array([0, 1, 0.5]) };
  assert.strictEqual(gainAt(null, 3), 1);
  assert.strictEqual(gainAt(c, 0), 0);
  assert.strictEqual(gainAt(c, 1), 0);
  assert.ok(Math.abs(gainAt(c, 1.05) - 0.5) < 1e-9);
  assert.ok(Math.abs(gainAt(c, 1.1) - 1) < 1e-9);
  assert.ok(Math.abs(gainAt(c, 1.15) - 0.75) < 1e-6);
  assert.strictEqual(gainAt(c, 9), 0.5);
});

test('placement is sample-exact: startOffset and offset land on the right samples', () => {
  const click = new Float32Array(SR);
  click[0] = 0.5;
  click[100] = -0.25;
  const { channels: [L, R] } = mixTracks([
    { channels: [click], sampleRate: SR, startOffset: 1.0 },
    // Start 100 samples in: its -0.25 is its first sample, placed at 2.5 s.
    { channels: [click], sampleRate: SR, startOffset: 2.5, offset: 100 / SR }
  ], { duration: 4 });
  assert.strictEqual(L.length, 4 * SR);
  const nonzero = [];
  for (let i = 0; i < L.length; i++) if (L[i] !== 0) nonzero.push([i, L[i]]);
  assert.deepStrictEqual(nonzero, [[48000, 0.5], [48100, -0.25], [120000, -0.25]]);
  assert.deepStrictEqual(R, L, 'mono goes to both sides');
});

test('sums are exact: output equals the arithmetic sum when nothing clips', () => {
  const a = [whiteNoise(SR, 0.2, 1), whiteNoise(SR, 0.2, 2)];
  const b = [whiteNoise(SR, 0.2, 3)];
  const { channels: [L, R], limited } = mixTracks([
    { channels: a, sampleRate: SR, volume: 0.5 },
    { channels: b, sampleRate: SR, startOffset: 0 }
  ]);
  assert.strictEqual(limited, false);
  for (let i = 0; i < SR; i++) {
    assert.strictEqual(L[i], Math.fround(Math.fround(a[0][i] * 0.5) + b[0][i]));
    assert.strictEqual(R[i], Math.fround(Math.fround(a[1][i] * 0.5) + b[0][i]));
  }
});

test('a 44.1 kHz track is resampled and still lands on time', () => {
  const x = new Float32Array(44100 * 2);
  x[44100] = 0.8; // 1.0 s into the track
  const { channels: [L] } = mixTracks([{ channels: [x], sampleRate: 44100, startOffset: 0.5 }]);
  assert.strictEqual(L.length, 2 * SR + SR / 2);
  let best = 0;
  for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > Math.abs(L[best])) best = i;
  assert.strictEqual(best, 1.5 * SR);
});

test('clipping protection: loud sums are limited to -1 dBFS; clip mode hard-clips', () => {
  const tone = [sine(SR * 2, SR, 220, 0.8)];
  const tracks = [
    { channels: tone, sampleRate: SR },
    { channels: tone, sampleRate: SR }
  ];
  const limited = mixTracks(tracks);
  assert.ok(limited.limited);
  assert.ok(limited.peak > 1.5);
  assert.ok(peak(limited.channels) <= dbToGain(-1) + 1e-6);
  const clipped = mixTracks(tracks, { protect: 'clip' });
  assert.strictEqual(peak(clipped.channels), 1);
  const raw = mixTracks(tracks, { protect: 'none' });
  assert.ok(peak(raw.channels) > 1.5);
});

test('duration cuts tracks; muted and zero-volume tracks are skipped; gain curves apply', () => {
  const one = new Float32Array(SR * 3).fill(0.1);
  const res = mixTracks([
    { channels: [one], sampleRate: SR },
    { channels: [one], sampleRate: SR, muted: true },
    { channels: [one], sampleRate: SR, volume: 0 }
  ], { duration: 2 });
  assert.strictEqual(res.channels[0].length, 2 * SR);
  assert.ok(Math.abs(res.channels[0][SR] - 0.1) < 1e-7);

  const ramp = { rate: 1, start: 0, values: new Float32Array([0, 1, 1]) };
  const r = mixTracks([{ channels: [one], sampleRate: SR, gain: ramp }], { duration: 2 });
  assert.strictEqual(r.channels[0][0], 0);
  assert.ok(Math.abs(r.channels[0][SR / 2] - 0.05) < 1e-6);
  assert.ok(Math.abs(r.channels[0][SR + 10] - 0.1) < 1e-6);

  assert.throws(() => mixTracks([{ channels: [one], sampleRate: SR, gain: { rate: 0, values: [] } }]));
  assert.throws(() => mixTracks([{ channels: [[0, 1]], sampleRate: SR }]));
  assert.deepStrictEqual(mixTracks([]).channels.map((c) => c.length), [0, 0]);
});

test('voice activity finds talking and ignores a quiet noise floor', () => {
  const n = SR * 6;
  const x = whiteNoise(n, 0.002, 7);
  const voice = speechLike(2, SR, { amplitude: 0.3 });
  for (let i = 0; i < voice.length; i++) x[2 * SR + i] += voice[i];
  const va = voiceActivity([x], SR);
  const activeIn = (a, b) => {
    let on = 0;
    for (let f = Math.round(a * va.rate); f < Math.round(b * va.rate); f++) on += va.active[f];
    return on / ((b - a) * va.rate);
  };
  assert.strictEqual(activeIn(0, 1.9), 0);
  assert.strictEqual(activeIn(4.1, 6), 0);
  assert.ok(activeIn(2, 4) > 0.5);
});

test('ducking: music goes down under the voice, before it starts, and comes back after', (t) => {
  const duration = 12;
  // Voice from 4 s to 7 s (a voiceover placed at 4 s in output time).
  const voice = speechLike(3, SR, { amplitude: 0.3, seed: 5 });
  const voiceTrack = { channels: [voice], sampleRate: SR, startOffset: 4 };
  const t0 = performance.now();
  const curve = duckingCurve([voiceTrack], duration, { amountDb: -12, attack: 0.2, hold: 0.5, release: 0.8 });
  const ms = performance.now() - t0;
  t.diagnostic(`ducking curve: ${((duration * 1000) / ms).toFixed(0)}x realtime`);

  const db = (s) => 20 * Math.log10(gainAt(curve, s));
  assert.ok(Math.abs(db(2)) < 1e-6, 'full volume well before');
  assert.ok(db(3.8) < 0 && db(3.8) > -12, 'dipping in the lookahead');
  assert.ok(Math.abs(db(4.0) + 12) < 0.01, 'fully down when the voice starts');
  assert.ok(Math.abs(db(5.5) + 12) < 0.01, 'down through the voice (and its short gaps)');
  const voiceEnd = 4 + 3;
  assert.ok(Math.abs(db(voiceEnd + 2.5)) < 1e-6, 'back to full volume after release');

  // End to end through the mixer: music level measured under and after the voice.
  const music = [sine(duration * SR, SR, 330, 0.2), sine(duration * SR, SR, 440, 0.2)];
  const mixed = mixTracks([{ channels: music, sampleRate: SR, gain: curve }], { duration }).channels[0];
  const under = rmsDb(mixed, 4.5 * SR, 6.5 * SR);
  const after = rmsDb(mixed, 10 * SR, 11.5 * SR);
  const before = rmsDb(mixed, 1 * SR, 3 * SR);
  t.diagnostic(`music level: before ${before.toFixed(1)} dB, under voice ${under.toFixed(1)} dB, after ${after.toFixed(1)} dB`);
  assert.ok(Math.abs(before - under - 12) < 0.2);
  assert.ok(Math.abs(after - before) < 0.1);
});

test('ducking with no voice leaves the music alone; muted voice tracks are ignored', () => {
  const quiet = { channels: [new Float32Array(SR * 5)], sampleRate: SR };
  const c = duckingCurve([quiet], 5);
  assert.ok(c.values.every((v) => v === 1));
  const loud = { channels: [speechLike(5, SR)], sampleRate: SR, muted: true };
  assert.ok(duckingCurve([loud], 5).values.every((v) => v === 1));
});

test('mix speed', (t) => {
  const seconds = 60;
  const tracks = [
    { channels: [speechLike(seconds, SR)], sampleRate: SR },
    { channels: [whiteNoise(seconds * 44100, 0.1), whiteNoise(seconds * 44100, 0.1, 2)], sampleRate: 44100,
      gain: { rate: 100, values: new Float32Array(seconds * 100).fill(0.5) } }
  ];
  const t0 = performance.now();
  mixTracks(tracks);
  const ms = performance.now() - t0;
  t.diagnostic(`mix (mono voice + stereo 44.1 kHz music with resampling and a gain curve): ${((seconds * 1000) / ms).toFixed(0)}x realtime`);
});

test('a volume that is not a number (hand-edited project) does not poison the mix', () => {
  const x = new Float32Array(SR).fill(0.25);
  for (const volume of ['0.5', NaN, null, Infinity, -2]) {
    const { channels: [L] } = mixTracks([{ channels: [x], sampleRate: SR, volume }]);
    assert.ok(L.every(Number.isFinite), `volume ${volume}`);
    assert.ok(peak([L]) <= 0.25 + 1e-9, `volume ${volume}`);
  }
});
