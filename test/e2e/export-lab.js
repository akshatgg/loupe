// The export-formats e2e page (export-formats.e2e.js drives it). On top of
// lab.js (fixture recordings, MP4 inspection) it takes WebM and GIF exports
// apart without the muxers that wrote them: media-parse.mjs reads the
// container, WebCodecs' VideoDecoder/AudioDecoder decode WebM, and
// ImageDecoder decodes GIF frames.
//
//   exportLab.makeBusyRecording(options)    a fast text scroll, H.264 .mp4
//   exportLab.inspectWebm(url, request)
//   exportLab.inspectGif(url, request)
//
// request = { samples: [{ t, points: [{x, y}] }], snapshots: [{ t, name }],
//             sound: [{ from, to }], onsetAfter }  (as lab.inspect)

import './lab.js';
import { Muxer, ArrayBufferTarget } from '../../src/vendor/mp4-muxer/mp4-muxer.mjs';
import { readFile } from '../../src/renderer/exporter/demux.js';
import { parseWebm, parseGif } from './media-parse.mjs';

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

const rms = (x, a, b) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return b > a ? Math.sqrt(s / (b - a)) : 0;
};

function frequency(x, a, b, rate) {
  const ups = [];
  for (let i = Math.max(1, a); i < b; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) ups.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  }
  return ups.length > 2 ? ((ups.length - 1) * rate) / (ups.at(-1) - ups[0]) : 0;
}

async function savePng(canvas, name) {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  await window.labHost.save(name, new Uint8Array(await blob.arrayBuffer()));
}

// Colour samples and snapshots from a decoded picture shown at `t`.
async function takeFromImage(image, width, height, t, request, result) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const img = ctx.getImageData(0, 0, width, height);
  for (const s of request.samples ?? []) {
    if (Math.abs(s.t - t) > 1e-6) continue;
    result.colours.push({ t: s.t, colours: s.points.map((p) => average(img.data, width, height, Math.round(p.x), Math.round(p.y))) });
  }
  for (const s of request.snapshots ?? []) {
    if (Math.abs(s.t - t) > 1e-6) continue;
    await savePng(canvas, s.name);
    result.snapshots.push(s.name);
  }
}

// ------------------------------------------------------------------ WebM

async function inspectWebm(url, request = {}) {
  const buffer = await readFile(url, 'the export');
  const bytes = new Uint8Array(buffer);
  const file = parseWebm(bytes);
  const video = file.tracks.find((t) => t.type === 'video');
  const audio = file.tracks.find((t) => t.type === 'audio');
  const blocksOf = (track) => file.blocks.filter((b) => b.track === track.number);
  const vblocks = blocksOf(video);
  const result = {
    duration: file.duration, videoCodec: video.codec, audioCodec: audio?.codec ?? null,
    width: video.width, height: video.height, blocks: vblocks.length,
    blockTimes: vblocks.map((b) => b.time), keyframes: vblocks.filter((b) => b.key).length,
    frames: 0, timestamps: [], colours: [], snapshots: [], hasAudio: Boolean(audio)
  };

  // Every wanted time takes the last frame at or before it.
  const wanted = [...(request.samples ?? []), ...(request.snapshots ?? [])].map((s) => s.t);
  const frames = [];
  let error = null;
  const decoder = new VideoDecoder({
    output: (frame) => { frames.push(frame); },
    error: (e) => { error = e; }
  });
  decoder.configure({ codec: 'vp09.00.41.08', codedWidth: video.width, codedHeight: video.height });
  const settle = async () => {
    while (frames.length) {
      const frame = frames.shift();
      result.frames++;
      result.timestamps.push(frame.timestamp);
      const t = frame.timestamp / 1e6;
      for (const w of new Set(wanted)) {
        if (Math.abs(w - t) < 0.5 / 60) await takeFromImage(frame, video.width, video.height, w, request, result);
      }
      frame.close();
    }
  };
  for (const b of vblocks) {
    decoder.decode(new EncodedVideoChunk({
      type: b.key ? 'key' : 'delta', timestamp: Math.round(b.time * 1e6), data: bytes.subarray(b.offset, b.offset + b.size)
    }));
    while (decoder.decodeQueueSize > 8) await new Promise((resolve) => setTimeout(resolve, 1));
    await settle();
  }
  await decoder.flush();
  await settle();
  decoder.close();
  if (error) throw error;
  result.colours.sort((a, b) => a.t - b.t);

  if (audio) {
    const ablocks = blocksOf(audio);
    const planes = [];
    let rate = audio.sampleRate;
    const adec = new AudioDecoder({
      output: (data) => {
        rate = data.sampleRate;
        const ch = [];
        for (let c = 0; c < data.numberOfChannels; c++) {
          const plane = new Float32Array(data.numberOfFrames);
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          ch.push(plane);
        }
        planes.push(ch);
        data.close();
      },
      error: (e) => { error = e; }
    });
    adec.configure({ codec: 'opus', sampleRate: audio.sampleRate, numberOfChannels: audio.channels, description: audio.codecPrivate });
    for (const b of ablocks) {
      adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(b.time * 1e6), data: bytes.subarray(b.offset, b.offset + b.size) }));
    }
    await adec.flush();
    adec.close();
    if (error) throw error;
    const total = planes.reduce((n, p) => n + p[0].length, 0);
    const left = new Float32Array(total);
    const right = new Float32Array(total);
    let at = 0;
    for (const p of planes) { left.set(p[0], at); right.set(p[1] ?? p[0], at); at += p[0].length; }
    // Players skip the Opus pre-skip given in the codec private data (OpusHead).
    const preSkip = audio.codecPrivate ? audio.codecPrivate[10] | (audio.codecPrivate[11] << 8) : 0;
    const l = left.subarray(preSkip);
    const r = right.subarray(preSkip);
    result.audio = {
      sampleRate: rate, channels: audio.channels, preSkip, duration: l.length / rate, packets: ablocks.length,
      windows: (request.sound ?? []).map(({ from, to }) => {
        const a = Math.round(from * rate);
        const b = Math.min(l.length, Math.round(to * rate));
        return { from, to, rms: rms(l, a, b), rmsRight: rms(r, a, b), frequency: frequency(l, a, b, rate) };
      })
    };
    if (request.onsetAfter !== undefined) {
      let i = Math.round(request.onsetAfter * rate);
      while (i < l.length && Math.abs(l[i]) < 0.05) i++;
      result.audio.onset = i < l.length ? i / rate : null;
    }
  }
  return result;
}

