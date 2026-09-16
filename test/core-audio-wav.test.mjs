import test from 'node:test';
import assert from 'node:assert';
import { isWav, parseWav } from '../src/core/audio/wav.js';

// A WAV the way native-win/WavFile.cs writes it: 44-byte header, 16-bit PCM.
function wav16(frames, { rate = 48000, channels = 2, dataSize } = {}) {
  const bytes = frames.length * channels * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const str = (at, s) => { for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataSize ?? bytes, true);
  frames.forEach((f, i) => f.forEach((s, c) => v.setInt16(44 + (i * channels + c) * 2, s, true)));
  return buf;
}

test('16-bit stereo PCM reads as float channels at its own rate', () => {
  const buf = wav16([[16384, -32768], [0, 32767]], { rate: 44100 });
  assert.ok(isWav(buf));
  const { channels, sampleRate } = parseWav(buf);
  assert.strictEqual(sampleRate, 44100);
  assert.strictEqual(channels.length, 2);
  assert.deepStrictEqual([...channels[0]], [0.5, 0]);
  assert.strictEqual(channels[1][0], -1);
  assert.ok(Math.abs(channels[1][1] - 1) < 1e-4);
});

test('a header never finished (recording cut short) reads to the end', () => {
  const { channels } = parseWav(wav16([[1, 1], [2, 2], [3, 3]], { dataSize: 0 }));
  assert.strictEqual(channels[0].length, 3);
});

test('anything else is refused with a plain message', () => {
  assert.strictEqual(isWav(new ArrayBuffer(4)), false);
  assert.throws(() => parseWav(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 0, 0, 0, 0]).buffer), /Not a WAV/);
  const odd = wav16([[1, 1]]);
  new DataView(odd).setUint16(34, 12, true);
  assert.throws(() => parseWav(odd), /isn't supported/);
});
