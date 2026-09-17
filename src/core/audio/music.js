// Background music (project field audio.music = { file, volume, duck }).
//
// The file is copied into the project folder by the main process
// (src/main/ipc/music.js, IPC 'music:choose' / 'music:import'); the exporter
// decodes it and calls:
//
//   fitMusic({ channels, sampleRate }, duration, options) -> { channels, sampleRate }
//     Exactly `duration` seconds: looped with a short crossfade at each seam
//     when the song is shorter than the video, cut when it is longer, and
//     faded out over the last seconds either way.
//
//   musicTrack(settings, decoded, duration, { voiceTracks }) -> mix.js track
//     fitMusic + volume + (when settings.duck) the ducking curve for the
//     given voice tracks.

import { duckingCurve } from './duck.js';

// Keep in sync with src/main/ipc/music.js (a test checks they match).
export const MUSIC_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.wav', '.aif', '.aiff', '.flac', '.ogg', '.opus', '.webm'];

export function fitMusic({ channels, sampleRate }, duration, {
  loop = true, crossfade = 1, fadeIn = 0, fadeOut = 3, offset = 0
} = {}) {
  const n = Math.max(0, Math.round(duration * sampleRate));
  const start = Math.max(0, Math.min(channels[0].length, Math.round(offset * sampleRate)));
  const song = channels.map((c) => c.subarray(start));
  const len = song[0].length;
  const out = channels.map(() => new Float32Array(n));
  if (len === 0 || n === 0) return { channels: out, sampleRate };

  // Crossfade length is capped at a third of the song so a very short loop
  // still has a body between its seams.
  const xf = loop ? Math.min(Math.round(crossfade * sampleRate), Math.floor(len / 3)) : 0;
  for (let c = 0; c < song.length; c++) {
    const src = song[c];
    const dst = out[c];
    let pos = 0;
    let first = true;
    while (pos < n) {
      // Each pass after the first starts xf samples early, overlapping the
      // previous pass's tail with an equal-power crossfade.
      const at = first ? 0 : pos - xf;
      for (let i = 0; i < len && at + i < n; i++) {
        const o = at + i;
        if (!first && i < xf) {
          const p = (i + 0.5) / xf;
          const fadeInG = Math.sin((p * Math.PI) / 2);
          const fadeOutG = Math.cos((p * Math.PI) / 2);
          // dst[o] already holds the previous pass's sample; turn it down as
          // this pass comes up.
          dst[o] = dst[o] * fadeOutG + src[i] * fadeInG;
        } else {
          dst[o] = src[i];
        }
      }
      pos = at + len;
      first = false;
      if (!loop) break;
    }
  }

  applyFades(out, sampleRate, n, fadeIn, fadeOut);
  return { channels: out, sampleRate };
}

// Raised-cosine fades; each is capped at half the length so short videos get
// a fade that finishes rather than a jump.
function applyFades(channels, sampleRate, n, fadeIn, fadeOut) {
  const fi = Math.min(Math.round(fadeIn * sampleRate), Math.floor(n / 2));
  const fo = Math.min(Math.round(fadeOut * sampleRate), Math.floor(n / 2));
  for (const c of channels) {
    for (let i = 0; i < fi; i++) c[i] *= 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / fi);
    for (let i = 0; i < fo; i++) {
      c[n - fo + i] *= 0.5 + 0.5 * Math.cos((Math.PI * (i + 0.5)) / fo);
    }
  }
}

export function musicTrack(settings, decoded, duration, { voiceTracks = [], duckOptions, fitOptions } = {}) {
  const fitted = fitMusic(decoded, duration, fitOptions);
  return {
    channels: fitted.channels,
    sampleRate: fitted.sampleRate,
    startOffset: 0,
    volume: settings?.volume ?? 0.3,
    gain: settings?.duck === false ? null : duckingCurve(voiceTracks, duration, duckOptions)
  };
}
