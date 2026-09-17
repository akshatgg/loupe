'use strict';
const test = require('node:test');
const assert = require('node:assert');
// The captions core is ESM (src/core); Node loads it with require().
const {
  normalizeCaptions, normalizeSegment, wordsFromChunks, joinWords, segmentsAt, defaultCaptions,
  wrapText, buildSegments, LINE_DEFAULTS,
  addSegment, removeSegment, editText, mergeWithNext, mergeSegments, splitSegment, shiftTiming, setTiming,
  formatTimestamp, toSRT, toVTT, formatSubtitles,
  planChunks,
  isLanguage, languageName, languageChoices
} = require('../src/core/captions/index.js');

let n = 0;
const ids = () => `id${++n}`;

// "one two three" -> timed words, 0.4 s each with a 0.1 s gap.
function wordsOf(text, start = 0, step = 0.5) {
  return text.split(' ').map((w, i) => ({ text: ` ${w}`, start: start + i * step, end: start + i * step + step - 0.1 }));
}

// --- model ---------------------------------------------------------------

test('captions from disk are cleaned up rather than failing the project', () => {
  const c = normalizeCaptions({
    show: true,
    language: 'de',
    segments: [
      { id: 'b', source: 'main', start: 5, end: 6, text: ' later ' },
      { id: 'a', source: 'main', start: 1, end: 2, text: 'first', words: [{ text: 'first', start: 1, end: 1.5 }, { bogus: 1 }] },
      { id: 'a', start: 3, end: 4, text: 'duplicate id' },
      { start: 'x', end: 2, text: 'bad time' },
      { start: 1, end: 2, text: '   ' },
      null
    ],
    style: { size: 9, position: 'sideways' }
  });
  assert.strictEqual(c.show, true);
  assert.strictEqual(c.language, 'de');
  assert.deepStrictEqual(c.segments.map((s) => s.text), ['first', 'duplicate id', 'later']);
  assert.deepStrictEqual(c.segments[0].words, [{ text: 'first', start: 1, end: 1.5 }]);
  assert.notStrictEqual(c.segments[1].id, 'a', 'a duplicate id is replaced');
  assert.strictEqual(c.segments[1].source, 'main');
  assert.deepStrictEqual(c.style, { size: 2, position: 'bottom', box: true });
  assert.strictEqual(normalizeCaptions({ style: { box: false } }).style.box, false);
  assert.deepStrictEqual(normalizeCaptions(null), defaultCaptions());
});

test('a segment never has negative or zero length', () => {
  const s = normalizeSegment({ start: -2, end: -1, text: 'x' });
  assert.strictEqual(s.start, 0);
  assert.ok(s.end > s.start);
});

test('word chunks from the model become words in source time', () => {
  const words = wordsFromChunks([
    { text: ' Hello,', timestamp: [0.5, 0.9] },
    { text: ' ', timestamp: [0.9, 1] },
    { text: ' world', timestamp: [1.0, null] },
    { text: ' past', timestamp: [29.5, 31] },
    { text: 'broken', timestamp: [] }
  ], 60, 90);
  assert.deepStrictEqual(words, [
    { text: ' Hello,', start: 60.5, end: 60.9 },
    { text: ' world', start: 61, end: 61.3 },
    { text: ' past', start: 89.5, end: 90 }
  ]);
  assert.strictEqual(joinWords(words), 'Hello, world past');
});

test('segmentsAt finds what shows at a moment, start inclusive and end exclusive', () => {
  const segs = [{ source: 'main', start: 1, end: 2 }, { source: 'src2', start: 1, end: 3 }];
  assert.strictEqual(segmentsAt(segs, 1).length, 2);
  assert.strictEqual(segmentsAt(segs, 2).length, 1);
  assert.strictEqual(segmentsAt(segs, 1.5, 'main').length, 1);
  assert.strictEqual(segmentsAt(segs, 0.5).length, 0);
});

