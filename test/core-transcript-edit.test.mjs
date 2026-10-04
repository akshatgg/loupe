import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/core/transcript-edit.js';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';

const near = (a, b, what, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
const w = (text, start, end) => ({ text, start, end });
const project = (words, duration = 30) => {
  const p = P.createProject({ main: { width: 1920, height: 1080, duration }, createdAt: 0 });
  return P.setCaptions(p, { segments: [{ id: 's1', source: 'main', start: words[0].start, end: words.at(-1).end, text: words.map((x) => x.text).join(' '), words }] });
};
const talk = () => project([
  w('So', 1, 1.2), w('um', 1.4, 1.7), w('this', 1.8, 2), w('is', 2.05, 2.2), w('the', 2.25, 2.4), w('uh,', 2.5, 2.9), w('editor.', 3, 3.5),
  w('It', 8, 8.2), w('works', 8.25, 8.6), w('like', 9.2, 9.5), w('you', 10, 10.2), w('know', 10.25, 10.5), w('well.', 11, 11.4)
]);

test('cutting a stretch splits the clip around it and shortens the video by that much', () => {
  const p = talk();
  const next = T.cutSource(p, 'main', 1.4, 1.7);
  assert.equal(next.clips.length, 2);
  near(next.clips[0].end, 1.4, 'first ends at the cut');
  near(next.clips[1].start, 1.7, 'second starts after it');
  near(buildTimeline(next).duration, 30 - 0.3, 'shorter by the cut');
  assert.equal(new Set(next.clips.map((c) => c.id)).size, 2);
  assert.equal(T.cutSource(next, 'main', 1.45, 1.65), next, 'already cut: nothing to do');
});

test('a cut at a clip’s very start or end leaves no sliver, and the whole video can’t go', () => {
  const p = talk();
  const next = T.cutSource(p, 'main', 0.05, 2);
  assert.equal(next.clips.length, 1);
  near(next.clips[0].start, 2, 'the sliver before went too');
  assert.throws(() => T.cutSource(p, 'main', 0, 30), /whole video/);
  assert.throws(() => T.cutSource(p, 'main', 2, 2), /Select some words/);
});

test('a transition after the clip stays at its end', () => {
  let p = P.splitAt(talk(), 20);
  p = P.setTransition(p, p.clips[0].id, 'fade');
  const next = T.cutSource(p, 'main', 5, 6);
  assert.equal(next.clips.length, 3);
  assert.equal(next.transitions[0].after, next.clips[1].id, 'on the second piece, before the next clip');
});

test('a cut is put back by joining the clips either side, exactly as it was', () => {
  const p = talk();
  const cut = T.cutSource(p, 'main', 1.4, 1.7);
  assert.equal(T.canRestore(cut, 'main', 1.5), true);
  const back = T.restoreSource(cut, 'main', 1.5);
  assert.deepEqual(back.clips.map((c) => [c.start, c.end]), [[0, 30]]);
  near(buildTimeline(back).duration, 30, 'the full length again');
  assert.equal(T.canRestore(back, 'main', 1.5), false, 'nothing cut there now');
});

test('restoring is refused in plain words once the clips around it differ', () => {
  let cut = T.cutSource(talk(), 'main', 1.4, 1.7);
  cut = P.setClipLook(cut, cut.clips[0].id, { color: { brightness: 0.4 } });
  assert.throws(() => T.restoreSource(cut, 'main', 1.5), /can’t be put back/);
});

test('filler words are found: always "um" and "uh", "like" and "you know" only between pauses', () => {
  const ranges = T.fillerRanges(talk());
  assert.deepEqual(ranges.map((r) => [r.start, r.end]), [[1.4, 1.7], [2.5, 2.9], [9.2, 9.5], [10, 10.5]]);
  // "So" opening the sentence is followed at once by speech; "works like" with no pause is not a filler.
  const fluent = project([w('It', 1, 1.2), w('works', 1.25, 1.5), w('like', 1.55, 1.8), w('this.', 1.85, 2.2)]);
  assert.deepEqual(T.fillerRanges(fluent), []);
});

test('the filler switch cuts them all as one edit and puts them all back', () => {
  const p = talk();
  const on = T.setFillersCut(p, true);
  assert.equal(T.hasCuts(on, 'filler'), true);
  assert.equal(on.transcript.cuts.length, 4);
  near(buildTimeline(on).duration, 30 - (0.3 + 0.4 + 0.3 + 0.5), 'shorter by the fillers');
  P.validateProject(JSON.parse(JSON.stringify(on)));
  const off = T.setFillersCut(on, false);
  assert.equal(T.hasCuts(off, 'filler'), false);
  assert.equal('transcript' in off, false);
  assert.deepEqual(off.clips.map((c) => [c.start, c.end]), [[0, 30]]);
});

test('long pauses are shortened to a short one, short pauses left alone', () => {
  const p = talk();
  const ranges = T.silenceRanges(p);
  assert.equal(ranges.length, 1, 'only the 4.5 s pause before "It"');
  near(ranges[0].start, 3.5 + 0.2, 'keeps a little after the last word');
  near(ranges[0].end, 8 - 0.2, 'and a little before the next');
  const on = T.setSilencesCut(p, true);
  near(buildTimeline(on).duration, 30 - 4.1, 'the pause is now 0.4 s');
  const off = T.setSilencesCut(on, false);
  near(buildTimeline(off).duration, 30, 'and back');
});

test('both switches together, off in either order, end where they began', () => {
  const p = talk();
  const both = T.setSilencesCut(T.setFillersCut(p, true), true);
  assert.equal(both.transcript.cuts.filter((c) => c.reason === 'silence').length, 1);
  const a = T.setFillersCut(T.setSilencesCut(both, false), false);
  const b = T.setSilencesCut(T.setFillersCut(both, false), false);
  for (const end of [a, b]) assert.deepEqual(end.clips.map((c) => [c.start, c.end]), [[0, 30]]);
});

test('no transcript: the switches change nothing', () => {
  const p = P.createProject({ main: { width: 10, height: 10, duration: 5 }, createdAt: 0 });
  assert.equal(T.setFillersCut(p, true), p);
  assert.equal(T.setSilencesCut(p, true), p);
});

test('a hand-edited transcript section is cleaned, not refused', () => {
  const p = { ...talk(), transcript: { cuts: [{ source: 'main', start: 1, end: 2, reason: 'filler' }, { source: 'nope', start: 1, end: 2, reason: 'filler' }, 'junk'] } };
  assert.equal(P.validateProject(p).transcript.cuts.length, 1);
  assert.equal('transcript' in P.validateProject({ ...p, transcript: 'x' }), false);
});

test('a caption no longer says a word that was cut, and stays one caption across the cut', async () => {
  const { captionsToOutput } = await import('../src/core/captions/timeline.js');
  // Words as the transcriber writes them: each with its leading space.
  const words = [[' So', 1, 1.2], [' um', 1.4, 1.7], [' this', 1.8, 2], [' works.', 2.05, 2.6]].map(([text, start, end]) => ({ text, start, end }));
  let p = P.createProject({ main: { width: 1920, height: 1080, duration: 30 }, createdAt: 0 });
  p = P.setCaptions(p, { segments: [{ id: 's1', source: 'main', start: 1, end: 2.6, text: 'So um this works.', words }] });
  const before = captionsToOutput(p.captions.segments, buildTimeline(p));
  assert.deepEqual(before.map((c) => c.text), ['So um this works.']);
  const cut = T.setFillersCut(p, true);
  const after = captionsToOutput(cut.captions.segments, buildTimeline(cut));
  assert.deepEqual(after.map((c) => c.text), ['So this works.']);
  assert.deepEqual(after[0].words.map((w) => w.text.trim()), ['So', 'this', 'works.']);
  near(after[0].end - after[0].start, 1.6 - 0.3, 'as long as what is left', 1e-3);
  // The project's own transcript is untouched, so putting the word back restores the caption.
  const back = T.setFillersCut(cut, false);
  assert.deepEqual(captionsToOutput(back.captions.segments, buildTimeline(back)).map((c) => c.text), ['So um this works.']);
});

test('a caption cut in two by a long removal is two captions, each with its own words', async () => {
  const { captionsToOutput } = await import('../src/core/captions/timeline.js');
  const words = [[' One', 1, 1.4], [' two', 1.5, 1.9], [' three', 6, 6.4], [' four', 6.5, 7]].map(([text, start, end]) => ({ text, start, end }));
  let p = P.createProject({ main: { width: 1920, height: 1080, duration: 30 }, createdAt: 0 });
  p = P.setCaptions(p, { segments: [{ id: 's1', source: 'main', start: 1, end: 7, text: 'One two three four', words }] });
  // Move the second half to the front: the halves no longer play one after the other.
  p = P.splitAt(p, 4);
  p = P.moveClip(p, 1, 0);
  const cues = captionsToOutput(p.captions.segments, buildTimeline(p));
  assert.deepEqual(cues.map((c) => c.text), ['three four', 'One two']);
});
