'use strict';
// What a video file is, before Loupe imports it: its length, upright size,
// frame rate, how far it is turned, and whether the editor and exporter can
// play its picture and sound.
//
//   probeVideo(file) -> { duration, width, height, fps, rotation, codec,
//                         sound: 'aac' | 'other' | null }
//
// Only the file's index is read -- every top-level box but the media data,
// as the exporter's openRecording does -- so a many-gigabyte video is
// described from a few hundred kilobytes. Errors are plain words for people.

const fs = require('node:fs');

let mp4box = null;
function loadMp4box() {
  if (!mp4box) {
    mp4box = require('../vendor/mp4box/mp4box.all.mjs');
    // Its warnings about boxes it doesn't know ('©swr' and friends) are noise.
    mp4box.Log.setLogLevel(mp4box.Log.error);
  }
  return mp4box;
}

// The codecs the exporter's VideoDecoder is asked to play; the preview's
// <video> plays them all too.
const VIDEO_CODECS = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01']);
const MEDIA_BOXES = new Set(['mdat', 'free', 'skip', 'wide']);
const MAX_INDEX_BOX = 512 * 1024 * 1024;

const NOT_VIDEO = 'That file isn’t a video Loupe can read. Loupe can open MP4 and MOV videos.';
const UNREADABLE_CODEC = 'This video is in a format Loupe can’t read (such as ProRes). ' +
  'Export it as an H.264 or HEVC MP4, then import that.';

// Clockwise quarter turns from a track's display matrix [a b u c d v x y w]
// (a..d in 16.16 fixed point). Anything that isn't a quarter turn is shown
// as it is stored.
function rotationOf(matrix) {
  if (!matrix || matrix.length < 5) return 0;
  const degrees = Math.round((Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI);
  const turn = ((degrees % 360) + 360) % 360;
  return [0, 90, 180, 270].includes(turn) ? turn : 0;
}

// The top-level boxes that aren't media data, joined: they parse as a file
// whose sample offsets still point into the real one.
async function readIndex(file) {
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    throw new Error('That video couldn’t be opened. Is the file still there?');
  }
  try {
    const { size: fileSize } = await handle.stat();
    const parts = [];
    const head = Buffer.alloc(16);
    let at = 0;
    while (at + 8 <= fileSize) {
      const { bytesRead } = await handle.read(head, 0, 16, at);
      if (bytesRead < 8) break;
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (size === 1 && bytesRead >= 16) size = Number(head.readBigUInt64BE(8));
      else if (size === 0) size = fileSize - at;
      if (size < 8 || at + size > fileSize + 8) break;
      if (!MEDIA_BOXES.has(type)) {
        if (size > MAX_INDEX_BOX) break;
        const box = Buffer.alloc(Math.min(size, fileSize - at));
        await handle.read(box, 0, box.length, at);
        parts.push(box);
      }
      at += size;
    }
    const joined = Buffer.concat(parts);
    return joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.byteLength);
  } finally {
    await handle.close();
  }
}

async function probeVideo(file) {
  const index = await readIndex(file);
  const { createFile } = loadMp4box();
  const parsed = createFile();
  let info = null;
  parsed.onReady = (i) => { info = i; };
  parsed.onError = () => {};
  index.fileStart = 0;
  try {
    parsed.appendBuffer(index);
    parsed.flush();
  } catch {
    info = null;
  }
  if (!info) throw new Error(NOT_VIDEO);
  // mp4box files a track it has no decoder name for (ProRes, DNxHD) as
  // 'metadata'; any track with a picture size is someone's video.
  const video = info.tracks.find((t) => t.type === 'video' && t.video) ??
    info.tracks.find((t) => t.track_width > 0 && t.track_height > 0);
  if (!video) throw new Error(NOT_VIDEO);
  if (video.type !== 'video' || !VIDEO_CODECS.has(String(video.codec).split('.')[0])) {
    throw new Error(UNREADABLE_CODEC);
  }

  const duration = video.movie_duration > 0
    ? video.movie_duration / info.timescale
    : video.duration / video.timescale;
  if (!(duration > 0)) throw new Error('That video has nothing in it to play.');
  // tkhd's size is the picture as shown (non-square pixels applied); the
  // coded size is the fallback.
  const w = Math.round(video.track_width || video.video.width);
  const h = Math.round(video.track_height || video.video.height);
  const rotation = rotationOf(video.matrix);
  const sideways = rotation === 90 || rotation === 270;
  const fps = Math.round((video.nb_samples / duration) * 100) / 100;

  const audio = info.tracks.find((t) => t.type === 'audio');
  // AAC is what the exporter's AudioDecoder path handles (demux.js aacConfig).
  const sound = !audio ? null : /^mp4a\.40\./.test(audio.codec) ? 'aac' : 'other';

  return {
    duration,
    width: sideways ? h : w,
    height: sideways ? w : h,
    fps: fps > 0 ? fps : 30,
    rotation,
    codec: video.codec,
    sound
  };
}

module.exports = { probeVideo, rotationOf, VIDEO_CODECS };
