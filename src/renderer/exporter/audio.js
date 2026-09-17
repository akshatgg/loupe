// Sound in and out of WebCodecs: a demuxed AAC track decoded into plain
// Float32Array channels (what src/core/audio works on), and a finished mix
// encoded back into AAC chunks for the muxer.

import { sampleData } from './demux.js';
import { chooseAudioConfig, AUDIO_RATE } from './encode.js';

const micro = (seconds) => Math.round(seconds * 1e6);
const FEED_BATCH = 256;

function waitForDequeue(codec) {
  return new Promise((resolve) => {
    codec.addEventListener('dequeue', resolve, { once: true });
    setTimeout(resolve, 20);
  });
}

// -> { channels, sampleRate }, sample 0 at recording time 0. The first
// decoded sample belongs at the first packet's time, which the demuxer has
// already moved by the edit list (so the encoder's priming lands before 0
// and is cut off); later blocks follow by their offset from the first.
// Chromium's decoder doesn't carry the packet timestamps through -- its
// output starts at 0 even when the first packet is at -51ms -- so only the
// differences between output timestamps are used.
export async function decodeAudioTrack(demuxed, label) {
  const track = demuxed.audio;
  if (!track) return null;
  const config = {
    codec: track.codec, sampleRate: track.sampleRate, numberOfChannels: track.channels,
    description: track.description
  };
  const { supported } = await AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!supported) throw new Error(`This computer can't decode the sound in ${label} (${track.codec}).`);

  const blocks = [];
  let rate = track.sampleRate;
  let channelCount = track.channels;
  let error = null;
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        rate = data.sampleRate;
        channelCount = data.numberOfChannels;
        const planes = [];
        for (let c = 0; c < data.numberOfChannels; c++) {
          const plane = new Float32Array(data.numberOfFrames);
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          planes.push(plane);
        }
        blocks.push({ at: data.timestamp / 1e6, planes });
      } finally {
        data.close();
      }
    },
    error: (e) => { error = e; }
  });
  decoder.configure(config);
  const read = demuxed.read ?? ((s) => sampleData(demuxed.buffer, s));
  for (let i = 0; i < track.samples.length; i++) {
    if (error) break;
    const s = track.samples[i];
    decoder.decode(new EncodedAudioChunk({
      type: 'key', timestamp: micro(s.time), duration: micro(s.duration), data: await read(s)
    }));
    if (i % FEED_BATCH === FEED_BATCH - 1) {
      while (decoder.decodeQueueSize > FEED_BATCH && !error) await waitForDequeue(decoder);
    }
  }
  if (!error) await decoder.flush().catch((e) => { error ??= e; });
  if (decoder.state !== 'closed') decoder.close();
  if (error) throw new Error(`Couldn't decode the sound in ${label} (${error.message}).`);

  const origin = track.samples.length ? track.samples[0].time - (blocks[0]?.at ?? 0) : 0;
  const startOf = (block) => Math.round((block.at + origin) * rate);
  const end = blocks.reduce((m, b) => Math.max(m, startOf(b) + b.planes[0].length), 0);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(Math.max(0, end)));
  for (const b of blocks) {
    const start = startOf(b);
    b.planes.forEach((plane, c) => {
      if (c >= channelCount) return;
      const from = Math.max(0, -start);
      if (from < plane.length) channels[c].set(plane.subarray(from), start + from);
    });
  }
  return { channels, sampleRate: rate };
}

// A whole audio file someone added (music: MP3, M4A, WAV, FLAC, Ogg...;
// a voiceover take: WebM/Opus) -> { channels, sampleRate } at 48 kHz.
// Chromium's own media decoders read all of these through decodeAudioData,
// which WebCodecs can't (it has no demuxers). Only pages have it, not workers.
export async function decodeAudioFile(bytes, label) {
  const ctx = new OfflineAudioContext(1, 1, AUDIO_RATE);
  let buffer;
  try {
    buffer = await ctx.decodeAudioData(bytes);
  } catch {
    throw new Error(`Couldn't read the sound in ${label}. The file may be damaged or in a format this computer can't play.`);
  }
  const channels = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c));
  return { channels, sampleRate: buffer.sampleRate };
}

// AAC encoders start with "priming" samples that decoders play back as
// silence unless the file has an edit list to skip them, and mp4-muxer
// writes none -- so without this the sound would come out late (2112
// samples, 44ms, with the macOS encoder). How many there are depends on
// the encoder, so it is measured once: a burst of noise goes through this
// encoder and decoder and is lined up with the original.
const NOISE_START = 9600;
const NOISE_LENGTH = 9600;
const MAX_DELAY = 4096;
const delayMeasured = new Map();

