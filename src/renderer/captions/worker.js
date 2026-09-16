// Speech to text, off the page's thread: Whisper through transformers.js,
// on the GPU (WebGPU) when there is one and on the CPU (WebAssembly)
// otherwise. Loaded as a module worker by client.js; nothing here touches the
// network: the model comes from the files main downloaded (file://), the
// runtime from src/vendor.
//
// Messages in:
//   { type: "load", model: { key, id, dtype, baseUrl }, device: "auto"|"webgpu"|"wasm" }
//   { type: "transcribe", job, audio: Float32Array (16 kHz mono, source time 0 at [0]),
//     language: "auto"|"en"|... }
//   { type: "cancel", job }
// Messages out:
//   { type: "ready", key, device, ms }
//   { type: "language", job, language, probability }
//   { type: "progress", job, done, total, words }   seconds of audio; words found in this piece
//   { type: "result", job, language, words, device, ms }
//   { type: "cancelled", job }
//   { type: "error", job?, message }

import { pipeline, env, Tensor } from '../../vendor/transformers/transformers.min.js';
import { planChunks } from '../../core/captions/chunks.js';
import { wordsFromChunks } from '../../core/captions/model.js';

const RATE = 16000;
const VENDOR = new URL('../../vendor/transformers/', import.meta.url).href;

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;
// The runtime is already a local file; caching it again in the Cache API
// gains nothing (and file:// responses cannot be cached).
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: `${VENDOR}ort-wasm-simd-threaded.asyncify.mjs`,
  wasm: `${VENDOR}ort-wasm-simd-threaded.asyncify.wasm`
};

let asr = null;
let loaded = null; // { key, device }
const cancelled = new Set();

const yieldToMessages = () => new Promise((res) => setTimeout(res, 0));

async function hasWebGPU() {
  try {
    return Boolean(await self.navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

async function build(model, device) {
  const p = await pipeline('automatic-speech-recognition', model.id, { device, dtype: model.dtype });
  // One second of silence: compiles the GPU shaders now, and proves this
  // device really runs the model before any real work depends on it.
  await p(new Float32Array(RATE), { return_timestamps: 'word', language: 'en' });
  return p;
}

async function load({ model, device = 'auto' }) {
  if (loaded && loaded.key === model.key && asr) return loaded;
  const t0 = performance.now();
  env.localModelPath = model.baseUrl;
  if (asr) { await asr.dispose?.(); asr = null; }
  let used = device === 'auto' ? ((await hasWebGPU()) ? 'webgpu' : 'wasm') : device;
  try {
    asr = await build(model, used);
  } catch (err) {
    if (used !== 'webgpu') throw err;
    // Some GPUs/drivers fail on a model that the CPU runs fine.
    used = 'wasm';
    asr = await build(model, used);
  }
  loaded = { key: model.key, device: used, ms: performance.now() - t0 };
  return loaded;
}

// Whisper has no separate language detector: it predicts a language token as
// the first thing it writes. Run one decoder step and read which language
// token is most likely.
async function detectLanguage(audio) {
  const gc = asr.model.generation_config;
  const langToId = gc?.lang_to_id;
  if (!langToId) return { language: 'en', probability: 0 };
  const { input_features } = await asr.processor(audio);
  const start = BigInt(gc.decoder_start_token_id);
  const decoder_input_ids = new Tensor('int64', BigInt64Array.from([start]), [1, 1]);
  const out = await asr.model({ input_features, decoder_input_ids });
  const [, seq, vocab] = out.logits.dims;
  const logits = out.logits.data;
  const base = (seq - 1) * vocab;
  let best = null;
  let max = -Infinity;
  const scores = [];
  for (const [token, id] of Object.entries(langToId)) {
    const v = Number(logits[base + Number(id)]);
    scores.push(v);
    if (v > max) { max = v; best = token; }
  }
  // Softmax over the language tokens only, for a rough confidence.
  let sum = 0;
  for (const v of scores) sum += Math.exp(v - max);
  return { language: best.replace(/^<\|/, '').replace(/\|>$/, ''), probability: 1 / sum };
}

async function transcribe({ job, audio, language }) {
  if (!asr) throw new Error('The speech model is not loaded');
  const t0 = performance.now();
  const total = audio.length / RATE;
  const chunks = planChunks(audio, RATE);

  let lang = language;
  if (!lang || lang === 'auto') {
    // Listen to the first stretch with sound in it.
    const speech = chunks.find((c) => !c.silent);
    if (speech) {
      const d = await detectLanguage(audio.subarray(speech.start, speech.end));
      lang = d.language;
      postMessage({ type: 'language', job, language: lang, probability: d.probability });
    } else {
      lang = 'en';
    }
  }

  const words = [];
  for (const c of chunks) {
    await yieldToMessages();
    if (cancelled.has(job)) {
      cancelled.delete(job);
      postMessage({ type: 'cancelled', job });
      return;
    }
    let found = [];
    if (!c.silent) {
      const out = await asr(audio.subarray(c.start, c.end), { return_timestamps: 'word', language: lang, task: 'transcribe' });
      found = wordsFromChunks(out.chunks, c.start / RATE, c.end / RATE);
      words.push(...found);
    }
    postMessage({ type: 'progress', job, done: c.end / RATE, total, words: found });
  }
  cancelled.delete(job);
  postMessage({ type: 'result', job, language: lang, words, device: loaded.device, ms: performance.now() - t0 });
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'load') {
      const r = await load(msg);
      postMessage({ type: 'ready', key: r.key, device: r.device, ms: r.ms });
    } else if (msg.type === 'transcribe') {
      await transcribe(msg);
    } else if (msg.type === 'cancel') {
      cancelled.add(msg.job);
    }
  } catch (err) {
    postMessage({ type: 'error', job: msg.job, message: String(err?.message || err) });
  }
};