// --- lines ---------------------------------------------------------------

test('text wraps to at most 42 characters, balancing two lines', () => {
  const lines = wrapText('Today I will show you how to record your screen and share it');
  assert.strictEqual(lines.length, 2);
  for (const l of lines) assert.ok(l.length <= 42, l);
  // Balanced, not a full line over a stub.
  assert.ok(Math.abs(lines[0].length - lines[1].length) < 10, JSON.stringify(lines));
  assert.deepStrictEqual(wrapText('short'), ['short']);
  assert.deepStrictEqual(wrapText('typed\nnewline'), ['typed', 'newline']);
  // A word longer than a line gets its own line rather than being cut.
  assert.deepStrictEqual(wrapText('a supercalifragilisticexpialidocious b', 10), ['a', 'supercalifragilisticexpialidocious', 'b']);
  // No spaces (e.g. Japanese): broken anywhere.
  assert.ok(wrapText('あ'.repeat(50), 20).every((l) => l.length <= 20));
});

test('words become captions of at most two lines and six seconds', () => {
  const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const segs = buildSegments(wordsOf(text, 0, 0.3), { idFactory: ids, source: 'src2' });
  assert.ok(segs.length > 3);
  for (const s of segs) {
    assert.strictEqual(s.source, 'src2');
    assert.ok(wrapText(s.text).length <= LINE_DEFAULTS.maxLines, s.text);
    assert.ok(s.end - s.start <= LINE_DEFAULTS.maxDuration + 1e-9, `${s.start}-${s.end}`);
    assert.ok(s.words.length > 0);
  }
  // Every word is in exactly one caption, in order.
  assert.strictEqual(segs.map((s) => s.text).join(' '), text);
  for (let i = 1; i < segs.length; i++) assert.ok(segs[i].start >= segs[i - 1].end);
});

test('a pause or the end of a sentence starts a new caption', () => {
  const words = [
    ...wordsOf('We start with the library where recordings are saved.', 0),
    ...wordsOf('Next the editor.', 4.6),
    ...wordsOf('After a long pause', 20)
  ];
  const segs = buildSegments(words, { idFactory: ids });
  assert.deepStrictEqual(segs.map((s) => s.text), [
    'We start with the library where recordings are saved.',
    'Next the editor.',
    'After a long pause'
  ]);
});

test('a caption that would flash by is held for a second, without overlapping the next', () => {
  const segs = buildSegments([
    { text: ' Hi.', start: 0, end: 0.2 },
    { text: ' Next', start: 1.5, end: 1.9 },
    { text: ' Ok.', start: 5, end: 5.2 }
  ], { idFactory: ids, maxGap: 0.5 });
  assert.strictEqual(segs[0].end, 1);
  assert.ok(segs[1].end <= segs[2].start);
  const close = buildSegments([{ text: ' A.', start: 0, end: 0.2 }, { text: ' B', start: 0.6, end: 0.8 }], { idFactory: ids, maxGap: 0.3 });
  assert.ok(close[0].end <= close[1].start - LINE_DEFAULTS.minGap + 1e-9);
});

test('a full caption breaks at a comma rather than mid-phrase', () => {
  const words = wordsOf('When you are happy with the result of your editing, press export and choose the size you need', 0, 0.2);
  const segs = buildSegments(words, { idFactory: ids });
  assert.ok(segs[0].text.endsWith('editing,'), JSON.stringify(segs.map((s) => s.text)));
});

// --- edits ---------------------------------------------------------------

function sample() {
  return [
    { id: 'a', source: 'main', start: 0, end: 2, text: 'one two three four', words: wordsOf('one two three four', 0) },
    { id: 'b', source: 'main', start: 3, end: 5, text: 'five six' },
    { id: 'c', source: 'src2', start: 1, end: 2, text: 'other source' }
  ];
}

