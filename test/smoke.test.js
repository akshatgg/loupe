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

test('every window page declares a Content-Security-Policy', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src', 'renderer');
  for (const name of fs.readdirSync(dir)) {
    const page = path.join(dir, name, 'index.html');
    if (!fs.existsSync(page)) continue;
    assert.match(fs.readFileSync(page, 'utf8'), /http-equiv="Content-Security-Policy"/, `${name}/index.html`);
  }
});
