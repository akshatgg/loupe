// What the Captions panel uses to turn a recording's speech into captions.
//
//   import { createCaptionsEngine, STAGE_TEXT } from '../captions/client.js';
//   const engine = createCaptionsEngine();            // window.loupe.captions by default
//   const models = await engine.listModels();          // [{ key, label, description, bytes, downloaded }]
//   const job = engine.transcribe({
//     url,                  // file:// URL of the recording's video (raw.mov / raw.mp4)
//     source: 'main',       // the project source key the captions attach to
//     language: 'auto',     // or a code from core/captions/languages.js
//     model: 'standard',    // or 'accurate'
//     onProgress(p) {}      // { stage, fraction, overall, text, language?, words? }
//   });
//   job.cancel();                                       // any time; the promise rejects with code "cancelled"
//   const { language, segments, words, device } = await job.promise;
//   // segments: [{ id, source, start, end, text, words }] in source time,
//   // ready for project.captions.segments.
//
// Stages, in order: "model" (one-time download; skipped once downloaded) and
// "audio" (reading the recording's sound) run side by side, then "load"
// (starting the model) and "transcribe". `overall` is 0..1 across all of
// them for a single progress bar; `text` is a sentence to show beside it.
// Failures reject with a CaptionsError whose `message` can be shown as is.

import { decodeMicTrack, CaptionsError } from './audio.js';
import { buildSegments } from '../../core/captions/lines.js';
import { isLanguage } from '../../core/captions/languages.js';

export { CaptionsError };

export const STAGE_TEXT = Object.freeze({
  model: 'Downloading the speech model. This only happens once.',
  audio: 'Listening to your recording…',
  load: 'Getting ready…',
  transcribe: 'Writing captions…'
});

// How long a cancel waits for the worker to stop politely before it is shut
// down (a piece of audio on a slow CPU can take several seconds).
const HARD_CANCEL_MS = 1500;

// "Error invoking remote method 'x': Error: message" -> "message"
function ipcMessage(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
}

