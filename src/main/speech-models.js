'use strict';
/* global AbortController */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');

// The speech-to-text models behind captions, and their one-time download.
//
// Downloads happen HERE, in the main process, not in the renderer: the
// renderer is sandboxed and cannot write to disk, a model is hundreds of MB
// (streamed straight to a file instead of held in memory), and the list of
// URLs is fixed in this file so no page can make the app fetch anything
// else. Every file is pinned to a commit of the model repository and
// checked against its hash, so what runs is exactly what was tested.
//
// Layout: <userData>/speech-models/<repo id>/<file> plus `.complete` once
// every file has been verified. The captions worker loads them from there
// over file:// (transformers.js env.localModelPath), fully offline.

const HOST = 'https://huggingface.co';

// sha256 for large (LFS) files; `git` = the git blob id for small ones, which
// is all the hub publishes for them (sha1 of "blob <size>\0" + content).
const MODELS = Object.freeze({
  standard: {
    label: 'Standard',
    description: 'Quick, and good with clear speech.',
    id: 'onnx-community/whisper-base_timestamped',
    revision: '608c49e61301901684bc36cac8f74b95ff6b5a8e',
    // Full-precision encoder, 4-bit decoder: the fastest pair on a GPU
    // (about 15x real time on an M-series Mac) that still runs well on the
    // CPU when there is no GPU (about 4x).
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    files: [
      { path: 'config.json', size: 2243, git: 'ce7faf5d5e56e82d4800e55f524582a525639ff7' },
      { path: 'generation_config.json', size: 3832, git: 'a57cdbf036979f80bb7ff092a0fee6256a81d329' },
      { path: 'preprocessor_config.json', size: 339, git: '91876762a536a746d268353c5cba57286e76b058' },
      { path: 'tokenizer.json', size: 2480466, git: '1e95340ff836fad1b5932e800fb7b8c5e6d78a74' },
      { path: 'tokenizer_config.json', size: 282682, git: '25be523be5ac50a7671a77f55acba082459d6314' },
      { path: 'onnx/encoder_model.onnx', size: 82451730, sha256: '7fcea817bb2be4d86729b521e5a7fcbec28fa743edfed67e882b33ff15852540' },
      { path: 'onnx/decoder_model_merged_q4.onnx', size: 123738327, sha256: 'fc1902ce2e42c69b2346d8e2a98898c60c01da1e6a64ae90f41d22350ac7db13' }
    ]
  },
  accurate: {
    label: 'More accurate',
    description: 'Better with accents and background noise. Slower, and a bigger download.',
    id: 'onnx-community/whisper-small_timestamped',
    revision: '65caa70f294b46e1c33ff820aae6b16d048ab818',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    files: [
      { path: 'config.json', size: 2227, git: 'b0447377b1ade057f991a6a0870d2a91de762f7f' },
      { path: 'generation_config.json', size: 3893, git: '703dc78ee83e87fca3ace72170253cdfe4cd2d13' },
      { path: 'preprocessor_config.json', size: 339, git: '91876762a536a746d268353c5cba57286e76b058' },
      { path: 'tokenizer.json', size: 2480466, git: '1e95340ff836fad1b5932e800fb7b8c5e6d78a74' },
      { path: 'tokenizer_config.json', size: 282683, git: 'd13b786c04765fb1a06492b53587752cd67665ea' },
      { path: 'onnx/encoder_model.onnx', size: 352791798, sha256: 'c0908c1ef2326f5487d1f77e56c6925f910ae56c87fa269ed885682ac851e588' },
      { path: 'onnx/decoder_model_merged_q4.onnx', size: 233421212, sha256: '333bf5560a548e89b03abab5c4d33a7057129b08782707cebcbdf25b63588915' }
    ]
  }
});

const DEFAULT_MODEL = 'standard';

function validateModelKey(key, catalog = MODELS) {
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(catalog, key)) {
    throw new Error(`Unknown speech model: ${JSON.stringify(key)}`);
  }
  return key;
}

const totalBytes = (m) => m.files.reduce((n, f) => n + f.size, 0);

function hasherFor(file) {
  if (file.sha256) return { hash: crypto.createHash('sha256'), expected: file.sha256 };
  const hash = crypto.createHash('sha1');
  hash.update(`blob ${file.size}\0`);
  return { hash, expected: file.git };
}

