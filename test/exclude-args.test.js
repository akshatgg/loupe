'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildExcludeWindowArgs } = require('../src/main/exclude-args');

test('builds one --exclude-window pair per id', () => {
  assert.deepStrictEqual(
    buildExcludeWindowArgs(['12', '34']),
    ['--exclude-window', '12', '--exclude-window', '34']
  );
});

test('accepts numbers, not just strings', () => {
  assert.deepStrictEqual(
    buildExcludeWindowArgs([12, 34]),
    ['--exclude-window', '12', '--exclude-window', '34']
  );
});

test('empty/undefined/null input yields no args', () => {
  assert.deepStrictEqual(buildExcludeWindowArgs([]), []);
  assert.deepStrictEqual(buildExcludeWindowArgs(undefined), []);
  assert.deepStrictEqual(buildExcludeWindowArgs(null), []);
});

test('skips null/undefined entries within the list', () => {
  assert.deepStrictEqual(
    buildExcludeWindowArgs([null, '5', undefined]),
    ['--exclude-window', '5']
  );
});

test('drops duplicate ids', () => {
  assert.deepStrictEqual(
    buildExcludeWindowArgs(['7', '7', 7]),
    ['--exclude-window', '7']
  );
});

test('drops malformed (non-numeric) ids rather than passing them through', () => {
  assert.deepStrictEqual(
    buildExcludeWindowArgs(['12', 'abc', '-1', '3.5', '']),
    ['--exclude-window', '12']
  );
});

test('preserves first-seen order', () => {
  assert.deepStrictEqual(
    buildExcludeWindowArgs(['9', '3', '9', '1']),
    ['--exclude-window', '9', '--exclude-window', '3', '--exclude-window', '1']
  );
});