// ------------------------------------------------------------------ GIF

async function inspectGif(url, request = {}) {
  const buffer = await readFile(url, 'the export');
  const parsed = parseGif(new Uint8Array(buffer));
  const decoder = new ImageDecoder({ type: 'image/gif', data: buffer });
  await decoder.tracks.ready;
  await decoder.completed;
  const track = decoder.tracks.selectedTrack;
  const result = {
    width: parsed.width, height: parsed.height, frames: parsed.frames.length, loops: parsed.loops,
    delays: parsed.frames.map((f) => f.delayCs), localPalettes: parsed.frames.filter((f) => f.localPalette).length,
    decodedFrames: track.frameCount, colours: [], snapshots: []
  };
  // The frame showing at t, from the delays.
  const starts = [];
  let cs = 0;
  for (const f of parsed.frames) { starts.push(cs / 100); cs += f.delayCs; }
  const frameAt = (t) => {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1] <= t + 1e-6) i++;
    return i;
  };
  const times = [...new Set([...(request.samples ?? []), ...(request.snapshots ?? [])].map((s) => s.t))];
  for (const t of times) {
    const { image } = await decoder.decode({ frameIndex: frameAt(t) });
    await takeFromImage(image, parsed.width, parsed.height, t, request, result);
    image.close();
  }
  decoder.close();
  result.colours.sort((a, b) => a.t - b.t);
  return result;
}

// ------------------------------------------------------------------ fixtures

// A long page of small text scrolling fast, with the colour of a band
// changing: busy like a real scroll, so a size limit really has to bite.
async function makeBusyRecording({ name, width = 1280, height = 720, duration = 10, fps = 30 }) {
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width, height, frameRate: fps }, fastStart: false, firstTimestampBehavior: 'offset' });
  let error = null;
  const encoder = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { error = e; } });
  encoder.configure({ codec: 'avc1.640028', width, height, bitrate: 12e6, framerate: fps, avc: { format: 'avc' } });
  const count = Math.round(duration * fps);
  const step = 6;
  const page = new OffscreenCanvas(width, height + count * step);
  const pc = page.getContext('2d', { alpha: false });
  pc.fillStyle = '#ffffff';
  pc.fillRect(0, 0, page.width, page.height);
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  const words = ['export', 'video', 'the', 'screen', 'recorder', 'zoom', 'loupe', 'a', 'of', 'settings', 'quality', 'balanced', 'share', 'link'];
  pc.font = '14px sans-serif';
  for (let y = 18; y < page.height; y += 19) {
    pc.fillStyle = `hsl(${Math.floor(rand() * 360)}, 60%, 30%)`;
    let line = '';
    while (pc.measureText(line).width < width - 40) line += `${words[Math.floor(rand() * words.length)]} `;
    pc.fillText(line, 20, y);
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  for (let k = 0; k < count; k++) {
    ctx.drawImage(page, 0, -k * step);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((k / fps) * 1e6) });
    encoder.encode(frame, { keyFrame: k % fps === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 4) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await encoder.flush();
  encoder.close();
  if (error) throw error;
  muxer.finalize();
  await window.labHost.save(name, new Uint8Array(target.buffer));
  return { frames: count, bytes: target.buffer.byteLength };
}

window.exportLab = { inspectWebm, inspectGif, makeBusyRecording };
