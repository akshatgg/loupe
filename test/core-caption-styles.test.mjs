// Caption style presets and captions that move word by word: which word is
// being spoken (through cuts and speed changes), what the layer draws for
// each animation, the preset bundles, and what the project accepts.
import test from 'node:test';
import assert from 'node:assert';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import { drawFrame, exportSize } from '../src/core/compose.js';
import { captionsToOutput } from '../src/core/captions/timeline.js';
import { segmentsAt } from '../src/core/captions/model.js';
import {
  activeWordIndex, wordScale, wordsMatchText, POP_SCALE, POP_SECONDS, UPCOMING_ALPHA
} from '../src/core/captions/words.js';
import {
  CAPTION_PRESETS, CAPTION_ANIMATIONS, presetFor, restyleCaptions, completeCaptionStyle, captionPreset
} from '../src/core/captions/style.js';
import { FONTS, FONT_IDS, fontStack, canvasFont } from '../src/core/fonts.js';
import { drawCaptions, layoutCaptions } from '../src/core/layers/captions.js';
import { mockContext } from './support/mock-canvas.mjs';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
const MAIN = { width: 1600, height: 1000, duration: 10 };
const FRAME = { displayWidth: 3200, displayHeight: 2000 };
const WORDS = [
  { text: ' Hello', start: 1, end: 2 }, { text: ' there', start: 2, end: 3 },
  { text: ' good', start: 3, end: 4 }, { text: ' people', start: 4, end: 5 }
];
const SEGMENT = { id: 'c1', source: 'main', start: 1, end: 5, text: 'Hello there good people', words: WORDS };

function project(style = {}, segments = [SEGMENT]) {
  let p = P.createProject({ main: MAIN });
  p = P.setStyle(p, { padding: 0, radius: 0, shadow: 0, background: { type: 'none', value: null }, cursor: { show: false } });
  return P.setCaptions(p, { show: true, segments, style });
}

function render(p, outT) {
  const ctx = mockContext();
  drawFrame(ctx, { project: p, tl: buildTimeline(p), outT, frames: { main: FRAME }, size: exportSize(p), assets: {} });
  return ctx;
}

// [{ text, colour, alpha }] of every piece of text drawn.
const drawn = (ctx) => ctx.named('fillText').map((c) => ({ text: c.args[0], colour: c.state.fillStyle, alpha: c.state.globalAlpha }));

// ---------------------------------------------------------------- fonts

test('the fonts are a short fixed list of stacks, each ending in a generic family', () => {
  assert.deepStrictEqual(FONT_IDS, ['system', 'serif', 'mono', 'rounded', 'condensed']);
  for (const f of FONTS) {
    assert.ok(f.label && typeof f.label === 'string');
    assert.match(f.stack, /(sans-serif|serif|monospace)$/, f.id);
  }
  assert.strictEqual(canvasFont('serif', 40, 700), `700 40px ${fontStack('serif')}`);
  assert.strictEqual(fontStack('no such font'), fontStack('system'), 'an unknown font still draws');
});

// ---------------------------------------------------------------- which word

test('the spoken word is the last one that has started, by the frame\'s time', () => {
  assert.strictEqual(activeWordIndex(WORDS, 0.5), -1, 'before the first word');
  assert.strictEqual(activeWordIndex(WORDS, 1), 0);
  assert.strictEqual(activeWordIndex(WORDS, 1.99), 0);
  assert.strictEqual(activeWordIndex(WORDS, 2), 1);
  assert.strictEqual(activeWordIndex(WORDS, 4.5), 3);
  assert.strictEqual(activeWordIndex(WORDS, 99), 3);
  // Through a pause the last word stays the spoken one.
  const gappy = [{ text: 'a', start: 0, end: 0.2 }, { text: 'b', start: 1, end: 1.2 }];
  assert.strictEqual(activeWordIndex(gappy, 0.6), 0);
});

test('word timings follow a cut: later words light up earlier in the video, and a word cut away is not shown', () => {
  // Source 2.2-2.8 (the middle of "there") is cut out of the video.
  const p = P.cutRange(project(), 2.2, 2.8);
  const tl = buildTimeline(p);
  const cues = captionsToOutput(p.captions.segments, tl);
  // The video plays straight on over the cut, so it is still one caption --
  // without the word that was cut.
  assert.strictEqual(cues.length, 1, 'one caption across the cut');
  const [cue] = cues;
  assert.strictEqual(cue.text, 'Hello good people');
  near(cue.start, 1);
  near(cue.end, 5 - 0.6);
  // "good" is said at source 3, which is now 2.4 in the video.
  near(cue.words[1].start, 2.4);
  near(cue.words[1].start, tl.toOutput('main', 3));
  near(cue.words[2].start, 3.4);
  assert.strictEqual(activeWordIndex(segmentsAt(cues, 2.3)[0].words, 2.3), 0, '"Hello" is still the spoken word just after the cut');
  assert.strictEqual(activeWordIndex(segmentsAt(cues, 2.5)[0].words, 2.5), 1, '"good" at 2.5, not at 3');
});

