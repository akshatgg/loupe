// Styling and animation of text and title-card annotations: where an
// animation is at a given moment, what the layer draws for each setting, the
// ready-made lower thirds, and what the project accepts.
import test from 'node:test';
import assert from 'node:assert';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import { drawFrame, exportSize } from '../src/core/compose.js';
import * as A from '../src/core/layers/annotations.js';
import {
  textAnimationAt, animateSecondsOf, revealLines, isClear, CLEAR, LOWER_THIRDS, lowerThird,
  TEXT_ANIMATIONS, TEXT_WEIGHTS, TEXT_ALIGNS, TEXT_STYLE_DEFAULTS
} from '../src/core/text-style.js';
import { fontStack } from '../src/core/fonts.js';
import { mockContext } from './support/mock-canvas.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
const MAIN = { width: 1600, height: 1000, duration: 10 };
const FRAME = { displayWidth: 3200, displayHeight: 2000 };

function plain() {
  const p = P.createProject({ main: MAIN });
  return P.setStyle(p, { padding: 0, radius: 0, shadow: 0, background: { type: 'none', value: null }, cursor: { show: false } });
}

function withText(extra = {}, type = 'text') {
  return P.addAnnotation(plain(), { type, start: 2, end: 6, x: 0.5, y: 0.5, text: 'Hello\nworld', color: '#ffffff', size: 1, ...extra });
}

function render(p, outT) {
  const ctx = mockContext();
  const state = drawFrame(ctx, { project: p, tl: buildTimeline(p), outT, frames: { main: FRAME }, size: exportSize(p), assets: {} });
  return { ctx, state };
}

const texts = (ctx) => ctx.named('fillText').map((c) => c.args[0]);
const T = (extra) => ({ type: 'text', start: 2, end: 6, ...extra });

// ---------------------------------------------------------------- animation progress

test('with nothing set, text fades as it always has: 0.2 s, and 0.5 s for a title card', () => {
  assert.deepStrictEqual(textAnimationAt(T(), 1.9), { alpha: 0, slide: 0, scale: 1, reveal: 1 });
  near(textAnimationAt(T(), 2.1).alpha, 0.5);
  assert.deepStrictEqual(textAnimationAt(T(), 4), { alpha: 1, slide: 0, scale: 1, reveal: 1 });
  near(textAnimationAt(T(), 5.9).alpha, 0.5);
  assert.strictEqual(textAnimationAt(T(), 6).alpha, 0);
  near(textAnimationAt(T({ type: 'title' }), 2.25).alpha, 0.5);
  assert.strictEqual(animateSecondsOf(T()), 0.2);
  assert.strictEqual(animateSecondsOf(T({ type: 'title' })), 0.5);
  // The layer's own opacity is the same number.
  near(A.opacityAt(T(), 2.1), 0.5);
  near(A.opacityAt(T({ type: 'title' }), 2.25), 0.5);
});

test('a chosen animation takes animateSeconds, 0.4 s unless set', () => {
  assert.strictEqual(animateSecondsOf(T({ animateIn: 'fade' })), 0.4);
  assert.strictEqual(animateSecondsOf(T({ animateIn: 'slide', animateSeconds: 1 })), 1);
  // Never more than a third of the time it is on screen.
  near(animateSecondsOf({ type: 'text', start: 0, end: 0.9, animateIn: 'fade', animateSeconds: 2 }), 0.3);
  const a = T({ animateIn: 'fade', animateSeconds: 1 });
  near(textAnimationAt(a, 2.25).alpha, 0.25);
  near(textAnimationAt(a, 2.5).alpha, 0.5);
  assert.strictEqual(textAnimationAt(a, 3).alpha, 1);
  // The way out is still the default fade, over the same length.
  near(textAnimationAt(a, 5.5).alpha, 0.5);
});

test('none shows it at once and takes it away at once', () => {
  const a = T({ animateIn: 'none', animateOut: 'none' });
  assert.deepStrictEqual(textAnimationAt(a, 2), { alpha: 1, slide: 0, scale: 1, reveal: 1 });
  assert.deepStrictEqual(textAnimationAt(a, 5.999), { alpha: 1, slide: 0, scale: 1, reveal: 1 });
  assert.strictEqual(textAnimationAt(a, 6).alpha, 0);
});

test('slide comes up from below while fading in, and settles', () => {
  const a = T({ animateIn: 'slide', animateSeconds: 1 });
  const start = textAnimationAt(a, 2);
  assert.strictEqual(start.alpha, 0);
  assert.strictEqual(start.slide, 1);
  const half = textAnimationAt(a, 2.5);
  near(half.alpha, 0.5);
  near(half.slide, 0.25);
  assert.deepStrictEqual(textAnimationAt(a, 3.5), { alpha: 1, slide: 0, scale: 1, reveal: 1 });
  // Out: back down as it fades.
  const out = textAnimationAt(T({ animateOut: 'slide', animateSeconds: 1 }), 5.5);
  near(out.slide, 0.25);
  near(out.alpha, 0.5);
});

