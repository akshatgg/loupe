// Songs and sound files (project field audio.clips, see clips.js): each clip
// placed where it starts in the video, from its point in the file, for its
// length, repeating or not, with its fades, volume and ducking.
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
import { gainAt } from './mix.js';
import { clipLength, clipGainAt } from './clips.js';
import { applyTone, isNeutralTone } from './tone.js';

const CURVE_RATE = 100;

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

// One audio clip as a mix.js track, in a video `videoDuration` long (the
// part past the video's end isn't heard). `ducking` is the curve for the
// voices, shared by every clip that ducks.
export function audioClipTrack(clip, decoded, videoDuration, { ducking = null } = {}) {
  const length = Math.min(clipLength(clip, videoDuration), videoDuration - clip.start);
  if (!(length > 0)) return null;
  let fitted;
  if (isNeutralTone(clip)) {
    fitted = fitMusic(decoded, length, { loop: clip.loop, offset: clip.from, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut });
  } else {
    // The clip's pan, equalizer and compressor (tone.js) go before its
    // fades: a compressor after them would turn a fade-out back up.
    fitted = fitMusic(decoded, length, { loop: clip.loop, offset: clip.from, fadeIn: 0, fadeOut: 0 });
    fitted.channels = applyTone(fitted.channels, fitted.sampleRate, clip);
    applyFades(fitted.channels, fitted.sampleRate, fitted.channels[0].length, clip.fadeIn, clip.fadeOut);
  }
  const points = clip.points ?? [];
  const duck = clip.duck ? ducking : null;
  // Volume points and ducking make one curve over the clip, in video time.
  let gain = duck;
  if (points.length) {
    const n = Math.max(2, Math.ceil(length * CURVE_RATE) + 1);
    const values = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const t = Math.min(length, k / CURVE_RATE);
      values[k] = clipGainAt(clip, t) * (duck ? gainAt(duck, clip.start + t) : 1);
    }
    gain = { rate: CURVE_RATE, start: clip.start, values };
  }
  return {
    channels: fitted.channels,
    sampleRate: fitted.sampleRate,
    startOffset: clip.start,
    volume: points.length ? 1 : clip.volume,
    muted: clip.muted,
    gain
  };
}

export function musicTrack(settings, decoded, duration, { voiceTracks = [], duckOptions, fitOptions } = {}) {
  const start = Math.min(Math.max(0, settings?.start ?? 0), duration);
  const from = Math.max(0, settings?.from ?? 0);
  // A song joined part way through comes up over a moment instead of with a
  // click. The ducking curve is in video time, as the track's placement is.
  const fitted = fitMusic(decoded, duration - start, { fadeIn: from > 0 ? 0.3 : 0, ...fitOptions, offset: from });
  return {
    channels: fitted.channels,
    sampleRate: fitted.sampleRate,
    startOffset: start,
    volume: settings?.volume ?? 0.3,
    gain: settings?.duck === false ? null : duckingCurve(voiceTracks, duration, duckOptions)
  };
}
