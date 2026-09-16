// The visual layers: annotations, keystroke badges, the webcam bubble and
// transitions (src/core/layers), plus the recording fields the migration
// carries into v2 for them.
import test from 'node:test';
import assert from 'node:assert';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import { drawFrame, frameState, exportSize } from '../src/core/compose.js';
import * as A from '../src/core/layers/annotations.js';
import { badgesAt, normalizeKeys, SHOW_SECONDS } from '../src/core/layers/keystrokes.js';
import { bubbleRect, webcamFrameKey, webcamTime } from '../src/core/layers/webcam.js';
import { transitionAt, crossfadeMix, TRANSITION_FRAME } from '../src/core/layers/transitions.js';
import { mockContext } from './support/mock-canvas.mjs';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);
const FRAME = { displayWidth: 3200, displayHeight: 2000 };
const MAIN = { width: 1600, height: 1000, duration: 10 };

function plain(extra = {}) {
  const p = P.createProject({ main: { ...MAIN, ...extra } });
  return P.setStyle(p, { padding: 0, radius: 0, shadow: 0, background: { type: 'none', value: null }, cursor: { show: false } });
}

function render(project, { outT = 1, frames = { main: FRAME }, assets = {}, size } = {}) {
  const ctx = mockContext();
  const tl = buildTimeline(project);
  const state = drawFrame(ctx, { project, tl, outT, frames, size: size ?? exportSize(project), assets });
  return { ctx, state };
}

const texts = (ctx) => ctx.named('fillText').map((c) => c.args[0]);

// ---------------------------------------------------------------- annotations

test('annotations show only during their source range, fading in and out (hidden areas never fade)', () => {
  const a = { type: 'text', start: 2, end: 4 };
  assert.strictEqual(A.opacityAt(a, 1.99), 0);
  near(A.opacityAt(a, 2.1), 0.5);
  assert.strictEqual(A.opacityAt(a, 3), 1);
  near(A.opacityAt(a, 3.9), 0.5);
  assert.strictEqual(A.opacityAt(a, 4), 0);
  assert.strictEqual(A.opacityAt({ type: 'blur', start: 2, end: 4 }, 2), 1);
  assert.strictEqual(A.opacityAt({ type: 'blur', start: 2, end: 4 }, 3.99), 1);
  // A title fades longer.
  near(A.opacityAt({ type: 'title', start: 0, end: 3 }, 0.25), 0.5);
});

test('text is drawn centred on its point in the content area, with its colour and lines', () => {
  let p = P.setStyle(plain(), { padding: 0.1 });
  p = P.addAnnotation(p, { type: 'text', start: 0, end: 5, x: 0.5, y: 0.25, text: 'Hello\nworld', color: '#ffcc00', size: 2 });
  const { ctx, state } = render(p, { outT: 2 });
  assert.deepStrictEqual(texts(ctx), ['Hello', 'world']);
  const hello = ctx.named('fillText')[0];
  near(hello.args[1], state.content.x + 0.5 * state.content.w);
  assert.strictEqual(hello.state.fillStyle, '#ffcc00');
  assert.match(hello.state.font, /88px/);
  // Clipped to the content area.
  assert.ok(ctx.named('clip').length >= 1);
  // Outside its range: nothing.
  assert.deepStrictEqual(texts(render(p, { outT: 6 }).ctx), []);
});

test('a title card covers the whole output in its colour with readable ink', () => {
  let p = P.setStyle(plain(), { padding: 0.1 });
  p = P.addAnnotation(p, { type: 'title', start: 0, end: 3, text: 'My demo\nPart one', color: '#fafafa', size: 1 });
  const { ctx, state } = render(p, { outT: 1.5 });
  const fill = ctx.named('fillRect').find((c) => c.state.fillStyle === '#fafafa');
  assert.deepStrictEqual(fill.args, [0, 0, state.size.width, state.size.height]);
  assert.strictEqual(fill.depth, 1, 'not inside the content clip');
  assert.deepStrictEqual(texts(ctx), ['My demo', 'Part one']);
  assert.strictEqual(ctx.named('fillText')[0].state.fillStyle, '#111114');
  assert.strictEqual(A.inkFor('#101010'), '#ffffff');
  assert.strictEqual(A.inkFor('#fff'), '#111114');
});

