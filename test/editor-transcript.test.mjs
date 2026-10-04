import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptWords, wordAt } from '../src/renderer/editor/transcript-panel.js';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';

const project = () => {
  const p = P.createProject({ main: { width: 1920, height: 1080, duration: 20 }, createdAt: 0 });
  return P.setCaptions(p, {
    segments: [
      { id: 's1', source: 'main', start: 1, end: 3, text: 'Hello there world',
        words: [{ text: 'Hello', start: 1, end: 1.5 }, { text: 'there', start: 1.6, end: 2.2 }, { text: 'world', start: 2.4, end: 3 }] },
      { id: 's2', source: 'main', start: 6, end: 8, text: 'A line without word times' }
    ]
  });
};

test('words come out in order, a line without timings as one entry', () => {
  const p = project();
  const words = transcriptWords(p, buildTimeline(p));
  assert.deepEqual(words.map((w) => w.text), ['Hello', 'there', 'world', 'A line without word times']);
  assert.deepEqual(words.map((w) => w.first), [true, false, false, true]);
  assert.ok(Math.abs(words[1].outStart - 1.6) < 1e-9);
  assert.equal(words[3].segmentId, 's2');
});

test('a word cut from the video is left out, and later words move up', () => {
  const p = P.cutRange(project(), 1.55, 2.3);
  const words = transcriptWords(p, buildTimeline(p));
  assert.deepEqual(words.map((w) => w.text), ['Hello', 'world', 'A line without word times']);
  assert.ok(Math.abs(words[1].outStart - (2.4 - 0.75)) < 1e-6, `world at ${words[1].outStart}`);
});

test('a speed change moves the words with it', () => {
  const p = P.paintSpeed(project(), { start: 4, end: 6, rate: 2 });
  const tl = buildTimeline(p);
  const words = transcriptWords(p, tl);
  assert.ok(words[3].outStart < 6 && words[3].outStart > 4.9, `after a 2x stretch: ${words[3].outStart}`);
});

test('no captions: no words', () => {
  const p = P.createProject({ main: { width: 10, height: 10, duration: 5 }, createdAt: 0 });
  assert.deepEqual(transcriptWords(p, buildTimeline(p)), []);
});

test('wordAt finds the word being said, and nothing in a long silence', () => {
  const p = project();
  const words = transcriptWords(p, buildTimeline(p));
  assert.equal(wordAt(words, 0.5), -1);
  assert.equal(wordAt(words, 1.2), 0);
  assert.equal(wordAt(words, 1.55), 0, 'just after a word it stays lit');
  assert.equal(wordAt(words, 1.7), 1);
  assert.equal(wordAt(words, 4.5), -1);
  assert.equal(wordAt(words, 7), 3);
  assert.equal(wordAt([], 1), -1);
});

test('with cut words kept, they sit where they were said, marked cut, and are never the word being said', async () => {
  const { wordsRange } = await import('../src/renderer/editor/transcript-panel.js');
  const p = P.cutRange(project(), 1.55, 2.3);
  const words = transcriptWords(p, buildTimeline(p), { withCut: true });
  assert.deepEqual(words.map((w) => [w.text, Boolean(w.cut)]), [['Hello', false], ['there', true], ['world', false], ['A line without word times', false]]);
  assert.equal(wordAt(words, 1.56), 0, 'the cut word is skipped');
  assert.deepEqual(wordsRange(words, 0, 2), { source: 'main', start: 1, end: 3, count: 2 });
  assert.deepEqual(wordsRange(words, 2, 0), { source: 'main', start: 1, end: 3, count: 2 }, 'picked backwards');
  assert.equal(wordsRange(words, 1, 1), null, 'only a cut word: nothing to cut');
});

test('words carry their moment of the recording', () => {
  const p = project();
  const [hello] = transcriptWords(p, buildTimeline(p));
  assert.deepEqual([hello.source, hello.start, hello.end], ['main', 1, 1.5]);
});
