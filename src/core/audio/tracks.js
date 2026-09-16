// The sound of an export: every recording's microphone and system audio laid
// along the output timeline and mixed (mix.js).
//
//   recordingTracks(project, tl, decoded) -> mix.js tracks
//   exportMix(project, tl, decoded, { extraTracks }) -> mixTracks() result, or
//     null when there is nothing to hear (the export then has no audio track)
//
// `decoded` holds what the exporter could decode, per kind and recording:
//   { mic: { [sourceKey]: { channels, sampleRate } },
//     system: { [sourceKey]: { channels, sampleRate } } }
// A recording missing from it is silent. Both kinds follow tl.audioPlan()
// (cuts, reordering, speed with pitch kept), so they stay in step with the
// picture. Voiceovers and music are placed on output time by their own
// modules and come in as `extraTracks`.

import { followPlan } from './follow.js';
import { mixTracks, MIX_RATE } from './mix.js';

const KINDS = ['mic', 'system'];

export function recordingTracks(project, tl, decoded = {}) {
  const plan = tl.audioPlan();
  const tracks = [];
  for (const kind of KINDS) {
    const settings = project.audio?.[kind] ?? {};
    if (settings.muted) continue;
    const pcm = decoded[kind];
    if (!pcm || !Object.keys(pcm).length) continue;
    tracks.push(...followPlan(plan, pcm, {
      track: { kind, volume: settings.volume ?? 1, muted: false }
    }));
  }
  return tracks;
}

export function exportMix(project, tl, decoded, { extraTracks = [], sampleRate = MIX_RATE } = {}) {
  const tracks = [...recordingTracks(project, tl, decoded), ...extraTracks]
    .filter((t) => t && !t.muted);
  if (!tracks.length) return null;
  return mixTracks(tracks, { sampleRate, duration: tl.duration });
}
