// The microphone track of a recording as 16 kHz mono samples, which is what
// the speech model listens to.
//
//   decodeMicTrack(url, { signal, onProgress, sampleRate }) ->
//     { samples: Float32Array, sampleRate, duration }
//
// `samples[0]` is source time 0 (the start of the video), so a word found at
// sample i is at i / sampleRate seconds in the recording, whatever the audio
// track's own start offset or encoder priming.
//
// Long recordings are never loaded whole: mp4-audio.js indexes the audio
// frames, only their bytes are read (fetch with Range over file://), and they
// are decoded with WebCodecs a slice at a time and resampled per slice with
// an OfflineAudioContext. At 16 kHz an hour is 230 MB of samples; the
// video itself is never in memory. Must run in a window (OfflineAudioContext
// does not exist in workers).

import { readMoov, parseAudioTrack, planReads } from '../../core/captions/mp4-audio.js';

const TARGET_RATE = 16000;
// Seconds of decoded audio collected before each resample.
const BLOCK_SECONDS = 30;
// Past this the fallback (decode the whole file at once) would need too much memory.
const FALLBACK_MAX_BYTES = 512 * 1024 * 1024;

export class CaptionsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CaptionsError';
    this.code = code;
  }
}

function abortError() {
  return new CaptionsError('cancelled', 'Cancelled');
}

export function rangeReader(url) {
  return async (offset, length) => {
    const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (!res.ok) throw new CaptionsError('read', `Could not read the recording (${res.status})`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // file:// answers 200 with just the range; a server ignoring Range sends
    // everything, so cut it down to what was asked for.
    if (res.status === 200 && buf.length > length) return buf.subarray(offset, offset + length);
    return buf;
  };
}

async function resampleMono(mono, fromRate, toRate) {
  if (fromRate === toRate) return mono;
  const outLen = Math.max(1, Math.round(mono.length * toRate / fromRate));
  const ctx = new OfflineAudioContext(1, outLen, toRate);
  const buf = ctx.createBuffer(1, mono.length, fromRate);
  buf.copyToChannel(mono, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

function toMono(data) {
  const frames = data.numberOfFrames;
  const channels = data.numberOfChannels;
  const mono = new Float32Array(frames);
  const tmp = channels > 1 ? new Float32Array(frames) : null;
  for (let c = 0; c < channels; c++) {
    const target = tmp ?? mono;
    data.copyTo(target, { planeIndex: c, format: 'f32-planar' });
    if (tmp) for (let i = 0; i < frames; i++) mono[i] += tmp[i] / channels;
  }
  return mono;
}

async function decodeWithWebCodecs(track, read, { signal, onProgress, sampleRate }) {
  const config = {
    codec: track.codec,
    sampleRate: track.sampleRate,
    numberOfChannels: track.channels,
    description: track.description
  };
  const support = await AudioDecoder.isConfigSupported(config);
  if (!support.supported) throw new CaptionsError('unsupported', `Audio format not supported: ${track.codec}`);

  const endSeconds = Math.max(0, track.startSeconds + track.duration);
  const out = new Float32Array(Math.ceil(endSeconds * sampleRate) + sampleRate);
  let maxWritten = 0;

  // Decoded frames waiting to be resampled: contiguous native-rate audio
  // starting at blockStart seconds.
  let pending = [];
  let pendingFrames = 0;
  let blockStart = null;
  let failure = null;

  const flushBlock = async () => {
    if (!pendingFrames) return;
    const mono = new Float32Array(pendingFrames);
    let p = 0;
    for (const part of pending) { mono.set(part, p); p += part.length; }
    const start = blockStart;
    pending = [];
    pendingFrames = 0;
    blockStart = null;
    const res = await resampleMono(mono, track.sampleRate, sampleRate);
    // Placed by timestamp, so priming (negative times) falls off the front
    // and a gap in the track stays a gap.
    let at = Math.round(start * sampleRate);
    let from = 0;
    if (at < 0) { from = -at; at = 0; }
    const n = Math.min(res.length - from, out.length - at);
    if (n > 0) {
      out.set(res.subarray(from, from + n), at);
      maxWritten = Math.max(maxWritten, at + n);
    }
  };

  const decoded = [];
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        decoded.push({ t: data.timestamp / 1e6, mono: toMono(data), rate: data.sampleRate });
      } finally {
        data.close();
      }
    },
    error: (e) => { failure = e; }
  });
  decoder.configure(config);

  const drain = async () => {
    while (decoded.length) {
      const { t, mono, rate } = decoded.shift();
      if (rate !== track.sampleRate) track.sampleRate = rate; // HE-AAC reports the doubled rate
      if (blockStart === null) blockStart = t;
      // A jump in time (a gap in the track) starts a new block.
      const expected = blockStart + pendingFrames / track.sampleRate;
      if (Math.abs(t - expected) > 0.05) {
        await flushBlock();
        blockStart = t;
      }
      pending.push(mono);
      pendingFrames += mono.length;
      if (pendingFrames >= BLOCK_SECONDS * track.sampleRate) await flushBlock();
    }
  };

  try {
    const reads = planReads(track);
    let done = 0;
    for (const r of reads) {
      if (signal?.aborted) throw abortError();
      if (failure) throw failure;
      const bytes = await read(r.start, r.end - r.start);
      for (let i = r.first; i <= r.last; i++) {
        const o = track.offsets[i] - r.start;
        const data = bytes.subarray(o, o + track.sizes[i]);
        const next = i + 1 < track.count ? track.times[i + 1] : track.endTime;
        decoder.decode(new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round((track.startSeconds + track.times[i] / track.timescale) * 1e6),
          duration: Math.round(((next - track.times[i]) / track.timescale) * 1e6),
          data
        }));
      }
      // Keep the decoder's queue short so memory stays flat.
      while (decoder.decodeQueueSize > 64) await new Promise((res) => setTimeout(res, 0));
      await drain();
      done += r.last - r.first + 1;
      onProgress?.(done / track.count);
    }
    await decoder.flush();
    if (failure) throw failure;
    await drain();
    await flushBlock();
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  const length = Math.max(maxWritten, Math.round(endSeconds * sampleRate));
  return out.subarray(0, Math.min(out.length, length));
}