test('pop grows from small, a little past full size, and back', () => {
  const a = T({ animateIn: 'pop', animateSeconds: 1 });
  near(textAnimationAt(a, 2).scale, 0.6);
  assert.strictEqual(textAnimationAt(a, 2).alpha, 0);
  assert.ok(textAnimationAt(a, 2.25).alpha === 0.5);
  assert.ok(textAnimationAt(a, 2.7).scale > 1, 'past full size on the way');
  near(textAnimationAt(a, 3).scale, 1);
  assert.strictEqual(textAnimationAt(a, 3).alpha, 1);
  near(textAnimationAt(T({ animateOut: 'pop', animateSeconds: 1 }), 6 - 1e-9).scale, 0.6, 1e-6);
});

test('typewriter shows a growing share of the letters', () => {
  const a = T({ animateIn: 'typewriter', animateSeconds: 1 });
  assert.strictEqual(textAnimationAt(a, 2).reveal, 0);
  assert.strictEqual(textAnimationAt(a, 2).alpha, 1);
  near(textAnimationAt(a, 2.5).reveal, 0.5);
  assert.strictEqual(textAnimationAt(a, 3.2).reveal, 1);
  assert.deepStrictEqual(revealLines(['Hello', 'world'], 0), ['', '']);
  assert.deepStrictEqual(revealLines(['Hello', 'world'], 0.3), ['Hel', '']);
  assert.deepStrictEqual(revealLines(['Hello', 'world'], 0.7), ['Hello', 'wo']);
  const lines = ['Hello', 'world'];
  assert.strictEqual(revealLines(lines, 1), lines);
  assert.deepStrictEqual(revealLines(['añ😀'], 0.67), ['añ'], 'whole characters');
});

test('the progress depends only on the time given, so every frame at that time agrees', () => {
  const a = T({ animateIn: 'pop', animateOut: 'slide', animateSeconds: 0.7 });
  for (const t of [2.01, 2.3, 4, 5.6]) assert.deepStrictEqual(textAnimationAt(a, t), textAnimationAt({ ...a }, t));
});

// ---------------------------------------------------------------- drawing

test('font, weight and alignment change how text is drawn', () => {
  const base = render(withText(), 4).ctx.named('fillText')[0];
  assert.match(base.state.font, /^600 \d+(\.\d+)?px "SF Pro Display"/);
  assert.strictEqual(base.state.textAlign, 'center');

  const { ctx, state } = render(withText({ font: 'serif', weight: 'bold', align: 'left' }), 4);
  const [hello, world] = ctx.named('fillText');
  assert.ok(hello.state.font.startsWith('800 ') && hello.state.font.endsWith(fontStack('serif')), hello.state.font);
  assert.strictEqual(hello.state.textAlign, 'left');
  // Both lines start at the left edge of the block, which is still centred on its point.
  assert.strictEqual(hello.args[1], world.args[1]);
  const L = A.textLayout(mockContext(), state, state.project.annotations[0]);
  near(L.box.x + L.box.w / 2, state.content.x + 0.5 * state.content.w, 1e-6);
  near(hello.args[1], L.textX);
  assert.ok(L.textX < L.cx);
  assert.match(render(withText({ weight: 'regular' }), 4).ctx.named('fillText')[0].state.font, /^400 /);
  const right = render(withText({ align: 'right' }), 4).ctx.named('fillText')[0];
  assert.strictEqual(right.state.textAlign, 'right');
  assert.ok(right.args[1] > L.cx);
});

test('an outline is stroked round the letters before they are filled', () => {
  assert.strictEqual(render(withText(), 4).ctx.named('strokeText').length, 0);
  const { ctx } = render(withText({ outline: 0.5 }), 4);
  const strokes = ctx.named('strokeText');
  assert.deepStrictEqual(strokes.map((c) => c.args[0]), ['Hello', 'world']);
  assert.strictEqual(strokes[0].state.strokeStyle, '#111114', 'dark round white letters');
  const thick = render(withText({ outline: 1 }), 4).ctx.named('strokeText')[0].state.lineWidth;
  near(thick, strokes[0].state.lineWidth * 2, 1e-6);
  const order = ctx.calls.filter((c) => c.name === 'strokeText' || c.name === 'fillText').map((c) => c.name);
  assert.deepStrictEqual(order, ['strokeText', 'strokeText', 'fillText', 'fillText']);
});