test('word timings follow a speed change: at 2x the words come sooner and closer together', () => {
  // Source 3-5 ("good people") plays twice as fast (the speed eases in and out).
  const p = P.paintSpeed(project(), { start: 3, end: 5, rate: 2 });
  const tl = buildTimeline(p);
  const [cue] = captionsToOutput(p.captions.segments, tl);
  assert.ok(cue.end < 4.3, `the caption ends sooner: ${cue.end}`);
  near(cue.words[1].start, 2);
  near(cue.words[2].start, 3);
  // "people" is said at source 4: well before 4 in the video now.
  const people = tl.toOutput('main', 4);
  assert.ok(people > 3.3 && people < 3.7, `people at ${people}`);
  near(cue.words[3].start, people);
  near(cue.words[3].end, cue.end, 0.01);
  assert.strictEqual(activeWordIndex(cue.words, people - 0.05), 2);
  assert.strictEqual(activeWordIndex(cue.words, people + 0.05), 3, '"people" starts when it is heard, not a second after "good"');
});

test('a cut and a 2x stretch together still land each word on its moment', () => {
  let p = P.paintSpeed(project(), { start: 3, end: 5, rate: 2 });
  p = P.cutRange(p, 1.5, 2.5);
  const tl = buildTimeline(p);
  const cues = captionsToOutput(p.captions.segments, tl);
  const last = cues.at(-1);
  let checked = 0;
  for (const [i, w] of WORDS.entries()) {
    const o = tl.toOutput('main', w.start + 0.01);
    if (o === null || o < last.start) continue;
    near(last.words[i].start, o, 0.02);
    assert.strictEqual(activeWordIndex(last.words, o + 0.05), i);
    checked++;
  }
  assert.strictEqual(checked, 3, '"Hello" before the cut, "good" and "people" after it ("there" starts inside the cut)');
  // "good" (source 3) is a second earlier because of the cut before it.
  near(last.words[2].start, 2, 0.02);
});

test('word timings that are not the text\'s own are ignored', () => {
  assert.strictEqual(wordsMatchText(WORDS, 'Hello there good people'), true);
  assert.strictEqual(wordsMatchText(WORDS, 'Hello there, good people'), false);
  assert.strictEqual(wordsMatchText(undefined, 'Hello'), false);
  assert.strictEqual(wordsMatchText([{ text: 'Hello', start: 'soon', end: 2 }], 'Hello'), false);
  const p = project({}, [{ ...SEGMENT, text: 'Something else entirely' }]);
  assert.strictEqual(captionsToOutput(p.captions.segments, buildTimeline(p))[0].words, undefined);
});

// ---------------------------------------------------------------- what is drawn

test('karaoke: the whole line, the spoken word in the spoken-word colour, later words dimmer', () => {
  const p = project({ preset: 'karaoke', activeColor: '#ff0000' });
  assert.deepStrictEqual(drawn(render(p, 2.5)), [
    { text: 'Hello', colour: '#ffffff', alpha: 1 },
    { text: 'there', colour: '#ff0000', alpha: 1 },
    { text: 'good', colour: '#ffffff', alpha: UPCOMING_ALPHA },
    { text: 'people', colour: '#ffffff', alpha: UPCOMING_ALPHA }
  ]);
  // A later frame: a different word.
  const later = drawn(render(p, 4.5));
  assert.deepStrictEqual(later.map((w) => w.colour), ['#ffffff', '#ffffff', '#ffffff', '#ff0000']);
  assert.deepStrictEqual(later.map((w) => w.alpha), [1, 1, 1, 1]);
});

test('karaoke words sit where they would in the whole line, left to right', () => {
  const p = project({ preset: 'karaoke' });
  const ctx = render(p, 2.5);
  const xs = ctx.named('fillText').map((c) => c.args[1]);
  assert.deepStrictEqual([...xs].sort((a, b) => a - b), xs);
  const size = exportSize(p);
  const l = layoutCaptions(mockContext(), { x: 0, y: 0, w: size.width, h: size.height }, [{ text: SEGMENT.text }], p.captions.style);
  // 0.5 em a character in the fake context: the line is centred on the frame.
  const lineWidth = SEGMENT.text.length * 0.5 * l.px;
  near(xs[0], size.width / 2 - lineWidth / 2);
  near(xs[1], xs[0] + 'Hello '.length * 0.5 * l.px);
  // The box is the size of the whole line whichever word is lit.
  const boxAt = (t) => render(p, t).named('roundRect').at(-1)?.args.slice(0, 4);
  assert.deepStrictEqual(boxAt(1.2), boxAt(4.8));
});

