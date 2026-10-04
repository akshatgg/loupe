// The whole sound of a project, made the same way for the export and for the
// editor's preview, so what someone hears while editing is what the video
// will have:
//
//   await renderProjectAudio(project, tl, inputs, options) -> { mix, pending, cleanUp }
//
//   inputs = {
//     mic:       { [sourceKey]: { channels, sampleRate } },  // inside each recording's video
//     system:    { [sourceKey]: { channels, sampleRate } },  // system.m4a / system.wav
//     music:     { [file]: { channels, sampleRate } },       // project.audio.clips[].file
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
// `mix` is mixTracks()'s result, or null when there is nothing to hear;
// `cleanUp` names the noise removal that ran ('rnnoise', or 'spectral' when
// the wasm couldn't load), or null.
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
//   4. Each audio clip at its place, lowered while anyone talks (music.js, duck.js).
//   5. mixTracks().
//
// The microphone, the computer sound and each audio clip can each have a pan,
// an equalizer and a compressor (tone.js): the mix applies the first two's
// to every stretch laid along the timeline (and so after clean-up and
// levelling), and music.js a clip's before its fades.

import { denoiseWithInfo } from './denoise.js';
import { level } from './level.js';
import { recordingTracks } from './tracks.js';
import { placeVoiceovers } from './voiceover.js';
import { audioClipTrack } from './music.js';
import { clipHeard, anySolo } from './clips.js';
import { duckingCurve } from './duck.js';
import { mixTracks, MIX_RATE } from './mix.js';
import { toneOf, isNeutralTone } from './tone.js';

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
    let engine = null;
    if (settings.cleanUp) {
      const cleaned = await denoiseWithInfo(channels, pcm.sampleRate, {
        ...denoiseOptions,
        onProgress: (f) => onProgress?.(settings.level ? f * 0.8 : f)
      });
      channels = cleaned.channels;
      engine = cleaned.engine;
    }
    if (settings.level) channels = level(channels, pcm.sampleRate).channels;
    onProgress?.(1);
    return { channels, sampleRate: pcm.sampleRate, engine };
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
  let cleanUp = null;

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
    cleanUp ??= out.pcm.engine ?? null;
    (job.kind === 'mic' ? mic : voiceover)[job.key] = out.pcm;
  }
  onProgress?.(1);

  // A soloed audio row plays alone: the video's sound and voiceovers too
  // are left out while one is on.
  const solo = anySolo(audio);
  const recorded = solo ? [] : recordingTracks(project, tl, { mic, system: inputs.system ?? {} });
  const spoken = solo ? [] : placeVoiceovers(takes, tl, voiceover);
  const tracks = [...recorded, ...spoken];

  // A recording's own sound, for its detached clips: the (cleaned up,
  // levelled) microphone and the computer sound at their volumes, as one.
  const sourceSound = new Map();
  const soundOf = (key) => {
    if (!sourceSound.has(key)) {
      const parts = [];
      // With the microphone's and the computer sound's own pan, equalizer
      // and compressor, as on the video.
      const tone = (settings) => (isNeutralTone(settings) ? null : toneOf(settings));
      if (!audio.mic.muted && mic[key]) parts.push({ ...mic[key], volume: audio.mic.volume, tone: tone(audio.mic) });
      if (!audio.system.muted && inputs.system?.[key]) parts.push({ ...inputs.system[key], volume: audio.system.volume, tone: tone(audio.system) });
      const length = project.sources[key]?.duration ?? 0;
      sourceSound.set(key, parts.length && length > 0 ? mixTracks(parts, { sampleRate, duration: length }) : null);
    }
    return sourceSound.get(key);
  };
  const decodedFor = (c) => (c.source ? soundOf(c.source) : inputs.music?.[c.file]);

  // Songs, sound files and detached video sound: each clip that is heard and
  // decoded (`inputs.music` is { [file]: pcm }; several clips can share one).
  const heardClips = (audio.clips ?? []).filter((c) => clipHeard(audio, c) &&
    (c.volume > 0 || c.points?.length) && decodedFor(c));
  if (heardClips.length) {
    // Detached sound with a microphone in it is someone talking too.
    const detachedVoices = heardClips.filter((c) => c.source && project.sources[c.source]?.mic)
      .map((c) => audioClipTrack({ ...c, duck: false }, decodedFor(c), tl.duration));
    const voices = recorded.filter((t) => t.kind === 'mic').concat(spoken, detachedVoices.filter(Boolean));
    const ducking = heardClips.some((c) => c.duck) ? duckingCurve(voices, tl.duration) : null;
    for (const clip of heardClips) {
      // Detached sound never ducks under itself.
      const curve = clip.source ? (clip.duck ? duckingCurve(recorded.filter((t) => t.kind === 'mic').concat(spoken), tl.duration) : null) : ducking;
      tracks.push(audioClipTrack(clip, decodedFor(clip), tl.duration, { ducking: curve }));
    }
  }
  const heard = tracks.filter((t) => t && !t.muted && t.volume !== 0);
  if (!heard.length || !(tl.duration > 0)) return { mix: null, pending, cleanUp };
  return { mix: mixTracks(heard, { sampleRate, duration: tl.duration }), pending, cleanUp };
}
