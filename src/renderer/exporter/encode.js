// Choosing how to compress: the codec string, bitrate and hardware/software
// encoder for a video of a given size, and the AAC (MP4) or Opus (WebM)
// settings for the sound. WebM is VP9, which few computers encode in
// hardware; Chromium's libvpx does it in software.
//
// Hardware encoding (VideoToolbox, Media Foundation) is several times faster
// and is tried first. Some machines have none, or none for this size (a 4K
// portrait export is beyond some GPUs' H.264 limits), so a software encoder is
// the fallback; Chromium's software H.264 encoder only does the Baseline
// profile, which is tried last.

import { qualityBitrate, AUDIO_BITRATES } from '../../core/export-plan.js';

export const AUDIO_RATE = 48000;
export const AUDIO_CHANNELS = 2;
export const AUDIO_BITRATE = AUDIO_BITRATES.mp4;
export const KEYFRAME_SECONDS = 2;

// H.264 levels: [level_idc, max frame size in macroblocks, max macroblocks/s].
const AVC_LEVELS = [
  [31, 3600, 108000], [32, 5120, 216000], [40, 8192, 245760], [42, 8704, 522240],
  [50, 22080, 589824], [51, 36864, 983040], [52, 36864, 2073600],
  [60, 139776, 4177920], [61, 139776, 8355840], [62, 139776, 16711680]
];

export function avcLevel(width, height, fps) {
  const frame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = frame * fps;
  const hit = AVC_LEVELS.find(([, fs, mbps]) => frame <= fs && rate <= mbps);
  return (hit ?? AVC_LEVELS.at(-1))[0];
}

export function bitrateFor(width, height, fps, quality = 'balanced', format = 'mp4') {
  return qualityBitrate({ format, width, height, fps, quality });
}

// VP9 levels by picture size and rate (level 4.1 is 1080p60, 5.1 is 4K60).
export function vp9Level(width, height, fps) {
  const rate = width * height * fps;
  if (rate <= 1280 * 720 * 60) return 31;
  if (rate <= 1920 * 1080 * 60) return 41;
  if (rate <= 2560 * 1440 * 60) return 50;
  return rate <= 4096 * 2176 * 60 ? 51 : 52;
}

// Codec strings to try, best first.
export function codecCandidates(codec, width, height, fps, format = 'mp4') {
  if (format === 'webm') {
    const level = vp9Level(width, height, fps);
    // Profile 0, 8-bit, 4:2:0.
    return [{ codec: `vp09.00.${level}.08`, muxCodec: 'V_VP9' }];
  }
  if (codec === 'hevc') {
    // Main profile; level 4.1 (123) up to 1080p60, 5.1 (153) up to 4K30,
    // 5.2 (156) for 4K60.
    const pixels = width * height;
    const level = pixels <= 2228224 && fps <= 60 ? 123 : pixels * fps <= 8912896 * 30 ? 153 : 156;
    return [{ codec: `hvc1.1.6.L${level}.B0`, muxCodec: 'hevc', hevc: { format: 'hevc' } }];
  }
  const level = avcLevel(width, height, fps).toString(16).padStart(2, '0').toUpperCase();
  return [
    { codec: `avc1.6400${level}`, muxCodec: 'avc', avc: { format: 'avc' } },
    { codec: `avc1.4D40${level}`, muxCodec: 'avc', avc: { format: 'avc' } },
    { codec: `avc1.42E0${level}`, muxCodec: 'avc', avc: { format: 'avc' } }
  ];
}

// The first configuration this computer can actually encode.
// `bitrate` overrides the quality's.
export async function chooseVideoConfig({
  format = 'mp4', codec = 'h264', width, height, fps, quality, bitrate: wanted
}, api = globalThis.VideoEncoder) {
  const bitrate = wanted ?? bitrateFor(width, height, fps, quality, format);
  for (const acceleration of ['prefer-hardware', 'prefer-software']) {
    for (const candidate of codecCandidates(codec, width, height, fps, format)) {
      const { muxCodec, ...codecOptions } = candidate;
      const config = {
        ...codecOptions, width, height, bitrate, framerate: fps,
        hardwareAcceleration: acceleration, latencyMode: 'quality',
        bitrateMode: 'variable'
      };
      try {
        const { supported } = await api.isConfigSupported(config);
        if (supported) return { config, muxCodec, hardware: acceleration === 'prefer-hardware' };
      } catch {
        // An option this build doesn't know about: try the next one.
      }
    }
  }
  const name = format === 'webm' ? 'WebM' : codec === 'hevc' ? 'HEVC' : 'H.264';
  throw new Error(`This computer can't make a ${width}x${height} ${name} video. Try a smaller size.`);
}

export async function chooseAudioConfig(format = 'mp4', api = globalThis.AudioEncoder) {
  const webm = format === 'webm';
  const config = {
    codec: webm ? 'opus' : 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: AUDIO_CHANNELS,
    bitrate: webm ? AUDIO_BITRATES.webm : AUDIO_BITRATES.mp4
  };
  const { supported } = await api.isConfigSupported(config);
  if (!supported) throw new Error(`This computer can't encode ${webm ? 'Opus' : 'AAC'} sound.`);
  return config;
}
