import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import { drawFrame, frameState, exportSize, layout, LAYERS, aspectRatio } from '../src/core/compose.js';
import { gradientLine, coverCrop } from '../src/core/layers/background.js';
import { arrowPoints } from '../src/core/layers/cursor.js';
import { parseCursorTrack, cursorAt, prepareCursor, cursorPosition, cursorOpacity } from '../src/core/cursor.js';
import { mockContext } from './support/mock-canvas.mjs';

const require = createRequire(import.meta.url);
const v1Project = require('../src/main/project.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);
const V1_CLICKS = JSON.parse(readFileSync(new URL('./fixtures/v1-project-clicks.json', import.meta.url), 'utf8'));
const CURSOR_BIN = readFileSync(new URL('./fixtures/v1-cursor.bin', import.meta.url));

// A decoded 2x (Retina) frame of a 1600x1000 point recording.
const FRAME = { displayWidth: 3200, displayHeight: 2000 };
const MAIN = { width: 1600, height: 1000, duration: 10 };

function render(project, { outT = 1, size, cursors = {}, frames = { main: FRAME }, assets = {} } = {}) {
  const ctx = mockContext();
  const tl = buildTimeline(project);
  const state = drawFrame(ctx, { project, tl, outT, frames, size: size ?? exportSize(project), assets: { cursors, ...assets } });
  return { ctx, state };
}

// ---------------------------------------------------------------- sizes

test('export size: source shape keeps v1 sizes, chosen shapes use the short side', () => {
  const v1 = P.migrate(V1_CLICKS); // a 1470x956 display
  assert.deepStrictEqual(exportSize(v1), { width: 1660, height: 1080 });
  assert.deepStrictEqual(exportSize(v1, '4k'), { width: 3322, height: 2160 });
  const p = P.createProject({ main: MAIN });
  assert.deepStrictEqual(exportSize(P.setStyle(p, { aspect: '16:9' })), { width: 1920, height: 1080 });
  assert.deepStrictEqual(exportSize(P.setStyle(p, { aspect: '9:16' })), { width: 1080, height: 1920 });
  assert.deepStrictEqual(exportSize(P.setStyle(p, { aspect: '1:1' }), '720p'), { width: 720, height: 720 });
  assert.deepStrictEqual(exportSize(P.setStyle(p, { aspect: '4:5' })), { width: 1080, height: 1350 });
  assert.throws(() => exportSize(p, '8k'), /resolution/);
  assert.strictEqual(aspectRatio('source'), null);
  assert.throws(() => aspectRatio('wide'), /aspect/);
});

test('layout insets by the padding and scales sizes with the short side', () => {
  const p = P.setStyle(P.createProject({ main: MAIN }), { padding: 0.1, radius: 20 });
  const a = layout(p, { width: 1920, height: 1080 });
  assert.deepStrictEqual(a.content, { x: 108, y: 108, w: 1704, h: 864 });
  assert.strictEqual(a.unit, 1);
  assert.strictEqual(a.radius, 20);
  const b = layout(p, { width: 2160, height: 3840 });
  assert.strictEqual(b.unit, 2);
  assert.strictEqual(b.radius, 40);
  assert.deepStrictEqual(b.content, { x: 216, y: 216, w: 1728, h: 3408 });
});

// ---------------------------------------------------------------- v1 picture

test('a migrated project draws the whole frame edge to edge on black, like v1', () => {
  const p = P.migrate(V1_CLICKS);
  const { ctx, state } = render(p, { outT: 0.5 });
  const draws = ctx.named('drawImage');
  assert.strictEqual(draws.length, 1);
  // Source 1470x956 points; a 2x frame; no zoom -> the whole frame into the whole output.
  const frame = { displayWidth: 2940, displayHeight: 1912 };
  const again = render(p, { outT: 0.5, frames: { main: frame } }).ctx.named('drawImage')[0].args;
  assert.deepStrictEqual(again.slice(1), [0, 0, 2940, 1912, 0, 0, 1660, 1080]);
  assert.strictEqual(state.radius, 0);
  assert.strictEqual(ctx.named('arcTo').length, 0, 'square corners');
  assert.ok(!ctx.calls.some((c) => c.name === 'set:shadowBlur'), 'no frame shadow');
  const bg = ctx.named('fillRect')[0];
  assert.deepStrictEqual(bg.args, [0, 0, 1660, 1080]);
  assert.strictEqual(bg.state.fillStyle, '#000000');
});

test('the camera crop follows a zoom, in frame pixels, and the cursor sits where v1 put it', () => {
  let p = P.createProject({ main: MAIN });
  p = P.setStyle(p, { background: { type: 'none', value: null }, padding: 0, radius: 0, shadow: 0 });
  p = P.addZoom(p, { start: 0, end: 10, level: 2, follow: false, x: 600, y: 400 });
  const cursors = { main: [{ t: 0, x: 700, y: 450, shape: 'arrow' }] };
  const size = { width: 1600, height: 1000 };
  const { ctx, state } = render(p, { outT: 5, size, cursors });
  near(state.camera.zoom, 2, 1e-3);
  const [, sx, sy, sw, sh, dx, dy, dw, dh] = ctx.named('drawImage')[0].args;
  near(sw, 1600, 2); // 800 points of a 2x frame
  near(sh, 1000, 2);
  near(sx, (600 - 400) * 2, 2);
  near(sy, (400 - 250) * 2, 2);
  assert.deepStrictEqual([dx, dy, dw, dh], [0, 0, 1600, 1000]);
  // v1: cursor at (x - rectX) * outW / vw, scale outW / vw.
  near(state.pointScale, 2, 1e-2);
  const move = ctx.named('moveTo').at(-1).args;
  near(move[0], (700 - 200) * 2, 2);
  near(move[1], (450 - 150) * 2, 2);
  const points = arrowPoints(move[0], move[1], state.pointScale);
  const lines = ctx.named('lineTo').slice(-6).map((c) => c.args);
  lines.forEach((pt, i) => { near(pt[0], points[i + 1][0], 1e-9); near(pt[1], points[i + 1][1], 1e-9); });
  const fill = ctx.named('fill').at(-1);
  assert.strictEqual(fill.state.fillStyle, '#ffffff');
});

test('cursor.show false hides the cursor but keeps click ripples', () => {
  const p = P.migrate(V1_CLICKS);
  const click = p.sources.main.clicks[0];
  const cursors = { main: [{ t: 0, x: 10, y: 10, shape: 'arrow' }] };
  const hidden = P.setStyle(p, { cursor: { show: false } });
  const { ctx } = render(hidden, { outT: click.t + 0.1, cursors });
  assert.strictEqual(ctx.named('lineTo').length, 0, 'no arrow');
  const ring = ctx.named('arc');
  assert.strictEqual(ring.length, 1);
  const s = 1660 / 1470;
  near(ring[0].args[0], click.x * s, 1e-6);
  near(ring[0].args[2], (6 + 34 * 0.2) * s, 1e-6);
  // Not before the click (this recording ends 0.13s after it); with clicks
  // off it never shows.
  assert.strictEqual(render(hidden, { outT: click.t - 0.05, cursors }).ctx.named('arc').length, 0);
  const off = P.setStyle(p, { cursor: { clicks: false } });
  assert.strictEqual(render(off, { outT: click.t + 0.1, cursors }).ctx.named('arc').length, 0);
});

// ---------------------------------------------------------------- style

test('backgrounds: colour, gradient and a cover-fitted image', () => {
  const p = P.createProject({ main: MAIN });
  const color = render(P.setStyle(p, { background: { type: 'color', value: '#123456' } })).ctx;
  assert.strictEqual(color.named('fillRect')[1].state.fillStyle, '#123456');

  const grad = render(P.setStyle(p, { background: { type: 'gradient', value: { angle: 90, stops: ['#ff0000', '#00ff00', '#0000ff'] } } }), { size: { width: 1920, height: 1080 } }).ctx;
  const g = grad.named('createLinearGradient')[0];
  assert.deepStrictEqual(g.args.map((v) => Math.round(v)), [0, 540, 1920, 540]);
  const gradFill = grad.named('fillRect')[1].state.fillStyle;
  assert.deepStrictEqual(gradFill.stops, [[0, '#ff0000'], [0.5, '#00ff00'], [1, '#0000ff']]);

  const img = { naturalWidth: 1000, naturalHeight: 1000 };
  const withImage = render(P.setStyle(p, { background: { type: 'image', value: 'bg.png' } }),
    { size: { width: 1920, height: 1080 }, assets: { background: img } }).ctx;
  const bgDraw = withImage.named('drawImage').find((c) => c.args[0] === img);
  assert.deepStrictEqual(bgDraw.args.slice(1).map((v) => Math.round(v)), [0, 219, 1000, 563, 0, 0, 1920, 1080]);
  // Not loaded yet: black, no crash.
  assert.strictEqual(render(P.setStyle(p, { background: { type: 'image', value: 'bg.png' } })).ctx.named('drawImage').length, 1);
});

test('gradient lines and cover crops', () => {
  const down = gradientLine(180, 100, 50);
  near(down.x0, 50); near(down.y0, 0); near(down.x1, 50); near(down.y1, 50);
  const diag = gradientLine(135, 100, 100);
  near(diag.x0, 0); near(diag.y0, 0); near(diag.x1, 100); near(diag.y1, 100);
  assert.deepStrictEqual(coverCrop(200, 100, 100, 100), { sx: 50, sy: 0, sw: 100, sh: 100 });
});

test('padding, rounded corners and shadow frame the recording', () => {
  const p = P.setStyle(P.createProject({ main: MAIN }), { padding: 0.1, radius: 20, shadow: 1, aspect: '16:9' });
  const { ctx, state } = render(p);
  assert.deepStrictEqual(state.content, { x: 108, y: 108, w: 1704, h: 864 });
  // The shadow is a filled rounded rect drawn with a blur, before the clip.
  const shadowFill = ctx.named('fill').find((c) => c.state.shadowBlur > 0);
  assert.ok(shadowFill, 'shadow drawn');
  near(shadowFill.state.shadowBlur, 60);
  const clipAt = ctx.calls.findIndex((c) => c.name === 'clip');
  assert.ok(clipAt > ctx.calls.indexOf(shadowFill), 'shadow is outside the clip');
  assert.strictEqual(ctx.named('arcTo').length, 8, 'rounded shadow and rounded clip');
  const [, , , , , dx, dy, dw, dh] = ctx.named('drawImage')[0].args;
  assert.deepStrictEqual([dx, dy, dw, dh], [108, 108, 1704, 864]);
  assert.ok(ctx.named('drawImage')[0].depth >= 1, 'frame drawn inside the clip');
  assert.strictEqual(ctx.depth, 0, 'every save is restored');
});

test('with the source shape, padding fits the whole recording instead of cropping it', () => {
  // A new project: source shape, 6% padding. The inset box is wider than the
  // recording, so the recording is centred in it at its own shape.
  const p = P.createProject({ main: MAIN });
  const size = exportSize(p);
  assert.deepStrictEqual(size, { width: 1728, height: 1080 });
  const { ctx, state } = render(p, { size });
  const [, sx, sy, sw, sh, dx, dy, dw, dh] = ctx.named('drawImage')[0].args;
  assert.deepStrictEqual([sx, sy, sw, sh], [0, 0, 3200, 2000], 'nothing cropped');
  near(dw / dh, 1.6, 2e-3);
  assert.strictEqual(dy, 65);
  assert.strictEqual(dh, 950);
  near(dx + dw / 2, size.width / 2, 1);
  assert.strictEqual(state.rect.width, 1600);
  // A square recording appended to a wide video is letterboxed, not stretched.
  const q = P.setStyle(P.appendRecording(p, 'src2', { width: 800, height: 800, duration: 4 }), { padding: 0 });
  const sq = render(q, { outT: 11, size, frames: { src2: { displayWidth: 800, displayHeight: 800 } } });
  const args = sq.ctx.named('drawImage')[0].args;
  assert.deepStrictEqual(args.slice(1), [0, 0, 800, 800, 324, 0, 1080, 1080]);
});

test('a 9:16 export of a wide recording shows a full-height slice that pans to the cursor', () => {
  let p = P.setStyle(P.createProject({ main: MAIN }), { aspect: '9:16', padding: 0 });
  p = P.setStyle(p, { radius: 0 });
  const size = exportSize(p);
  const cursors = { main: [{ t: 0, x: 1550, y: 500, shape: 'arrow' }] };
  const { ctx, state } = render(p, { outT: 5, size, cursors });
  const [, sx, sy, sw, sh] = ctx.named('drawImage')[0].args;
  near(sh, 2000, 1);
  near(sw / sh, 1080 / 1920, 1e-3);
  near(sx + sw, 3200, 1); // panned all the way right
  assert.strictEqual(sy, 0);
  // The cursor is inside the picture.
  const move = ctx.named('moveTo').at(-1).args;
  assert.ok(move[0] > 0 && move[0] < size.width, `cursor x ${move[0]}`);
  assert.strictEqual(state.rect.height, 1000);
});

test('cursor size, spotlight and ring', () => {
  const base = P.setStyle(P.createProject({ main: MAIN }), { padding: 0, radius: 0, shadow: 0 });
  const cursors = { main: [{ t: 0, x: 800, y: 500, shape: 'arrow' }] };
  const size = { width: 1600, height: 1000 };
  const big = render(P.setStyle(base, { cursor: { size: 2 } }), { size, cursors }).ctx;
  const line = big.named('lineTo')[0].args;
  near(line[1] - 500, 17 * 2, 1e-9);

  const spot = render(P.setStyle(base, { cursor: { highlight: 'spotlight' } }), { size, cursors }).ctx;
  const dim = spot.named('fill').find((c) => c.args[0] === 'evenodd');
  assert.ok(dim, 'spotlight dims around a hole');
  assert.strictEqual(spot.named('arc')[0].args[0], 800);

  const ring = render(P.setStyle(base, { cursor: { highlight: 'ring' } }), { size, cursors }).ctx;
  assert.strictEqual(ring.named('arc').length, 1);
  assert.ok(ring.named('stroke').length >= 2, 'ring and arrow outline');
});

test('hide when idle fades the cursor out after it sits still', () => {
  const p = P.setStyle(P.createProject({ main: MAIN }), { cursor: { hideWhenIdle: true } });
  const cursors = { main: [{ t: 0, x: 100, y: 100, shape: 'arrow' }, { t: 1, x: 300, y: 300, shape: 'arrow' }] };
  const at = (t) => render(p, { outT: t, cursors }).ctx.named('fill').filter((c) => c.state.fillStyle === '#ffffff');
  assert.strictEqual(at(1.5).length, 1);
  assert.strictEqual(at(1.5)[0].state.globalAlpha, 1);
  near(at(2.65)[0].state.globalAlpha, 0.5, 1e-6);
  assert.strictEqual(at(5).length, 0);
});

test('every section 5 layer is registered in order; extension points draw nothing yet', () => {
  assert.deepStrictEqual(LAYERS.map((l) => l.layer.name),
    ['background', 'shadow', 'frame', 'cursor', 'annotations', 'keystrokes', 'webcam', 'captions', 'transitions']);
  assert.deepStrictEqual(LAYERS.map((l) => l.clip), [false, false, true, true, true, false, false, false, false]);
  let p = P.createProject({ main: MAIN });
  p = P.addAnnotation(p, { type: 'box', start: 0, end: 5 });
  assert.doesNotThrow(() => render(p));
});

test('frames from an appended recording draw with that recording’s camera and size', () => {
  const p = P.appendRecording(P.createProject({ main: MAIN }), 'src2', { width: 800, height: 800, duration: 4 });
  const other = { displayWidth: 800, displayHeight: 800 };
  const { ctx, state } = render(p, { outT: 11, frames: { main: FRAME, src2: other } });
  assert.strictEqual(state.source, 'src2');
  near(state.t, 1);
  assert.strictEqual(ctx.named('drawImage')[0].args[0], other);
  // No frame decoded yet: black content, nothing else breaks.
  assert.strictEqual(render(p, { outT: 11, frames: {} }).ctx.named('drawImage').length, 0);
});

test('camera tracks are cached across edits that do not touch zooms', () => {
  const p = P.addZoom(P.createProject({ main: MAIN }), { start: 1, end: 3 });
  const cursors = { main: [] };
  const a = frameState({ project: p, tl: buildTimeline(p), outT: 2, size: { width: 1600, height: 1000 }, assets: { cursors } });
  const q = P.setTitle(p, 'Renamed');
  const b = frameState({ project: q, tl: buildTimeline(q), outT: 2, size: { width: 1600, height: 1000 }, assets: { cursors } });
  assert.strictEqual(a.camera, b.camera, 'same sample object: cache hit');
  const r = P.updateZoom(q, 'z1', { level: 3 });
  const c = frameState({ project: r, tl: buildTimeline(r), outT: 2, size: { width: 1600, height: 1000 }, assets: { cursors } });
  assert.notStrictEqual(c.camera, b.camera);
  assert.ok(c.camera.zoom > b.camera.zoom);
});

// ---------------------------------------------------------------- cursor.bin

test('parseCursorTrack reads real cursor.bin exactly like src/main/project.js', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'loupe-cursor-'));
  copyFileSync(new URL('./fixtures/v1-cursor.bin', import.meta.url), path.join(dir, 'cursor.bin'));
  const expected = v1Project.readCursorTrack(dir);
  const parsed = parseCursorTrack(CURSOR_BIN);
  assert.ok(parsed.length > 100);
  assert.deepStrictEqual(parsed, expected);
  assert.deepStrictEqual(parseCursorTrack(new Uint8Array(CURSOR_BIN).buffer), expected);
});

