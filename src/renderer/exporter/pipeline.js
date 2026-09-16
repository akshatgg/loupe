// One export, start to finish (docs/EDITOR-V2.md section 6): read and demux
// every recording the timeline uses, mix the sound, then for each output frame
// fetch the source picture, draw it with the same compositor as the editor
// preview, and encode and mux it -- H.264/HEVC + AAC into MP4, VP9 + Opus into
// WebM, or 256-colour frames into a GIF. The file comes out as positioned byte
// ranges through `write`, which the page hands to the main process.
//
//   exportProject(job, { write, progress, signal }) -> summary
//
// job = {
//   project,                       // v2 project (validated again here)
//   sources: { [key]: { video, cursor, systemAudio, webcam, keys } },  // file:// URLs or null
//   background,                    // file:// URL of a background image, or null
//   audioFiles: { music, voiceover: { [takeId]: url } },  // file:// URLs or null
//   format, resolution, codec, quality, fps, sizeLimit, gifWidth, gifFps, dither
// }
//
// With a size limit the video is encoded at the bitrate the limit allows.
// Encoders only roughly keep to a bitrate, and each has a floor below which
// it won't go however low the target, so an export that comes out too big is
// encoded again: first at a proportionally lower bitrate, then at 30 frames a
// second, then smaller. Each pass is written over the last from byte 0 (main
// cuts the file to the final pass's length, summary.bytes).

import { loadProjectData } from '../../core/project.js';
import { buildTimeline } from '../../core/timeline.js';
import { drawFrame } from '../../core/compose.js';
import { outputSize, outputFps, videoBitrate, MB } from '../../core/export-plan.js';
import { parseCursorTrack } from '../../core/cursor.js';
import { renderProjectAudio } from '../../core/audio/project-audio.js';
import { isWav, parseWav } from '../../core/audio/wav.js';
import { Muxer as Mp4Muxer, StreamTarget as Mp4Target } from '../../vendor/mp4-muxer/mp4-muxer.mjs';
import { Muxer as WebmMuxer, StreamTarget as WebmTarget } from '../../vendor/webm-muxer/webm-muxer.mjs';
import { readFile, demux } from './demux.js';
import { openVideoSource } from './video-source.js';
import { openVisuals } from './visuals.js';
import { decodeAudioTrack, decodeAudioFile, encodeAudio } from './audio.js';
import { chooseVideoConfig, AUDIO_RATE, AUDIO_CHANNELS, KEYFRAME_SECONDS } from './encode.js';
import { createGifWriter } from './gif.js';

const WRITE_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_WRITES = 4;
const MAX_ENCODE_QUEUE = 6;
const PROGRESS_EVERY_MS = 100;
// How far ahead of the video the sound may be written: players read a file
// front to back, so the two are kept roughly side by side in it.
const AUDIO_LEAD_US = 500000;
// The steps tried, in order, to get under a size limit (each with up to two
// bitrate passes), and how far under the limit a retry aims.
const LIMIT_STEPS = [{ maxFps: Infinity, scale: 1 }, { maxFps: 30, scale: 1 }, { maxFps: 30, scale: 0.75 }, { maxFps: 24, scale: 0.5 }];
const PASSES_PER_STEP = 2;
const LIMITED_KEYFRAME_SECONDS = 10;
const RETRY_MARGIN = 0.9;
const JOB_EXPORT_KEYS = ['format', 'resolution', 'codec', 'quality', 'fps', 'sizeLimit', 'gifWidth', 'gifFps', 'dither'];

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function labelOf(key, count) {
  return count > 1 ? `the recording "${key}"` : 'the recording';
}

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('Export cancelled.');
}

async function loadImage(url) {
  const blob = new Blob([await readFile(url, 'the background image')]);
  return createImageBitmap(blob);
}

