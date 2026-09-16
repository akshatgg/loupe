# transformers.js (vendored)

On-device speech to text for captions (`src/renderer/captions/worker.js`).
Vendored so the app keeps zero runtime npm dependencies and never loads code
from a CDN.

- `transformers.min.js`: `@huggingface/transformers` 4.3.0, `dist/transformers.min.js`
  (Apache-2.0, `LICENSE`)
- `ort-wasm-simd-threaded.asyncify.mjs` / `.wasm`: the ONNX Runtime Web 1.30.0
  WebAssembly/WebGPU runtime that build expects (MIT, `LICENSE-onnxruntime`)

sha256:

```
1475fd440e9932ab206682ee42cb18f6097403e9ee77ea62084c592d0f83597d  transformers.min.js
0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611  ort-wasm-simd-threaded.asyncify.mjs
49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082  ort-wasm-simd-threaded.asyncify.wasm
```

The speech models themselves are not vendored: they download once into
userData (`src/main/speech-models.js`), pinned to a revision and hash.