// For containers the index cannot read: let the browser decode the whole file.
async function decodeWhole(url, { signal, sampleRate, onProgress }) {
  const res = await fetch(url);
  const size = Number(res.headers.get('content-length')) || 0;
  if (size > FALLBACK_MAX_BYTES) throw new CaptionsError('unsupported', 'This recording is too large to read its sound');
  const buf = await res.arrayBuffer();
  if (signal?.aborted) throw abortError();
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  let audio;
  try {
    audio = await ctx.decodeAudioData(buf);
  } catch {
    throw new CaptionsError('no-audio', 'This recording has no sound to turn into captions.');
  }
  const mono = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
  }
  onProgress?.(1);
  return mono;
}

export async function decodeMicTrack(url, { signal, onProgress, sampleRate = TARGET_RATE, read = rangeReader(url) } = {}) {
  let moov = null;
  let track = null;
  try {
    moov = await readMoov(read);
    track = moov && parseAudioTrack(moov);
  } catch {
    track = null;
  }
  if (signal?.aborted) throw abortError();

  let samples;
  if (track && typeof AudioDecoder !== 'undefined') {
    samples = await decodeWithWebCodecs(track, read, { signal, onProgress, sampleRate });
  } else if (moov && !track) {
    // A readable MP4/MOV that simply has no sound track (recorded without the mic).
    throw new CaptionsError('no-audio', 'This recording has no microphone sound to turn into captions.');
  } else {
    samples = await decodeWhole(url, { signal, sampleRate, onProgress });
  }
  return { samples, sampleRate, duration: samples.length / sampleRate };
}