async function openSources(job, project, keys, report, { sound = true } = {}) {
  const opened = {};
  const decoded = { mic: {}, system: {} };
  for (const [i, key] of keys.entries()) {
    const label = labelOf(key, keys.length);
    const files = job.sources?.[key];
    if (!files?.video) throw new Error(`Couldn't find the video for ${label}.`);
    report({ phase: 'reading', source: i, sources: keys.length });
    const demuxed = demux(await readFile(files.video, label));
    const video = await openVideoSource(demuxed, label);
    let cursor = null;
    if (files.cursor) {
      // A recording without a cursor track still exports, just without the
      // cursor drawn in.
      cursor = parseCursorTrack(await readFile(files.cursor, `the cursor track of ${label}`).catch(() => new ArrayBuffer(0)));
    }
    opened[key] = { video, cursor, demuxed };
    // A GIF has no sound, so none is decoded.
    if (!sound) continue;
    if (project.sources[key].mic && demuxed.audio && !project.audio.mic.muted) {
      decoded.mic[key] = await decodeAudioTrack(demuxed, label);
    }
    if (files.systemAudio && !project.audio.system.muted) {
      const what = `the system sound of ${label}`;
      const bytes = await readFile(files.systemAudio, what);
      // Windows records it as system.wav, which WebCodecs has no decoder for.
      const pcm = isWav(bytes) ? parseWav(bytes) : await decodeAudioTrack(demux(bytes), what);
      if (pcm) decoded.system[key] = pcm;
    }
  }
  return { opened, decoded };
}

// The music and voiceover takes the project uses. A take whose file is gone
// is left out rather than failing the export; music the person chose is
// expected, so a file that can't be read is an error they should see.
async function openAddedSound(job, project) {
  const files = job.audioFiles ?? {};
  let music = null;
  if (project.audio.music) {
    if (!files.music) throw new Error("Couldn't find the music file. Remove the music or add it again.");
    music = await decodeAudioFile(await readFile(files.music, 'the music'), 'the music');
  }
  const voiceover = {};
  for (const take of project.audio.voiceover) {
    const url = files.voiceover?.[take.id];
    if (!url) continue;
    voiceover[take.id] = await decodeAudioFile(await readFile(url, 'a voiceover'), 'a voiceover');
  }
  return { music, voiceover };
}

// Bytes to main, in order, with a little backpressure so a slow disk doesn't
// pile the whole file up in this page's memory. `end` is the file length
// written so far.
function createWriter(write) {
  const state = {
    writing: Promise.resolve(), pending: 0, failure: null, end: 0,
    send(position, data) {
      const bytes = data.slice();
      state.end = Math.max(state.end, position + bytes.byteLength);
      state.pending++;
      state.writing = state.writing.then(() => write(position, bytes)).catch((e) => { state.failure ??= e; })
        .finally(() => { state.pending--; });
      return state.writing;
    }
  };
  return state;
}

function createMuxer(format, { onData, video, width, height, fps, audio }) {
  if (format === 'webm') {
    return new WebmMuxer({
      target: new WebmTarget({ chunked: true, chunkSize: WRITE_CHUNK_BYTES, onData }),
      video: { codec: video.muxCodec, width, height, frameRate: fps },
      audio: audio ? { codec: 'A_OPUS', sampleRate: AUDIO_RATE, numberOfChannels: AUDIO_CHANNELS } : undefined,
      firstTimestampBehavior: 'offset'
    });
  }
  return new Mp4Muxer({
    target: new Mp4Target({ chunked: true, chunkSize: WRITE_CHUNK_BYTES, onData }),
    video: { codec: video.muxCodec, width, height, frameRate: fps },
    audio: audio ? { codec: 'aac', sampleRate: AUDIO_RATE, numberOfChannels: AUDIO_CHANNELS } : undefined,
    fastStart: false,
    firstTimestampBehavior: 'offset'
  });
}

// Draws output frames in order: onFrame(canvas, ctx, k) after each.
async function renderFrames({ plan, opened, visuals, project, tl, fps, width, height, assets, signal, progress, readPixels }, onFrame) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: readPixels });
  let lastReport = 0;
  for (let k = 0; k < plan.length; k++) {
    checkAbort(signal);
    const { source, t } = plan[k];
    // Webcam, and the other side of a crossfade (exporter/visuals.js).
    const extra = await visuals.extraFrames(k / fps, tl, plan[k]);
    const picture = await opened[source].video.frameAt(t);
    drawFrame(ctx, {
      project, tl, outT: k / fps, frames: { ...extra, [source]: picture }, size: { width, height }, assets
    });
    await onFrame(canvas, ctx, k);
    const now = performance.now();
    if (now - lastReport > PROGRESS_EVERY_MS || k === plan.length - 1) {
      lastReport = now;
      progress({ phase: 'video', frame: k + 1, total: plan.length });
    }
  }
}

