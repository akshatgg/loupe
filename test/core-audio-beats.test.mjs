// Beat marks on songs (src/core/audio/beats.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBeats } from '../src/core/audio/beats.js';

const SR = 44100;

// A drum-like click every `period` seconds from `offset`, over a quiet hum.
function clickTrack(seconds, bpm, offset = 0, { accentEvery = 0 } = {}) {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = 0.02 * Math.sin((2 * Math.PI * 110 * i) / SR);
  const period = 60 / bpm;
  for (let k = 0; offset + k * period < seconds; k++) {
    const at = Math.round((offset + k * period) * SR);
    const loud = accentEvery && k % accentEvery === 0 ? 0.9 : 0.6;
    for (let j = 0; j < 0.03 * SR && at + j < x.length; j++) {
      x[at + j] += loud * Math.exp(-j / (0.006 * SR)) * Math.sin((2 * Math.PI * 1800 * j) / SR);
    }
  }
  return { channels: [x], sampleRate: SR };
}

function checkGrid(result, bpm, offset, seconds) {
  assert.ok(Math.abs(result.bpm - bpm) < 1.5, `tempo ${result.bpm} for ${bpm}`);
  const period = 60 / bpm;
  assert.ok(result.beats.length >= Math.floor((seconds - offset) / period) - 1, `${result.beats.length} beats`);
  for (const t of result.beats) {
    const k = Math.round((t - offset) / period);
    assert.ok(Math.abs(t - (offset + k * period)) < 0.03, `beat at ${t.toFixed(3)} off the grid`);
  }
}

test('a steady 120 BPM beat is found, on its hits', () => {
  checkGrid(detectBeats(clickTrack(12, 120, 0.25)), 120, 0.25, 12);
});

test('other tempos: 90 and 150 BPM, with accents', () => {
  checkGrid(detectBeats(clickTrack(14, 90, 0.4, { accentEvery: 4 })), 90, 0.4, 14);
  checkGrid(detectBeats(clickTrack(10, 150, 0.1)), 150, 0.1, 10);
});

test('stereo is read as one; silence and a steady tone have no beats', () => {
  const mono = clickTrack(8, 120, 0.3);
  checkGrid(detectBeats({ channels: [mono.channels[0], mono.channels[0]], sampleRate: SR }), 120, 0.3, 8);
  assert.deepEqual(detectBeats({ channels: [new Float32Array(SR * 4)], sampleRate: SR }).beats, []);
  const tone = new Float32Array(SR * 4).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR));
  assert.deepEqual(detectBeats({ channels: [tone], sampleRate: SR }).beats, []);
});