function noiseBurst() {
  const out = new Float32Array(NOISE_START + NOISE_LENGTH + MAX_DELAY + 4800);
  let seed = 12345;
  for (let i = NOISE_START; i < NOISE_START + NOISE_LENGTH; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out[i] = ((seed >>> 8) / 0x1000000 - 0.5) * 0.8;
  }
  return out;
}

async function roundTrip(samples, config) {
  const chunks = [];
  let error = null;
  const encoder = new AudioEncoder({ output: (chunk, meta) => chunks.push({ chunk, meta }), error: (e) => { error = e; } });
  encoder.configure(config);
  const planar = new Float32Array(samples.length * 2);
  planar.set(samples, 0);
  planar.set(samples, samples.length);
  const data = new AudioData({
    format: 'f32-planar', sampleRate: config.sampleRate, numberOfFrames: samples.length,
    numberOfChannels: 2, timestamp: 0, data: planar
  });
  encoder.encode(data);
  data.close();
  await encoder.flush();
  encoder.close();
  const description = chunks.find((c) => c.meta?.decoderConfig)?.meta.decoderConfig.description;
  const decoded = [];
  const decoder = new AudioDecoder({
    output: (d) => {
      const plane = new Float32Array(d.numberOfFrames);
      d.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
      decoded.push(plane);
      d.close();
    },
    error: (e) => { error = e; }
  });
  decoder.configure({ codec: config.codec, sampleRate: config.sampleRate, numberOfChannels: 2, description });
  for (const { chunk } of chunks) decoder.decode(chunk);
  await decoder.flush();
  decoder.close();
  if (error) throw error;
  const out = new Float32Array(decoded.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of decoded) { out.set(p, at); at += p.length; }
  return out;
}

export function bestLag(reference, decoded, start, length, maxLag) {
  let best = 0;
  let bestScore = -Infinity;
  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = start; i < start + length; i++) sum += reference[i] * (decoded[i + lag] ?? 0);
    if (sum > bestScore) { bestScore = sum; best = lag; }
  }
  return best;
}

// Per format: Opus has its own look-ahead, measured the same way.
export async function encoderDelay(format = 'mp4') {
  if (!delayMeasured.has(format)) {
    let lag = 0;
    try {
      const reference = noiseBurst();
      const decoded = await roundTrip(reference, await chooseAudioConfig(format));
      lag = bestLag(reference, decoded, NOISE_START, 2400, MAX_DELAY);
    } catch {
      // Unmeasurable. Guessing wrong would be as bad as not correcting, so
      // the sound is left as it comes out.
    }
    delayMeasured.set(format, lag);
  }
  return delayMeasured.get(format);
}

// A mixTracks() result -> [{ chunk, meta }] AAC (Opus for WebM), timestamps
// from 0. The
// first `encoderDelay()` samples of the mix are left out so that, after
// the encoder's priming, the sound lines up with the picture again.
export async function encodeAudio(mix, { signal, format = 'mp4' } = {}) {
  const config = await chooseAudioConfig(format);
  const skip = await encoderDelay(format);
  const out = [];
  let error = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => out.push({ chunk, meta }),
    error: (e) => { error = e; }
  });
  encoder.configure(config);
  const [left, right = left] = mix.channels;
  const frames = left.length;
  const block = 4096;
  for (let at = Math.min(skip, frames); at < frames; at += block) {
    if (error) break;
    if (signal?.aborted) throw signal.reason;
    const n = Math.min(block, frames - at);
    const planar = new Float32Array(n * 2);
    planar.set(left.subarray(at, at + n), 0);
    planar.set(right.subarray(at, at + n), n);
    const data = new AudioData({
      format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfFrames: n, numberOfChannels: 2,
      timestamp: Math.round(((at - skip) / AUDIO_RATE) * 1e6), data: planar
    });
    encoder.encode(data);
    data.close();
    while (encoder.encodeQueueSize > 32 && !error) await waitForDequeue(encoder);
  }
  if (!error) await encoder.flush().catch((e) => { error ??= e; });
  if (encoder.state !== 'closed') encoder.close();
  if (error) throw new Error(`Couldn't encode the sound (${error.message}).`);
  return out;
}
