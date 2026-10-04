// Two small canvases for the Clip panel's Advanced colour tools:
//
//   createCurveEditor({ id, onInput(points), onChange() })
//     the clip's curve (core/grade.js): click to add a point, drag one to
//     move it, double-click one to remove it. onInput on every change,
//     onChange once a drag is let go (one undo step).
//   createHistogram({ id, source })
//     how many pixels of `source()` (the preview canvas) are at each
//     brightness, dark on the left.

import { h } from './ui.js';
import { curvePoints, evalCurve, addCurvePoint, moveCurvePoint, removeCurvePoint, histogram } from '../../core/grade.js';

const PAD = 8;
const GRAB = 10;

// A canvas's drawing surface sized to what it shows at; null while hidden.
function surface(canvas) {
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  if (!(w > 0 && hgt > 0)) return null;
  const dpr = globalThis.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  return { ctx, w, h: hgt, ink: globalThis.getComputedStyle(canvas).color };
}

export function createCurveEditor({ id, onInput, onChange }) {
  const canvas = h('canvas', {
    id, class: 'curve-editor', role: 'img', 'aria-label': 'Colour curve',
    title: 'Curve: click to add a point, drag to move it, double-click to remove it'
  });
  let points = curvePoints(null);
  let drag = -1;
  let changed = false;

  const box = () => {
    const r = canvas.getBoundingClientRect();
    return { left: r.left + PAD, top: r.top + PAD, w: Math.max(1, r.width - 2 * PAD), h: Math.max(1, r.height - 2 * PAD) };
  };
  const toCurve = (e, b = box()) => ({ x: (e.clientX - b.left) / b.w, y: 1 - (e.clientY - b.top) / b.h });
  const hit = (e) => {
    const b = box();
    let best = -1;
    let bestD = GRAB;
    points.forEach((p, i) => {
      const d = Math.hypot(b.left + p.x * b.w - e.clientX, b.top + (1 - p.y) * b.h - e.clientY);
      if (d <= bestD) { best = i; bestD = d; }
    });
    return best;
  };

  function draw() {
    const s = surface(canvas);
    if (!s) return;
    const { ctx, ink } = s;
    const w = s.w - 2 * PAD;
    const hgt = s.h - 2 * PAD;
    const X = (x) => PAD + x * w;
    const Y = (y) => PAD + (1 - y) * hgt;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.12;
    ctx.beginPath();
    for (let k = 0; k <= 4; k++) {
      ctx.moveTo(X(k / 4), Y(0)); ctx.lineTo(X(k / 4), Y(1));
      ctx.moveTo(X(0), Y(k / 4)); ctx.lineTo(X(1), Y(k / 4));
    }
    ctx.stroke();
    // As recorded: the straight line.
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(0));
    ctx.lineTo(X(1), Y(1));
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let k = 0; k <= 100; k++) {
      const x = k / 100;
      if (k === 0) ctx.moveTo(X(x), Y(evalCurve(points, x)));
      else ctx.lineTo(X(x), Y(evalCurve(points, x)));
    }
    ctx.stroke();
    ctx.fillStyle = ink;
    points.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), i === drag ? 5.5 : 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    let i = hit(e);
    if (i < 0) {
      const at = toCurve(e);
      const added = addCurvePoint(points, at.x, at.y);
      if (!added) return;
      points = added.points;
      i = added.index;
      changed = true;
      onInput(points);
    }
    drag = i;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
    e.preventDefault();
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const at = toCurve(e);
    const next = moveCurvePoint(points, drag, at.x, at.y);
    if (next[drag].x === points[drag].x && next[drag].y === points[drag].y) return;
    points = next;
    changed = true;
    onInput(points);
    draw();
  });
  const release = () => {
    if (drag < 0) return;
    drag = -1;
    if (changed) onChange();
    changed = false;
    draw();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('dblclick', (e) => {
    const i = hit(e);
    const next = removeCurvePoint(points, i);
    if (i < 0 || next === points) return;
    points = next;
    onInput(points);
    onChange();
    draw();
  });

  return {
    el: canvas,
    draw,
    // The project's curve (ignored mid-drag: the drag is ahead of it).
    set(curve) {
      if (drag < 0) points = curvePoints(curve);
      draw();
    }
  };
}

const SAMPLE = { w: 160, h: 90 };
const BINS = 64;

export function createHistogram({ id, source }) {
  const canvas = h('canvas', { id, class: 'histogram', role: 'img', 'aria-label': 'Brightness of this frame', title: 'Histogram: dark on the left, bright on the right' });
  let sample = null;

  function draw() {
    const s = surface(canvas);
    const from = source();
    if (!s || !from || !(from.width > 0 && from.height > 0)) return;
    if (!sample) {
      sample = document.createElement('canvas');
      sample.width = SAMPLE.w;
      sample.height = SAMPLE.h;
    }
    const sctx = sample.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(from, 0, 0, SAMPLE.w, SAMPLE.h);
    const bins = histogram(sctx.getImageData(0, 0, SAMPLE.w, SAMPLE.h).data, BINS);
    canvas.bins = bins;
    const most = Math.max(1, ...bins);
    const { ctx, w, h: hgt, ink } = s;
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.75;
    const bw = w / BINS;
    bins.forEach((n, i) => {
      // A square root, so one big flat area doesn't flatten everything else.
      const bar = Math.sqrt(n / most) * hgt;
      ctx.fillRect(i * bw, hgt - bar, Math.max(1, bw - 1), bar);
    });
    ctx.globalAlpha = 1;
  }

  return { el: canvas, draw };
}