export function createCaptionsEngine({
  bridge = globalThis.window?.loupe?.captions,
  workerUrl = new URL('./worker.js', import.meta.url),
  device = 'auto'
} = {}) {
  let worker = null;
  let loadedKey = null;
  let active = null;
  let jobCounter = 0;
  const handlers = new Set();

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(workerUrl, { type: 'module' });
    worker.onmessage = (e) => { for (const h of [...handlers]) h(e.data); };
    worker.onerror = (e) => {
      for (const h of [...handlers]) h({ type: 'error', message: e.message || 'The captions worker stopped' });
    };
    return worker;
  }

  function killWorker() {
    if (worker) worker.terminate();
    worker = null;
    loadedKey = null;
  }

  // Resolve on the first message `match` returns a value for; reject on errors.
  function waitFor(match, job) {
    let h;
    const promise = new Promise((resolve, reject) => {
      h = (msg) => {
        if (msg.type === 'error' && (msg.job === undefined || msg.job === job)) {
          reject(new CaptionsError('failed', msg.message));
          return;
        }
        const v = match(msg);
        if (v !== undefined) resolve(v);
      };
      handlers.add(h);
    });
    return { promise: promise.finally(() => handlers.delete(h)), cancel: () => handlers.delete(h) };
  }

  async function listModels() {
    if (!bridge) throw new CaptionsError('unavailable', 'Captions are not available here');
    return bridge.models();
  }

  function transcribe({ url, source = 'main', language = 'auto', model = 'standard', onProgress, lineOptions, audio } = {}) {
    if (!isLanguage(language)) {
      // The model would otherwise fail deep inside with a message nobody can act on.
      return { promise: Promise.reject(new CaptionsError('failed', `Unknown language: ${language}`)), cancel() {} };
    }
    if (active) {
      return { promise: Promise.reject(new CaptionsError('busy', 'Captions are already being made')), cancel() {} };
    }
    const job = ++jobCounter;
    const controller = new AbortController();
    const state = { cancelled: false, stage: null };
    const needsDownload = { value: false };
    const fractions = { model: 0, audio: 0, load: 0, transcribe: 0 };
    let detectedLanguage = null;

    const report = (stage, fraction, extra = {}) => {
      fractions[stage] = Math.max(0, Math.min(1, fraction));
      const w = needsDownload.value
        ? { model: 0.35, audio: 0.08, load: 0.04, transcribe: 0.53 }
        : { model: 0, audio: 0.12, load: 0.05, transcribe: 0.83 };
      const overall = Object.keys(w).reduce((n, k) => n + w[k] * fractions[k], 0);
      try {
        onProgress?.({ stage, fraction: fractions[stage], overall, text: STAGE_TEXT[stage], language: detectedLanguage, ...extra });
      } catch { /* a panel bug must not stop the job */ }
    };

    const cancelledError = () => new CaptionsError('cancelled', 'Cancelled');
    const check = () => { if (state.cancelled) throw cancelledError(); };

    const run = async () => {
      if (!bridge) throw new CaptionsError('unavailable', 'Captions are not available here');
      const models = await bridge.models();
      const info = models.find((m) => m.key === model);
      if (!info) throw new CaptionsError('failed', `Unknown speech model: ${model}`);
      needsDownload.value = !info.downloaded;

      const modelTask = (async () => {
        const off = bridge.onModelProgress?.((p) => {
          if (p.key === model && p.total) report('model', p.received / p.total);
        });
        try {
          return await bridge.ensureModel(model);
        } catch (err) {
          if (state.cancelled) throw cancelledError();
          throw new CaptionsError('download', ipcMessage(err));
        } finally {
          off?.();
        }
      })();
      const audioTask = audio
        ? Promise.resolve({ samples: audio, sampleRate: 16000 })
        : decodeMicTrack(url, { signal: controller.signal, onProgress: (f) => report('audio', f) });
      // Whichever fails first wins; the other is told to stop.
      modelTask.catch(() => controller.abort());
      audioTask.catch(() => { if (needsDownload.value) bridge.cancelModel(model); });
      const [loadInfo, decoded] = await Promise.all([modelTask, audioTask]);
      report('model', 1);
      report('audio', 1);
      check();

      state.stage = 'load';
      report('load', 0);
      const w = ensureWorker();
      if (loadedKey !== model) {
        const ready = waitFor((m) => (m.type === 'ready' ? m : undefined));
        w.postMessage({ type: 'load', model: loadInfo, device });
        await ready.promise;
        loadedKey = model;
      }
      check();
      report('load', 1);

      state.stage = 'transcribe';
      report('transcribe', 0);
      const done = waitFor((m) => {
        if (m.job !== job) return undefined;
        if (m.type === 'language') { detectedLanguage = m.language; return undefined; }
        if (m.type === 'progress') { report('transcribe', m.done / (m.total || 1), { words: m.words }); return undefined; }
        if (m.type === 'result' || m.type === 'cancelled') return m;
        return undefined;
      }, job);
      // A copy the worker can own: the decoded buffer may be a view into a larger one.
      const samples = decoded.samples.slice();
      w.postMessage({ type: 'transcribe', job, audio: samples, language }, [samples.buffer]);
      const result = await done.promise;
      if (result.type === 'cancelled') throw cancelledError();
      report('transcribe', 1);
      return {
        language: result.language,
        words: result.words,
        segments: buildSegments(result.words, { ...lineOptions, source }),
        device: result.device,
        duration: decoded.samples.length / 16000,
        ms: result.ms
      };
    };

    const promise = run()
      .catch((err) => {
        if (state.cancelled || err?.code === 'cancelled') throw cancelledError();
        if (err instanceof CaptionsError) throw err;
        throw new CaptionsError('failed', String(err?.message || err));
      })
      .finally(() => { active = null; });

    const cancel = () => {
      if (state.cancelled) return;
      state.cancelled = true;
      controller.abort();
      bridge?.cancelModel?.(model);
      if (worker && state.stage === 'transcribe') {
        worker.postMessage({ type: 'cancel', job });
        const w = worker;
        setTimeout(() => {
          // Still busy with a long piece of audio: stop it outright. The next
          // job starts a fresh worker (and loads the model again).
          if (worker === w && active === entry) {
            killWorker();
            for (const h of [...handlers]) h({ type: 'cancelled', job });
          }
        }, HARD_CANCEL_MS);
      } else if (worker && state.stage === 'load') {
        killWorker();
        for (const h of [...handlers]) h({ type: 'error', message: 'Cancelled' });
      }
    };
    const entry = { job, promise, cancel };
    active = entry;
    return entry;
  }

  function dispose() {
    active?.cancel();
    killWorker();
  }

  return { listModels, transcribe, dispose };
}
