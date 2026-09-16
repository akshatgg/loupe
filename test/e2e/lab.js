// The e2e lab page (run.js drives it with executeJavaScript). It makes the
// fixture recordings with WebCodecs and takes exported files apart again:
//
//   lab.makeRecording(options) -> saves an .mp4 through labHost.save
//   lab.inspect(url, request)  -> frame count, timestamps, sampled colours,
//                                 sound measurements; saves PNG snapshots
//
// The fixture picture encodes the recording time it was drawn at, so a
// sampled pixel of an export says which moment of which recording is showing:
//   top half     one of 8 colours, by whole second (palette per recording)
//   bottom half  grey rising from dark to light within each second
//   a white square travels along the middle line (never under the samples)

import { Muxer, ArrayBufferTarget } from '../../src/vendor/mp4-muxer/mp4-muxer.mjs';
import { demux, readFile } from '../../src/renderer/exporter/demux.js';
import { decodeAudioTrack, encoderDelay } from '../../src/renderer/exporter/audio.js';

export const PALETTES = {
  a: [[220, 40, 40], [40, 190, 60], [40, 80, 220], [230, 210, 40], [200, 50, 200], [40, 200, 210], [240, 130, 20], [120, 60, 160]],
  b: [[120, 60, 160], [240, 130, 20], [40, 200, 210], [200, 50, 200], [230, 210, 40], [40, 80, 220], [40, 190, 60], [220, 40, 40]]
};
const GREY_LOW = 16;
const GREY_SPAN = 220;

function drawPattern(ctx, width, height, t, palette) {
  const [r, g, b] = palette[Math.floor(t) % palette.length];
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  ctx.fillRect(0, 0, width, height / 2);
  const grey = Math.round(GREY_LOW + (t - Math.floor(t)) * GREY_SPAN);
  ctx.fillStyle = `rgb(${grey}, ${grey}, ${grey})`;
  ctx.fillRect(0, height / 2, width, height / 2);
  const size = Math.round(height / 10);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(Math.round(((t / 2) % 1) * (width - size)), height / 2 - size / 2, size, size);
}

function sine({ duration, rate, freq, amp, silence }) {
  const out = new Float32Array(Math.round(duration * rate));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const quiet = silence && t >= silence[0] && t < silence[1];
    out[i] = quiet ? 0 : amp * Math.sin(2 * Math.PI * freq * t);
  }
  return out;
}

async function encodeVideo(muxer, { width, height, duration, fps, codec, palette, still }) {
  let error = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { error = e; }
  });
  encoder.configure(codec === 'hevc'
    ? { codec: 'hvc1.1.6.L123.B0', width, height, bitrate: 4e6, framerate: fps, hevc: { format: 'hevc' } }
    : { codec: 'avc1.640028', width, height, bitrate: 4e6, framerate: fps, avc: { format: 'avc' } });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  const count = Math.round(duration * fps);
  let k = 0;
  for (let i = 0; i < count; i++) {
    const t = i / fps;
    // A still stretch: the screen didn't change, so the recorder wrote no
    // frames after the first one (variable frame rate).
    if (still && t > still[0] && t < still[1]) continue;
    drawPattern(ctx, width, height, t, palette);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6) });
    encoder.encode(frame, { keyFrame: k++ % fps === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 4) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await encoder.flush();
  encoder.close();
  if (error) throw error;
  return k;
}

async function encodeSound(muxer, samples, rate) {
  let error = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { error = e; }
  });
  encoder.configure({ codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: 1, bitrate: 128000 });
  // Like the exporter: skip the encoder's priming so the tone is where it
  // was generated, as in a real recording (whose file has an edit list).
  const skip = await encoderDelay();
  for (let at = skip; at < samples.length; at += 1024) {
    const n = Math.min(1024, samples.length - at);
    const data = new AudioData({
      format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: 1,
      timestamp: Math.round(((at - skip) / rate) * 1e6), data: samples.slice(at, at + n)
    });
    encoder.encode(data);
    data.close();
  }
  await encoder.flush();
  encoder.close();
  if (error) throw error;
}

async function makeRecording({
  name, width = 640, height = 400, duration = 8, fps = 30, codec = 'avc', palette = 'a',
  still = null, sound = null
}) {
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec, width, height, frameRate: fps },
    audio: sound ? { codec: 'aac', sampleRate: 48000, numberOfChannels: 1 } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset'
  });
  const frames = await encodeVideo(muxer, { width, height, duration, fps, codec, palette: PALETTES[palette], still });
  if (sound) await encodeSound(muxer, sine({ duration, rate: 48000, ...sound }), 48000);
  muxer.finalize();
  await window.labHost.save(name, new Uint8Array(target.buffer));
  return { frames, bytes: target.buffer.byteLength };
}

