// Reading webcam.webm: the webcam bubble records it with MediaRecorder
// (src/renderer/camera), which writes a live WebM -- the Segment and every
// Cluster have "unknown" sizes and there are no Cues. So instead of seeking
// with a <video> (slow and not frame-exact without Cues), the whole file is
// walked once here and its video frames listed in the same shape demux.js
// gives for MP4, so the export decodes them with the same VideoSource.
//
//   demuxWebm(buffer) -> { buffer, video: { codec, width, height,
//     description, samples: [{ time, duration, key, offset, size }] } | null }
//
// Only what a MediaRecorder or ffmpeg video track needs is read: the first
// video track, SimpleBlocks and BlockGroups without lacing.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb
};

// Elements that sit directly in the Segment: meeting one ends a Cluster of
// unknown size.
const SEGMENT_CHILDREN = new Set([
  0x114d9b74, // SeekHead
  ID.Info, ID.Tracks, ID.Cluster,
  0x1c53bb6b, // Cues
  0x1043a770, // Chapters
  0x1254c367, // Tags
  0x1941a469 // Attachments
]);

function readVint(bytes, pos, { keepMarker }) {
  if (pos >= bytes.length) return null;
  const first = bytes[pos];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || pos + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[pos + i];
    if (bytes[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

// An element header at pos: { id, size (null when unknown), data }.
function header(bytes, pos) {
  const id = readVint(bytes, pos, { keepMarker: true });
  if (!id || id.length > 4) return null;
  const size = readVint(bytes, pos + id.length, { keepMarker: false });
  if (!size) return null;
  return { id: id.value, size: size.unknown ? null : size.value, data: pos + id.length + size.length };
}

function uint(bytes, pos, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + bytes[pos + i];
  return v;
}

function text(bytes, pos, len) {
  let s = '';
  for (let i = 0; i < len && bytes[pos + i] !== 0; i++) s += String.fromCharCode(bytes[pos + i]);
  return s;
}

const hex2 = (n) => n.toString(16).padStart(2, '0');

// A WebM codec id as a WebCodecs codec string.
export function codecString(codecId, priv) {
  switch (codecId) {
    case 'V_VP8': return 'vp8';
    // Profile 0, level 1.0, 8-bit: what Chromium's recorder makes; decoders
    // read the real values from the stream.
    case 'V_VP9': return 'vp09.00.10.08';
    case 'V_AV1': return 'av01.0.04M.08';
    case 'V_MPEG4/ISO/AVC':
      return priv && priv.length >= 4 ? `avc1.${hex2(priv[1])}${hex2(priv[2])}${hex2(priv[3])}` : null;
    default: return null;
  }
}

function readTrack(bytes, start, end) {
  const t = { number: 0, type: 0, codecId: '', priv: null, width: 0, height: 0 };
  for (let pos = start; pos < end;) {
    const el = header(bytes, pos);
    if (!el || el.size === null) break;
    const { id, data, size } = el;
    if (id === ID.TrackNumber) t.number = uint(bytes, data, size);
    else if (id === ID.TrackType) t.type = uint(bytes, data, size);
    else if (id === ID.CodecID) t.codecId = text(bytes, data, size);
    else if (id === ID.CodecPrivate) t.priv = bytes.subarray(data, data + size);
    else if (id === ID.Video) {
      for (let p = data; p < data + size;) {
        const v = header(bytes, p);
        if (!v || v.size === null) break;
        if (v.id === ID.PixelWidth) t.width = uint(bytes, v.data, v.size);
        if (v.id === ID.PixelHeight) t.height = uint(bytes, v.data, v.size);
        p = v.data + v.size;
      }
    }
    pos = data + size;
  }
  return t;
}

export function demuxWebm(buffer) {
  const bytes = new Uint8Array(buffer);
  const ebml = header(bytes, 0);
  if (!ebml || ebml.id !== ID.EBML || ebml.size === null) throw new Error('This isn’t a WebM file.');
  let pos = ebml.data + ebml.size;
  const seg = header(bytes, pos);
  if (!seg || seg.id !== ID.Segment) throw new Error('This WebM file has no content.');
  const segEnd = seg.size === null ? bytes.length : Math.min(bytes.length, seg.data + seg.size);

  let scale = 1000000;
  let track = null;
  const blocks = [];
  let clusterTime = 0;
  let clusterEnd = -1;
  pos = seg.data;

  const addBlock = (data, size, key) => {
    const num = readVint(bytes, data, { keepMarker: false });
    if (!num || !track || num.value !== track.number || size < num.length + 3) return;
    const at = data + num.length;
    const rel = ((bytes[at] << 8) | bytes[at + 1]) << 16 >> 16;
    const flags = bytes[at + 2];
    if (flags & 0x06) return; // laced: not something a video recorder writes
    const offset = at + 3;
    const end = data + size;
    if (end > bytes.length) return; // cut off mid-frame (a recording that stopped abruptly)
    blocks.push({ tc: clusterTime + rel, key: key ?? Boolean(flags & 0x80), offset, size: end - offset });
  };

  while (pos < segEnd) {
    const el = header(bytes, pos);
    if (!el) break;
    // Leaving an unknown-size Cluster: the next Segment-level element.
    if (clusterEnd === Infinity && SEGMENT_CHILDREN.has(el.id)) clusterEnd = -1;
    const end = el.size === null ? Infinity : el.data + el.size;
    if (el.id === ID.Cluster) {
      clusterEnd = end;
      clusterTime = 0;
      pos = el.data;
      continue;
    }
    if (el.id === ID.Info && el.size !== null) {
      for (let p = el.data; p < end;) {
        const c = header(bytes, p);
        if (!c || c.size === null) break;
        if (c.id === ID.TimecodeScale) scale = uint(bytes, c.data, c.size) || scale;
        p = c.data + c.size;
      }
    } else if (el.id === ID.Tracks && el.size !== null) {
      for (let p = el.data; p < end;) {
        const c = header(bytes, p);
        if (!c || c.size === null) break;
        if (c.id === ID.TrackEntry && !track) {
          const t = readTrack(bytes, c.data, c.data + c.size);
          if (t.type === 1) track = t;
        }
        p = c.data + c.size;
      }
    } else if (el.id === ID.Timecode && clusterEnd !== -1) {
      clusterTime = uint(bytes, el.data, el.size);
    } else if (el.id === ID.SimpleBlock && clusterEnd !== -1) {
      addBlock(el.data, el.size, null);
    } else if (el.id === ID.BlockGroup && clusterEnd !== -1 && el.size !== null) {
      let block = null;
      let referenced = false;
      for (let p = el.data; p < end;) {
        const c = header(bytes, p);
        if (!c || c.size === null) break;
        if (c.id === ID.Block) block = c;
        if (c.id === ID.ReferenceBlock) referenced = true;
        p = c.data + c.size;
      }
      if (block) addBlock(block.data, block.size, !referenced);
    }
    if (el.size === null) break; // an unknown size we can't step over
    pos = el.data + el.size;
    if (clusterEnd !== -1 && clusterEnd !== Infinity && pos >= clusterEnd) clusterEnd = -1;
  }

  if (!track) return { buffer, video: null };
  const codec = codecString(track.codecId, track.priv);
  if (!codec) throw new Error(`The webcam video uses a format Loupe can’t read (${track.codecId}).`);
  const seconds = scale / 1e9;
  const byTime = blocks.map((b, i) => i).sort((a, b) => blocks[a].tc - blocks[b].tc);
  const durations = new Array(blocks.length);
  byTime.forEach((bi, k) => {
    const next = byTime[k + 1];
    durations[bi] = next !== undefined ? (blocks[next].tc - blocks[bi].tc) * seconds : 1 / 30;
  });
  const samples = blocks.map((b, i) => ({
    time: b.tc * seconds, duration: Math.max(0, durations[i]), key: b.key, offset: b.offset, size: b.size
  }));
  return {
    buffer,
    video: {
      kind: 'video', codec, width: track.width, height: track.height,
      description: track.codecId === 'V_MPEG4/ISO/AVC' ? track.priv : undefined,
      samples
    }
  };
}