test('cursor sampling: nearest, smoothed and idle', () => {
  const track = [{ t: 0, x: 0, y: 0, shape: 'arrow' }, { t: 1, x: 100, y: 0, shape: 'ibeam' }, { t: 2, x: 100, y: 0, shape: 'ibeam' }];
  assert.strictEqual(cursorAt(track, 0.4), track[0]);
  assert.strictEqual(cursorAt(track, 0.6), track[1]);
  assert.strictEqual(cursorAt([], 1), null);
  const prep = prepareCursor(track);
  assert.deepStrictEqual(cursorPosition(prep, 0.6, false), { x: 100, y: 0, shape: 'ibeam' });
  const smooth = cursorPosition(prep, 0.5, true);
  assert.ok(smooth.x > 20 && smooth.x < 80, `smoothed ${smooth.x}`);
  assert.strictEqual(cursorOpacity(prep, 2), 1);
  assert.strictEqual(cursorOpacity(prep, 5), 0);
  assert.strictEqual(cursorOpacity(prep, 5, [{ t: 4.5 }]), 1, 'a click wakes it');
});

test('captions are drawn over the whole frame at their output time, only when shown', () => {
  let p = P.createProject({ main: MAIN });
  p = P.setCaptions(p, {
    show: true,
    segments: [{ id: 'c1', source: 'main', start: 4, end: 6, text: 'Hello there' }]
  });
  // A cut before the caption moves it 2 s earlier in the output.
  p = P.cutRange(p, 1, 3);
  const size = { width: 1920, height: 1080 };
  const texts = (project, outT) => render(project, { outT, size }).ctx.named('fillText').map((c) => c.args[0]);
  assert.deepStrictEqual(texts(p, 2.5), ['Hello there']);
  assert.deepStrictEqual(texts(p, 4.5), []);
  const drawn = render(p, { outT: 2.5, size }).ctx.named('fillText')[0];
  assert.ok(drawn.args[2] > 540, 'at the bottom by default');
  assert.deepStrictEqual(texts(P.setCaptions(p, { show: false }), 2.5), []);
});

