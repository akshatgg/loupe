// Just enough of an MP4/QuickTime reader to find the AAC microphone track in
// a recording (raw.mov from AVAssetWriter on macOS, raw.mp4 from Media
// Foundation on Windows) and list where each audio frame lives.
//
// Why not read the whole file: a long recording is gigabytes of video with a
// few megabytes of audio in between. With this index the renderer reads only
// the audio bytes (fetch with a Range header) and decodes them with
// WebCodecs' AudioDecoder, a slice at a time.
//
// `read(offset, length)` -> Promise<Uint8Array> is the only I/O; it may
// return fewer bytes at the end of the file. No DOM or Node APIs here.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta']);

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(dv, o) {
  return dv.getUint32(o) * 2 ** 32 + dv.getUint32(o + 4);
}

// Child boxes of a box payload: [{ type, start, end, headerSize }], offsets
// into `bytes`.
export function listBoxes(bytes, start = 0, end = bytes.length) {
  const dv = view(bytes);
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = fourcc(bytes, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = u64(dv, p + 8);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    out.push({ type, start: p, end: p + size, headerSize: header });
    p += size;
  }
  return out;
}

function child(bytes, box, type) {
  return listBoxes(bytes, box.start + box.headerSize, box.end).find((b) => b.type === type);
}

function children(bytes, box, type) {
  return listBoxes(bytes, box.start + box.headerSize, box.end).filter((b) => b.type === type);
}

// Top-level boxes, read header by header, until `moov` is found (it is at
// the end of the file for AVAssetWriter output, before mdat for others).
export async function readMoov(read) {
  let offset = 0;
  for (let guard = 0; guard < 10000; guard++) {
    const head = await read(offset, 16);
    if (!head || head.length < 8) return null;
    const dv = view(head);
    let size = dv.getUint32(0);
    const type = fourcc(head, 4);
    if (size === 1) {
      if (head.length < 16) return null;
      size = u64(dv, 8);
    }
    if (type === 'moov') {
      if (size === 0) size = 64 * 1024 * 1024;
      const bytes = await read(offset, size);
      return bytes;
    }
    if (size === 0) return null; // runs to the end of the file and was not moov
    if (size < 8) return null;
    offset += size;
  }
  return null;
}

// --- sample tables -------------------------------------------------------

function fullBoxPayload(box) {
  return box.start + box.headerSize + 4; // version + flags
}

function parseMdhd(bytes, box) {
  const dv = view(bytes);
  const p = box.start + box.headerSize;
  const version = bytes[p];
  if (version === 1) return { timescale: dv.getUint32(p + 20), duration: u64(dv, p + 24) };
  return { timescale: dv.getUint32(p + 12), duration: dv.getUint32(p + 16) };
}

function parseMvhdTimescale(bytes, box) {
  const dv = view(bytes);
  const p = box.start + box.headerSize;
  return bytes[p] === 1 ? dv.getUint32(p + 20) : dv.getUint32(p + 12);
}

function parseHdlr(bytes, box) {
  return fourcc(bytes, box.start + box.headerSize + 8);
}

// Edit list -> presentation offset. An initial empty edit delays the track; a
// media_time skips the encoder's priming samples at the start.
function parseElst(bytes, edts, movieTimescale) {
  const elst = edts && child(bytes, edts, 'elst');
  if (!elst) return { emptySeconds: 0, mediaTime: 0, found: false };
  const dv = view(bytes);
  const p = elst.start + elst.headerSize;
  const version = bytes[p];
  const count = dv.getUint32(p + 4);
  let q = p + 8;
  let emptySeconds = 0;
  for (let i = 0; i < count; i++) {
    const segDur = version === 1 ? u64(dv, q) : dv.getUint32(q);
    const mediaTime = version === 1 ? Number(dv.getBigInt64(q + 8)) : dv.getInt32(q + 4);
    q += version === 1 ? 20 : 12;
    if (mediaTime === -1) { emptySeconds += segDur / (movieTimescale || 1); continue; }
    return { emptySeconds, mediaTime, found: true };
  }
  return { emptySeconds, mediaTime: 0, found: true };
}

// Files without an edit list (afconvert, iTunes-style .m4a) record the
// encoder priming in an "iTunSMPB" tag instead:
// " 00000000 00000840 000002CE 0000000000CCEE..." -- the second field is the
// number of priming samples, in hex. Without it every word would be ~45 ms late.
export function parseItunSmpb(moov) {
  const key = [0x69, 0x54, 0x75, 0x6e, 0x53, 0x4d, 0x50, 0x42]; // "iTunSMPB"
  outer: for (let i = 0; i + key.length <= moov.length; i++) {
    for (let k = 0; k < key.length; k++) if (moov[i + k] !== key[k]) continue outer;
    // The value is in the next "data" box: 8 header + 4 type + 4 locale.
    for (let j = i + key.length; j + 16 < moov.length && j < i + 64; j++) {
      if (fourcc(moov, j + 4) !== 'data') continue;
      const size = view(moov).getUint32(j);
      const text = String.fromCharCode(...moov.subarray(j + 16, Math.min(moov.length, j + size)));
      const fields = text.trim().split(/\s+/);
      const priming = parseInt(fields[1], 16);
      return Number.isFinite(priming) ? priming : null;
    }
    return null;
  }
  return null;
}

