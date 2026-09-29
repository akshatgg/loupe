// Songs and sound files as clips on the timeline's audio rows
// (project.audio.clips). Each clip is
//
//   { id, file, name, start, from, length, fileDuration, volume, fadeIn,
//     fadeOut, duck, muted, loop, lane }
//
//   file          'music/<name>' inside the project folder (ipc/music.js)
//   start         where in the video it begins (output seconds)
//   from          how far into the file it plays from (seconds)
//   length        how long it plays (seconds), or null: to the end of the
//                 file -- or of the video, when it repeats
//   fileDuration  the file's length once known (seconds), or null
//   volume        0..2; fadeIn / fadeOut in seconds; duck: lower it under
//                 speech; muted; loop: repeat the file until `length` (or the
//                 end of the video)
//   lane          which audio row it sits on, 0 at the top
//   points        volume over time, [{ t, gain }] (below); [] for none
//   beats         show the song's beats on it and snap to them
//   source        instead of a file: the video's own sound ("detach audio"),
//                 `from` being the recording's time; `file` is then null
//
// Output time is the video as it plays, so a clip keeps its place when
// video clips are trimmed or moved, as music does in any video editor.

export const MAX_LANES = 6;
// Shorter than this a clip can't be seen or grabbed on the timeline.
export const MIN_AUDIO_SECONDS = 0.1;

// How long clip plays, in a video `videoDuration` long.
export function clipLength(clip, videoDuration) {
  if (clip.length !== null && clip.length !== undefined) return clip.length;
  if (clip.loop || !(clip.fileDuration > 0)) return Math.max(0, videoDuration - clip.start);
  return Math.max(0, clip.fileDuration - (clip.from ?? 0));
}

export function clipEnd(clip, videoDuration) {
  return clip.start + clipLength(clip, videoDuration);
}

// The row for a clip playing [start, end): `prefer` when nothing else is
// there, else the first free one; -1 when every row is taken there.
// Locked rows (a Set of row numbers) take nothing new.
export function freeLane(clips, start, end, videoDuration, { prefer = null, except = null, locked = null } = {}) {
  const busy = (lane) => Boolean(locked?.has(lane)) || clips.some((c) => c.id !== except && c.lane === lane &&
    c.start < end - 1e-6 && clipEnd(c, videoDuration) > start + 1e-6);
  if (Number.isInteger(prefer) && prefer >= 0 && prefer < MAX_LANES && !busy(prefer)) return prefer;
  for (let lane = 0; lane < MAX_LANES; lane++) if (!busy(lane)) return lane;
  return -1;
}

// A file name without its folder or extension, for the clip's label.
export function audioName(file) {
  return String(file ?? '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
}

// ---- volume over time
//
// `points` ([{ t, gain }], t in seconds from the clip's start, gain 0..2,
// in time order): with none, the clip plays at `volume`; with some, the
// volume runs straight from one point to the next and holds the first and
// last levels before and after them -- the volume line of a video editor.

export function clipGainAt(clip, t) {
  const pts = clip.points ?? [];
  if (!pts.length) return clip.volume;
  if (t <= pts[0].t) return pts[0].gain;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const a = pts[i - 1];
      const b = pts[i];
      return b.t - a.t < 1e-9 ? b.gain : a.gain + ((b.gain - a.gain) * (t - a.t)) / (b.t - a.t);
    }
  }
  return pts.at(-1).gain;
}

const at = (points, t) => ({ t, gain: clipGainAt({ volume: 1, points }, t) });

// The points of the two halves of a clip split `delta` seconds in, each
// with a point at the cut so the level carries on where it was.
export function splitPoints(points, delta) {
  if (!points?.length) return [[], []];
  const first = points.filter((p) => p.t < delta - 1e-9).concat(at(points, delta));
  const second = [{ t: 0, gain: at(points, delta).gain }]
    .concat(points.filter((p) => p.t > delta + 1e-9).map((p) => ({ ...p, t: p.t - delta })));
  return [first, second];
}

// The points of a clip whose start moved `s` seconds later into it.
export function shiftPoints(points, s) {
  if (!points?.length || Math.abs(s) < 1e-9) return points ?? [];
  const kept = points.map((p) => ({ ...p, t: p.t - s })).filter((p) => p.t > 1e-9);
  return s > 0 && points.some((p) => p.t < s) ? [{ t: 0, gain: at(points, s).gain }, ...kept] : kept;
}

// ---- rows

export function laneOf(audio, lane) {
  const l = audio?.lanes?.[lane];
  return { muted: Boolean(l?.muted), solo: Boolean(l?.solo), locked: Boolean(l?.locked) };
}

// Whether a clip is heard: not muted itself, not on a muted row, and -- when
// any row is soloed -- on a soloed one.
export function clipHeard(audio, clip) {
  if (clip.muted) return false;
  const lane = laneOf(audio, clip.lane);
  if (lane.muted) return false;
  return !anySolo(audio) || lane.solo;
}

export function anySolo(audio) {
  return (audio?.lanes ?? []).some((l) => l?.solo);
}
