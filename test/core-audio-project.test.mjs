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
    voiceover: [{ id: 'vo1', file: 'voiceover/Voiceover.webm', source: 'main', t: 2, volume: 1 }]
  });
  p = P.addAudioClip(p, { file: 'music/song.wav', volume: 0.3, duck: false });
  const tl = buildTimeline(p);
  const { mix } = await renderProjectAudio(p, tl, {
    mic: { main: mono(sine(6 * SR, SR, 440, 0.2)) },
    system: { main: mono(sine(6 * SR, SR, 660, 0.2)) },
    music: { 'music/song.wav': mono(sine(10 * SR, SR, 220, 0.5)) },
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
    voiceover: [{ id: 'vo1', file: 'voiceover/Voiceover.webm', source: 'main', t: 7, volume: 1 }]
  });
  p = P.addAudioClip(p, { file: 'music/song.wav', volume: 0.5, duck: true });
  p = P.cutRange(p, 1, 2);
  const tl = buildTimeline(p);
  const micSamples = sine(10 * SR, SR, 440, 0.3);
  micSamples.fill(0, 4 * SR); // talking for the first 4 s of the recording only
  const { mix } = await renderProjectAudio(p, tl, {
    mic: { main: mono(micSamples) },
    music: { 'music/song.wav': mono(sine(20 * SR, SR, 220, 0.4)) },
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
    mic: { cleanUp: false, level: false, muted: true }
  });
  p = P.addAudioClip(p, { file: 'music/a.mp3', volume: 1, duck: true });
  const tl = buildTimeline(p);
  const { mix } = await renderProjectAudio(p, tl, {
    mic: { main: mono(sine(4 * SR, SR, 440, 0.3)) },
    music: { 'music/a.mp3': mono(sine(8 * SR, SR, 220, 0.3)) }
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
  assert.strictEqual(full.cleanUp, 'rnnoise');
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

test('audio clips: each at its place in the video, from its point in the song, with its fades', async () => {
  let p = project(8);
  // One song: 3 s of one note, then another.
  const song = new Float32Array(12 * SR);
  song.set(sine(3 * SR, SR, 220, 0.5), 0);
  song.set(sine(9 * SR, SR, 330, 0.5), 3 * SR);
  p = P.setAudio(p, { mic: { muted: true } });
  p = P.addAudioClip(p, { file: 'music/song.wav', start: 2, from: 3, length: 3, fileDuration: 12, volume: 1, duck: false });
  // A second sound on its own row, overlapping the first.
  p = P.addAudioClip(p, { file: 'music/beep.wav', start: 4, fileDuration: 1, volume: 0.5, duck: false, loop: true, length: 3 });
  assert.deepStrictEqual(p.audio.clips.map((c) => c.lane), [0, 1]);
  const beep = sine(1 * SR, SR, 550, 0.4);
  const { mix } = await renderProjectAudio(p, buildTimeline(p), { music: { 'music/song.wav': mono(song), 'music/beep.wav': mono(beep) } });
  const L = mix.channels[0];
  assert.strictEqual(L.length, 8 * SR);
  assert.ok(amplitude(L, 330, 0.2, 1.8) < 0.005 && amplitude(L, 220, 0.2, 1.8) < 0.005, 'silent before the first clip');
  near(amplitude(L, 330, 2.3, 3.8), 0.5, 0.02, 'the song from 0:03');
  assert.ok(amplitude(L, 220, 2.3, 3.8) < 0.01, 'not the song\u2019s beginning');
  assert.ok(amplitude(L, 330, 5.3, 6) < 0.005, 'the song stops after its 3 seconds');
  near(amplitude(L, 550, 4.2, 4.8), 0.2, 0.02, 'the second clip at half volume, over the first');
  near(amplitude(L, 550, 6.2, 6.8), 0.2, 0.03, 'repeating for its 3 seconds');
  assert.ok(amplitude(L, 550, 7.2, 7.9) < 0.005, 'and no longer');

  // Muted, it is gone; a fade in starts quiet.
  const muted = P.updateAudioClip(p, 'a2', { muted: true });
  const quiet = await renderProjectAudio(muted, buildTimeline(muted), { music: { 'music/song.wav': mono(song), 'music/beep.wav': mono(beep) } });
  assert.ok(amplitude(quiet.mix.channels[0], 550, 4.2, 6.8) < 0.005, 'muted clip not heard');
  const faded = P.updateAudioClip(p, 'a1', { fadeIn: 2, length: 3 });
  const f = (await renderProjectAudio(faded, buildTimeline(faded), { music: { 'music/song.wav': mono(song) } })).mix.channels[0];
  assert.ok(amplitude(f, 330, 2.0, 2.4) < amplitude(f, 330, 3.6, 4.0) * 0.6, 'fading in');
});

test('volume points shape a clip’s level over time; row mute and solo decide what is heard', async () => {
  let p = project(8);
  p = P.setAudio(p, { mic: { muted: true } });
  p = P.addAudioClip(p, { file: 'music/a.wav', start: 0, fileDuration: 8, volume: 1, duck: false });
  p = P.updateAudioClip(p, 'a1', { points: [{ t: 1, gain: 1 }, { t: 5, gain: 0 }] });
  p = P.addAudioClip(p, { file: 'music/b.wav', start: 0, fileDuration: 8, volume: 0.5, duck: false });
  assert.strictEqual(p.audio.clips[1].lane, 1);
  const inputs = { music: { 'music/a.wav': mono(sine(8 * SR, SR, 220, 0.4)), 'music/b.wav': mono(sine(8 * SR, SR, 550, 0.4)) } };
  let L = (await renderProjectAudio(p, buildTimeline(p), inputs)).mix.channels[0];
  near(amplitude(L, 220, 0.2, 0.9), 0.4, 0.01, 'full before the first point');
  near(amplitude(L, 220, 2.8, 3.2), 0.2, 0.02, 'halfway down between the points');
  assert.ok(amplitude(L, 220, 5.5, 7.5) < 0.005, 'silent after the last point');
  near(amplitude(L, 550, 0.5, 1.5), 0.2, 0.01, 'the other row at its volume');

  const muted = P.setAudioLane(p, 1, { muted: true });
  L = (await renderProjectAudio(muted, buildTimeline(muted), inputs)).mix.channels[0];
  assert.ok(amplitude(L, 550, 0.5, 1.5) < 0.005, 'a muted row is silent');
  near(amplitude(L, 220, 0.2, 0.9), 0.4, 0.01, 'the others play on');

  const solo = P.setAudioLane(p, 1, { solo: true });
  L = (await renderProjectAudio(solo, buildTimeline(solo), inputs)).mix.channels[0];
  assert.ok(amplitude(L, 220, 0.2, 0.9) < 0.005, 'soloing row 2 silences row 1');
  near(amplitude(L, 550, 0.5, 1.5), 0.2, 0.01, 'and plays row 2');
});

test('detached video sound plays from its audio clip: moved, it moves; deleted, the video is silent', async () => {
  let p = project(6);
  p = P.setAudio(p, { mic: { cleanUp: false, level: false } });
  const mic = sine(6 * SR, SR, 440, 0.3);
  mic.fill(0, 0, 2 * SR); // sound only from 2 s of the recording
  const inputs = { mic: { main: mono(mic) } };
  p = P.detachAudio(p, p.clips[0].id);
  let L = (await renderProjectAudio(p, buildTimeline(p), inputs)).mix.channels[0];
  assert.ok(amplitude(L, 440, 0.5, 1.5) < 0.005, 'silent where the recording was');
  near(amplitude(L, 440, 2.5, 3.5), 0.3, 0.01, 'the same sound at the same moment');
  const moved = P.updateAudioClip(p, 'a1', { start: 1 });
  L = (await renderProjectAudio(moved, buildTimeline(moved), inputs)).mix.channels[0];
  assert.ok(amplitude(L, 440, 2.1, 2.9) < 0.005, 'moved a second later: not yet at 2 s');
  near(amplitude(L, 440, 3.2, 4.2), 0.3, 0.01, 'but from 3 s');
  const gone = P.removeAudioClip(p, 'a1');
  const out = await renderProjectAudio(gone, buildTimeline(gone), inputs);
  assert.ok(!out.mix || amplitude(out.mix.channels[0], 440, 2.5, 3.5) < 0.005, 'deleted: the video is silent');
  const back = P.reattachAudio(p, 'a1');
  L = (await renderProjectAudio(back, buildTimeline(back), inputs)).mix.channels[0];
  near(amplitude(L, 440, 2.5, 3.5), 0.3, 0.01, 'reattached: from the video again');
});