test('arrows, boxes and hidden areas follow the recording through a zoom', () => {
  let p = plain();
  p = P.addAnnotation(p, { type: 'box', start: 0, end: 10, x: 0.5, y: 0.5, w: 0.25, h: 0.1 });
  const size = exportSize(p);
  const tl = buildTimeline(p);
  const ctx = mockContext();
  const flat = frameState({ project: p, tl, outT: 1, size, frames: { main: FRAME } });
  const g1 = A.annotationGeometry(ctx, flat, p.annotations[0]);
  near(g1.box.x, size.width / 2, 1e-6);
  near(g1.box.w, size.width * 0.25, 1e-6);
  // Pinned 2x zoom on the box's corner: it doubles and stays on that spot.
  const z = P.addZoom(p, { start: 0, end: 10, level: 2, follow: false, x: 800, y: 500 });
  const zoomed = frameState({ project: z, tl: buildTimeline(z), outT: 5, size, frames: { main: FRAME } });
  const g2 = A.annotationGeometry(ctx, zoomed, z.annotations[0]);
  near(g2.box.w, g1.box.w * 2, 1);
  near(g2.box.x, size.width / 2, 1);
  // And back: canvas pixels -> recording fractions.
  const f = A.recordingFraction(zoomed, g2.box.x, g2.box.y);
  near(f.x, 0.5, 1e-3);
  near(f.y, 0.5, 1e-3);
  const c = A.contentFraction(flat, size.width / 4, size.height / 2);
  near(c.x, 0.25);
  near(c.y, 0.5);
});

test('arrow and box drawing; a hidden area pixelates what is under it', () => {
  let p = plain();
  p = P.addAnnotation(p, { type: 'arrow', start: 0, end: 10, x: 0.1, y: 0.1, x2: 0.5, y2: 0.5, color: '#ff3b30' });
  p = P.addAnnotation(p, { type: 'box', start: 0, end: 10, x: 0.6, y: 0.6, w: 0.2, h: 0.2, color: '#34c759' });
  p = P.addAnnotation(p, { type: 'blur', start: 0, end: 10, x: 0.2, y: 0.7, w: 0.3, h: 0.1 });
  const { ctx } = render(p, { outT: 5 });
  assert.ok(ctx.named('stroke').some((c) => c.state.strokeStyle === '#ff3b30'), 'arrow line');
  assert.ok(ctx.named('fill').some((c) => c.state.fillStyle === '#ff3b30'), 'arrow head');
  assert.ok(ctx.named('stroke').some((c) => c.state.strokeStyle === '#34c759'), 'box');
  // The mock has no canvas to read back, so the hidden area is covered.
  assert.ok(ctx.named('fillRect').some((c) => c.state.fillStyle === '#5f6368'), 'hidden area');
  // Hidden areas go under the others.
  const order = ctx.calls.filter((c) => (c.name === 'fillRect' && c.state.fillStyle === '#5f6368') || (c.name === 'stroke' && c.state.strokeStyle === '#34c759'));
  assert.strictEqual(order[0].name, 'fillRect');
});

// ---------------------------------------------------------------- keystrokes

test('keystroke badges: the latest presses for a moment, fading out', () => {
  const keys = normalizeKeys([{ t: 3, label: '⌘C' }, { t: 1, label: '⌘K' }, { t: 3.5, label: '⌘V' }, { t: 'x', label: 'bad' }, { t: 9 }]);
  assert.deepStrictEqual(keys.map((k) => k.label), ['⌘K', '⌘C', '⌘V']);
  assert.deepStrictEqual(badgesAt(keys, 0.5), []);
  assert.deepStrictEqual(badgesAt(keys, 1.5).map((b) => b.label), ['⌘K']);
  assert.deepStrictEqual(badgesAt(keys, 3.6).map((b) => b.label), ['⌘C', '⌘V']);
  assert.deepStrictEqual(badgesAt(keys, 3 + SHOW_SECONDS + 0.01).map((b) => b.label), ['⌘V']);
  assert.strictEqual(badgesAt(keys, 1 + SHOW_SECONDS - 0.15)[0].alpha < 1, true);
  assert.deepStrictEqual(badgesAt(keys, 20), []);
});