test('edits never change their input', () => {
  const segs = sample();
  const frozen = JSON.stringify(segs);
  editText(segs, 'a', 'x');
  mergeWithNext(segs, 'a');
  splitSegment(segs, 'a', { index: 3 }, ids);
  shiftTiming(segs, null, 1);
  setTiming(segs, 'a', { start: 1 });
  addSegment(segs, { start: 9, end: 10, text: 'new', id: 'n' });
  removeSegment(segs, 'a');
  assert.strictEqual(JSON.stringify(segs), frozen);
});

test('editing text drops word timings only when the words changed', () => {
  const same = editText(sample(), 'a', '  one  two three four ');
  assert.strictEqual(same.find((s) => s.id === 'a').text, 'one two three four');
  assert.ok(same.find((s) => s.id === 'a').words);
  const changed = editText(sample(), 'a', 'one 2 three four');
  assert.strictEqual(changed.find((s) => s.id === 'a').words, undefined);
  assert.deepStrictEqual(editText(sample(), 'missing', 'x'), sample());
});

test('merging joins a caption with the next one from the same source', () => {
  const m = mergeWithNext(sample(), 'a');
  const a = m.find((s) => s.id === 'a');
  assert.strictEqual(m.length, 2);
  assert.deepStrictEqual([a.start, a.end, a.text], [0, 5, 'one two three four five six']);
  assert.strictEqual(a.words, undefined, 'b had no word timings');
  assert.strictEqual(mergeSegments(sample(), 'a', 'c').length, 3, 'different sources do not merge');
  assert.strictEqual(mergeWithNext(sample(), 'b').length, 3, 'nothing after the last one');
});

test('splitting at the text cursor uses the word timings', () => {
  const s = splitSegment(sample(), 'a', { index: 'one two'.length }, () => 'a2');
  const left = s.find((x) => x.id === 'a');
  const right = s.find((x) => x.id === 'a2');
  assert.strictEqual(left.text, 'one two');
  assert.strictEqual(right.text, 'three four');
  // Between "two" (ends 0.9) and "three" (starts 1.0).
  assert.ok(Math.abs(left.end - 0.95) < 1e-9);
  assert.strictEqual(right.start, left.end);
  assert.strictEqual(left.words.length, 2);
});

test('splitting at the playhead, with and without word timings', () => {
  const s = splitSegment(sample(), 'a', { time: 1.3 }, () => 'a2');
  assert.deepStrictEqual(s.filter((x) => x.source === 'main').map((x) => x.text), ['one two three', 'four', 'five six']);
  const noWords = splitSegment(sample(), 'b', { time: 4 }, () => 'b2');
  assert.deepStrictEqual(noWords.filter((x) => x.start >= 3).map((x) => [x.text, x.start, x.end]), [['five', 3, 4], ['six', 4, 5]]);
  // Splitting at the very edge leaves one side empty: no change.
  assert.strictEqual(splitSegment(sample(), 'a', { index: 0 }).length, 3);
  assert.throws(() => splitSegment(sample(), 'a', {}));
});

test('shifting timing moves captions (and their words) but never before zero', () => {
  const later = shiftTiming(sample(), null, 0.5);
  assert.deepStrictEqual(later.map((s) => s.start), [0.5, 3.5, 1.5]);
  assert.strictEqual(later[0].words[0].start, 0.5);
  const earlier = shiftTiming(sample(), ['b'], -10);
  assert.deepStrictEqual(earlier.find((s) => s.id === 'b').start, 0);
  assert.deepStrictEqual(earlier.find((s) => s.id === 'b').end, 2);
  assert.throws(() => shiftTiming(sample(), null, 'x'));
});

