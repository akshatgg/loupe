// Sound for the preview, on the player's clock -- the same sound the export
// will have. The mix (microphone cleaned up and evened out, computer sound,
// voiceovers, music lowered under speech, all following cuts and speed) is
// made in a worker by the exporter's own renderer (audio-worker.js), then
// played here through Web Audio from the playhead.
//
//   createAudioPreview({ sources, folder }) -> {
//     sync({ project, outT, playing }),  every frame the player draws
//     stop(),
//     state: { preparing, ready },      onState(fn) when it changes
//     peaks(sourceKey)                  a recording's waveform (audio-math.js peaks)
//     file(kind, file)                  a music file or take: { status, peaks, duration }
//     setMuted(bool)                    silence it (while recording a voiceover)
//     sourcesChanged()                  a recording was added (Add recording)
//     mix, playing, position            the AudioBuffer, and where it is playing (tests)
//   }
//
// While an edit's sound is being made, the previous mix keeps playing, so
// playback never stalls; a small "Preparing audio…" note says the sound is
// catching up. Music and voiceover files are decoded here: decodeAudioData
// reads every format Chromium plays and only exists on pages.

import { sameSound, playbackAction, computePeaks } from './audio-math.js';
import { h } from './ui.js';

// Edits in quick succession (a slider drag) make one mix.
const RENDER_DELAY_MS = 180;

