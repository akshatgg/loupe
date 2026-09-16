// One recording's pictures on demand: frameAt(t) is the newest frame shown at
// or before recording time t. Recordings are variable frame rate (a still
// screen produces no new frames), so "the frame at t" is whichever frame was
// last put on screen by then, exactly what a player would show.
//
// Decoding is sequential: the export asks for times in order within a clip,
// so each call usually just feeds the decoder a few more samples. A jump
// backwards (a reordered clip) or far ahead (a cut) resets the decoder at the
// keyframe before the wanted frame.
//
// Frames come out of VideoDecoder asynchronously and, with B-frames (the
// recorder's HEVC has them), only after later samples arrive. So the source
// keeps feeding until the wanted frame has come out, holding at most a few
// decoded frames: hardware decoders stall if too many frames stay open.

import { sampleData } from './demux.js';

const MAX_AHEAD = 16;

const micro = (seconds) => Math.round(seconds * 1e6);

export async function openVideoSource(demuxed, label) {
  const track = demuxed.video;
  if (!track) throw new Error(`${label} has no video in it.`);
  const config = {
    codec: track.codec,
    codedWidth: track.width,
    codedHeight: track.height,
    description: track.description,
    optimizeForLatency: true
  };
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`This computer can't decode the video in ${label} (${track.codec}).`);
  return new VideoSource(demuxed.buffer, track, config, label);
}

export class VideoSource {
  constructor(buffer, track, config, label) {
    this.buffer = buffer;
    this.samples = track.samples;
    this.config = config;
    this.label = label;
    // Samples in presentation order, for "newest sample at or before t".
    this.byTime = this.samples.map((s, i) => i).sort((a, b) => this.samples[a].time - this.samples[b].time);
    // The keyframe each sample (in decode order) needs decoding from.
    this.keyOf = new Int32Array(this.samples.length);
    let key = 0;
    this.samples.forEach((s, i) => { if (s.key) key = i; this.keyOf[i] = key; });
    this.current = null;
    this.pending = [];
    this.next = 0;
    this.error = null;
    this.wake = null;
    this.decoder = null;
    this.reset(0);
  }

  reset(from) {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.dropFrames();
    this.decoder = new VideoDecoder({
      output: (frame) => {
        let i = this.pending.length;
        while (i > 0 && this.pending[i - 1].timestamp > frame.timestamp) i--;
        this.pending.splice(i, 0, frame);
        this.poke();
      },
      error: (e) => { this.error = e; this.poke(); }
    });
    this.decoder.addEventListener('dequeue', () => this.poke());
    this.decoder.configure(this.config);
    this.next = from;
    this.flushed = false;
  }

  poke() {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  // Until the decoder reports progress, or a moment passes: a frame can be
  // on its way back from the GPU process without any event yet.
  waitForProgress() {
    return new Promise((resolve) => {
      this.wake = resolve;
      setTimeout(() => this.poke(), 2);
    });
  }

  dropFrames() {
    this.current?.close();
    this.current = null;
    for (const f of this.pending) f.close();
    this.pending = [];
  }

  // Index (decode order) of the newest sample shown at or before t.
  sampleAt(t) {
    const { byTime, samples } = this;
    let lo = 0;
    let hi = byTime.length - 1;
    if (samples[byTime[0]].time > t) return byTime[0];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (samples[byTime[mid]].time <= t) lo = mid;
      else hi = mid - 1;
    }
    return byTime[lo];
  }

  fail() {
    throw new Error(`Couldn't decode the video in ${this.label} (${this.error?.message ?? 'unknown error'}).`);
  }

  async frameAt(t) {
    if (this.error) this.fail();
    const index = this.sampleAt(t);
    const want = micro(this.samples[index].time);
    if (this.current?.timestamp === want) return this.current;

    const key = this.keyOf[index];
    const behind = this.current && this.current.timestamp > want;
    // Not fed yet, and a keyframe lies between: skip straight to it.
    const skip = key > this.next || (this.flushed && index >= this.next);
    if (behind || skip || (this.next > index + MAX_AHEAD && !this.holds(want))) this.reset(key);

    for (;;) {
      if (this.error) this.fail();
      while (this.pending.length && this.pending[0].timestamp <= want) {
        this.current?.close();
        this.current = this.pending.shift();
      }
      if (this.current?.timestamp === want) return this.current;
      // Past the wanted frame without seeing it (it failed to decode or is
      // missing): the newest frame before is the best there is.
      if (this.pending.length && this.current) return this.current;
      if (this.pending.length) return this.pending[0];

      if (this.decoder.decodeQueueSize > 2) {
        await this.waitForProgress();
      } else if (this.next < this.samples.length && this.next <= index + MAX_AHEAD) {
        const s = this.samples[this.next++];
        this.decoder.decode(new EncodedVideoChunk({
          type: s.key ? 'key' : 'delta',
          timestamp: micro(s.time),
          duration: micro(s.duration),
          data: sampleData(this.buffer, s)
        }));
        if (this.next > index) await this.waitForProgress();
      } else if (!this.flushed) {
        // Nothing more to feed: make the decoder hand over what it holds.
        // After a flush it needs a keyframe, which the next call arranges.
        this.flushed = true;
        await this.decoder.flush().catch((e) => { this.error ??= e; });
      } else {
        if (this.current) return this.current;
        throw new Error(`Couldn't find a picture at ${t.toFixed(2)}s in ${this.label}.`);
      }
    }
  }

  holds(timestamp) {
    return this.pending.some((f) => f.timestamp <= timestamp);
  }

  close() {
    this.dropFrames();
    if (this.decoder.state !== 'closed') this.decoder.close();
  }
}