// MPEG-4 descriptors use a variable-length size: up to 4 bytes of 7 bits.
function readDescriptor(bytes, p, end) {
  const tag = bytes[p++];
  let size = 0;
  for (let i = 0; i < 4 && p < end; i++) {
    const b = bytes[p++];
    size = (size << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return { tag, start: p, end: Math.min(end, p + size) };
}

function parseEsds(bytes, esds) {
  let p = fullBoxPayload(esds);
  const end = esds.end;
  const es = readDescriptor(bytes, p, end);
  if (es.tag !== 0x03) return null;
  p = es.start + 2; // ES_ID
  const flags = bytes[p++];
  if (flags & 0x80) p += 2; // dependsOn_ES_ID
  if (flags & 0x40) p += 1 + bytes[p]; // URL
  if (flags & 0x20) p += 2; // OCR_ES_Id
  const dc = readDescriptor(bytes, p, es.end);
  if (dc.tag !== 0x04) return null;
  const objectType = bytes[dc.start];
  const dsi = readDescriptor(bytes, dc.start + 13, dc.end);
  if (dsi.tag !== 0x05) return { objectType, asc: null };
  return { objectType, asc: bytes.slice(dsi.start, dsi.end) };
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// AudioSpecificConfig: 5 bits object type, 4 bits rate index, 4 bits channels.
export function parseAudioSpecificConfig(asc) {
  if (!asc || asc.length < 2) return null;
  let bit = 0;
  const bits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = asc[(bit >> 3)] ?? 0;
      v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return v;
  };
  let objectType = bits(5);
  if (objectType === 31) objectType = 32 + bits(6);
  const idx = bits(4);
  const sampleRate = idx === 15 ? bits(24) : AAC_RATES[idx];
  const channels = bits(4);
  return { objectType, sampleRate, channels };
}

function findBoxDeep(bytes, start, end, type, depth = 0) {
  for (const b of listBoxes(bytes, start, end)) {
    if (b.type === type) return b;
    if (depth < 3 && (b.type === 'wave' || CONTAINERS.has(b.type))) {
      const inner = findBoxDeep(bytes, b.start + b.headerSize, b.end, type, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

function parseMp4a(bytes, entry) {
  const dv = view(bytes);
  const p = entry.start + entry.headerSize; // SampleEntry: 6 reserved + 2 data ref index
  const soundVersion = dv.getUint16(p + 8); // QuickTime sound description version
  let channels = dv.getUint16(p + 16);
  let sampleRate = dv.getUint32(p + 24) / 65536;
  let childStart = p + 28;
  if (soundVersion === 1) childStart += 16;
  if (soundVersion === 2) {
    sampleRate = dv.getFloat64(p + 32);
    channels = dv.getUint32(p + 40);
    childStart = p + 64;
  }
  const esds = findBoxDeep(bytes, childStart, entry.end, 'esds');
  const es = esds ? parseEsds(bytes, esds) : null;
  return { channels, sampleRate, es };
}

function parseSampleTables(bytes, stbl) {
  const dv = view(bytes);
  const need = (t) => {
    const b = child(bytes, stbl, t);
    return b ? fullBoxPayload(b) : -1;
  };

  // stsz: sample sizes
  let p = need('stsz');
  if (p < 0) throw new Error('No sample size table');
  const fixedSize = dv.getUint32(p);
  const count = dv.getUint32(p + 4);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixedSize || dv.getUint32(p + 8 + i * 4);

  // stco/co64: chunk offsets
  let offsets;
  p = need('stco');
  if (p >= 0) {
    const n = dv.getUint32(p);
    offsets = new Float64Array(n);
    for (let i = 0; i < n; i++) offsets[i] = dv.getUint32(p + 4 + i * 4);
  } else {
    p = need('co64');
    if (p < 0) throw new Error('No chunk offset table');
    const n = dv.getUint32(p);
    offsets = new Float64Array(n);
    for (let i = 0; i < n; i++) offsets[i] = u64(dv, p + 4 + i * 8);
  }

  // stsc: samples per chunk, run-length encoded by first chunk
  p = need('stsc');
  if (p < 0) throw new Error('No sample-to-chunk table');
  const stscN = dv.getUint32(p);
  const sampleOffsets = new Float64Array(count);
  let s = 0;
  for (let e = 0; e < stscN && s < count; e++) {
    const q = p + 4 + e * 12;
    const firstChunk = dv.getUint32(q) - 1;
    const perChunk = dv.getUint32(q + 4);
    const nextFirst = e + 1 < stscN ? dv.getUint32(q + 12) - 1 : offsets.length;
    for (let c = firstChunk; c < nextFirst && s < count; c++) {
      let off = offsets[c];
      for (let k = 0; k < perChunk && s < count; k++) {
        sampleOffsets[s] = off;
        off += sizes[s];
        s++;
      }
    }
  }

  // stts: decode times
  p = need('stts');
  if (p < 0) throw new Error('No time-to-sample table');
  const sttsN = dv.getUint32(p);
  const times = new Float64Array(count);
  let t = 0;
  s = 0;
  for (let e = 0; e < sttsN && s < count; e++) {
    const n = dv.getUint32(p + 4 + e * 8);
    const delta = dv.getUint32(p + 8 + e * 8);
    for (let k = 0; k < n && s < count; k++) { times[s++] = t; t += delta; }
  }
  return { count, sizes, offsets: sampleOffsets, times, endTime: t };
}

// The first AAC audio track in a `moov` box -> everything a decoder needs,
// or null when the recording has no such track (recorded without the mic).
//
// { codec: "mp4a.40.2", sampleRate, channels, description (AudioSpecificConfig),
//   timescale, count, sizes, offsets, times (timescale units),
//   startSeconds (presentation time of media time 0), duration (seconds) }
export function parseAudioTrack(moov) {
  const top = listBoxes(moov);
  const moovBox = top.find((b) => b.type === 'moov');
  if (!moovBox) return null;
  const mvhd = child(moov, moovBox, 'mvhd');
  const movieTimescale = mvhd ? parseMvhdTimescale(moov, mvhd) : 1000;

  for (const trak of children(moov, moovBox, 'trak')) {
    const mdia = child(moov, trak, 'mdia');
    if (!mdia) continue;
    const hdlr = child(moov, mdia, 'hdlr');
    if (!hdlr || parseHdlr(moov, hdlr) !== 'soun') continue;
    const mdhd = child(moov, mdia, 'mdhd');
    const minf = child(moov, mdia, 'minf');
    const stbl = minf && child(moov, minf, 'stbl');
    const stsd = stbl && child(moov, stbl, 'stsd');
    if (!mdhd || !stsd) continue;
    const entries = listBoxes(moov, fullBoxPayload(stsd) + 4, stsd.end);
    const entry = entries.find((e) => e.type === 'mp4a');
    if (!entry) continue;
    const { channels, sampleRate, es } = parseMp4a(moov, entry);
    if (!es || es.objectType !== 0x40 || !es.asc) continue;
    const asc = parseAudioSpecificConfig(es.asc);
    if (!asc) continue;
    const { timescale, duration } = parseMdhd(moov, mdhd);
    const tables = parseSampleTables(moov, stbl);
    const elst = parseElst(moov, child(moov, trak, 'edts'), movieTimescale);
    const { emptySeconds } = elst;
    let { mediaTime } = elst;
    if (!elst.found) {
      // Priming samples at the AAC rate; the media timescale is usually the same.
      const priming = parseItunSmpb(moov);
      if (priming) mediaTime = priming * timescale / (asc.sampleRate || sampleRate || timescale);
    }
    return {
      codec: `mp4a.40.${asc.objectType}`,
      sampleRate: asc.sampleRate || sampleRate,
      channels: asc.channels || channels,
      description: es.asc,
      timescale,
      ...tables,
      startSeconds: emptySeconds - mediaTime / timescale,
      duration: (duration || tables.endTime) / timescale
    };
  }
  return null;
}

export async function readAudioTrack(read) {
  const moov = await readMoov(read);
  return moov ? parseAudioTrack(moov) : null;
}

// Group frames into byte ranges to fetch together. Audio frames sit in small
// runs between video frames; a gap of a few KB is cheaper to read through
// than a separate request, a gap of megabytes of video is not.
export function planReads(track, { maxGap = 64 * 1024, maxBytes = 4 * 1024 * 1024 } = {}) {
  const reads = [];
  let cur = null;
  for (let i = 0; i < track.count; i++) {
    const off = track.offsets[i];
    const end = off + track.sizes[i];
    if (cur && off >= cur.end && off - cur.end <= maxGap && end - cur.start <= maxBytes) {
      cur.end = end;
      cur.last = i;
    } else {
      cur = { start: off, end, first: i, last: i };
      reads.push(cur);
    }
  }
  return reads;
}
