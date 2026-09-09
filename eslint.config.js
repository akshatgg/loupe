'use strict';
module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', process: 'readonly',
                 console: 'readonly', __dirname: 'readonly', Buffer: 'readonly',
                 setTimeout: 'readonly', clearTimeout: 'readonly',
                 setInterval: 'readonly', clearInterval: 'readonly' }
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'prefer-const': 'error',
      eqeqeq: 'error'
    }
  },
  { ignores: ['bin/', 'node_modules/', 'dist/', 'src/renderer/'] }
];
