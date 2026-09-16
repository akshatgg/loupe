// Direct editing of annotations on the preview: click one to select it, drag
// it to move it, drag its handles to resize it (or point an arrow), and
// double-click text or a title card to change the words right there.
//
// The picture itself is drawn by core/layers/annotations.js; this is only a
// transparent layer over the canvas with the selection outline and handles
// (so nothing of it can end up in an export). Positions come from the same
// annotationGeometry the layer draws with, in canvas pixels, and are turned
// back into the annotation's own fractions with the frame state the drag
// began with. A drag is one undo step.

import { h } from './ui.js';
import { updateAnnotation } from '../../core/project.js';
import {
  annotationGeometry, visibleAnnotations, recordingFraction, contentFraction
} from '../../core/layers/annotations.js';
import { movedBy, resizedBox } from './annotation-math.js';

const HIT_PX = 8;
const ORDER = { title: 4, text: 3, arrow: 2, box: 1, blur: 0 };

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const k = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + k * dx), py - (y1 + k * dy));
}

export function createAnnotationOverlay({ canvas, stage, store, player, editor }) {
  const ctx = canvas.getContext('2d');
  const frame = h('div', { class: 'anno-frame', hidden: true });
  const layer = h('div', { class: 'anno-overlay' }, frame);
  const editorBox = h('textarea', { class: 'anno-inline', hidden: true, spellcheck: 'true', 'aria-label': 'Words' });
  layer.append(editorBox);
  stage.append(layer);
  let drag = null;
  let editing = null; // annotation id being typed into

  // Canvas pixels per CSS pixel, and where the canvas is inside the stage.
  function metrics() {
    const c = canvas.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    return { k: canvas.width / Math.max(1, c.width), left: c.left - s.left, top: c.top - s.top, rect: c };
  }

  function placeLayer() {
    const m = metrics();
    Object.assign(layer.style, { left: `${m.left}px`, top: `${m.top}px`, width: `${m.rect.width}px`, height: `${m.rect.height}px` });
    return m;
  }

  const selectedId = () => (store.selection?.kind === 'annotation' ? store.selection.id : null);

  function shown(state) {
    if (!state) return [];
    return visibleAnnotations(state).sort((a, b) => ORDER[b.type] - ORDER[a.type]);
  }

  // Canvas-pixel point of a pointer event.
  function pointOf(e, m = metrics()) {
    return { x: (e.clientX - m.rect.left) * m.k, y: (e.clientY - m.rect.top) * m.k };
  }

  function handlesFor(a, g) {
    if (a.type === 'arrow') return [{ id: 'tail', x: g.x1, y: g.y1 }, { id: 'head', x: g.x2, y: g.y2 }];
    if (a.type === 'box' || a.type === 'blur') {
      const { x, y, w, h: hh } = g.box;
      return [
        { id: 'top-left', x, y }, { id: 'top-right', x: x + w, y },
        { id: 'bottom-left', x, y: y + hh }, { id: 'bottom-right', x: x + w, y: y + hh }
      ];
    }
    if (a.type === 'text') return [{ id: 'scale', x: g.box.x + g.box.w, y: g.box.y + g.box.h }];
    return [];
  }

  function hitTest(state, p, m) {
    const tol = HIT_PX * m.k;
    const sel = state.project.annotations.find((a) => a.id === selectedId());
    if (sel && shown(state).includes(sel)) {
      const g = annotationGeometry(ctx, state, sel);
      for (const hd of handlesFor(sel, g)) {
        if (Math.hypot(p.x - hd.x, p.y - hd.y) <= tol * 1.4) return { a: sel, handle: hd.id };
      }
    }
    for (const a of shown(state)) {
      const g = annotationGeometry(ctx, state, a);
      if (a.type === 'arrow') {
        if (distToSegment(p.x, p.y, g.x1, g.y1, g.x2, g.y2) <= Math.max(tol, g.width)) return { a };
        continue;
      }
      const { x, y, w, h: hh } = g.box;
      if (p.x >= x - tol && p.x <= x + w + tol && p.y >= y - tol && p.y <= y + hh + tol) return { a };
    }
    return null;
  }

  function render() {
    const m = placeLayer();
    const state = player.state;
    const id = selectedId();
    const a = state && id ? shown(state).find((q) => q.id === id) : null;
    if (!a || editing === a.id) {
      frame.hidden = true;
      return;
    }
    const g = annotationGeometry(ctx, state, a);
    const px = (v) => `${v / m.k}px`;
    frame.hidden = false;
    frame.className = `anno-frame kind-${a.type}`;
    if (a.type === 'arrow') {
      Object.assign(frame.style, { left: '0px', top: '0px', width: '0px', height: '0px' });
    } else {
      Object.assign(frame.style, { left: px(g.box.x), top: px(g.box.y), width: px(g.box.w), height: px(g.box.h) });
    }
    const handles = handlesFor(a, g).map((hd) => {
      const el = h('div', { class: 'anno-handle', dataset: { handle: hd.id } });
      const bx = a.type === 'arrow' ? hd.x : hd.x - g.box.x;
      const by = a.type === 'arrow' ? hd.y : hd.y - g.box.y;
      Object.assign(el.style, { left: px(bx), top: px(by) });
      return el;
    });
    frame.replaceChildren(...handles);
  }

  function beginEdit(a) {
    const state = player.state;
    if (!state || (a.type !== 'text' && a.type !== 'title')) return;
    const m = placeLayer();
    const g = annotationGeometry(ctx, state, a);
    editing = a.id;
    const box = a.type === 'title'
      ? { x: state.size.width * 0.15, y: state.size.height * 0.35, w: state.size.width * 0.7, h: state.size.height * 0.3 }
      : g.box;
    Object.assign(editorBox.style, {
      left: `${box.x / m.k}px`, top: `${box.y / m.k}px`,
      width: `${Math.max(160, box.w / m.k)}px`, height: `${Math.max(44, box.h / m.k)}px`
    });
    editorBox.value = a.text;
    editorBox.hidden = false;
    editorBox.focus();
    editorBox.select();
    render();
  }

  function endEdit(commit) {
    if (editing === null) return;
    const id = editing;
    editing = null;
    editorBox.hidden = true;
    if (commit && store.project.annotations.some((a) => a.id === id)) {
      const value = editorBox.value;
      store.apply((p) => updateAnnotation(p, id, { text: value }));
    }
    render();
  }

  editorBox.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); endEdit(false); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); endEdit(true); }
  });
  editorBox.addEventListener('blur', () => endEdit(true));

  layer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target === editorBox) return;
    const state = player.state;
    if (!state) return;
    const m = metrics();
    const p = pointOf(e, m);
    const hit = hitTest(state, p, m);
    if (!hit) {
      if (selectedId()) editor.select(null);
      return;
    }
    e.preventDefault();
    if (player.playing) player.pause();
    editor.select({ kind: 'annotation', id: hit.a.id });
    const a0 = hit.a;
    const s0 = state;
    const p0 = p;
    const inContent = a0.type === 'text';
    const frac = (q) => (inContent ? contentFraction(s0, q.x, q.y) : recordingFraction(s0, q.x, q.y));
    const f0 = frac(p0);
    const size0 = a0.size;
    const g0 = annotationGeometry(ctx, s0, a0);
    drag = {
      moved: false,
      move(ev) {
        const q = pointOf(ev);
        if (!this.moved && Math.hypot(q.x - p0.x, q.y - p0.y) < 3 * m.k) return;
        this.moved = true;
        const f = frac(q);
        let patch;
        if (!hit.handle) {
          patch = movedBy(a0, f.x - f0.x, f.y - f0.y);
        } else if (hit.handle === 'tail') {
          patch = { x: f.x, y: f.y };
        } else if (hit.handle === 'head') {
          patch = { x2: f.x, y2: f.y };
        } else if (hit.handle === 'scale') {
          // Text grows with the distance from its centre.
          const cx = g0.box.x + g0.box.w / 2;
          const cy = g0.box.y + g0.box.h / 2;
          const d0 = Math.hypot(p0.x - cx, p0.y - cy);
          const d1 = Math.hypot(q.x - cx, q.y - cy);
          patch = { size: Math.max(0.4, Math.min(4, size0 * (d0 > 0 ? d1 / d0 : 1))) };
        } else {
          patch = resizedBox(a0, hit.handle, f.x, f.y);
        }
        for (const k of ['x', 'y', 'x2', 'y2']) if (k in patch) patch[k] = Math.max(-0.99, Math.min(1.99, patch[k]));
        store.apply((pr) => updateAnnotation(pr, a0.id, patch), { gesture: `annotation:drag:${a0.id}` });
      },
      end() { store.endGesture(); }
    };
    layer.setPointerCapture(e.pointerId);
  });
  layer.addEventListener('pointermove', (e) => {
    if (drag) { drag.move(e); return; }
    const state = player.state;
    if (!state) return;
    const m = metrics();
    const hit = hitTest(state, pointOf(e, m), m);
    layer.style.cursor = !hit ? '' : hit.handle ? (hit.handle === 'scale' ? 'nwse-resize' : 'crosshair') : 'move';
  });
  const finish = () => {
    const d = drag;
    drag = null;
    d?.end();
  };
  layer.addEventListener('pointerup', finish);
  layer.addEventListener('pointercancel', finish);
  layer.addEventListener('dblclick', (e) => {
    const state = player.state;
    if (!state) return;
    const m = metrics();
    const hit = hitTest(state, pointOf(e, m), m);
    if (hit && (hit.a.type === 'text' || hit.a.type === 'title')) beginEdit(hit.a);
  });

  // After the player has drawn the change, so player.state is current.
  let queued = false;
  const soon = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  };
  store.subscribe(soon);
  player.onTime(soon);
  new ResizeObserver(soon).observe(stage);
  // The frame state is only there after the first draw.
  requestAnimationFrame(() => render());

  return { render, beginEdit, endEdit, get editing() { return editing; }, element: layer };
}
