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

// -> { channels, sampleRate }, sample 0 at recording time 0. Each decoded
// block is placed by its own timestamp, so the edit list's delay/skip (AAC
// priming) and any gap in the file land where they belong in time.
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
  for (let i = 0; i < track.samples.length; i++) {
    if (error) break;
    const s = track.samples[i];
    decoder.decode(new EncodedAudioChunk({
      type: 'key', timestamp: micro(s.time), duration: micro(s.duration), data: sampleData(demuxed.buffer, s)
    }));
    if (i % FEED_BATCH === FEED_BATCH - 1) {
      while (decoder.decodeQueueSize > FEED_BATCH && !error) await waitForDequeue(decoder);
    }
  }
  if (!error) await decoder.flush().catch((e) => { error ??= e; });
  if (decoder.state !== 'closed') decoder.close();
  if (error) throw new Error(`Couldn't decode the sound in ${label} (${error.message}).`);

  const end = blocks.reduce((m, b) => Math.max(m, Math.round(b.at * rate) + b.planes[0].length), 0);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(Math.max(0, end)));
  for (const b of blocks) {
    const start = Math.round(b.at * rate);
    b.planes.forEach((plane, c) => {
      if (c >= channelCount) return;
      const from = Math.max(0, -start);
      if (from < plane.length) channels[c].set(plane.subarray(from), start + from);
    });
  }
  return { channels, sampleRate: rate };
}

// A mixTracks() result -> [{ chunk, meta }] AAC, timestamps from 0.
export async function encodeAudio(mix, { signal } = {}) {
  const config = await chooseAudioConfig();
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
  for (let at = 0; at < frames; at += block) {
    if (error) break;
    if (signal?.aborted) throw signal.reason;
    const n = Math.min(block, frames - at);
    const planar = new Float32Array(n * 2);
    planar.set(left.subarray(at, at + n), 0);
    planar.set(right.subarray(at, at + n), n);
    const data = new AudioData({
      format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfFrames: n, numberOfChannels: 2,
      timestamp: Math.round((at / AUDIO_RATE) * 1e6), data: planar
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
