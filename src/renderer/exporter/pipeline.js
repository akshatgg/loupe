// One export, start to finish (docs/EDITOR-V2.md section 6): read and demux
// every recording the timeline uses, mix the sound, then for each output frame
// fetch the source picture, draw it with the same compositor as the editor
// preview, encode, and mux. The muxed file comes out as positioned byte
// ranges through `write`, which the page hands to the main process.
//
//   exportProject(job, { write, progress, signal }) -> summary
//
// job = {
//   project,                       // v2 project (validated again here)
//   sources: { [key]: { video, cursor, systemAudio } },   // file:// URLs or null
//   background,                    // file:// URL of a background image, or null
//   audioFiles: { music, voiceover: { [takeId]: url } },  // file:// URLs or null
//   resolution, codec, quality, fps
// }

import { loadProjectData } from '../../core/project.js';
import { buildTimeline } from '../../core/timeline.js';
import { drawFrame, exportSize } from '../../core/compose.js';
import { parseCursorTrack } from '../../core/cursor.js';
import { renderProjectAudio } from '../../core/audio/project-audio.js';
import { isWav, parseWav } from '../../core/audio/wav.js';
import { Muxer, StreamTarget } from '../../vendor/mp4-muxer/mp4-muxer.mjs';
import { readFile, demux } from './demux.js';
import { openVideoSource } from './video-source.js';
import { decodeAudioTrack, decodeAudioFile, encodeAudio } from './audio.js';
import { chooseVideoConfig, AUDIO_RATE, AUDIO_CHANNELS, KEYFRAME_SECONDS } from './encode.js';

const WRITE_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_WRITES = 4;
const MAX_ENCODE_QUEUE = 6;
const PROGRESS_EVERY_MS = 100;
// How far ahead of the video the sound may be written: players read a file
// front to back, so the two are kept roughly side by side in it.
const AUDIO_LEAD_US = 500000;

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

async function openSources(job, project, keys, report) {
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
    opened[key] = { video, cursor };
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

export async function exportProject(job, { write, progress = () => {}, signal } = {}) {
  const started = performance.now();
  const project = loadProjectData(job.project);
  const tl = buildTimeline(project);
  const fps = job.fps ?? project.export.fps;
  const plan = tl.framePlan(fps);
  const { width, height } = exportSize(project, job.resolution ?? project.export.resolution);
  const codec = job.codec ?? project.export.codec;
  const quality = job.quality ?? project.export.quality;

  const keys = [...new Set(project.clips.map((c) => c.source))];
  const { opened, decoded } = await openSources(job, project, keys, progress);
  checkAbort(signal);

  const assets = {
    cursors: Object.fromEntries(keys.map((k) => [k, opened[k].cursor])),
    background: project.style.background.type === 'image' && job.background
      ? await loadImage(job.background).catch(() => null) : null
  };

  progress({ phase: 'sound' });
  // Clean-up, levelling, music with ducking and voiceovers: the same
  // renderer the editor's preview plays (core/audio/project-audio.js).
  const added = await openAddedSound(job, project);
  checkAbort(signal);
  let lastSound = 0;
  const { mix, cleanUp } = await renderProjectAudio(project, tl, { ...decoded, ...added }, {
    onProgress: (fraction) => {
      const now = performance.now();
      if (now - lastSound > PROGRESS_EVERY_MS || fraction === 1) {
        lastSound = now;
        progress({ phase: 'sound', fraction });
      }
    }
  });
  const audioChunks = mix ? await encodeAudio(mix, { signal }) : [];
  checkAbort(signal);

  const video = await chooseVideoConfig({ codec, width, height, fps, quality });

  // Bytes to main, in order, with a little backpressure so a slow disk
  // doesn't pile the whole file up in this page's memory.
  let writing = Promise.resolve();
  let pendingWrites = 0;
  let failure = null;
  const target = new StreamTarget({
    chunked: true,
    chunkSize: WRITE_CHUNK_BYTES,
    onData: (data, position) => {
      const bytes = data.slice();
      pendingWrites++;
      writing = writing.then(() => write(position, bytes)).catch((e) => { failure ??= e; })
        .finally(() => { pendingWrites--; });
    }
  });
  const muxer = new Muxer({
    target,
    video: { codec: video.muxCodec, width, height, frameRate: fps },
    audio: audioChunks.length ? { codec: 'aac', sampleRate: AUDIO_RATE, numberOfChannels: AUDIO_CHANNELS } : undefined,
    fastStart: false,
    firstTimestampBehavior: 'offset'
  });

  let nextAudio = 0;
  const addAudioUpTo = (timestamp) => {
    while (nextAudio < audioChunks.length && audioChunks[nextAudio].chunk.timestamp <= timestamp) {
      const { chunk, meta } = audioChunks[nextAudio++];
      muxer.addAudioChunk(chunk, meta);
    }
  };

  let encoded = 0;
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

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  const frameUs = 1e6 / fps;
  const keyEvery = Math.max(1, Math.round(KEYFRAME_SECONDS * fps));
  let lastReport = 0;
  const failed = (e) => new Error(`Couldn't encode the video (${e.message ?? e}).`);

  try {
    for (let k = 0; k < plan.length; k++) {
      checkAbort(signal);
      if (failure) throw failed(failure);
      const { source, t } = plan[k];
      const picture = await opened[source].video.frameAt(t);
      drawFrame(ctx, {
        project, tl, outT: k / fps, frames: { [source]: picture }, size: { width, height }, assets
      });
      const frame = new VideoFrame(canvas, { timestamp: Math.round(k * frameUs), duration: Math.round(frameUs) });
      encoder.encode(frame, { keyFrame: k % keyEvery === 0 });
      frame.close();

      while ((encoder.encodeQueueSize > MAX_ENCODE_QUEUE || pendingWrites > MAX_PENDING_WRITES) && !failure) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const now = performance.now();
      if (now - lastReport > PROGRESS_EVERY_MS || k === plan.length - 1) {
        lastReport = now;
        progress({ phase: 'video', frame: k + 1, total: plan.length });
      }
    }
    await encoder.flush();
    if (failure) throw failed(failure);
    addAudioUpTo(Infinity);
    muxer.finalize();
    await writing;
    if (failure) throw failure;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    for (const k of keys) opened[k].video.close();
  }

  const seconds = (performance.now() - started) / 1000;
  return {
    frames: plan.length, encoded, width, height, fps, duration: tl.duration,
    codec: video.config.codec, hardware: video.hardware, audio: audioChunks.length > 0,
    cleanUp: cleanUp ?? 'none',
    seconds, speed: seconds > 0 ? tl.duration / seconds : 0
  };
}
