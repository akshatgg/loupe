// WAV files: the computer sound Windows records (system.wav, written by
// native-win/WavFile.cs as 16-bit PCM) goes straight to the mix without the
// MP4 demuxer or WebCodecs, which don't read WAV. Pure.
//
//   isWav(buffer) -> bool
//   parseWav(buffer) -> { channels: Float32Array[], sampleRate }
//
// Reads integer PCM (8, 16, 24, 32 bits) and 32-bit float, plain or
// WAVE_FORMAT_EXTENSIBLE. A header whose data size was never filled in (a
// recording cut short) reads to the end of the file.

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

const tag = (view, at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

export function isWav(buffer) {
  if (!buffer || buffer.byteLength < 12) return false;
  const view = new DataView(buffer);
  return tag(view, 0) === 'RIFF' && tag(view, 8) === 'WAVE';
}

export function parseWav(buffer) {
  if (!isWav(buffer)) throw new Error('Not a WAV file.');
  const view = new DataView(buffer);
  let fmt = null;
  let data = null;
  for (let at = 12; at + 8 <= buffer.byteLength;) {
    const id = tag(view, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16) {
      let format = view.getUint16(body, true);
      // The sub-format's first two bytes are the real format code.
      if (format === EXTENSIBLE && size >= 40) format = view.getUint16(body + 24, true);
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true)
      };
    } else if (id === 'data') {
      const end = size === 0 || size === 0xffffffff || body + size > buffer.byteLength ? buffer.byteLength : body + size;
      data = { start: body, end };
      break;
    }
    at = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('The WAV file has no sound in it.');
  const { format, channels: count, sampleRate, bits } = fmt;
  const supported = (format === PCM && [8, 16, 24, 32].includes(bits)) || (format === FLOAT && bits === 32);
  if (!supported || count < 1 || !(sampleRate > 0)) {
    throw new Error(`This WAV format isn't supported (format ${format}, ${bits} bits).`);
  }
  const bytes = bits / 8;
  const frames = Math.floor((data.end - data.start) / (bytes * count));
  const channels = Array.from({ length: count }, () => new Float32Array(frames));
  const read = format === FLOAT
    ? (at) => view.getFloat32(at, true)
    : bits === 8 ? (at) => (view.getUint8(at) - 128) / 128
      : bits === 16 ? (at) => view.getInt16(at, true) / 32768
        : bits === 24 ? (at) => ((view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16))) / 8388608
          : (at) => view.getInt32(at, true) / 2147483648;
  let at = data.start;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++, at += bytes) channels[c][i] = read(at);
  }
  return { channels, sampleRate };
}
