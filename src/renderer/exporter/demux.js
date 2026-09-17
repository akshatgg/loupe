// Reading a recording: fetch the .mov/.mp4 (file:// works from this page),
// parse it with mp4box.js, and describe its video and sound tracks in the
// terms WebCodecs wants -- a decoder config and a list of samples.
//
// openRecording(url) reads only the file's index (every top-level box but
// the media data) and then the samples' bytes as they are needed, a few MB
// at a time with ranged reads: a 20-minute 4K recording is gigabytes, far
// more than a page should hold at once. demux(buffer) does the same for a
// file already in memory (exports being checked, small audio files). Either
// way `demuxed.read(sample)` gives a sample's bytes.

import { createFile, DataStream, Endianness } from '../../vendor/mp4box/mp4box.all.mjs';

export async function readFile(url, label = 'a recording') {
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(`Couldn't open ${label}. Is the file still there?`);
  }
  if (!response.ok) throw new Error(`Couldn't open ${label}. Is the file still there?`);
  return response.arrayBuffer();
}

// Bytes [start, start + length) of the file at `url` (fewer at its end).
// A range starting at or past the end fails outright (there is no way to ask
// a file:// URL its size first): with `pastEnd` that reads as nothing.
async function readRange(url, start, length, label, { pastEnd = false } = {}) {
  let response;
  try {
    response = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` } });
  } catch {
    if (pastEnd) return new ArrayBuffer(0);
    throw new Error(`Couldn't open ${label}. Is the file still there?`);
  }
  if (!response.ok) throw new Error(`Couldn't open ${label}. Is the file still there?`);
  const bytes = await response.arrayBuffer();
  // Should the range ever be ignored, the part wanted is still what's used.
  return bytes.byteLength > length ? bytes.slice(start, start + length) : bytes;
}

const MB = 1024 * 1024;
// How much is read at a time around a sample: the next samples are usually
// right after it. A few windows are kept for a decoder reset or two sources
// reading the same file.
const READ_WINDOW = 8 * MB;
const KEEP_WINDOWS = 4;
// Boxes other than media data are the index: small, even for long recordings.
const MAX_INDEX_BOX = 512 * MB;
const MEDIA_BOXES = new Set(['mdat', 'free', 'skip', 'wide']);

