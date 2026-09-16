// Choosing how to compress: the codec string, bitrate and hardware/software
// encoder for a video of a given size, and the AAC settings for the sound.
//
// Hardware encoding (VideoToolbox, Media Foundation) is several times faster
// and is tried first. Some machines have none, or none for this size (a 4K
// portrait export is beyond some GPUs' H.264 limits), so a software encoder is
// the fallback; Chromium's software H.264 encoder only does the Baseline
// profile, which is tried last.

export const AUDIO_RATE = 48000;
export const AUDIO_CHANNELS = 2;
export const AUDIO_BITRATE = 160000;
export const KEYFRAME_SECONDS = 2;

// Bits per pixel per frame. Screen recordings are mostly flat colour and
// sharp text, which compress well; "small" still keeps text readable.
const QUALITY_BPP = { high: 0.1, balanced: 0.06, small: 0.035 };

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

export function bitrateFor(width, height, fps, quality = 'balanced') {
  const bpp = QUALITY_BPP[quality] ?? QUALITY_BPP.balanced;
  return Math.round(Math.min(120e6, Math.max(1e6, width * height * fps * bpp)));
}

// Codec strings to try, best first.
export function codecCandidates(codec, width, height, fps) {
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
export async function chooseVideoConfig({ codec = 'h264', width, height, fps, quality }, api = globalThis.VideoEncoder) {
  const bitrate = bitrateFor(width, height, fps, quality);
  for (const acceleration of ['prefer-hardware', 'prefer-software']) {
    for (const candidate of codecCandidates(codec, width, height, fps)) {
      const { muxCodec, ...codecOptions } = candidate;
      const config = {
        ...codecOptions, width, height, bitrate, framerate: fps,
        hardwareAcceleration: acceleration, latencyMode: 'quality', bitrateMode: 'variable'
      };
      try {
        const { supported } = await api.isConfigSupported(config);
        if (supported) return { config, muxCodec, hardware: acceleration === 'prefer-hardware' };
      } catch {
        // An option this build doesn't know about: try the next one.
      }
    }
  }
  const name = codec === 'hevc' ? 'HEVC' : 'H.264';
  throw new Error(`This computer can't make a ${width}x${height} ${name} video. Try a smaller size.`);
}

export async function chooseAudioConfig(api = globalThis.AudioEncoder) {
  const config = {
    codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: AUDIO_CHANNELS, bitrate: AUDIO_BITRATE
  };
  const { supported } = await api.isConfigSupported(config);
  if (!supported) throw new Error("This computer can't encode AAC sound.");
  return config;
}
