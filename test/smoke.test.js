'use strict';
const test = require('node:test');
const assert = require('node:assert');
const pkg = require('../package.json');

test('package declares the native build script', () => {
  assert.ok(pkg.scripts['build:native'], 'build:native script must exist');
});

test('package has no runtime dependencies', () => {
  assert.deepStrictEqual(pkg.dependencies ?? {}, {});
});