const fourCC = (view, at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

// `readWindow` is how much to read at a time (smaller in the checks).
export async function openRecording(url, label = 'a recording', { readWindow = READ_WINDOW } = {}) {
  const index = [];
  let at = 0;
  let hasMoov = false;
  for (let n = 0; n < 100000; n++) {
    const head = new DataView(await readRange(url, at, 16, label, { pastEnd: at > 0 }));
    if (head.byteLength < 8) break;
    let size = head.getUint32(0);
    const type = fourCC(head, 4);
    if (size === 1 && head.byteLength >= 16) size = Number(head.getBigUint64(8));
    else if (size === 0) size = Infinity; // runs to the end of the file
    if (size < 8) break;
    if (!MEDIA_BOXES.has(type)) {
      if (size > MAX_INDEX_BOX) break;
      index.push(new Uint8Array(await readRange(url, at, size, label)));
      if (type === 'moov') hasMoov = true;
    }
    if (!Number.isFinite(size)) break;
    at += size;
  }
  // A file laid out some other way (fragments, a damaged index) is read
  // whole, as before.
  if (!hasMoov) return demux(await readFile(url, label));

  // The index boxes alone parse as a file: sample offsets come from the
  // index, so they still point into the real file.
  const joined = new Uint8Array(index.reduce((n, b) => n + b.byteLength, 0));
  let pos = 0;
  for (const b of index) { joined.set(b, pos); pos += b.byteLength; }
  const parsed = parse(joined.buffer);

  const windows = [];
  async function read(sample) {
    const end = sample.offset + sample.size;
    let w = windows.find((x) => x.start <= sample.offset && x.start + x.bytes.byteLength >= end);
    if (!w) {
      const bytes = new Uint8Array(await readRange(url, sample.offset, Math.max(readWindow, sample.size), label, { pastEnd: true }));
      if (bytes.byteLength < sample.size) throw new Error(`The video file of ${label} ends early. It may be damaged.`);
      w = { start: sample.offset, bytes };
      windows.push(w);
      if (windows.length > KEEP_WINDOWS) windows.shift();
    }
    return w.bytes.subarray(sample.offset - w.start, end - w.start);
  }
  return { ...parsed, read };
}

// The config record (avcC, hvcC) as WebCodecs' `description`: the box
// without its 8-byte header.
function boxPayload(box) {
  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  box.write(stream);
  return new Uint8Array(stream.buffer, 8);
}

// QuickTime files (.mov) keep the AAC config inside a 'wave' box.
function aacConfig(entry) {
  const esds = entry.esds ?? entry.wave?.esds ?? entry.wave?.boxes?.find((b) => b.type === 'esds');
  const decoderConfig = esds?.esd?.descs?.find((d) => d.tag === 4);
  const specific = decoderConfig?.descs?.find((d) => d.tag === 5);
  return specific?.data ? new Uint8Array(specific.data) : undefined;
}

// Seconds of presentation time before a track's first sample: the edit list
// can start with an empty edit (a delay) and then skip into the media (AAC
// encoder priming, B-frame reordering). Recording time 0 is the movie's 0.
function editOffsets(trak, movieTimescale, timescale) {
  let delay = 0;
  let skip = 0;
  for (const e of trak.edts?.elst?.entries ?? []) {
    if (e.media_time === -1) {
      delay += e.segment_duration / movieTimescale;
      continue;
    }
    skip = e.media_time / timescale;
    break;
  }
  return { delay, skip };
}

function describeTrack(file, info, t) {
  const trak = file.getTrackById(t.id);
  const entry = trak.mdia.minf.stbl.stsd.entries[0];
  const timescale = t.timescale;
  const { delay, skip } = editOffsets(trak, info.timescale, timescale);
  const samples = trak.samples.map((s) => ({
    time: s.cts / timescale - skip + delay,
    dts: s.dts,
    duration: s.duration / timescale,
    key: s.is_sync,
    offset: s.offset,
    size: s.size
  }));
  const base = { id: t.id, codec: t.codec, timescale, samples };
  if (t.video) {
    const config = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    return {
      ...base, kind: 'video', width: t.video.width, height: t.video.height,
      description: config && (entry.avcC || entry.hvcC) ? boxPayload(config) : undefined
    };
  }
  if (t.audio) {
    return {
      ...base, kind: 'audio', sampleRate: t.audio.sample_rate, channels: t.audio.channel_count,
      description: aacConfig(entry)
    };
  }
  return null;
}

export function demux(buffer) {
  return { ...parse(buffer), buffer, read: (sample) => sampleData(buffer, sample) };
}

function parse(buffer) {
  const file = createFile();
  let info = null;
  let error = null;
  file.onReady = (i) => { info = i; };
  file.onError = (e) => { error = e; };
  buffer.fileStart = 0;
  file.appendBuffer(buffer);
  file.flush();
  // mp4box's own words ("ISOFile") mean nothing to anyone: they go to the log.
  if (!info) {
    if (error) console.error('Loupe: demux failed:', error);
    throw new Error("The recording's video file is damaged and can't be read.");
  }
  const tracks = info.tracks.map((t) => describeTrack(file, info, t)).filter(Boolean);
  // The first track of each kind, as the recorder writes one of each.
  return {
    video: tracks.find((t) => t.kind === 'video') ?? null,
    audio: tracks.find((t) => t.kind === 'audio') ?? null
  };
}

export function sampleData(buffer, sample) {
  return new Uint8Array(buffer, sample.offset, sample.size);
}