class SpeechModelError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// `root` may be a function, so the path is only resolved on first use (after
// the app has set up its userData directory).
function createSpeechModels({ root, fetchImpl = fetch, host = HOST, catalog = MODELS }) {
  const inFlight = new Map(); // key -> { promise, controller, listeners }
  const rootDir = () => (typeof root === 'function' ? root() : root);

  const dirOf = (m) => path.join(rootDir(), ...m.id.split('/'));
  const markerOf = (m) => path.join(dirOf(m), '.complete');

  function isDownloaded(key) {
    const m = catalog[key];
    try {
      const marker = JSON.parse(fs.readFileSync(markerOf(m), 'utf8'));
      if (marker.revision !== m.revision) return false;
      // Sizes only: hashing hundreds of MB on every check would be slow, and
      // the hashes were verified when the files were written.
      return m.files.every((f) => fs.statSync(path.join(dirOf(m), f.path)).size === f.size);
    } catch {
      return false;
    }
  }

  function info(key) {
    const m = catalog[key];
    return {
      key,
      label: m.label,
      description: m.description,
      bytes: totalBytes(m),
      downloaded: isDownloaded(key),
      downloading: inFlight.has(key)
    };
  }

  function list() {
    return Object.keys(catalog).map(info);
  }

  // What the captions worker needs to load a downloaded model.
  function loadInfo(key) {
    const m = catalog[key];
    // A trailing slash so transformers.js joins "<id>/<file>" beneath it.
    const baseUrl = pathToFileURL(rootDir()).href.replace(/\/?$/, '/');
    return { key, id: m.id, dtype: m.dtype, baseUrl };
  }

  async function downloadFile(m, file, signal, onBytes) {
    const dest = path.join(dirOf(m), file.path);
    const part = `${dest}.part`;
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const { hash, expected } = hasherFor(file);

    // Resume an interrupted download: re-hash what is already there, then
    // ask for the rest.
    let have = 0;
    try {
      const st = await fs.promises.stat(part);
      if (st.size > 0 && st.size < file.size) {
        for await (const chunk of fs.createReadStream(part)) hash.update(chunk);
        have = st.size;
      } else {
        await fs.promises.rm(part, { force: true });
      }
    } catch { /* nothing to resume */ }

    const url = `${host}/${m.id}/resolve/${m.revision}/${file.path}`;
    const headers = have ? { Range: `bytes=${have}-` } : {};
    let res;
    try {
      res = await fetchImpl(url, { headers, signal, redirect: 'follow' });
    } catch (err) {
      if (signal.aborted) throw new SpeechModelError('cancelled', 'Download cancelled');
      throw new SpeechModelError('network', `Could not download the speech model. Check your internet connection and try again. (${err.message})`);
    }
    if (have && res.status !== 206) {
      // The server ignored the range: start this file over.
      if (res.body) await res.body.cancel().catch(() => {});
      await fs.promises.rm(part, { force: true });
      return downloadFile(m, file, signal, onBytes);
    }
    if (!res.ok) {
      throw new SpeechModelError('network', `Could not download the speech model (the server said ${res.status}). Please try again later.`);
    }
    onBytes(have);

    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    let written = have;
    try {
      for await (const chunk of res.body) {
        if (signal.aborted) throw new SpeechModelError('cancelled', 'Download cancelled');
        const buf = Buffer.from(chunk);
        written += buf.length;
        if (written > file.size) throw new SpeechModelError('corrupt', 'The downloaded speech model was not what was expected. Please try again.');
        hash.update(buf);
        if (!out.write(buf)) await once(out, 'drain');
        onBytes(buf.length);
      }
    } catch (err) {
      out.destroy();
      if (signal.aborted) throw new SpeechModelError('cancelled', 'Download cancelled');
      if (err instanceof SpeechModelError) {
        if (err.code === 'corrupt') await fs.promises.rm(part, { force: true });
        throw err;
      }
      throw new SpeechModelError('network', `The download stopped part way. Check your internet connection and try again. (${err.message})`);
    }
    out.end();
    await once(out, 'close');

    if (written !== file.size || hash.digest('hex') !== expected) {
      await fs.promises.rm(part, { force: true });
      throw new SpeechModelError('corrupt', 'The downloaded speech model was not what was expected. Please try again.');
    }
    await fs.promises.rename(part, dest);
  }

  // Download whatever is missing; resolves with loadInfo. Calling it again
  // while a download runs joins that download.
  function ensure(key, onProgress = () => {}) {
    validateModelKey(key, catalog);
    if (isDownloaded(key)) return Promise.resolve(loadInfo(key));
    const running = inFlight.get(key);
    if (running) {
      running.listeners.add(onProgress);
      return running.promise;
    }
    const m = catalog[key];
    const controller = new AbortController();
    const listeners = new Set([onProgress]);
    const total = totalBytes(m);
    let received = 0;
    let lastSent = 0;
    const report = (file, force) => {
      const now = Date.now();
      if (!force && now - lastSent < 200) return;
      lastSent = now;
      for (const cb of listeners) {
        try { cb({ key, received, total, file }); } catch { /* a closed window */ }
      }
    };

    const promise = (async () => {
      await fs.promises.mkdir(dirOf(m), { recursive: true });
      await fs.promises.rm(markerOf(m), { force: true });
      for (const file of m.files) {
        const dest = path.join(dirOf(m), file.path);
        const st = await fs.promises.stat(dest).catch(() => null);
        if (st && st.size === file.size) {
          received += file.size;
          report(file.path, true);
          continue;
        }
        await downloadFile(m, file, controller.signal, (n) => { received += n; report(file.path, false); });
      }
      await fs.promises.writeFile(markerOf(m), JSON.stringify({ revision: m.revision, id: m.id }));
      report(null, true);
      return loadInfo(key);
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, { promise, controller, listeners });
    return promise;
  }

  function cancel(key) {
    validateModelKey(key, catalog);
    const running = inFlight.get(key);
    if (running) running.controller.abort();
    return Boolean(running);
  }

  async function remove(key) {
    validateModelKey(key, catalog);
    cancel(key);
    await inFlight.get(key)?.promise.catch(() => {});
    await fs.promises.rm(dirOf(catalog[key]), { recursive: true, force: true });
    return info(key);
  }

  return { list, info, ensure, cancel, remove, isDownloaded, loadInfo };
}

module.exports = { MODELS, DEFAULT_MODEL, createSpeechModels, validateModelKey, SpeechModelError };
