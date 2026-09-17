'use strict';
// Signals and measurements shared by the audio tests (test/audio-*.test.js).
// Deterministic: every generator takes a seed, so a failing margin can be
// reproduced exactly.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

function whiteNoise(n, amplitude, seed = 1) {
  const r = rng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = r() * 2 * amplitude;
  return out;
}

function sine(n, sampleRate, freq, amplitude, phase = 0) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate + phase);
  return out;
}

// Something with the gross structure of speech: a gliding pitch (110-220 Hz)
// with ~25 harmonics under a formant-like spectral tilt, chopped into 150-400
// ms "syllables" with short gaps and a longer pause every few words.
function speechLike(seconds, sampleRate, { amplitude = 0.3, seed = 3 } = {}) {
  const r = rng(seed);
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  let i = 0;
  let word = 0;
  while (i < n) {
    const syll = Math.round((0.15 + (r() + 0.5) * 0.25) * sampleRate);
    const gap = Math.round((word % 4 === 3 ? 0.45 : 0.06 + (r() + 0.5) * 0.08) * sampleRate);
    const f0a = 130 + (r() + 0.5) * 80;
    const f0b = f0a * (0.85 + (r() + 0.5) * 0.3);
    const formant = 500 + (r() + 0.5) * 1500;
    const phases = new Float64Array(26);
    for (let k = 0; k < syll && i + k < n; k++) {
      const p = k / syll;
      const f0 = f0a + (f0b - f0a) * p;
      const env = Math.sin(Math.PI * p) ** 0.6;
      let v = 0;
      for (let h = 1; h <= 25; h++) {
        const f = f0 * h;
        if (f > sampleRate / 2 - 500) break;
        phases[h] += (2 * Math.PI * f) / sampleRate;
        const tilt = 1 / h;
        const form = 1 + 3 * Math.exp(-(((f - formant) / 300) ** 2));
        v += Math.sin(phases[h]) * tilt * form;
      }
      out[i + k] = v * env;
    }
    i += syll + gap;
    word++;
  }
  // Normalise to the requested peak.
  let p = 0;
  for (const v of out) p = Math.max(p, Math.abs(v));
  for (let k = 0; k < n; k++) out[k] *= amplitude / p;
  return out;
}

// SNR of `y` against the clean reference `ref`, after fitting the best
// scalar gain (so a processor that changes overall level isn't penalised
// for it, only for noise and distortion).
function snrDb(ref, y, start = 0, end = ref.length) {
  let num = 0;
  let den = 0;
  for (let i = start; i < end; i++) { num += ref[i] * y[i]; den += ref[i] * ref[i]; }
  const g = num / den;
  let s = 0;
  let e = 0;
  for (let i = start; i < end; i++) {
    const clean = g * ref[i];
    s += clean * clean;
    e += (y[i] - clean) ** 2;
  }
  return 10 * Math.log10(s / e);
}

function correlation(a, b, start = 0, end = a.length) {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = start; i < end; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return ab / Math.sqrt(aa * bb);
}

function rmsDb(x, start = 0, end = x.length) {
  let s = 0;
  for (let i = start; i < end; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / (end - start));
}

function readWav(file) {
  const buf = fs.readFileSync(file);
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = { channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    } else if (id === 'data') {
      if (!fmt || fmt.bits !== 16) throw new Error('expected 16-bit PCM wav');
      const frames = size / (2 * fmt.channels);
      const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < fmt.channels; c++) {
          channels[c][f] = buf.readInt16LE(off + 8 + (f * fmt.channels + c) * 2) / 32768;
        }
      }
      return { channels, sampleRate: fmt.sampleRate };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

// Real synthesized speech from macOS `say`, as mono 48 kHz. Returns null
// where `say`/`afconvert` aren't available (non-macOS CI).
function macVoice(text, sampleRate = 48000) {
  if (process.platform !== 'darwin') return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-voice-'));
  try {
    const aiff = path.join(dir, 'voice.aiff');
    const wav = path.join(dir, 'voice.wav');
    execFileSync('say', ['-o', aiff, text], { stdio: 'ignore' });
    execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${sampleRate}`, '-c', '1', aiff, wav], { stdio: 'ignore' });
    return readWav(wav);
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { rng, whiteNoise, sine, speechLike, snrDb, correlation, rmsDb, readWav, macVoice };
