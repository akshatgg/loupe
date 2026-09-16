// A small loader for the vendored RNNoise build (src/vendor/rnnoise/).
//
// The Emscripten glue that ships with the build is a 1.9 MB script that only
// runs in a page or worker. The module itself needs just two tiny imports, so
// it is instantiated directly here instead -- the same code then runs in the
// editor, the exporter and under `node --test`.
//
// Not pure: loadRnnoise() reads the .wasm file, with fetch() in a browser
// and node:fs under Node. Everything after loading is plain computation.

// RNNoise works on 10 ms frames at 48 kHz, on samples scaled like 16-bit PCM.
export const RNNOISE_RATE = 48000;
export const RNNOISE_FRAME = 480;

// Export/import names are minified by the build, so they are pinned to this
// exact file (sha256 in src/vendor/rnnoise/README.md). Replacing the .wasm
// means re-checking this table against its Emscripten glue.
const EXPORTS = {
  memory: 'c', ctors: 'd', malloc: 'e', free: 'f',
  create: 'h', destroy: 'i', processFrame: 'j'
};

const WASM_URL = new URL('../../vendor/rnnoise/rnnoise.wasm', import.meta.url);

let modulePromise = null;

async function readWasmBytes() {
  // Node's fetch() cannot read file:// URLs, so wherever Node APIs exist
  // (tests, Electron's main process) read from disk. Sandboxed renderer pages
  // and workers have no `process` and use fetch(file://), which works there.
  if ((typeof process === 'object' && process.versions?.node) || typeof fetch !== 'function') {
    const { readFile } = await import('node:fs/promises');
    return readFile(WASM_URL);
  }
  const res = await fetch(WASM_URL);
  if (!res.ok) throw new Error(`could not load noise removal (${res.status})`);
  return res.arrayBuffer();
}

// Compiles once per process; each engine instance gets its own memory.
function compiled(bytes) {
  if (bytes) return WebAssembly.compile(bytes);
  // A failed load is not cached, so a later export can try again.
  modulePromise ??= readWasmBytes().then((b) => WebAssembly.compile(b))
    .catch((err) => { modulePromise = null; throw err; });
  return modulePromise;
}

// Returns an engine with its own heap. `process(frame)` denoises exactly
// RNNOISE_FRAME float samples in [-1, 1] in place and returns RNNoise's voice
// probability for the frame (0..1). Create one state per channel, since the
// model carries history between frames.
export async function loadRnnoise({ wasm } = {}) {
  const module = wasm instanceof WebAssembly.Module ? wasm : await compiled(wasm);
  let memory = null;
  const imports = {
    a: {
      // _emscripten_resize_heap: grow to at least the requested byte size.
      a: (requested) => {
        const pages = Math.ceil(((requested >>> 0) - memory.buffer.byteLength) / 65536);
        try { memory.grow(Math.max(pages, 1)); return 1; } catch { return 0; }
      },
      // _emscripten_memcpy_big
      b: (dest, src, num) => {
        new Uint8Array(memory.buffer).copyWithin(dest, src, src + num);
      }
    }
  };
  const instance = await WebAssembly.instantiate(module, imports);
  const x = instance.exports;
  memory = x[EXPORTS.memory];
  x[EXPORTS.ctors]();

  function createState() {
    // A null model pointer selects the model compiled into the library.
    const st = x[EXPORTS.create](0);
    const ptr = x[EXPORTS.malloc](RNNOISE_FRAME * 4);
    if (!st || !ptr) throw new Error('noise removal ran out of memory');
    let alive = true;
    return {
      process(frame) {
        if (!alive) throw new Error('state destroyed');
        // The heap can grow (and its buffer be replaced) during a call, so
        // views are made fresh each time rather than cached.
        const heap = new Float32Array(memory.buffer, ptr, RNNOISE_FRAME);
        for (let i = 0; i < RNNOISE_FRAME; i++) heap[i] = frame[i] * 32768;
        const vad = x[EXPORTS.processFrame](st, ptr, ptr);
        const out = new Float32Array(memory.buffer, ptr, RNNOISE_FRAME);
        for (let i = 0; i < RNNOISE_FRAME; i++) frame[i] = out[i] / 32768;
        return vad;
      },
      destroy() {
        if (!alive) return;
        alive = false;
        x[EXPORTS.destroy](st);
        x[EXPORTS.free](ptr);
      }
    };
  }

  return { createState };
}