test('the background is the usual dark backing, a colour, or nothing', () => {
  const backing = (extra) => render(withText(extra), 4).ctx.named('fill').map((c) => c.state.fillStyle);
  assert.deepStrictEqual(backing({}), ['rgba(17, 17, 20, 0.72)']);
  assert.deepStrictEqual(backing({ background: null }), ['rgba(17, 17, 20, 0.72)']);
  assert.deepStrictEqual(backing({ background: '#ffd60a' }), ['#ffd60a']);
  assert.deepStrictEqual(backing({ background: CLEAR }), []);
  assert.strictEqual(isClear('#0000'), true);
  assert.strictEqual(isClear('#ffd60a'), false);
  assert.strictEqual(isClear(null), false);
  // With no backing the words keep a shadow to stand out.
  const bare = render(withText({ background: CLEAR }), 4).ctx.named('fillText')[0];
  assert.notStrictEqual(bare.state.shadowColor, 'rgba(0, 0, 0, 0)');
});

test('a fade is fainter at the start than a moment later', () => {
  const p = withText({ animateIn: 'fade', animateSeconds: 1 });
  const alpha = (t) => render(p, t).ctx.named('fillText')[0].state.globalAlpha;
  near(alpha(2.2), 0.2);
  near(alpha(2.6), 0.6);
  assert.strictEqual(alpha(3.5), 1);
});

test('slide and pop move and size the block about its middle', () => {
  const slide = render(withText({ animateIn: 'slide', animateSeconds: 1 }), 2.5);
  const L = A.textLayout(mockContext(), slide.state, slide.state.project.annotations[0]);
  const [down, back] = slide.ctx.named('translate');
  near(down.args[0], L.cx, 1e-6);
  near(down.args[1], L.cy + 0.25 * L.px * 0.9, 1e-6);
  assert.deepStrictEqual(back.args, [-L.cx, -L.cy]);
  assert.strictEqual(render(withText({ animateIn: 'slide', animateSeconds: 1 }), 4).ctx.named('translate').length, 0, 'at rest nothing moves');
  const pop = render(withText({ animateIn: 'pop', animateSeconds: 1 }), 2.5).ctx.named('scale')[0];
  assert.ok(pop.args[0] > 0.6 && pop.args[0] < 1.1 && pop.args[0] === pop.args[1]);
});

test('typewriter draws the letters so far, each where it will end up', () => {
  const p = withText({ animateIn: 'typewriter', animateSeconds: 1 });
  assert.deepStrictEqual(texts(render(p, 2.01).ctx), []);
  const part = render(p, 2.7);
  assert.deepStrictEqual(texts(part.ctx), ['Hello', 'wo']);
  const full = render(p, 4);
  assert.deepStrictEqual(texts(full.ctx), ['Hello', 'world']);
  // "wo" starts where "world" starts: the centred line's left edge.
  const L = A.textLayout(mockContext(), full.state, full.state.project.annotations[0]);
  const wo = part.ctx.named('fillText')[1];
  assert.strictEqual(wo.state.textAlign, 'left');
  near(wo.args[1], L.cx - (5 * 0.5 * L.px) / 2, 1e-6);
  // The backing is there from the start, full size.
  assert.strictEqual(render(p, 2.01).ctx.named('fill').length, 1);
});

test('a title card takes the font, weight, alignment and animation too', () => {
  const card = (extra, t = 4) => render(withText({ text: 'My demo\nPart one', color: '#fafafa', ...extra }, 'title'), t);
  const plainCard = card({}).ctx.named('fillText');
  assert.match(plainCard[0].state.font, /^700 /);
  assert.match(plainCard[1].state.font, /^500 /);
  const styled = card({ font: 'mono', weight: 'bold', align: 'left' });
  const [head, sub] = styled.ctx.named('fillText');
  assert.ok(head.state.font.startsWith('800 ') && head.state.font.endsWith(fontStack('mono')));
  assert.match(sub.state.font, /^600 /);
  assert.strictEqual(head.state.textAlign, 'left');
  near(head.args[1], styled.state.size.width * 0.08);
  // The card itself always covers the frame and fades with the animation's opacity.
  const sliding = card({ animateIn: 'slide', animateSeconds: 1 }, 2.5);
  const fill = sliding.ctx.named('fillRect').find((c) => c.state.fillStyle === '#fafafa');
  assert.deepStrictEqual(fill.args, [0, 0, sliding.state.size.width, sliding.state.size.height]);
  near(fill.state.globalAlpha, 0.5);
  assert.ok(sliding.ctx.named('translate').length >= 2, 'the words slide');
  assert.deepStrictEqual(texts(card({ animateIn: 'typewriter', animateSeconds: 1 }, 2.5).ctx), ['My demo']);
});

