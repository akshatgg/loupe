import test from 'node:test';
import assert from 'node:assert';
import * as P from '../src/core/project.js';
import {
  computePeaks, peakBetween, sameSound, playbackAction, RESYNC_SECONDS, PEAK_RATE
} from '../src/renderer/editor/audio-math.js';

const SR = 48000;

test('peaks: the loudest sample per 1/100 s over every track and channel, scaled by volume', () => {
  const a = new Float32Array(SR); // 1 s
  a[100] = -0.5; // first slot
  a[SR / 2 + 10] = 0.25;
  const b = new Float32Array(SR * 2);
  b[SR / 2 + 20] = 0.9; // same slot as a's 0.25, but at volume 0.5
  const peaks = computePeaks([
    { channels: [a], sampleRate: SR },
    { channels: [new Float32Array(SR * 2), b], sampleRate: SR, volume: 0.5 },
    null
  ]);
  assert.strictEqual(peaks.rate, PEAK_RATE);
  assert.strictEqual(peaks.values.length, 200, 'as long as the longest track');
  assert.strictEqual(peaks.values[0], 0.5);
  assert.ok(Math.abs(peaks.values[50] - 0.45) < 1e-6);
  assert.strictEqual(peaks.values[120], 0);
  assert.strictEqual(peakBetween(peaks, 0.4, 0.6), peaks.values[50]);
  assert.strictEqual(peakBetween(peaks, 3, 4), 0, 'past the end');
  assert.strictEqual(peakBetween(null, 0, 1), 0);
  // A narrow range still looks at one slot.
  assert.strictEqual(peakBetween(peaks, 0.501, 0.502), peaks.values[50]);
  // Other sample rates land in the same time slots.
  const c = new Float32Array(44100);
  c[22050 + 5] = 0.7;
  assert.strictEqual(computePeaks([{ channels: [c], sampleRate: 44100 }]).values[50], c[22055]);
});

test('only clips, speed, audio and sources count as a change to the sound', () => {
  const p = P.createProject({ main: { width: 100, height: 100, duration: 10, mic: true } });
  assert.strictEqual(sameSound(p, null), false);
  assert.strictEqual(sameSound(p, p), true);
  assert.strictEqual(sameSound(P.setStyle(p, { padding: 0.1 }), p), true);
  assert.strictEqual(sameSound(P.addZoom(p, { start: 1, end: 2 }), p), true);
  assert.strictEqual(sameSound(P.cutRange(p, 1, 2), p), false);
  assert.strictEqual(sameSound(P.paintSpeed(p, { start: 1, end: 2, rate: 2 }), p), false);
  assert.strictEqual(sameSound(P.setAudio(p, { mic: { volume: 0.5 } }), p), false);
});

test('playback: start at the playhead, keep going while in step, restart on a jump or a new mix, stop when paused', () => {
  const buffer = { duration: 10 };
  const other = { duration: 10 };
  assert.strictEqual(playbackAction({ playing: false, outT: 1, active: null, ctxTime: 0, buffer }), 'keep');
  assert.strictEqual(playbackAction({ playing: true, outT: 1, active: null, ctxTime: 0, buffer: null }), 'keep', 'nothing to play yet');
  assert.strictEqual(playbackAction({ playing: true, outT: 1, active: null, ctxTime: 5, buffer }), 'start');
  const active = { startedAtCtx: 5, startedAtOut: 1, buffer };
  assert.strictEqual(playbackAction({ playing: true, outT: 3, active, ctxTime: 7.02, buffer }), 'keep');
  assert.strictEqual(playbackAction({ playing: true, outT: 3 + RESYNC_SECONDS + 0.05, active, ctxTime: 7, buffer }), 'start', 'seeked');
  assert.strictEqual(playbackAction({ playing: true, outT: 3, active, ctxTime: 7, buffer: other }), 'start', 'an edit made a new mix');
  assert.strictEqual(playbackAction({ playing: false, outT: 3, active, ctxTime: 7, buffer }), 'stop');
  assert.strictEqual(playbackAction({ playing: true, outT: 3, active, ctxTime: 7, buffer: null }), 'stop', 'the edit left nothing to hear');
  assert.strictEqual(playbackAction({ playing: true, outT: 12, active: null, ctxTime: 7, buffer }), 'keep', 'past the end of the sound');
  assert.strictEqual(playbackAction({ playing: true, outT: 12, active, ctxTime: 7, buffer: other }), 'stop');
});