test('dragging an edge keeps a minimum length and trims word timings', () => {
  const s = setTiming(sample(), 'a', { start: 1.2 });
  const a = s.find((x) => x.id === 'a');
  assert.strictEqual(a.start, 1.2);
  assert.deepStrictEqual(a.words.map((w) => w.text), [' three', ' four']);
  const squashed = setTiming(sample(), 'b', { end: 2 }).find((x) => x.id === 'b');
  assert.deepStrictEqual([squashed.start, squashed.end], [3, 3.1]);
});

test('adding and removing captions', () => {
  const added = addSegment(sample(), { start: 7, end: 6, text: ' hi ', id: 'n' });
  assert.deepStrictEqual(added.find((s) => s.id === 'n'), { id: 'n', source: 'main', start: 6, end: 7, text: 'hi' });
  assert.throws(() => addSegment(sample(), { start: 'x', end: 1 }));
  assert.deepStrictEqual(removeSegment(sample(), 'b').map((s) => s.id), ['a', 'c']);
});

// --- SRT / VTT -----------------------------------------------------------

test('timestamps round to whole milliseconds', () => {
  assert.strictEqual(formatTimestamp(59.9996), '00:01:00,000');
  assert.strictEqual(formatTimestamp(3723.5, '.'), '01:02:03.500');
  assert.strictEqual(formatTimestamp(-1), '00:00:00,000');
});

test('SRT: numbered cues, sorted, wrapped, empty ones left out', () => {
  const srt = toSRT([
    { start: 5, end: 6.25, text: 'Second' },
    { start: 1, end: 2, text: 'Today I will show you how to record your screen and share it' },
    { start: 3, end: 3, text: 'zero length' },
    { start: 4, end: 5, text: '  ' }
  ]);
  assert.strictEqual(srt,
    '1\n00:00:01,000 --> 00:00:02,000\nToday I will show you how to\nrecord your screen and share it\n\n' +
    '2\n00:00:05,000 --> 00:00:06,250\nSecond\n');
});

test('VTT: header, dot separators, and markup characters escaped', () => {
  const vtt = toVTT([{ start: 0, end: 1.5, text: 'a < b & c --> d' }]);
  assert.strictEqual(vtt, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\na &lt; b &amp; c --&gt; d\n');
  assert.strictEqual(toVTT([]), 'WEBVTT\n');
  assert.strictEqual(formatSubtitles([], 'srt'), '\n');
  assert.throws(() => formatSubtitles([], 'ass'));
});

// --- chunks --------------------------------------------------------------

test('long audio is cut at the quietest moment before 28 s, and silence is marked', () => {
  const rate = 1000;
  const samples = new Float32Array(70 * rate);
  const tone = (from, to) => { for (let i = from * rate; i < to * rate; i++) samples[i] = 0.3 * Math.sin(i); };
  tone(0, 24.3);
  tone(24.7, 50); // a pause at 24.3..24.7
  const chunks = planChunks(samples, rate);
  assert.strictEqual(chunks[0].start, 0);
  assert.ok(chunks[0].end > 24.3 * rate && chunks[0].end < 24.7 * rate, String(chunks[0].end));
  for (let i = 1; i < chunks.length; i++) assert.strictEqual(chunks[i].start, chunks[i - 1].end);
  assert.strictEqual(chunks[chunks.length - 1].end, samples.length);
  for (const c of chunks) assert.ok(c.end - c.start <= 28 * rate);
  assert.strictEqual(chunks[chunks.length - 1].silent, true, 'the last 20 s are silent');
  assert.strictEqual(chunks[0].silent, false);
  assert.deepStrictEqual(planChunks(new Float32Array(0), rate), []);
});

// --- languages -----------------------------------------------------------

test('language choices start with automatic detection', () => {
  const choices = languageChoices();
  assert.deepStrictEqual(choices[0], { code: 'auto', name: 'Detect automatically' });
  assert.ok(choices.length > 90);
  assert.ok(isLanguage('de') && isLanguage('auto') && !isLanguage('xx') && !isLanguage('toString'));
  assert.strictEqual(languageName('ja'), 'Japanese');
});