// One pass of a video format at `bitrate` -> { encoded, bytes, config, hardware }.
async function encodeVideoPass(ctx) {
  const { exp, fps, width, height, plan, audioChunks, write, bitrate, pass } = ctx;
  const video = await chooseVideoConfig({
    format: exp.format, codec: exp.codec, width, height, fps, quality: exp.quality,
    bitrate
  });
  const out = createWriter(write);
  const muxer = createMuxer(exp.format, {
    onData: (data, position) => out.send(position, data),
    video, width, height, fps, audio: audioChunks.length > 0
  });

  let nextAudio = 0;
  const addAudioUpTo = (timestamp) => {
    while (nextAudio < audioChunks.length && audioChunks[nextAudio].chunk.timestamp <= timestamp) {
      const { chunk, meta } = audioChunks[nextAudio++];
      muxer.addAudioChunk(chunk, meta);
    }
  };

  let encoded = 0;
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addVideoChunk(chunk, meta);
        encoded++;
        addAudioUpTo(chunk.timestamp + AUDIO_LEAD_US);
      } catch (e) {
        failure ??= e;
      }
    },
    error: (e) => { failure ??= e; }
  });
  encoder.configure(video.config);

  const frameUs = 1e6 / fps;
  // A keyframe costs many times an ordinary frame; under a size limit they
  // come less often, leaving the bits for the picture.
  const keyEvery = Math.max(1, Math.round((exp.sizeLimit ? LIMITED_KEYFRAME_SECONDS : KEYFRAME_SECONDS) * fps));
  const failed = (e) => new Error(`Couldn't encode the video (${e.message ?? e}).`);
  const report = pass > 0
    // A retry shows its progress as the second half of the bar.
    ? (p) => ctx.progress(p.phase === 'video' ? { ...p, pass } : p)
    : ctx.progress;

  try {
    await renderFrames({ ...ctx, progress: report, readPixels: false }, async (canvas, _c, k) => {
      if (failure) throw failed(failure);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(k * frameUs), duration: Math.round(frameUs) });
      encoder.encode(frame, { keyFrame: k % keyEvery === 0 });
      frame.close();
      while ((encoder.encodeQueueSize > MAX_ENCODE_QUEUE || out.pending > MAX_PENDING_WRITES) && !failure) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    });
    await encoder.flush();
    if (failure) throw failed(failure);
    addAudioUpTo(Infinity);
    muxer.finalize();
    await out.writing;
    if (out.failure) throw out.failure;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  return { encoded, bytes: out.end, config: video.config, hardware: video.hardware, frames: plan.length };
}

async function encodeGif(ctx) {
  const { exp, fps, width, height, plan, write } = ctx;
  const out = createWriter(write);
  const gif = createGifWriter({
    width, height, fps, dither: exp.dither,
    write: (position, bytes) => out.send(position, bytes)
  });
  await renderFrames({ ...ctx, readPixels: true }, async (_canvas, c, k) => {
    await gif.addFrame(c.getImageData(0, 0, width, height).data, k);
    if (out.failure) throw out.failure;
  });
  const result = await gif.finish(plan.length);
  await out.writing;
  if (out.failure) throw out.failure;
  return { encoded: result.frames, bytes: out.end, palettes: result.palettes, frames: plan.length, config: { codec: 'gif' }, hardware: false };
}

