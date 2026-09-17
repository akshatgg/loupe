# RNNoise (WebAssembly)

Noise suppression for voice, used by `src/core/audio/denoise.js` through the
loader in `src/core/audio/rnnoise.js`.

- **What:** the RNNoise library by Jean-Marc Valin / Xiph.Org
  (https://github.com/xiph/rnnoise), release 0.2 model, compiled to
  WebAssembly with Emscripten by Jitsi.
- **Where from:** npm package `@jitsi/rnnoise-wasm` 0.2.1, file
  `dist/rnnoise-sync.js`, which embeds the module as a base64 data URI. The
  bytes were decoded unchanged into `rnnoise.wasm`; the 1.9 MB JavaScript
  glue around them is not used.
- **sha256:** `4f513a50613de74378331237886138eab52fa2650e8b1a41eb587d932d9b8850`
- **Licences:** RNNoise is BSD-3-Clause (`COPYING`); the Jitsi build is
  Apache-2.0 (`LICENSE`).

The export and import names inside the module are minified (`a`, `b`, ...).
`rnnoise.js` maps them for this exact file, so replacing it means re-checking
that table against the new build's Emscripten glue. `test/audio-denoise.test.js`
loads it, runs frames through it and checks the measured latency.
