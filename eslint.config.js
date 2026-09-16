'use strict';
module.exports = [
  {
    files: ['**/*.js'],
    ignores: ['src/renderer/**', 'web/**', 'src/core/**', 'test/e2e/lab.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', process: 'readonly',
                 console: 'readonly', __dirname: 'readonly', Buffer: 'readonly',
                 setTimeout: 'readonly', clearTimeout: 'readonly',
                 setInterval: 'readonly', clearInterval: 'readonly',
                 setImmediate: 'readonly', fetch: 'readonly' }
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'prefer-const': 'error',
      eqeqeq: 'error'
    }
  },
  // The renderer scripts are plain browser scripts loaded via <script> tags
  // (see src/renderer/*/index.html), not CommonJS modules -- they have no
  // `require`/`module` and run with the DOM globals a preload script exposes
  // (window.loupe) plus the ordinary browser environment. This is also,
  // per the final review, the one place a real security bug lived (untrusted
  // window titles reaching innerHTML in the picker) -- linting it is worth
  // doing permanently even though it is clean today.
  {
    files: ['src/renderer/**/*.js'],
    ignores: ['src/renderer/exporter/**', 'src/renderer/editor/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        console: 'readonly', requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly', setTimeout: 'readonly',
        clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', fetch: 'readonly', URL: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly', Path2D: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'prefer-const': 'error',
      eqeqeq: 'error'
    }
  },
  // The website (web/, deployed to Vercel) is plain browser scripts too.
  {
    files: ['web/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        console: 'readonly', fetch: 'readonly', URL: 'readonly', Intl: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        matchMedia: 'readonly', IntersectionObserver: 'readonly',
        getComputedStyle: 'readonly', performance: 'readonly', location: 'readonly',
        AbortController: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'prefer-const': 'error',
      eqeqeq: 'error'
    }
  },
  // The shared core (src/core, docs/EDITOR-V2.md) is ES modules used by
  // main, the renderer windows and the tests alike, so it may only lean on
  // what every one of those has: no DOM, no Node APIs.
  {
    files: ['src/core/**/*.js', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { console: 'readonly', structuredClone: 'readonly', URL: 'readonly' }
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'prefer-const': 'error',
      eqeqeq: 'error'
    }
  },
  // The exporter window (src/renderer/exporter) is ES modules running in a
  // hidden, sandboxed page: browser and WebCodecs globals, no Node. The e2e
  // lab page is the same kind of page.
  {
    files: ['src/renderer/exporter/**/*.js', 'test/e2e/lab.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', console: 'readonly', fetch: 'readonly',
        URL: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        performance: 'readonly', OffscreenCanvas: 'readonly', createImageBitmap: 'readonly',
        VideoDecoder: 'readonly', VideoEncoder: 'readonly', VideoFrame: 'readonly',
        AudioDecoder: 'readonly', AudioEncoder: 'readonly', AudioData: 'readonly',
        EncodedVideoChunk: 'readonly', EncodedAudioChunk: 'readonly', Blob: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'prefer-const': 'error',
      eqeqeq: 'error'
    }
  },
  // The editor window (src/renderer/editor) is ES modules too, in a sandboxed
  // page that reaches main only through window.loupe.
  {
    files: ['src/renderer/editor/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', console: 'readonly', fetch: 'readonly',
        URL: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', performance: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', ResizeObserver: 'readonly',
        Audio: 'readonly', Node: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'prefer-const': 'error',
      eqeqeq: 'error'
    }
  },
  // Local git worktrees of this repo are checked out under it; each lints itself.
  { ignores: ['src/vendor/', 'test/e2e/out/', 'bin/', 'node_modules/', 'dist/', '.build-native/', 'web/node_modules/'] }
];
