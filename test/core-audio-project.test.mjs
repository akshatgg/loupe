import test from 'node:test';
import assert from 'node:assert';
import { performance } from 'node:perf_hooks';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import { renderProjectAudio, createVoiceCache } from '../src/core/audio/project-audio.js';
import { measureLoudness, VOICE_TARGET_LUFS } from '../src/core/audio/level.js';
import fixtures from './audio-fixtures.js';

const { speechLike, whiteNoise, sine } = fixtures;
const SR = 48000;
const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} !== ${b} (±${eps})`);

// Amplitude of the `freq` component of x over [from, to) seconds (Hann window).
function amplitude(x, freq, from, to, rate = SR) {
  const a = Math.round(from * rate);
  const b = Math.round(to * rate);
  let re = 0;
  let im = 0;
  let wsum = 0;
  for (let i = a; i < b; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - a)) / (b - a));
    const ph = (2 * Math.PI * freq * i) / rate;
    re += x[i] * w * Math.cos(ph);
    im += x[i] * w * Math.sin(ph);
    wsum += w;
  }
  return (2 * Math.hypot(re, im)) / wsum;
}

const project = (duration = 6, extra = {}) =>
  P.createProject({ main: { width: 100, height: 100, duration, mic: true, systemAudio: 'system.m4a', ...extra } });
const mono = (samples) => ({ channels: [samples], sampleRate: SR });

test('nothing to hear gives no mix', async () => {
  const p = project();
  const { mix, pending } = await renderProjectAudio(p, buildTimeline(p), {});
  assert.strictEqual(mix, null);
  assert.strictEqual(pending, false);
});

test('mic, system audio, music and a voiceover all land in one mix at their volumes', async () => {
  let p = project(6);
  p = P.setAudio(p, {
    mic: { cleanUp: false, level: false, volume: 1 },
    system: { volume: 0.5 },
    music: { file: 'music/song.wav', volume: 0.3, duck: false },
    voiceover: [{ id: 'vo1', file: 'voiceover/Voiceover.webm', source: 'main', t: 2, volume: 1 }]
  });
  const tl = buildTimeline(p);
  const { mix } = await renderProjectAudio(p, tl, {
    mic: { main: mono(sine(6 * SR, SR, 440, 0.2)) },
    system: { main: mono(sine(6 * SR, SR, 660, 0.2)) },
    music: mono(sine(10 * SR, SR, 220, 0.5)),
    voiceover: { vo1: mono(sine(1 * SR, SR, 880, 0.3)) }
  });
  const L = mix.channels[0];
  assert.strictEqual(L.length, 6 * SR);
  near(amplitude(L, 440, 0.5, 1.5), 0.2, 0.01, 'mic');
  near(amplitude(L, 660, 0.5, 1.5), 0.1, 0.01, 'system at half');
  near(amplitude(L, 220, 0.5, 1.5), 0.15, 0.01, 'music at 0.3');
  near(amplitude(L, 880, 2.1, 2.9), 0.3, 0.01, 'voiceover while it plays');
  assert.ok(amplitude(L, 880, 0.2, 1.8) < 0.005, 'no voiceover before its moment');
  assert.ok(amplitude(L, 880, 3.2, 4) < 0.005, 'nor after it');
});

test('a voiceover follows its recording moment through a cut; music is ducked while anyone talks', async () => {
  let p = project(10);
  p = P.setAudio(p, {
    mic: { cleanUp: false, level: false },
    music: { file: 'music/song.wav', volume: 0.5, duck: true },
    voiceover: [{ id: 'vo1', file: 'voiceover/Voiceover.webm', source: 'main', t: 7, volume: 1 }]
  });
  p = P.cutRange(p, 1, 2);
  const tl = buildTimeline(p);
  const micSamples = sine(10 * SR, SR, 440, 0.3);
  micSamples.fill(0, 4 * SR); // talking for the first 4 s of the recording only
  const { mix } = await renderProjectAudio(p, tl, {
    mic: { main: mono(micSamples) },
    music: mono(sine(20 * SR, SR, 220, 0.4)),
    voiceover: { vo1: mono(sine(1.5 * SR, SR, 880, 0.3)) }
  });
  const L = mix.channels[0];
  assert.strictEqual(L.length, 9 * SR);
  // Recording 7 s plays at 6 s after the one-second cut.
  near(amplitude(L, 880, 6.1, 7.4), 0.3, 0.01, 'voiceover at its moment');
  assert.ok(amplitude(L, 880, 5.0, 5.9) < 0.01, 'not a second early');
  const full = amplitude(L, 220, 4.4, 5.5);
  const ducked = amplitude(L, 220, 0.5, 2.5);
  near(full, 0.2, 0.01, 'music at its volume when nobody talks');
  near(20 * Math.log10(ducked / full), -12, 1, 'music 12 dB down under the voice');
  assert.ok(amplitude(L, 220, 6.2, 6.5) < full * 0.5, 'and under the voiceover');
});

test('muting the mic leaves voiceovers, and does not duck the music', async () => {
  let p = project(4);
  p = P.setAudio(p, {
    mic: { cleanUp: false, level: false, muted: true },
    music: { file: 'music/a.mp3', volume: 1, duck: true }
  });
  const tl = buildTimeline(p);
  const { mix } = await renderProjectAudio(p, tl, {
    mic: { main: mono(sine(4 * SR, SR, 440, 0.3)) },
    music: mono(sine(8 * SR, SR, 220, 0.3))
  });
  assert.ok(amplitude(mix.channels[0], 440, 0.5, 1.5) < 0.001);
  near(amplitude(mix.channels[0], 220, 0.5, 1.5), 0.3, 0.01, 'music not lowered');
});

test('even out volume brings a quiet voice to the speech target', async () => {
  let p = project(8);
  p = P.setAudio(p, { mic: { cleanUp: false, level: true, volume: 1 } });
  const tl = buildTimeline(p);
  const quiet = speechLike(8, SR, { amplitude: 0.08 });
  const { mix } = await renderProjectAudio(p, tl, { mic: { main: mono(quiet) } });
  near(measureLoudness([mix.channels[0]], SR).integrated, VOICE_TARGET_LUFS, 1.5, 'loudness');
});

test('clean-up runs once per track and settings; quick mode uses the cache or reports pending', async () => {
  let p = project(3);
  p = P.setAudio(p, { mic: { cleanUp: true, level: false } });
  const tl = buildTimeline(p);
  const noisy = whiteNoise(3 * SR, 0.05, 7);
  const inputs = { mic: { main: mono(noisy) } };
  const cache = createVoiceCache();

  const quick = await renderProjectAudio(p, tl, inputs, { cache, quick: true });
  assert.strictEqual(quick.pending, true);
  near(quick.mix.channels[0][SR], noisy[SR], 1e-6, 'quick mix is the raw track');

  const progress = [];
  const full = await renderProjectAudio(p, tl, inputs, { cache, onProgress: (f) => progress.push(f) });
  assert.strictEqual(full.pending, false);
  assert.strictEqual(progress.at(-1), 1);
  const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  assert.ok(rms(full.mix.channels[0]) < rms(noisy) * 0.3, 'steady noise is removed');

  // Cached now: an edit (a cut) doesn't clean up again, and quick mode is final.
  const cut = P.cutRange(p, 1, 1.5);
  const started = performance.now();
  const again = await renderProjectAudio(cut, buildTimeline(cut), inputs, { cache, quick: true });
  assert.strictEqual(again.pending, false);
  assert.ok(performance.now() - started < 1000);
  assert.strictEqual(again.mix.channels[0].length, 2.5 * SR);
});
