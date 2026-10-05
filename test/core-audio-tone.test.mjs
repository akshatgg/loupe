import test from 'node:test';
import assert from 'node:assert';
import {
  defaultTone, toneOf, isNeutralTone, applyTone, equalize, compress, panChannels
} from '../src/core/audio/tone.js';
import { mixTracks } from '../src/core/audio/mix.js';
import { audioClipTrack } from '../src/core/audio/music.js';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import { renderProjectAudio } from '../src/core/audio/project-audio.js';

const SR = 48000;
const sine = (freq, seconds, amp = 0.5, rate = SR) => {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
};
// The loudest sample in [from, to) seconds.
const peak = (x, from = 0, to = x.length / SR) => {
  let m = 0;
  for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) m = Math.max(m, Math.abs(x[i]));
  return m;
};
// A tone's amplitude from its RMS (a high tone has few samples a cycle, so
// its loudest sample depends on where they fall).
const level = (x, from = 0, to = x.length / SR) => {
  let sum = 0;
  const a = Math.round(from * SR);
  const b = Math.round(to * SR);
  for (let i = a; i < b; i++) sum += x[i] * x[i];
  return Math.sqrt((2 * sum) / (b - a));
};
const db = (ratio) => 20 * Math.log10(ratio);
const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} !== ${b} (±${eps})`);

test('the defaults change nothing: the very same samples come back', () => {
  const x = sine(440, 0.5);
  const channels = [x];
  assert.strictEqual(isNeutralTone(defaultTone()), true);
  assert.strictEqual(isNeutralTone(toneOf({})), true);
  assert.strictEqual(isNeutralTone(toneOf(undefined)), true);
  assert.strictEqual(applyTone(channels, SR, {}), channels, 'not even copied');
  assert.strictEqual(applyTone(channels, SR, defaultTone()), channels);
  // A compressor that is off is neutral whatever its numbers say.
  assert.strictEqual(applyTone(channels, SR, { compressor: { on: false, threshold: -50, ratio: 20 } }), channels);
});

test('toneOf fills in what is missing and keeps numbers in range', () => {
  const t = toneOf({ pan: -3, eq: { low: 40, mid: 'x' }, compressor: { on: true, ratio: 0 } });
  assert.strictEqual(t.pan, -1);
  assert.deepStrictEqual(t.eq, { low: 12, mid: 0, high: 0 });
  assert.deepStrictEqual(t.compressor, { on: true, threshold: -24, ratio: 1, attack: 0.01, release: 0.2, makeup: 0 });
  assert.strictEqual(isNeutralTone(t), false);
});

test('the low band lifts a low tone and leaves a high one alone', () => {
  const eq = { low: 12, mid: 0, high: 0 };
  const low = equalize([sine(60, 1, 0.1)], SR, eq)[0];
  const high = equalize([sine(8000, 1, 0.1)], SR, eq)[0];
  near(db(level(low, 0.5) / 0.1), 12, 1, 'a 60 Hz tone, in dB');
  near(db(level(high, 0.5) / 0.1), 0, 0.3, 'an 8 kHz tone, in dB');
});

test('the high band lifts a high tone, the middle band a middle one, and each can cut', () => {
  const high = equalize([sine(12000, 1, 0.1)], SR, { low: 0, mid: 0, high: 12 })[0];
  near(db(level(high, 0.5) / 0.1), 12, 1, '12 kHz with the high band up');
  const mid = equalize([sine(1000, 1, 0.1)], SR, { low: 0, mid: 6, high: 0 })[0];
  near(db(level(mid, 0.5) / 0.1), 6, 0.3, '1 kHz with the middle band up');
  const far = equalize([sine(60, 1, 0.1)], SR, { low: 0, mid: 6, high: 0 })[0];
  near(db(level(far, 0.5) / 0.1), 0, 0.5, '60 Hz with the middle band up');
  const cut = equalize([sine(60, 1, 0.1)], SR, { low: -12, mid: 0, high: 0 })[0];
  near(db(level(cut, 0.5) / 0.1), -12, 1, '60 Hz with the low band down');
});

test('the compressor turns a loud tone down by about its ratio and leaves a quiet one alone', () => {
  const settings = { on: true, threshold: -24, ratio: 4, attack: 0.01, release: 0.2, makeup: 0 };
  // 0 dBFS is 24 dB over the threshold: 6 dB over it afterwards, so -18 dBFS.
  const loud = compress([sine(1000, 1, 1)], SR, settings)[0];
  near(db(peak(loud, 0.6)), -18, 1.5, 'a full-scale tone, in dBFS');
  const quietIn = sine(1000, 1, 0.02); // -34 dBFS, under the threshold
  const quiet = compress([quietIn], SR, settings)[0];
  assert.deepStrictEqual(quiet, quietIn, 'a tone under the threshold is untouched');
  // Makeup is added to everything.
  const lifted = compress([quietIn], SR, { ...settings, makeup: 6 })[0];
  near(db(peak(lifted, 0.5) / 0.02), 6, 0.1, 'makeup');
});

test('the compressor takes its attack time to bite and its release time to let go', () => {
  const x = new Float32Array(SR * 2);
  x.set(sine(1000, 1, 1), 0);
  x.set(sine(1000, 1, 0.05), SR); // loud for a second, then under the threshold
  const out = compress([x], SR, { on: true, threshold: -24, ratio: 4, attack: 0.05, release: 0.15, makeup: 0 })[0];
  assert.ok(peak(out, 0, 0.005) > 0.7, 'the first milliseconds get through');
  assert.ok(peak(out, 0.5, 1) < 0.16, 'then it is held down');
  assert.ok(peak(out, 1.01, 1.05) < 0.05 * 0.5, 'just after the loud part the quiet one is still turned down');
  near(peak(out, 1.9, 2), 0.05, 0.003, 'and a second later it is back');
});

test('both sides of a stereo sound are turned down together', () => {
  const out = compress([sine(1000, 1, 1), sine(1000, 1, 0.05)], SR, { on: true, threshold: -24, ratio: 4 });
  near(peak(out[1], 0.6) / peak(out[0], 0.6), 0.05, 0.002, 'the balance between the sides is kept');
});

test('pan: fully left silences the right, fully right the left, at equal power', () => {
  const x = sine(440, 0.2, 0.5);
  const [l, r] = panChannels([x], -1);
  assert.strictEqual(peak(r), 0, 'right is silent');
  near(peak(l), 0.5 * Math.SQRT2, 0.001, 'left carries both sides’ power');
  const [l2, r2] = panChannels([x], 1);
  assert.strictEqual(peak(l2), 0);
  near(peak(r2), 0.5 * Math.SQRT2, 0.001);
  const [l3, r3] = panChannels([x], 0.5);
  assert.ok(peak(r3) > peak(l3) && peak(l3) > 0, 'half right: both, more on the right');
  near(peak(l3) ** 2 + peak(r3) ** 2, 2 * 0.25, 0.001, 'the power stays the same');
  // A stereo sound keeps what is on each side.
  const [sl, sr] = panChannels([x, sine(880, 0.2, 0.5)], -1);
  assert.strictEqual(peak(sr), 0);
  assert.ok(peak(sl) > 0.5);
});

test('applyTone leaves its input alone', () => {
  const x = sine(100, 0.2, 0.5);
  const copy = x.slice();
  const out = applyTone([x], SR, { pan: -0.5, eq: { low: 6, mid: -3, high: 2 }, compressor: { on: true, threshold: -30, ratio: 8 } });
  assert.deepStrictEqual(x, copy);
  assert.strictEqual(out.length, 2);
  assert.ok(out.every((c) => c.length === x.length && c.every(Number.isFinite)));
});

// ---- in the mix

test('mixTracks: a track with a tone is panned, one without is mixed as before', () => {
  const x = sine(440, 0.5, 0.25);
  const plain = mixTracks([{ channels: [x], sampleRate: SR }]);
  const same = mixTracks([{ channels: [x], sampleRate: SR, tone: defaultTone() }]);
  assert.deepStrictEqual(same.channels, plain.channels);
  const left = mixTracks([{ channels: [x], sampleRate: SR, tone: { pan: -1 } }]);
  assert.strictEqual(peak(left.channels[1], 0, 0.5), 0);
  near(peak(left.channels[0], 0, 0.5), 0.25 * Math.SQRT2, 0.001);
});

test('an audio clip: its tone is applied before its fades, and none means the same samples as ever', () => {
  const song = { channels: [sine(1000, 2, 1)], sampleRate: SR };
  const clip = { ...P.defaultAudioClip(), id: 'a1', file: 'music/s.wav', volume: 1, duck: false, fadeOut: 1 };
  const before = audioClipTrack(clip, song, 2);
  const untouched = audioClipTrack({ ...clip, pan: 0, eq: { low: 0, mid: 0, high: 0 }, compressor: { on: false } }, song, 2);
  assert.deepStrictEqual(untouched.channels, before.channels);
  const squashed = audioClipTrack({ ...clip, compressor: { on: true, threshold: -24, ratio: 4 } }, song, 2);
  near(db(peak(squashed.channels[0], 0.5, 0.9)), -18, 1.5, 'turned down');
  // Half way down the fade the sound is half as loud as before it, as
  // without a compressor (one after the fade would undo part of it).
  near(peak(squashed.channels[0], 1.49, 1.51) / peak(squashed.channels[0], 0.5, 0.9), 0.5, 0.05, 'the fade is the fade');
  const panned = audioClipTrack({ ...clip, pan: 1 }, song, 2);
  assert.strictEqual(panned.channels.length, 2);
  assert.strictEqual(peak(panned.channels[0], 0, 2), 0);
});

test('the whole project: microphone and computer sound each take their own tone', async () => {
  const base = P.createProject({ main: { width: 100, height: 100, duration: 2, mic: true, systemAudio: 'system.m4a' } });
  const raw = P.setAudio(base, { mic: { cleanUp: false, level: false, volume: 1 }, system: { volume: 1 } });
  const inputs = {
    mic: { main: { channels: [sine(100, 2, 0.1)], sampleRate: SR } },
    system: { main: { channels: [sine(3000, 2, 0.1)], sampleRate: SR } }
  };
  const render = async (p) => (await renderProjectAudio(p, buildTimeline(p), inputs)).mix.channels;
  const plain = await render(raw);
  assert.deepStrictEqual(plain[0], plain[1], 'the same on both sides to begin with');
  const explicit = await render(P.setAudio(raw, { mic: defaultTone(), system: defaultTone() }));
  assert.deepStrictEqual(explicit, plain, 'the defaults written out change nothing');

  // Microphone to the left, computer sound to the right.
  const [L, R] = await render(P.setAudio(raw, { mic: { pan: -1 }, system: { pan: 1 } }));
  const amp = (x, freq) => {
    let re = 0;
    let im = 0;
    for (let i = SR / 2; i < SR * 1.5; i++) {
      re += x[i] * Math.cos((2 * Math.PI * freq * i) / SR);
      im += x[i] * Math.sin((2 * Math.PI * freq * i) / SR);
    }
    return (2 * Math.hypot(re, im)) / SR;
  };
  near(amp(L, 100), 0.1 * Math.SQRT2, 0.005, 'the microphone on the left');
  assert.ok(amp(R, 100) < 0.001, 'and not on the right');
  near(amp(R, 3000), 0.1 * Math.SQRT2, 0.005, 'computer sound on the right');
  assert.ok(amp(L, 3000) < 0.001, 'and not on the left');

  // The microphone's low band lifts the microphone only.
  const [B] = await render(P.setAudio(raw, { mic: { eq: { low: 12, mid: 0, high: 0 } } }));
  near(db(amp(B, 100) / 0.1), 12, 1, 'the microphone’s low tone');
  near(db(amp(B, 3000) / 0.1), 0, 0.3, 'computer sound untouched');
});

// ---- in the project

test('project: the new settings are optional, checked, and described plainly when wrong', () => {
  const base = P.createProject({ main: { width: 100, height: 100, duration: 4, mic: true, systemAudio: 'system.m4a' } });
  // An old project has none of them and loads as it is.
  const loaded = P.validateProject(JSON.parse(JSON.stringify(base)));
  assert.deepStrictEqual(loaded.audio, base.audio);
  assert.strictEqual('pan' in loaded.audio.mic, false);

  let p = P.addAudioClip(base, { file: 'music/s.wav', fileDuration: 4 });
  const id = p.audio.clips[0].id;
  p = P.updateAudioClip(p, id, { pan: -1, eq: { low: 6, mid: 0, high: -3 }, compressor: { on: true, threshold: -30, ratio: 8 } });
  assert.strictEqual(p.audio.clips[0].pan, -1);
  p = P.setAudio(p, { mic: { pan: 0.5, eq: { low: 3 } }, system: { compressor: { on: true } } });
  assert.strictEqual(p.audio.mic.pan, 0.5);
  assert.strictEqual(p.audio.mic.volume, 1, 'the other microphone settings stay');
  const again = P.validateProject(JSON.parse(JSON.stringify(p)));
  assert.deepStrictEqual(again.audio, p.audio, 'saved and loaded, it is the same');

  assert.throws(() => P.updateAudioClip(p, id, { pan: 2 }), /Audio pan must be a number from -1 to 1/);
  assert.throws(() => P.updateAudioClip(p, id, { eq: { low: 20 } }), /Audio low tones must be a number from -12 to 12/);
  assert.throws(() => P.updateAudioClip(p, id, { eq: 3 }), /Audio tone settings must be an object/);
  assert.throws(() => P.updateAudioClip(p, id, { compressor: { on: 'yes' } }), /Audio even out loud and quiet parts must be true or false/);
  assert.throws(() => P.updateAudioClip(p, id, { compressor: { on: true, ratio: 50 } }), /Audio evening out amount must be a number from 1 to 20/);
  assert.throws(() => P.setAudio(p, { mic: { pan: -4 } }), /Microphone pan must be a number from -1 to 1/);
  assert.throws(() => P.setAudio(p, { system: { compressor: { threshold: 3 } } }), /System audio evening out level must be a number from -60 to 0/);
  assert.throws(() => P.setAudio(p, { mic: { compressor: { attack: 5 } } }), /Microphone evening out attack must be a number/);
});

test('project: a split or duplicated clip keeps its tone', () => {
  let p = P.createProject({ main: { width: 100, height: 100, duration: 6 } });
  p = P.addAudioClip(p, { file: 'music/s.wav', fileDuration: 4, pan: 0.5 });
  const id = p.audio.clips[0].id;
  p = P.splitAudioClip(p, id, 2);
  assert.deepStrictEqual(p.audio.clips.map((c) => c.pan), [0.5, 0.5]);
});