export async function exportProject(job, { write, progress = () => {}, signal } = {}) {
  const started = performance.now();
  const project = loadProjectData(job.project);
  const exp = { ...project.export };
  for (const key of JOB_EXPORT_KEYS) if (job[key] !== undefined) exp[key] = job[key];
  const tl = buildTimeline(project);
  const fps = outputFps(exp);
  const plan = tl.framePlan(fps);
  const { width, height } = outputSize(project, exp);
  const gif = exp.format === 'gif';

  const keys = [...new Set(project.clips.map((c) => c.source))];
  const { opened, decoded } = await openSources(job, project, keys, progress, { sound: !gif });
  checkAbort(signal);

  let visuals = null;
  try {
    visuals = await openVisuals(job, project, keys, {
      openRecording: (k) => openVideoSource(opened[k].demuxed, labelOf(k, keys.length))
    });
    const assets = {
      ...visuals.assets,
      cursors: Object.fromEntries(keys.map((k) => [k, opened[k].cursor])),
      background: project.style.background.type === 'image' && job.background
        ? await loadImage(job.background).catch(() => null) : null
    };
    const ctx = { exp, project, tl, fps, plan, width, height, opened, visuals, assets, signal, progress, write };

    let result;
    let audioChunks = [];
    let passes = 1;
    let cleanUp = 'none';
    let made = { width, height, fps };
    if (gif) {
      result = await encodeGif(ctx);
    } else {
      progress({ phase: 'sound' });
      // Clean-up, levelling, music with ducking and voiceovers: the same
      // renderer the editor's preview plays (core/audio/project-audio.js).
      const added = await openAddedSound(job, project);
      checkAbort(signal);
      let lastSound = 0;
      const rendered = await renderProjectAudio(project, tl, { ...decoded, ...added }, {
        onProgress: (fraction) => {
          const now = performance.now();
          if (now - lastSound > PROGRESS_EVERY_MS || fraction === 1) {
            lastSound = now;
            progress({ phase: 'sound', fraction });
          }
        }
      });
      const mix = rendered.mix;
      cleanUp = rendered.cleanUp ?? 'none';
      audioChunks = mix ? await encodeAudio(mix, { signal, format: exp.format }) : [];
      checkAbort(signal);
      const audio = audioChunks.length > 0;
      const limit = exp.sizeLimit ? exp.sizeLimit * MB : Infinity;
      passes = 0;
      let lastBitrate = Infinity;
      steps: for (const step of exp.sizeLimit ? LIMIT_STEPS : LIMIT_STEPS.slice(0, 1)) {
        const stepFps = Math.min(fps, step.maxFps);
        const size = { width: even(width * step.scale), height: even(height * step.scale) };
        if (passes > 0 && stepFps === made.fps && size.width === made.width) continue;
        const stepPlan = stepFps === fps ? plan : tl.framePlan(stepFps);
        // A smaller step never aims higher than the last try that was too big.
        let bitrate = Math.min(lastBitrate, videoBitrate(exp, { ...size, fps: stepFps, duration: tl.duration, audio }));
        for (let i = 0; i < PASSES_PER_STEP; i++) {
          made = { ...size, fps: stepFps };
          result = await encodeVideoPass({ ...ctx, ...size, fps: stepFps, plan: stepPlan, audioChunks, bitrate, pass: passes });
          result.bitrate = bitrate;
          passes++;
          lastBitrate = bitrate;
          if (result.bytes <= limit) break steps;
          bitrate = Math.max(50000, Math.floor(bitrate * (limit / result.bytes) * RETRY_MARGIN));
        }
      }
      if (result.bytes > limit) {
        throw new Error(`This video won’t fit in ${exp.sizeLimit} MB (the smallest try was ${(result.bytes / MB).toFixed(1)} MB). Try a bigger limit, or trim the video first.`);
      }
    }

    const seconds = (performance.now() - started) / 1000;
    return {
      format: exp.format, frames: result.frames, encoded: result.encoded, ...made, duration: tl.duration,
      codec: result.config.codec, hardware: result.hardware, audio: audioChunks.length > 0, cleanUp,
      bytes: result.bytes, passes, ...(result.bitrate ? { bitrate: result.bitrate } : {}),
      ...(gif ? { palettes: result.palettes } : {}),
      seconds, speed: seconds > 0 ? tl.duration / seconds : 0
    };
  } finally {
    for (const k of keys) opened[k].video.close();
    visuals?.close();
  }
}
