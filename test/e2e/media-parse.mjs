// Just enough WebM (EBML) and GIF parsing to check exported files from the
// outside, independently of the muxers that wrote them. Pure; used by the
// export-formats e2e page and by unit tests.

// ------------------------------------------------------------------- WebM

const MASTER = new Set([
  0x18538067, // Segment
  0x1549a966, // Info
  0x1654ae6b, // Tracks
  0xae, // TrackEntry
  0xe0, // Video
  0xe1, // Audio
  0x1f43b675, // Cluster
  0xa0 // BlockGroup
]);

function readVint(bytes, at, keepMarker) {
  const first = bytes[at];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8) throw new Error(`bad EBML length at ${at}`);
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i];
    if (bytes[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function readUint(bytes, at, size) {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + bytes[at + i];
  return v;
}

function readFloat(bytes, at, size) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, size);
  return size === 4 ? view.getFloat32(0) : view.getFloat64(0);
}

const text = (bytes, at, size) => String.fromCharCode(...bytes.subarray(at, at + size)).replace(/\0+$/, '');

// -> { duration (s), timecodeScale, tracks: [{ number, codec, type, width,
//      height, sampleRate, channels, codecPrivate }],
//      blocks: [{ track, time (s), key, offset, size }] }
export function parseWebm(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const out = { duration: null, timecodeScale: 1e6, tracks: [], blocks: [] };
  let track = null;
  let clusterTime = 0;
  let durationRaw = null;

  function walk(start, end) {
    let at = start;
    while (at < end) {
      const id = readVint(bytes, at, true);
      const size = readVint(bytes, at + id.length, false);
      const body = at + id.length + size.length;
      const bodyEnd = size.unknown ? end : Math.min(end, body + size.value);
      const n = bodyEnd - body;
      switch (id.value) {
        case 0xae: track = {}; out.tracks.push(track); walk(body, bodyEnd); break;
        case 0x1f43b675: walk(body, bodyEnd); break;
        case 0x2ad7b1: out.timecodeScale = readUint(bytes, body, n); break;
        case 0x4489: durationRaw = readFloat(bytes, body, n); break;
        case 0xd7: track.number = readUint(bytes, body, n); break;
        case 0x83: track.type = readUint(bytes, body, n) === 1 ? 'video' : 'audio'; break;
        case 0x86: track.codec = text(bytes, body, n); break;
        case 0x63a2: track.codecPrivate = bytes.slice(body, bodyEnd); break;
        case 0xb0: track.width = readUint(bytes, body, n); break;
        case 0xba: track.height = readUint(bytes, body, n); break;
        case 0xb5: track.sampleRate = readFloat(bytes, body, n); break;
        case 0x9f: track.channels = readUint(bytes, body, n); break;
        case 0xe7: clusterTime = readUint(bytes, body, n); break;
        case 0xa3: // SimpleBlock
        case 0xa1: { // Block
          const num = readVint(bytes, body, false);
          const view = new DataView(bytes.buffer, bytes.byteOffset + body + num.length, 3);
          const rel = view.getInt16(0);
          const flags = view.getUint8(2);
          const data = body + num.length + 3;
          out.blocks.push({
            track: num.value, time: ((clusterTime + rel) * out.timecodeScale) / 1e9,
            key: id.value === 0xa3 ? Boolean(flags & 0x80) : null, offset: data, size: bodyEnd - data
          });
          break;
        }
        default:
          if (MASTER.has(id.value)) walk(body, bodyEnd);
      }
      at = bodyEnd;
    }
  }
  walk(0, bytes.length);
  if (durationRaw !== null) out.duration = (durationRaw * out.timecodeScale) / 1e9;
  return out;
}

// ------------------------------------------------------------------- GIF

// -> { width, height, loops (null when no NETSCAPE block), globalPalette
//      (entries), frames: [{ delayCs, localPalette (entries or 0), x, y,
//      width, height }] }
export function parseGif(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (text(b, 0, 6) !== 'GIF89a' && text(b, 0, 6) !== 'GIF87a') throw new Error('not a GIF');
  const u16 = (at) => b[at] | (b[at + 1] << 8);
  const out = { width: u16(6), height: u16(8), loops: null, globalPalette: 0, frames: [] };
  let at = 13;
  if (b[10] & 0x80) {
    out.globalPalette = 1 << ((b[10] & 7) + 1);
    at += 3 * out.globalPalette;
  }
  const skipSubBlocks = () => {
    while (b[at] !== 0) at += b[at] + 1;
    at++;
  };
  let delay = 0;
  for (;;) {
    const kind = b[at++];
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      const label = b[at++];
      if (label === 0xf9) {
        delay = u16(at + 2);
      } else if (label === 0xff && text(b, at + 1, 8) === 'NETSCAPE') {
        out.loops = u16(at + 12 + 2);
      }
      skipSubBlocks();
    } else if (kind === 0x2c) {
      const frame = { delayCs: delay, x: u16(at), y: u16(at + 2), width: u16(at + 4), height: u16(at + 6), localPalette: 0 };
      const packed = b[at + 8];
      at += 9;
      if (packed & 0x80) {
        frame.localPalette = 1 << ((packed & 7) + 1);
        at += 3 * frame.localPalette;
      }
      at++; // LZW minimum code size
      skipSubBlocks();
      out.frames.push(frame);
      delay = 0;
    } else {
      throw new Error(`unexpected GIF block 0x${kind?.toString(16)} at ${at - 1}`);
    }
    if (at > b.length) throw new Error('truncated GIF');
  }
  return out;
}
