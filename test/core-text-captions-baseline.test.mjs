// A project saved before caption presets and text styling existed must look
// exactly as it did. The fixture holds two such projects and, for a spread of
// moments in each, every call the frame made on the drawing context with the
// code as it was then (test/support/record-frame.mjs). The same projects,
// loaded and drawn by today's code, must make the same calls.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import * as P from '../src/core/project.js';
import { recordFrame } from './support/record-frame.mjs';

const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/text-captions-baseline.json', import.meta.url), 'utf8'));
const copy = (v) => JSON.parse(JSON.stringify(v));

test('the fixture covers captions with and without the box, text and title cards, at rest and mid-fade', () => {
  assert.strictEqual(baseline.cases.length, 18);
  const drawn = new Set(baseline.cases.flatMap((c) => c.calls.filter((x) => x[0] === 'fillText').map((x) => x[1][0])));
  for (const words of ['Hello there everyone', 'Hello', 'world', 'My demo', 'Part one']) assert.ok(drawn.has(words), words);
  assert.ok(baseline.cases.some((c) => c.calls.some((x) => x[0] === 'strokeText')), 'outlined captions');
  // Saved in the old format: no preset, font or animation anywhere.
  assert.deepStrictEqual(Object.keys(baseline.projects.boxed.captions.style).sort(), ['box', 'position', 'size']);
  assert.ok(baseline.projects.boxed.annotations.every((a) => !('font' in a) && !('animateIn' in a)));
});

for (const c of baseline.cases) {
  test(`a project saved before this draws the same: ${c.name}`, () => {
    const project = P.validateProject(copy(baseline.projects[c.project]));
    assert.deepStrictEqual(recordFrame(project, c.outT), c.calls);
  });
}

test('loading an older project leaves its annotations as they were saved', () => {
  const saved = copy(baseline.projects.boxed);
  assert.deepStrictEqual(P.validateProject(copy(saved)).annotations, saved.annotations);
});

test('a captions style saved without a preset is named after what it is', () => {
  assert.strictEqual(P.validateProject(copy(baseline.projects.boxed)).captions.style.preset, 'classic');
  assert.strictEqual(P.validateProject(copy(baseline.projects.outlined)).captions.style.preset, 'outline');
});
