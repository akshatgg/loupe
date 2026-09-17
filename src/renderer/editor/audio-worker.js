// The editor's sound, made off the page's thread (audio-preview.js starts
// this module worker). It decodes each recording's microphone and system
// sound exactly as the exporter does (exporter/demux.js, exporter/audio.js,
// core/audio/wav.js) and mixes the project with the exporter's own renderer
// (core/audio/project-audio.js), so the preview sounds like the export.
//
// Messages in:
//   { type: 'sources', sources: { [key]: { video, systemAudio } } }   file:// URLs
//   { type: 'pcm', id, pcm: { channels, sampleRate } | null }   music ('music:<file>')
//                                                               or a take ('take:<file>'), decoded by the page
//   { type: 'render', seq, project, music: id | null, takes: { [takeId]: id } }
// Messages out:
//   { type: 'peaks', key, peaks }                  a recording's waveform, once decoded
//   { type: 'status', seq, preparing: bool }
//   { type: 'mix', seq, channels, sampleRate, pending }   (channels transferred)
//   { type: 'error', message }
//
// A render first comes back "quick" -- cut, stretched and mixed, using
// clean-up and levelling only if they're already done -- so an edit is heard
// within moments, then again once any clean-up or levelling has run. Only
// the newest render request is worked on; older ones are dropped.

import { buildTimeline } from '../../core/timeline.js';
import { renderProjectAudio, createVoiceCache } from '../../core/audio/project-audio.js';
import { isWav, parseWav } from '../../core/audio/wav.js';
import { readFile, demux, openRecording } from '../exporter/demux.js';
import { decodeAudioTrack } from '../exporter/audio.js';
import { computePeaks } from './audio-math.js';

const cache = createVoiceCache();
// key -> Promise<{ mic, system }> (decoded PCM or null for each)
const recordings = new Map();
// id -> pcm | null (music and takes, sent by the page)
const files = new Map();
let latest = null;
let busy = false;

const post = (msg, transfer) => self.postMessage(msg, transfer ?? []);

function loadRecording(key, urls, hasMic) {
  if (recordings.has(key)) return recordings.get(key);
  const job = (async () => {
    const out = { mic: null, system: null };
    // A recording whose sound can't be read plays silently rather than
    // taking the rest of the preview's sound with it.
    if (urls.video && hasMic) {
      try {
        const demuxed = await openRecording(urls.video, 'the recording');
        out.mic = await decodeAudioTrack(demuxed, 'the recording');
      } catch (err) {
        post({ type: 'error', message: err.message });
      }
    }
    if (urls.systemAudio) {
      try {
        const bytes = await readFile(urls.systemAudio, 'the computer sound');
        out.system = isWav(bytes) ? parseWav(bytes) : await decodeAudioTrack(demux(bytes), 'the computer sound');
      } catch (err) {
        post({ type: 'error', message: err.message });
      }
    }
    post({ type: 'peaks', key, peaks: computePeaks([out.mic, out.system]) });
    return out;
  })();
  recordings.set(key, job);
  return job;
}

let sources = {};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function render(request) {
  const { seq, project } = request;
  post({ type: 'status', seq, preparing: true });
  const keys = [...new Set(project.clips.map((c) => c.source))];
  const loaded = await Promise.all(keys.map((k) =>
    loadRecording(k, sources[k] ?? {}, project.sources[k]?.mic)));
  const inputs = { mic: {}, system: {}, music: null, voiceover: {} };
  keys.forEach((k, i) => {
    if (loaded[i].mic) inputs.mic[k] = loaded[i].mic;
    if (loaded[i].system) inputs.system[k] = loaded[i].system;
  });
  // Music or a take the page hasn't finished decoding yet is left out for
  // now; the page asks again once it arrives.
  if (request.music) inputs.music = files.get(request.music) ?? null;
  for (const [takeId, id] of Object.entries(request.takes ?? {})) {
    const pcm = files.get(id);
    if (pcm) inputs.voiceover[takeId] = pcm;
  }
  const tl = buildTimeline(project);
  for (const quick of [true, false]) {
    if (latest && latest.seq !== seq) return;
    const { mix, pending } = await renderProjectAudio(project, tl, inputs, { cache, quick });
    if (latest && latest.seq !== seq) return;
    const channels = mix ? mix.channels : [];
    post({ type: 'mix', seq, channels, sampleRate: mix?.sampleRate ?? 48000, pending, empty: !mix }, channels.map((c) => c.buffer));
    if (!pending) break;
    // Let a newer request (another edit) be seen before the slow part.
    await tick();
  }
  post({ type: 'status', seq, preparing: false });
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (latest && !latest.done) {
      const request = latest;
      request.done = true;
      try {
        await render(request);
      } catch (err) {
        post({ type: 'error', message: err?.message ?? String(err) });
        post({ type: 'status', seq: request.seq, preparing: false });
      }
    }
  } finally {
    busy = false;
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'sources') {
    const next = msg.sources ?? {};
    // A recording read before its files were known would stay silent.
    for (const key of recordings.keys()) {
      if (next[key]?.video !== sources[key]?.video) recordings.delete(key);
    }
    sources = next;
  } else if (msg.type === 'pcm') {
    files.set(msg.id, msg.pcm);
  } else if (msg.type === 'render') {
    latest = { ...msg, done: false };
    pump();
  }
};
