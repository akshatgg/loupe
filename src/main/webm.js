'use strict';

// Gives Chromium's MediaRecorder WebM files a duration.
//
// MediaRecorder streams: it writes the file header before it knows how long
// the recording will be, so webcam.webm has no Duration element, and a
// <video> reports its duration as Infinity -- the editor could not show or
// seek it properly. The file is written chunk by chunk as it records (see
// ipc/camera.js), and it can be minutes long, so rewriting it at the end is
// avoided entirely: when the FIRST chunk arrives, before anything is on disk,
// an 11-byte Void element is added inside the Info element (and Info's size
// field widened to 8 bytes so its size can never overflow). At stop, those
// 11 bytes are overwritten in place with a Duration element of exactly the
// same length:
//
//   Void      EC 89 <9 zero bytes>
//   Duration  44 89 88 <8-byte big-endian float, in TimecodeScale units>
//
// Only the first chunk's bytes after Info move, so this refuses (leaving the
// file as it was) if a SeekHead or Cues -- which store byte positions --
// comes before the insertion point. Chromium writes neither.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Cues: 0x1c53bb6b,
  Void: 0xec
};

const RESERVED_BYTES = 11;

// An element ID: 1-4 bytes, marker bit kept as part of the value.
function readId(buf, pos) {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let length = 1;
  while (length <= 4 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 4 || pos + length > buf.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + buf[pos + i];
  return { id, length };
}

// A size: 1-8 bytes, marker bit removed; all ones means "unknown".
function readSize(buf, pos) {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || pos + length > buf.length) return null;
  let value = first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}

function sizeBytes8(value) {
  const out = Buffer.alloc(8);
  out[0] = 0x01;
  let v = value;
  for (let i = 7; i >= 1; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  return out;
}

function readUInt(buf, pos, length) {
  let v = 0;
  for (let i = 0; i < length; i++) v = v * 256 + buf[pos + i];
  return v;
}

// Returns { chunk, durationOffset, timecodeScale }: the first chunk with room
// for a Duration made, and where (from the start of the file) that room is.
// durationOffset is null when the chunk is left untouched.
function reserveDuration(firstChunk) {
  const buf = Buffer.from(firstChunk);
  const untouched = { chunk: buf, durationOffset: null, timecodeScale: null };

  const ebml = readId(buf, 0);
  if (!ebml || ebml.id !== ID.EBML) return untouched;
  const ebmlSize = readSize(buf, ebml.length);
  if (!ebmlSize || ebmlSize.unknown) return untouched;
  let pos = ebml.length + ebmlSize.length + ebmlSize.value;

  const segment = readId(buf, pos);
  if (!segment || segment.id !== ID.Segment) return untouched;
  const segmentSize = readSize(buf, pos + segment.length);
  if (!segmentSize) return untouched;
  const segmentSizePos = pos + segment.length;
  pos = segmentSizePos + segmentSize.length;

  // Top-level children of the Segment, up to Info.
  for (;;) {
    const el = readId(buf, pos);
    if (!el) return untouched;
    const size = readSize(buf, pos + el.length);
    if (!size || size.unknown) return untouched;
    const dataPos = pos + el.length + size.length;
    if (el.id === ID.SeekHead || el.id === ID.Cues) return untouched;
    if (el.id !== ID.Info) { pos = dataPos + size.value; continue; }

    const infoEnd = dataPos + size.value;
    if (infoEnd > buf.length) return untouched;
    let timecodeScale = 1000000;
    for (let p = dataPos; p < infoEnd;) {
      const child = readId(buf, p);
      const childSize = child && readSize(buf, p + child.length);
      if (!child || !childSize || childSize.unknown) return untouched;
      const childData = p + child.length + childSize.length;
      // Already has one (not Chromium, but harmless): nothing to reserve.
      if (child.id === ID.Duration) return untouched;
      if (child.id === ID.TimecodeScale && childSize.value <= 8) {
        timecodeScale = readUInt(buf, childData, childSize.value);
      }
      p = childData + childSize.value;
    }

    const newInfoSize = size.value + RESERVED_BYTES;
    const header = Buffer.concat([buf.subarray(pos, pos + el.length), sizeBytes8(newInfoSize)]);
    const voidEl = Buffer.alloc(RESERVED_BYTES);
    voidEl[0] = ID.Void;
    voidEl[1] = 0x80 | (RESERVED_BYTES - 2);
    const out = Buffer.concat([
      buf.subarray(0, pos), header, buf.subarray(dataPos, infoEnd), voidEl, buf.subarray(infoEnd)
    ]);
    const growth = out.length - buf.length;
    if (!segmentSize.unknown) {
      // A known Segment size grows by what was added, in the same width.
      const newSize = segmentSize.value + growth;
      if (newSize >= 2 ** (7 * segmentSize.length) - 1) return untouched;
      let v = newSize;
      for (let i = segmentSize.length - 1; i >= 0; i--) {
        out[segmentSizePos + i] = (i === 0 ? (0x80 >> (segmentSize.length - 1)) : 0) | (v % 256);
        v = Math.floor(v / 256);
      }
    }
    return {
      chunk: out,
      durationOffset: pos + header.length + (infoEnd - dataPos),
      timecodeScale: timecodeScale > 0 ? timecodeScale : 1000000
    };
  }
}

// The 11 bytes that replace the reserved Void: Duration in TimecodeScale
// units (nanoseconds per unit; 1,000,000 = milliseconds).
function durationElement(durationMs, timecodeScale) {
  const el = Buffer.alloc(RESERVED_BYTES);
  el[0] = 0x44; el[1] = 0x89; el[2] = 0x88;
  el.writeDoubleBE((durationMs * 1e6) / timecodeScale, 3);
  return el;
}

module.exports = { reserveDuration, durationElement, readId, readSize, RESERVED_BYTES };