test('captions have a dark box by default, and outlined words without it', () => {
  let p = P.createProject({ main: MAIN });
  p = P.setCaptions(p, { show: true, segments: [{ id: 'c1', source: 'main', start: 1, end: 3, text: 'Hi' }] });
  const size = { width: 1920, height: 1080 };
  const boxed = render(p, { outT: 2, size }).ctx;
  assert.ok(boxed.named('fill').some((c) => c.state.fillStyle === 'rgba(0, 0, 0, 0.72)'), 'a box');
  assert.strictEqual(boxed.named('strokeText').length, 0);
  const open = render(P.setCaptions(p, { style: { box: false } }), { outT: 2, size }).ctx;
  assert.ok(!open.named('fill').some((c) => c.state.fillStyle === 'rgba(0, 0, 0, 0.72)'), 'no box');
  assert.deepStrictEqual(open.named('strokeText').map((c) => c.args[0]), ['Hi']);
  assert.deepStrictEqual(open.named('fillText').map((c) => c.args[0]), ['Hi']);
});

test('an older project without the caption box setting gets it on load', () => {
  const p = P.createProject({ main: MAIN });
  const old = { ...p, captions: { ...p.captions, style: { size: 1.5, position: 'top' } } };
  assert.deepStrictEqual(P.validateProject(old).captions.style, { size: 1.5, position: 'top', box: true });
  assert.throws(() => P.setCaptions(p, { style: { box: 'yes' } }), /box/i);
});
