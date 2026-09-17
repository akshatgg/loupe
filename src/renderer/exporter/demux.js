// Reading a recording: fetch the .mov/.mp4 (file:// works from this page),
// parse it with mp4box.js, and describe its video and sound tracks in the
// terms WebCodecs wants -- a decoder config and a list of samples.
//
// The whole file is held in memory and samples are views into it, so nothing
// is copied per frame. Recordings are compressed screen video (tens of MB a
// minute), which keeps that affordable.

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
    buffer,
    video: tracks.find((t) => t.kind === 'video') ?? null,
    audio: tracks.find((t) => t.kind === 'audio') ?? null
  };
}

export function sampleData(buffer, sample) {
  return new Uint8Array(buffer, sample.offset, sample.size);
}