test('typewriter: words appear as they are spoken, in a box that does not move', () => {
  const p = project({ preset: 'typewriter' });
  assert.deepStrictEqual(drawn(render(p, 1.5)).map((w) => w.text), ['Hello']);
  assert.deepStrictEqual(drawn(render(p, 3.5)).map((w) => w.text), ['Hello', 'there', 'good']);
  assert.deepStrictEqual(drawn(render(p, 4.9)).map((w) => w.text), ['Hello', 'there', 'good', 'people']);
  assert.ok(drawn(render(p, 3.5)).every((w) => w.colour === '#ffffff' && w.alpha === 1));
  assert.match(render(p, 1.5).named('fillText')[0].state.font, /Menlo/);
  const boxAt = (t) => render(p, t).named('roundRect').at(-1)?.args.slice(0, 4);
  assert.deepStrictEqual(boxAt(1.5), boxAt(4.9));
});

test('pop: the spoken word grows quickly and the one before settles back', () => {
  near(wordScale(WORDS, 1, 2), 1);
  near(wordScale(WORDS, 1, 2 + POP_SECONDS), 1 + POP_SCALE);
  near(wordScale(WORDS, 1, 2.9), 1 + POP_SCALE);
  assert.ok(wordScale(WORDS, 1, 2 + POP_SECONDS / 2) > 1 + POP_SCALE / 2, 'most of the way there by half time');
  near(wordScale(WORDS, 0, 2), 1 + POP_SCALE, 1e-9);
  near(wordScale(WORDS, 0, 2 + POP_SECONDS), 1);
  near(wordScale(WORDS, 3, 2.5), 1);
  near(wordScale(WORDS, 0, 0.5), 1);

  const p = project({ preset: 'pop' });
  const ctx = render(p, 2.5);
  const scales = ctx.named('scale').map((c) => c.args);
  assert.ok(scales.some(([sx, sy]) => Math.abs(sx - (1 + POP_SCALE)) < 1e-9 && sx === sy), `a word drawn larger: ${JSON.stringify(scales)}`);
  const words = drawn(ctx);
  assert.deepStrictEqual(words.map((w) => w.text), ['Hello', 'there', 'good', 'people']);
  assert.strictEqual(words[1].colour, '#30d158');
  assert.ok(words.every((w) => w.alpha === 1));
  // No box, so every word is outlined.
  assert.strictEqual(ctx.named('strokeText').length, 4);
  assert.match(ctx.named('fillText')[0].state.font, /Arial Rounded/);
});

test('a line with no word timings is drawn whole, whatever the animation', () => {
  const plain = { id: 'c2', source: 'main', start: 1, end: 5, text: 'No timings here' };
  for (const preset of ['karaoke', 'pop', 'typewriter']) {
    const words = drawn(render(project({ preset }, [plain]), 1.1));
    assert.deepStrictEqual(words.map((w) => w.text), ['No timings here'], preset);
    assert.strictEqual(words[0].alpha, 1);
  }
});

test('long word-by-word captions wrap like whole lines do', () => {
  const text = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';
  const words = text.split(' ').map((w, i) => ({ text: ` ${w}`, start: i * 0.1, end: (i + 1) * 0.1 }));
  const area = { x: 0, y: 0, w: 1280, h: 720 };
  const whole = layoutCaptions(mockContext(), area, [{ text }], { animation: 'none' });
  const byWord = layoutCaptions(mockContext(), area, [{ text, words }], { animation: 'highlight' });
  assert.ok(whole.lines.length > 1);
  assert.deepStrictEqual(byWord.lines, whole.lines);
  assert.deepStrictEqual(byWord.rows.flatMap((r) => r.words.map((w) => w.i)), words.map((_, i) => i));
});

test('words written without spaces between them are joined without any', () => {
  const words = [{ text: '你好', start: 0, end: 1 }, { text: '世界', start: 1, end: 2 }];
  const ctx = mockContext();
  drawCaptions(ctx, { x: 0, y: 0, w: 1280, h: 720 }, [{ text: '你好世界', words }], { animation: 'highlight', activeColor: '#ff0000' }, 1.5);
  assert.deepStrictEqual(drawn(ctx).map((w) => [w.text, w.colour]), [['你好', '#ffffff'], ['世界', '#ff0000']]);
});

test('without a time to go by, an animated style draws whole lines', () => {
  const ctx = mockContext();
  drawCaptions(ctx, { x: 0, y: 0, w: 1280, h: 720 }, [{ text: SEGMENT.text, words: WORDS }], { animation: 'highlight' });
  assert.deepStrictEqual(drawn(ctx).map((w) => w.text), [SEGMENT.text]);
});

