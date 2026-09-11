'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateSpeedPaint, paintSpeed, retimePlan } = require('../src/main/speed');

test('a speed paint is validated against the recording', () => {
  assert.deepStrictEqual(validateSpeedPaint({ srcStart: 30, srcEnd: 35, rate: 2 }, 50),
    { srcStart: 30, srcEnd: 35, rate: 2 });
  // Dragging past either end of the recording just clamps.
  assert.deepStrictEqual(validateSpeedPaint({ srcStart: -1, srcEnd: 60, rate: 0.5 }, 50),
    { srcStart: 0, srcEnd: 50, rate: 0.5 });
  const bad = [
    { srcStart: 30, srcEnd: 35, rate: 16 },     // above 8x
    { srcStart: 30, srcEnd: 35, rate: 0.1 },    // below 0.25x
    { srcStart: 30, srcEnd: 35, rate: NaN },
    { srcStart: 35, srcEnd: 30, rate: 2 },      // backwards
    { srcStart: 30, srcEnd: 30.02, rate: 2 },   // too short to mean anything
    { srcStart: 'a', srcEnd: 35, rate: 2 },
    null
  ];
  for (const b of bad) assert.throws(() => validateSpeedPaint(b, 50), undefined, JSON.stringify(b));
});

test('painting a speed adds a segment; the rest of the video is untouched', () => {
  assert.deepStrictEqual(paintSpeed([], { srcStart: 30, srcEnd: 35, rate: 2 }),
    [{ srcStart: 30, srcEnd: 35, rate: 2 }]);
});

test('painting over part of a segment replaces just that part', () => {
  const segs = [{ srcStart: 10, srcEnd: 20, rate: 4 }];
  assert.deepStrictEqual(paintSpeed(segs, { srcStart: 14, srcEnd: 16, rate: 0.5 }), [
    { srcStart: 10, srcEnd: 14, rate: 4 },
    { srcStart: 14, srcEnd: 16, rate: 0.5 },
    { srcStart: 16, srcEnd: 20, rate: 4 }
  ]);
});

test('painting 1x puts a stretch back to normal speed', () => {
  const segs = [{ srcStart: 10, srcEnd: 20, rate: 4 }];
  assert.deepStrictEqual(paintSpeed(segs, { srcStart: 10, srcEnd: 20, rate: 1 }), []);
  assert.deepStrictEqual(paintSpeed(segs, { srcStart: 15, srcEnd: 25, rate: 1 }),
    [{ srcStart: 10, srcEnd: 15, rate: 4 }]);
});

test('touching segments at the same speed merge into one (no ramp down and back up)', () => {
  const segs = paintSpeed([{ srcStart: 30, srcEnd: 35, rate: 2 }], { srcStart: 35, srcEnd: 40, rate: 2 });
  assert.deepStrictEqual(segs, [{ srcStart: 30, srcEnd: 40, rate: 2 }]);
});

test('with no speed segments the export plan is the recording at 60fps', () => {
  const plan = retimePlan([], 2, 200);
  assert.strictEqual(plan.fps, 60);
  assert.ok(Math.abs(plan.outputDuration - 2) < 1e-6);
  assert.strictEqual(plan.frames.length, 120);
  plan.frames.forEach((t, k) => assert.ok(Math.abs(t - k / 60) < 1e-6, `frame ${k}`));
  assert.deepStrictEqual(plan.audio, []);
});

test('a 2x stretch shortens the video, and frames walk through it twice as fast', () => {
  const plan = retimePlan([{ srcStart: 2, srcEnd: 6, rate: 2 }], 10, 200);
  // 4s at 2x is ~2s of video; the 200ms ramps at each edge give back a little.
  assert.ok(plan.outputDuration > 8 && plan.outputDuration < 8.2, `output ${plan.outputDuration}`);
  const at = (tOut) => plan.frames[Math.round(tOut * 60)];
  assert.ok(Math.abs(at(1) - 1) < 1e-3, 'before the stretch: 1:1');
  // The stretch (recording 2..6s) plays at video ~2..4.1s; probe its middle.
  const mid = at(2.6);
  assert.ok(Math.abs(at(3.1) - mid - 1.0) < 1e-3, 'inside: 0.5s of video covers 1s of recording');
  for (let k = 1; k < plan.frames.length; k++) assert.ok(plan.frames[k] >= plan.frames[k - 1]);
  assert.ok(plan.frames.at(-1) <= 10);
});

test('a 0.5x stretch lengthens the video by the time it adds', () => {
  const plan = retimePlan([{ srcStart: 2, srcEnd: 4, rate: 0.5 }], 10, 0);
  assert.ok(Math.abs(plan.outputDuration - 12) < 1e-3, `output ${plan.outputDuration}`);
});

test('the audio slices stretch the sound to exactly the video length', () => {
  const plan = retimePlan([{ srcStart: 2, srcEnd: 6, rate: 2 }, { srcStart: 8, srcEnd: 9, rate: 0.5 }], 10, 200);
  // Slices cover only the retimed stretches; everything else plays at 1x.
  let out = 10;
  for (const s of plan.audio) {
    assert.ok(s.srcEnd > s.srcStart && s.rate > 0);
    out += (s.srcEnd - s.srcStart) / s.rate - (s.srcEnd - s.srcStart);
  }
  assert.ok(Math.abs(out - plan.outputDuration) < 1e-3, `audio ${out} vs video ${plan.outputDuration}`);
  // Ramps are sliced (10 per edge) so the audio eases like the video does.
  assert.strictEqual(plan.audio.filter((s) => s.srcStart >= 2 && s.srcEnd <= 6).length, 21);
});