test('keystroke badges draw only when shown, at the bottom or top of the content', () => {
  const keys = { main: [{ t: 1, label: '⌘K' }] };
  let p = plain({ keys: 'keys.json' });
  assert.deepStrictEqual(texts(render(p, { outT: 1.5, assets: { keys } }).ctx), []);
  p = P.setStyle(p, { keystrokes: { show: true } });
  const bottom = render(p, { outT: 1.5, assets: { keys } });
  assert.deepStrictEqual(texts(bottom.ctx), ['⌘K']);
  const yBottom = bottom.ctx.named('fillText')[0].args[2];
  const top = render(P.setStyle(p, { keystrokes: { position: 'top' } }), { outT: 1.5, assets: { keys } });
  const yTop = top.ctx.named('fillText')[0].args[2];
  assert.ok(yBottom > bottom.state.size.height * 0.8 && yTop < top.state.size.height * 0.2, `${yBottom} ${yTop}`);
});

// ---------------------------------------------------------------- webcam

test('the webcam bubble: time offset, corner, size, shape, and nothing without a picture', () => {
  const webcam = { file: 'webcam.webm', offset: -0.5, width: 1280, height: 720 };
  const p = plain({ webcam });
  assert.strictEqual(webcamTime(p.sources.main, 2), 2.5);
  assert.strictEqual(webcamTime(plain().sources.main, 2), null);
  const cam = { displayWidth: 1280, displayHeight: 720 };
  const frames = { main: FRAME, [webcamFrameKey('main')]: cam };
  const { ctx, state } = render(p, { frames });
  const r = bubbleRect(state);
  const short = Math.min(state.size.width, state.size.height);
  near(r.d, 0.22 * short);
  near(r.x + r.d, state.size.width - 28 * state.unit);
  const draw = ctx.named('drawImage').find((c) => c.args[0] === cam);
  // Cover-cropped to a square from the middle of the 16:9 picture.
  assert.deepStrictEqual(draw.args.slice(1, 5), [280, 0, 720, 720]);
  assert.ok(ctx.named('arc').length > 0, 'a circle');
  const tl = P.setStyle(p, { webcam: { corner: 'top-left', shape: 'rounded', size: 0.3 } });
  const s2 = render(tl, { frames });
  const r2 = bubbleRect(s2.state);
  near(r2.x, 28 * s2.state.unit);
  near(r2.y, 28 * s2.state.unit);
  assert.strictEqual(s2.ctx.named('arc').length, 0, 'rounded, not a circle');
  // Hidden, or no picture: nothing.
  const hidden = render(P.setStyle(p, { webcam: { show: false } }), { frames });
  assert.ok(!hidden.ctx.named('drawImage').some((c) => c.args[0] === cam));
  assert.ok(!render(p).ctx.named('drawImage').some((c) => c.args[0] === cam));
});

// ---------------------------------------------------------------- transitions

function twoClips() {
  let p = P.splitAt(plain(), 4);
  p = P.setStyle(p, { background: { type: 'color', value: '#123456' }, padding: 0.1 });
  return p;
}

test('a transition is centred on its join and names the other side’s held picture', () => {
  let p = twoClips();
  const [c1] = p.clips;
  p = P.setTransition(p, c1.id, 'crossfade', 1);
  const tl = buildTimeline(p);
  assert.strictEqual(transitionAt(p, tl, 3.4), null);
  const before = transitionAt(p, tl, 3.75);
  near(before.progress, 0.25);
  near(before.strength, 0.5);
  assert.deepStrictEqual([before.other.source, before.other.outT], ['main', 4]);
  near(before.other.t, 4);
  near(crossfadeMix(before, 3.75), 0.25);
  const after = transitionAt(p, tl, 4.25);
  near(after.other.t, 4 - 1e-4, 1e-6);
  near(crossfadeMix(after, 4.25), 0.25);
  assert.strictEqual(transitionAt(p, tl, 4.5), null);
  // Short clips shorten it.
  const short = P.setTransition(P.trimEnd(p, c1.id, 0.4), c1.id, 'dip', 2);
  const t2 = transitionAt(short, buildTimeline(short), 0.39);
  near(t2.half, 0.2);
});