function average(data, width, height, x, y, radius = 3) {
  const sum = [0, 0, 0];
  let n = 0;
  for (let j = Math.max(0, y - radius); j <= Math.min(height - 1, y + radius); j++) {
    for (let i = Math.max(0, x - radius); i <= Math.min(width - 1, x + radius); i++) {
      const at = (j * width + i) * 4;
      sum[0] += data[at]; sum[1] += data[at + 1]; sum[2] += data[at + 2];
      n++;
    }
  }
  return sum.map((v) => Math.round(v / n));
}

function rms(x, a, b) {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return b > a ? Math.sqrt(s / (b - a)) : 0;
}

// Frequency from rising zero crossings, interpolated between samples.
function frequency(x, a, b, rate) {
  const ups = [];
  for (let i = Math.max(1, a); i < b; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) ups.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  }
  return ups.length > 2 ? ((ups.length - 1) * rate) / (ups.at(-1) - ups[0]) : 0;
}

// request = {
//   samples: [{ t, points: [{ x, y }] }],   output seconds / pixels
//   snapshots: [{ t, name }],               PNGs saved through labHost
//   sound: [{ from, to }],                  RMS and frequency per window
//   onsetAfter                              first loud sample after this time
// }
async function inspect(url, request = {}) {
  const buffer = await readFile(url, 'the export');
  const file = demux(buffer);
  const track = file.video;
  const result = {
    codec: track.codec, width: track.width, height: track.height,
    samples: track.samples.length,
    duration: track.samples.reduce((m, s) => Math.max(m, s.time + s.duration), 0),
    keyframes: track.samples.filter((s) => s.key).length,
    frames: 0, timestamps: [], colours: [], hasAudio: Boolean(file.audio)
  };

  const nearestFrame = (t) => Math.round(t * 1e6);
  const wanted = new Map();
  for (const s of request.samples ?? []) {
    const key = nearestFrame(s.t);
    wanted.set(key, [...(wanted.get(key) ?? []), { kind: 'sample', ...s }]);
  }
  for (const s of request.snapshots ?? []) {
    const key = nearestFrame(s.t);
    wanted.set(key, [...(wanted.get(key) ?? []), { kind: 'snapshot', ...s }]);
  }
  // Each request takes the decoded frame nearest its time (within half a
  // 60fps frame); run.js then checks that frame is the right one.
  const pending = [...wanted.entries()];
  const snapshots = [];
  let error = null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      result.frames++;
      result.timestamps.push(frame.timestamp);
      for (const [key, items] of pending) {
        if (Math.abs(frame.timestamp - key) > 9000) continue;
        const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(frame, 0, 0);
        for (const item of items) {
          if (item.found !== undefined && Math.abs(item.found - item.t * 1e6) <= Math.abs(frame.timestamp - item.t * 1e6)) continue;
          item.found = frame.timestamp;
          if (item.kind === 'snapshot') {
            item.canvas = canvas;
          } else {
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            item.colours = item.points.map((p) => average(img.data, canvas.width, canvas.height, Math.round(p.x), Math.round(p.y)));
          }
        }
      }
      frame.close();
    },
    error: (e) => { error = e; }
  });
  decoder.configure({ codec: track.codec, codedWidth: track.width, codedHeight: track.height, description: track.description });
  for (const s of track.samples) {
    decoder.decode(new EncodedVideoChunk({
      type: s.key ? 'key' : 'delta', timestamp: Math.round(s.time * 1e6),
      duration: Math.round(s.duration * 1e6), data: new Uint8Array(buffer, s.offset, s.size)
    }));
    while (decoder.decodeQueueSize > 8) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await decoder.flush();
  decoder.close();
  if (error) throw error;
  result.timestamps.sort((a, b) => a - b);

  for (const [, items] of pending) {
    for (const item of items) {
      if (item.kind === 'sample') {
        result.colours.push({ t: item.t, found: item.found ?? null, colours: item.colours ?? null });
      } else if (item.canvas) {
        const blob = await item.canvas.convertToBlob({ type: 'image/png' });
        await window.labHost.save(item.name, new Uint8Array(await blob.arrayBuffer()));
        snapshots.push(item.name);
      }
    }
  }
  result.colours.sort((a, b) => a.t - b.t);
  result.snapshots = snapshots;

  if (file.audio) {
    const pcm = await decodeAudioTrack(file, 'the export');
    const rate = pcm.sampleRate;
    const [left, right = left] = pcm.channels;
    result.audio = {
      sampleRate: rate, channels: pcm.channels.length, duration: left.length / rate,
      windows: (request.sound ?? []).map(({ from, to }) => {
        const a = Math.round(from * rate);
        const b = Math.min(left.length, Math.round(to * rate));
        return { from, to, rms: rms(left, a, b), rmsRight: rms(right, a, b), frequency: frequency(left, a, b, rate) };
      })
    };
    if (request.onsetAfter !== undefined) {
      const start = Math.round(request.onsetAfter * rate);
      let i = start;
      while (i < left.length && Math.abs(left[i]) < 0.05) i++;
      result.audio.onset = i < left.length ? i / rate : null;
    }
  }
  return result;
}

window.lab = { makeRecording, inspect, encoderDelay, PALETTES, GREY_LOW, GREY_SPAN };
window.labReady = true;