test('arrows and boxes keep their own short fade whatever else is set', () => {
  near(A.opacityAt({ type: 'arrow', start: 2, end: 6, animateIn: 'none' }, 2.1), 0.5);
  assert.strictEqual(A.opacityAt({ type: 'blur', start: 2, end: 6 }, 2), 1);
});

// ---------------------------------------------------------------- lower thirds

test('three ready-made text styles, each a valid text annotation with a place on the picture', () => {
  assert.deepStrictEqual(LOWER_THIRDS.map((t) => t.id), ['name', 'chapter', 'callout']);
  assert.deepStrictEqual(LOWER_THIRDS.map((t) => t.label), ['Name and title', 'Chapter', 'Callout']);
  for (const t of LOWER_THIRDS) {
    const p = P.addAnnotation(plain(), { type: 'text', start: 1, end: 4, ...t.look });
    const a = p.annotations[0];
    for (const key of Object.keys(TEXT_STYLE_DEFAULTS)) assert.ok(key in a, `${t.id} sets ${key}`);
    assert.ok(a.x > 0 && a.x < 1 && a.y > 0 && a.y < 1);
    assert.ok(a.text && t.hint);
    assert.ok(texts(render(p, 3).ctx).length >= 1, `${t.id} draws`);
  }
  assert.ok(lowerThird('name').look.y > 0.7, 'a lower third sits low');
  assert.strictEqual(lowerThird('nope'), null);
});

// ---------------------------------------------------------------- validation

test('an annotation saved before these settings is accepted unchanged', () => {
  const p = withText();
  const saved = JSON.parse(JSON.stringify(p));
  assert.deepStrictEqual(Object.keys(saved.annotations[0]).filter((k) => k in TEXT_STYLE_DEFAULTS), []);
  assert.deepStrictEqual(P.validateProject(saved).annotations, saved.annotations);
  assert.strictEqual(P.validateProject(saved).version, 2);
});

test('the settings are saved on the annotation and can be changed one at a time', () => {
  let p = withText();
  const id = p.annotations[0].id;
  p = P.updateAnnotation(p, id, { font: 'rounded', weight: 'bold', align: 'right', outline: 0.3, background: '#1f1f23' });
  p = P.updateAnnotation(p, id, { animateIn: 'slide', animateOut: 'none', animateSeconds: 0.8 });
  const a = P.validateProject(JSON.parse(JSON.stringify(p))).annotations[0];
  assert.deepStrictEqual(
    [a.font, a.weight, a.align, a.outline, a.background, a.animateIn, a.animateOut, a.animateSeconds],
    ['rounded', 'bold', 'right', 0.3, '#1f1f23', 'slide', 'none', 0.8]);
  assert.strictEqual(P.updateAnnotation(p, id, { background: null }).annotations[0].background, null);
  assert.deepStrictEqual(TEXT_ANIMATIONS, ['none', 'fade', 'slide', 'pop', 'typewriter']);
  assert.deepStrictEqual(TEXT_WEIGHTS, ['regular', 'medium', 'bold']);
  assert.deepStrictEqual(TEXT_ALIGNS, ['left', 'center', 'right']);
});

test('bad text settings are turned down in plain words', () => {
  const p = withText();
  const id = p.annotations[0].id;
  const bad = (patch, re) => assert.throws(() => P.updateAnnotation(p, id, patch), re);
  bad({ font: 'Papyrus' }, /Text font must be one of system, serif, mono, rounded, condensed, got "Papyrus"/);
  bad({ weight: 'heavy' }, /Text weight must be one of regular, medium, bold/);
  bad({ align: 'middle' }, /Text alignment must be one of left, center, right/);
  bad({ outline: 2 }, /Text outline must be a number from 0 to 1, got 2/);
  bad({ background: 'blue' }, /Text background must be a colour like #1e90ff/);
  bad({ animateIn: 'spin' }, /Text animation in must be one of none, fade, slide, pop, typewriter/);
  bad({ animateOut: 'spin' }, /Text animation out must be one of/);
  bad({ animateSeconds: 5 }, /Text animation length must be a number from 0.1 to 2, got 5/);
  bad({ animateSeconds: 0 }, /Text animation length/);
  assert.throws(() => P.addAnnotation(plain(), { type: 'text', start: 1, end: 2, animateIn: 'spin' }), /Text animation in/);
  const saved = JSON.parse(JSON.stringify(p));
  saved.annotations[0].weight = 'heavy';
  assert.throws(() => P.validateProject(saved), /Text weight/);
});
