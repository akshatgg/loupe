'use strict';
module.exports = [
  {
    files: ['**/*.js'],
    ignores: ['src/renderer/**', 'web/**'],
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
  // The website's Vercel Functions (web/api/) are CommonJS Node, not browser code.
  {
    files: ['web/api/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', process: 'readonly',
                 Buffer: 'readonly', globalThis: 'readonly' }
    }
  },
  { ignores: ['bin/', 'node_modules/', 'dist/', '.build-native/', 'web/node_modules/'] }
];