test('font and colour apply to whole-line captions too', () => {
  const ctx = render(project({ font: 'serif', color: '#00ffcc' }), 2.5);
  const [line] = ctx.named('fillText');
  assert.strictEqual(line.args[0], SEGMENT.text);
  assert.strictEqual(line.state.fillStyle, '#00ffcc');
  assert.match(line.state.font, /^600 \d+px Georgia/);
});

// ---------------------------------------------------------------- presets

test('each preset is a bundle of settings, and a style is named after the one it matches', () => {
  assert.deepStrictEqual(CAPTION_PRESETS.map((p) => p.id), ['classic', 'outline', 'karaoke', 'pop', 'typewriter']);
  assert.deepStrictEqual(CAPTION_ANIMATIONS, ['none', 'highlight', 'pop', 'typewriter']);
  for (const preset of CAPTION_PRESETS) {
    assert.ok(preset.label);
    assert.strictEqual(presetFor({ ...completeCaptionStyle({}), ...preset.style }), preset.id);
  }
  assert.strictEqual(captionPreset('karaoke').style.animation, 'highlight');
  assert.strictEqual(captionPreset('nope'), null);
  assert.strictEqual(presetFor({ box: true, font: 'serif', color: '#ffffff', animation: 'none' }), 'custom');
  // Colours compare whatever their case.
  assert.strictEqual(presetFor({ box: true, font: 'system', color: '#FFFFFF', animation: 'none' }), 'classic');
});

test('picking a preset sets its settings and leaves size and position alone', () => {
  const p = project({ size: 1.4, position: 'top' });
  const next = P.setCaptions(p, { style: { preset: 'pop' } });
  assert.deepStrictEqual(next.captions.style, {
    size: 1.4, position: 'top', box: false, preset: 'pop', font: 'rounded', color: '#ffffff', activeColor: '#30d158', animation: 'pop'
  });
  assert.strictEqual(P.setCaptions(next, { style: { preset: 'classic' } }).captions.style.animation, 'none');
});

test('changing a setting keeps the preset\'s name only while it still matches', () => {
  const karaoke = project({ preset: 'karaoke' });
  assert.strictEqual(karaoke.captions.style.preset, 'karaoke');
  assert.strictEqual(P.setCaptions(karaoke, { style: { size: 1.6 } }).captions.style.preset, 'karaoke', 'size is not part of a preset');
  const changed = P.setCaptions(karaoke, { style: { font: 'serif' } });
  assert.strictEqual(changed.captions.style.preset, 'custom');
  assert.strictEqual(changed.captions.style.animation, 'highlight', 'nothing else changes');
  assert.strictEqual(P.setCaptions(changed, { style: { font: 'system' } }).captions.style.preset, 'karaoke', 'and back again');
  // The spoken-word colour is not part of a preset that never uses it.
  assert.strictEqual(P.setCaptions(project(), { style: { activeColor: '#ff0000' } }).captions.style.preset, 'classic');
  // Switching the box off turns Classic into Outline.
  assert.strictEqual(P.setCaptions(project(), { style: { box: false } }).captions.style.preset, 'outline');
  assert.deepStrictEqual(restyleCaptions(karaoke.captions.style, { preset: 'outline', color: '#ff0000' }).preset, 'custom');
});

// ---------------------------------------------------------------- validation

test('a project saved before presets loads with the defaults', () => {
  const p = project();
  const old = { ...p, captions: { ...p.captions, style: { size: 1, position: 'bottom', box: true } } };
  assert.deepStrictEqual(P.validateProject(old).captions.style, {
    size: 1, position: 'bottom', box: true, preset: 'classic', font: 'system', color: '#ffffff', activeColor: '#ffd60a', animation: 'none'
  });
  assert.deepStrictEqual(P.defaultCaptions().style, P.validateProject(old).captions.style);
});

test('bad caption style values are turned down in plain words', () => {
  const p = project();
  assert.throws(() => P.setCaptions(p, { style: { preset: 'disco' } }), /Caption style must be one of classic, outline, karaoke, pop, typewriter, custom, got "disco"/);
  assert.throws(() => P.setCaptions(p, { style: { font: 'Comic Sans' } }), /Caption font must be one of system, serif, mono, rounded, condensed/);
  assert.throws(() => P.setCaptions(p, { style: { color: 'red' } }), /Caption colour must be a colour like #1e90ff, got "red"/);
  assert.throws(() => P.setCaptions(p, { style: { activeColor: 12 } }), /Spoken word colour must be a colour/);
  assert.throws(() => P.setCaptions(p, { style: { animation: 'wobble' } }), /Caption animation must be one of none, highlight, pop, typewriter/);
  const bad = { ...p, captions: { ...p.captions, style: { ...p.captions.style, animation: 'wobble' } } };
  assert.throws(() => P.validateProject(bad), /Caption animation/);
});
