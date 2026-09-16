// The whole sound of a project, made the same way for the export and for the
// editor's preview, so what someone hears while editing is what the video
// will have:
//
//   await renderProjectAudio(project, tl, inputs, options) -> { mix, pending }
//
//   inputs = {
//     mic:       { [sourceKey]: { channels, sampleRate } },  // inside each recording's video
//     system:    { [sourceKey]: { channels, sampleRate } },  // system.m4a / system.wav
//     music:     { channels, sampleRate } | null,            // project.audio.music.file
//     voiceover: { [takeId]: { channels, sampleRate } }      // project.audio.voiceover[].file
//   }
//   options = {
//     cache,        // createVoiceCache(): clean-up and levelling are slow and
//                   // don't depend on the edit, so they are kept per track
//     quick,        // skip clean-up/levelling not already in the cache
//                   // (pending: true then says the result isn't final)
//     sampleRate, onProgress(fraction), denoiseOptions
//   }
//
// `mix` is mixTracks()'s result, or null when there is nothing to hear.
//
// The steps:
//   1. Voice clean-up and levelling ("Clean up background noise", "Even out
//      volume": audio.mic.cleanUp / level) on each whole microphone track and
//      each voiceover take -- both are the person talking, so the two
//      switches apply to both. Whole tracks rather than the edited pieces, so
//      trimming or cutting never re-runs them and a level doesn't jump at a cut.
//   2. Microphone and system audio laid along the timeline (tracks.js: cuts,
//      reordering, speed with pitch kept).
//   3. Voiceover takes placed where their recording moment plays (voiceover.js).
//   4. Music fitted to the video, lowered while anyone talks (music.js, duck.js).
//   5. mixTracks().

import { denoise } from './denoise.js';
import { level } from './level.js';
import { recordingTracks } from './tracks.js';
import { placeVoiceovers } from './voiceover.js';
import { musicTrack } from './music.js';
import { mixTracks, MIX_RATE } from './mix.js';

export function createVoiceCache() {
  return new WeakMap();
}

const processingKey = ({ cleanUp, level: even }) => `${cleanUp ? 'c' : ''}${even ? 'l' : ''}`;

// { pcm, ready }: the processed track, or (quick, not yet cached) the track
// as it is with ready false. Kept per decoded track object and settings.
async function voice(pcm, settings, { cache, quick, denoiseOptions, onProgress }) {
  const key = processingKey(settings);
  if (!key) return { pcm, ready: true };
  let byKey = cache?.get(pcm);
  if (cache && !byKey) cache.set(pcm, (byKey = new Map()));
  const hit = byKey?.get(key);
  if (hit?.value) return { pcm: hit.value, ready: true };
  if (quick) return { pcm, ready: false };
  if (hit?.promise) return { pcm: await hit.promise, ready: true };
  const promise = (async () => {
    let channels = pcm.channels;
    if (settings.cleanUp) {
      channels = await denoise(channels, pcm.sampleRate, {
        ...denoiseOptions,
        onProgress: (f) => onProgress?.(settings.level ? f * 0.8 : f)
      });
    }
    if (settings.level) channels = level(channels, pcm.sampleRate).channels;
    onProgress?.(1);
    return { channels, sampleRate: pcm.sampleRate };
  })();
  const entry = { promise, value: null };
  byKey?.set(key, entry);
  try {
    entry.value = await promise;
  } catch (err) {
    byKey?.delete(key);
    throw err;
  }
  return { pcm: entry.value, ready: true };
}

export async function renderProjectAudio(project, tl, inputs = {}, {
  cache = null, quick = false, sampleRate = MIX_RATE, onProgress, denoiseOptions
} = {}) {
  const audio = project.audio;
  const settings = { cleanUp: Boolean(audio.mic.cleanUp), level: Boolean(audio.mic.level) };
  let pending = false;

  // Every voice track to process, so progress can be reported across them.
  const jobs = [];
  if (!audio.mic.muted) {
    for (const [key, pcm] of Object.entries(inputs.mic ?? {})) if (pcm) jobs.push({ kind: 'mic', key, pcm });
  }
  const takes = (audio.voiceover ?? []).filter((v) => inputs.voiceover?.[v.id]);
  for (const v of takes) jobs.push({ kind: 'voiceover', key: v.id, pcm: inputs.voiceover[v.id] });
  const total = jobs.reduce((n, j) => n + j.pcm.channels[0].length, 0) || 1;
  let done = 0;

  const mic = {};
  const voiceover = {};
  for (const job of jobs) {
    const share = job.pcm.channels[0].length;
    const out = await voice(job.pcm, settings, {
      cache, quick, denoiseOptions, onProgress: (f) => onProgress?.((done + f * share) / total)
    });
    done += share;
    if (!out.ready) pending = true;
    (job.kind === 'mic' ? mic : voiceover)[job.key] = out.pcm;
  }
  onProgress?.(1);

  const recorded = recordingTracks(project, tl, { mic, system: inputs.system ?? {} });
  const spoken = placeVoiceovers(takes, tl, voiceover);
  const tracks = [...recorded, ...spoken];
  if (audio.music && inputs.music) {
    const voices = recorded.filter((t) => t.kind === 'mic').concat(spoken);
    tracks.push(musicTrack(audio.music, inputs.music, tl.duration, { voiceTracks: voices }));
  }
  const heard = tracks.filter((t) => t && !t.muted && t.volume !== 0);
  if (!heard.length || !(tl.duration > 0)) return { mix: null, pending };
  return { mix: mixTracks(heard, { sampleRate, duration: tl.duration }), pending };
}