export function createAudioPreview({ sources, folder = null }) {
  let worker = null;
  let ctx = null;
  let gain = null;
  let buffer = null;
  let active = null; // { node, startedAtCtx, startedAtOut, buffer }
  let muted = false;
  let lastProject = null;
  let timer = null;
  let seq = 0;
  let shownSeq = 0;
  const peaks = {};
  const files = new Map(); // id -> { status: 'loading'|'ready'|'failed', peaks, duration }
  const listeners = new Set();
  const state = { preparing: false, ready: false, error: null };

  const setState = (patch) => {
    const before = JSON.stringify(state);
    Object.assign(state, patch);
    if (JSON.stringify(state) !== before) for (const fn of listeners) fn(state);
  };

  // A note in the corner of the preview while the sound catches up with an
  // edit. The stage is the editor's; nothing else draws there.
  const note = h('div', { class: 'audio-note', role: 'status', hidden: true },
    h('span', { class: 'audio-note-dot' }), 'Preparing audio…');
  document.getElementById('stage')?.append(note);
  listeners.add((s) => { note.hidden = !s.preparing; });

  const fileUrl = (file) => {
    if (!folder || typeof file !== 'string') return null;
    // Each path segment is escaped, so names with "#" or "?" still load.
    return new URL(file.split('/').map(encodeURIComponent).join('/'), folder).href;
  };

  function postSources() {
    const urls = {};
    for (const [key, s] of Object.entries(sources)) urls[key] = { video: s.video, systemAudio: s.systemAudio };
    worker.postMessage({ type: 'sources', sources: urls });
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./audio-worker.js', import.meta.url), { type: 'module' });
    postSources();
    worker.onmessage = (e) => onWorker(e.data);
    worker.onerror = (e) => {
      console.error('audio preview:', e.message);
      setState({ preparing: false, error: 'The sound preview stopped working.' });
    };
    return worker;
  }

  function onWorker(msg) {
    if (msg.type === 'peaks') {
      peaks[msg.key] = msg.peaks;
      for (const fn of listeners) fn(state);
    } else if (msg.type === 'status') {
      if (msg.seq === seq) setState({ preparing: msg.preparing });
    } else if (msg.type === 'mix') {
      if (msg.seq < shownSeq) return;
      shownSeq = msg.seq;
      buffer = msg.empty ? null : toBuffer(msg);
      if (msg.seq === seq) setState({ ready: !msg.pending, preparing: msg.pending });
    } else if (msg.type === 'error') {
      console.warn('audio preview:', msg.message);
    }
  }

  function context() {
    if (!ctx) {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      gain = ctx.createGain();
      gain.gain.value = muted ? 0 : 1;
      gain.connect(ctx.destination);
    }
    return ctx;
  }

  function toBuffer({ channels, sampleRate }) {
    const c = context();
    const b = c.createBuffer(channels.length, channels[0].length, sampleRate);
    channels.forEach((data, i) => b.copyToChannel(data, i));
    return b;
  }

  // Music and takes: fetched and decoded once per file, then handed to the
  // worker. `id` names the file for both sides.
  function loadFile(kind, file) {
    const id = `${kind}:${file}`;
    if (files.has(id)) return id;
    const entry = { status: 'loading', peaks: null, duration: 0 };
    files.set(id, entry);
    (async () => {
      const url = fileUrl(file);
      if (!url) throw new Error('no project folder');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`couldn't read ${file}`);
      const decoded = await context().decodeAudioData(await res.arrayBuffer());
      const channels = [];
      for (let i = 0; i < Math.min(2, decoded.numberOfChannels); i++) channels.push(decoded.getChannelData(i).slice());
      const pcm = { channels, sampleRate: decoded.sampleRate };
      entry.peaks = computePeaks([pcm]);
      entry.duration = decoded.duration;
      entry.status = 'ready';
      ensureWorker().postMessage({ type: 'pcm', id, pcm });
    })().catch((err) => {
      console.warn('audio preview:', err.message);
      entry.status = 'failed';
    }).finally(() => {
      // Mix again now that this file can be heard (or is known to be missing).
      if (lastProject) requestRender(lastProject);
      for (const fn of listeners) fn(state);
    });
    return id;
  }

  function requestRender(project) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const music = project.audio.music ? loadFile('music', project.audio.music.file) : null;
      const takes = {};
      for (const take of project.audio.voiceover) takes[take.id] = loadFile('take', take.file);
      seq++;
      setState({ preparing: true });
      ensureWorker().postMessage({ type: 'render', seq, project, music, takes });
    }, lastProject ? RENDER_DELAY_MS : 0);
  }

  function stopNode() {
    if (!active) return;
    try { active.node.stop(); } catch { /* already stopped */ }
    active.node.disconnect();
    active = null;
  }

  function sync({ project, outT, playing }) {
    if (!sameSound(project, lastProject)) {
      lastProject = project;
      requestRender(project);
    }
    if (playing && !ctx) context();
    if (ctx?.state === 'suspended' && playing) ctx.resume().catch(() => {});
    const action = playbackAction({ playing, outT, active, ctxTime: ctx?.currentTime ?? 0, buffer });
    if (action === 'stop') stopNode();
    else if (action === 'start') {
      stopNode();
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(gain);
      // What starts now is heard after the output latency; start that much
      // further in, so the sound lines up with the picture when it is heard.
      const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
      node.start(0, Math.min(buffer.duration, Math.max(0, outT + latency)));
      active = { node, startedAtCtx: ctx.currentTime, startedAtOut: outT, buffer };
    }
  }

  return {
    sync,
    get state() { return state; },
    get mix() { return buffer; },
    // Whether sound is playing, and the output time it is at.
    get playing() { return active !== null; },
    get position() { return active ? active.startedAtOut + (ctx.currentTime - active.startedAtCtx) : null; },
    onState(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    peaks: (key) => peaks[key] ?? null,
    file: (kind, file) => files.get(`${kind}:${file}`) ?? null,
    // `sources` is the player's own object, so an added recording is already
    // in it; a worker made earlier only needs telling.
    sourcesChanged() {
      if (worker) postSources();
    },
    setMuted(on) {
      muted = Boolean(on);
      if (gain) gain.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.01);
    },
    stop() {
      clearTimeout(timer);
      stopNode();
      worker?.terminate();
      worker = null;
      ctx?.close().catch(() => {});
      ctx = null;
      note.remove();
    }
  };
}
