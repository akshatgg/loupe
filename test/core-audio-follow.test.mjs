import test from 'node:test';
import assert from 'node:assert';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import { stretch, windowSizeFor } from '../src/core/audio/wsola.js';
import { audioRuns, runTimeMap, followPlan } from '../src/core/audio/follow.js';
import { mixTracks } from '../src/core/audio/mix.js';

const SR = 48000;
const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} !== ${b} (±${eps})`);

function sine(seconds, freq, amp = 0.5, rate = SR) {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function rms(x, a = 0, b = x.length) {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

// Frequency from rising zero crossings, interpolated between samples.
function frequency(x, a, b, rate = SR) {
  const ups = [];
  for (let i = Math.max(1, a); i < b; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) ups.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  }
  return ((ups.length - 1) * rate) / (ups.at(-1) - ups[0]);
}

test('window size is ~21ms whatever the sample rate', () => {
  assert.strictEqual(windowSizeFor(48000), 1024);
  assert.strictEqual(windowSizeFor(44100), 1024);
  assert.strictEqual(windowSizeFor(96000), 2048);
  assert.strictEqual(windowSizeFor(16000), 256);
});

test('at 1x the sound comes through unchanged', () => {
  const x = sine(1, 440);
  const [y] = stretch([x], SR, (o) => o, x.length);
  let worst = 0;
  // The first half-window only has one Hann window over it.
  for (let i = 512; i < x.length - 1024; i++) worst = Math.max(worst, Math.abs(y[i] - x[i]));
  assert.ok(worst < 1e-5, `max difference ${worst}`);
});

test('2x keeps the pitch and the loudness, in half the time', () => {
  const x = sine(4, 440);
  const [y] = stretch([x], SR, (o) => o * 2, 2 * SR);
  assert.strictEqual(y.length, 2 * SR);
  near(frequency(y, 4800, y.length - 4800), 440, 2, 'frequency');
  near(rms(y, 4800, y.length - 4800), rms(x), 0.03, 'rms');
});

test('0.5x keeps the pitch too', () => {
  const x = sine(2, 300);
  const [y] = stretch([x], SR, (o) => o * 0.5, 4 * SR);
  near(frequency(y, 4800, y.length - 4800), 300, 2, 'frequency');
  near(rms(y, 4800, y.length - 4800), rms(x), 0.03, 'rms');
});

test('without pitch keeping, 2x is tape speed: an octave up', () => {
  const x = sine(2, 440);
  const [y] = stretch([x], SR, (o) => o * 2, SR, { preservePitch: false });
  near(frequency(y, 1000, y.length - 1000), 880, 2, 'frequency');
});

test('stereo channels are stretched together', () => {
  const l = sine(2, 440);
  const r = sine(2, 440, 0.25);
  const [a, b] = stretch([l, r], SR, (o) => o * 2, SR);
  for (let i = 2000; i < SR - 2000; i += 997) near(b[i], a[i] / 2, 1e-5, `sample ${i}`);
});

test('a speed ramp is one run; a cut or a reordered clip starts a new one', () => {
  let p = P.createProject({ main: { width: 100, height: 100, duration: 10, mic: true } });
  p = P.paintSpeed(p, { start: 2, end: 6, rate: 2 });
  const plan = buildTimeline(p).audioPlan();
  assert.ok(plan.length > 3, 'ramps come as several slices');
  const runs = audioRuns(plan);
  assert.strictEqual(runs.length, 1);
  near(runs[0].outEnd, buildTimeline(p).duration, 1e-6);

  const map = runTimeMap(runs[0]);
  const tl = buildTimeline(p);
  for (const o of [0.5, 2.1, 3, 4.05, 7]) near(map(o), tl.toSource(o).t, 1e-3, `at ${o}`);

  p = P.cutRange(p, 7, 7.5);
  p = P.moveClip(p, 1, 0);
  const cutRuns = audioRuns(buildTimeline(p).audioPlan());
  assert.strictEqual(cutRuns.length, 2);
  assert.ok(cutRuns[0].slices[0].srcStart > 6);
});

test('followPlan lays the stretched sound on the output timeline, fading only at jumps', () => {
  let p = P.createProject({ main: { width: 100, height: 100, duration: 6, mic: true } });
  p = P.cutRange(p, 2, 3);
  const tl = buildTimeline(p);
  const audio = { main: { channels: [sine(6, 440)], sampleRate: SR } };
  const tracks = followPlan(tl.audioPlan(), audio, { track: { volume: 0.5 } });
  assert.strictEqual(tracks.length, 2);
  assert.strictEqual(tracks[0].startOffset, 0);
  assert.strictEqual(tracks[1].startOffset, 2);
  assert.strictEqual(tracks[0].volume, 0.5);
  // Sample-exact seam: the second run starts where the first ends.
  assert.strictEqual(tracks[0].channels[0].length, 2 * SR);
  assert.strictEqual(tracks[1].channels[0].length, 3 * SR);
  // The recording's own start isn't a jump; the cut is.
  assert.ok(Math.abs(tracks[1].channels[0][0]) < 1e-6);
  assert.ok(Math.abs(tracks[0].channels[0].at(-1)) < 1e-6);

  const mix = mixTracks(tracks, { sampleRate: SR, duration: tl.duration });
  assert.strictEqual(mix.channels[0].length, 5 * SR);
  near(rms(mix.channels[0], SR / 2, SR), 0.5 * rms(audio.main.channels[0]), 0.01, 'rms');
  // After the cut, the output plays recording time 3.. at output 2..
  const src = audio.main.channels[0];
  for (const o of [2.5, 3.25, 4.75]) {
    const i = Math.round(o * SR);
    near(mix.channels[1][i], 0.5 * src[i + SR], 1e-4, `sample at ${o}`);
  }
});

test('a source with no decoded sound is silent', () => {
  const p = P.createProject({ main: { width: 100, height: 100, duration: 3 } });
  assert.deepStrictEqual(followPlan(buildTimeline(p).audioPlan(), {}), []);
});