test('dip darkens the whole frame; fade draws the background over the content', () => {
  const [c1] = twoClips().clips;
  const dip = P.setTransition(twoClips(), c1.id, 'dip', 1);
  const { ctx: d, state } = render(dip, { outT: 4 });
  const black = d.named('fillRect').at(-1);
  assert.strictEqual(black.state.fillStyle, '#000000');
  near(black.state.globalAlpha, 1);
  assert.deepStrictEqual(black.args, [0, 0, state.size.width, state.size.height]);
  const fade = P.setTransition(twoClips(), c1.id, 'fade', 1);
  const f = render(fade, { outT: 3.75 });
  const last = f.ctx.named('fillRect').at(-1);
  assert.strictEqual(last.state.fillStyle, '#123456');
  near(last.state.globalAlpha, 0.5);
});

test('a crossfade blends a second full frame of the other side', () => {
  const [c1] = twoClips().clips;
  const p = P.setTransition(twoClips(), c1.id, 'crossfade', 1);
  const other = { displayWidth: 3200, displayHeight: 2000, other: true };
  // No OffscreenCanvas in node: drawn without the blend, and without error.
  const { ctx } = render(p, { outT: 3.75, frames: { main: FRAME, [TRANSITION_FRAME]: other } });
  assert.ok(!ctx.named('drawImage').some((c) => c.args[0] === other));
  const saved = globalThis.OffscreenCanvas;
  const made = [];
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; this.ctx = mockContext(); made.push(this); }
    getContext() { return this.ctx; }
  };
  try {
    const r = render(p, { outT: 3.75, frames: { main: FRAME, [TRANSITION_FRAME]: other } });
    assert.strictEqual(made.length, 1);
    assert.ok(made[0].ctx.named('drawImage').some((c) => c.args[0] === other), 'the other picture is drawn in the second frame');
    const blend = r.ctx.named('drawImage').find((c) => c.args[0] === made[0]);
    near(blend.state.globalAlpha, 0.25);
  } finally {
    globalThis.OffscreenCanvas = saved;
  }
});

// ---------------------------------------------------------------- migration

test('a new recording’s v2 fields and default style come through the migration', () => {
  const v1 = {
    version: 1, source: { kind: 'display', width: 1600, height: 1000 },
    capture: { file: 'raw.mov', fps: 60, duration: 10, hasMicTrack: true },
    zoomKeyframes: [], clicks: [], speedSegments: [], settings: {},
    sources: {
      main: {
        systemAudio: 'system.m4a', webcam: { file: 'webcam.webm', offset: 0.2, width: 640, height: 480 },
        keys: 'keys.json', pauses: [{ start: 4, end: 5 }]
      }
    },
    style: { background: { type: 'color', value: '#222222' }, padding: 0.1, webcam: { corner: 'top-left' } }
  };
  const p = P.migrate(v1);
  const m = p.sources.main;
  assert.strictEqual(m.systemAudio, 'system.m4a');
  assert.deepStrictEqual(m.webcam, v1.sources.main.webcam);
  assert.strictEqual(m.keys, 'keys.json');
  assert.deepStrictEqual(p.clips.map((c) => [c.start, c.end]), [[0, 4], [5, 10]]);
  assert.strictEqual(p.style.keystrokes.show, true);
  assert.deepStrictEqual(p.style.background, { type: 'color', value: '#222222' });
  assert.strictEqual(p.style.padding, 0.1);
  assert.strictEqual(p.style.webcam.corner, 'top-left');
  // A broken preset style is ignored rather than refusing the recording.
  const bad = P.migrate({ ...v1, style: { padding: 'lots' } });
  assert.strictEqual(bad.style.padding, 0);
  // Without keys recorded, badges stay off.
  assert.strictEqual(P.migrate({ ...v1, sources: undefined }).style.keystrokes.show, false);
});
