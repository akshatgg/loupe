// The timeline's overlay rows, above the main clips: every picture or video
// laid over the video (project.overlays, core/layers/overlays.js) as a block
// on its row, V2 nearest the clips -- as a video editor stacks V2, V3 over
// V1. Click one to select it (the Clip panel shows its settings); drag it to
// move it, up or down to another row; drag its ends to trim it. Its
// keyframes show as diamonds.
//
//   createOverlayLanes({ store, editor, view }) -> { label, track, render(), pointerdown(e) }
//
// `view`: { x(t), pps, shown(), beginDrag(e, handlers), snapPoints(), snap(t, points), showGuide(t) }

import * as P from '../../core/project.js';
import { MAX_LANES } from '../../core/audio/clips.js';
import { h, icon } from './ui.js';
import { clamp, formatTime } from './timeline-math.js';

export const ROW_HEIGHT = 30;
const MIN_SECONDS = 0.1;

export function createOverlayLanes({ store, editor, view }) {
  const track = h('div', { class: 'tl-track tl-overlays', 'aria-label': 'Overlays' });
  const label = h('div', { class: 'tl-overlay-labels' });
  let labelRows = 0;
  let dragRows = 0;

  // Rows top to bottom: the highest first, V2 (row 0) nearest the clips.
  const rowsFor = (p) => Math.max(1, dragRows, ...(p.overlays ?? []).map((o) => o.lane + 1));
  const topOf = (lane, rows) => (rows - 1 - lane) * ROW_HEIGHT;

  function render() {
    const { project: p } = view.shown();
    const rows = rowsFor(p);
    track.style.height = `${rows * ROW_HEIGHT}px`;
    label.style.height = `${rows * ROW_HEIGHT}px`;
    if (rows !== labelRows) {
      labelRows = rows;
      label.replaceChildren(...Array.from({ length: rows }, (_, i) =>
        h('div', { class: 'tl-label lbl-overlay' }, icon('image', { size: 14 }), `V${rows - i + 1}`)));
    }
    const sel = store.selection;
    const els = [];
    for (let i = 0; i < rows; i++) els.push(h('div', { class: 'aclip-row', style: { top: `${i * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px` } }));
    for (const o of p.overlays ?? []) {
      const width = Math.max(4, o.length * view.pps);
      const times = new Set(Object.values(o.keyframes ?? {}).flat().map((k) => k.t));
      els.push(h('div', {
        class: `oclip ${o.kind}${sel?.kind === 'overlay' && sel.id === o.id ? ' selected' : ''}`,
        dataset: { id: o.id },
        style: { left: `${view.x(o.start)}px`, width: `${width}px`, top: `${topOf(o.lane, rows) + 2}px`, height: `${ROW_HEIGHT - 4}px` },
        title: `${o.name || 'Overlay'} · ${formatTime(o.start, { fraction: true })}–${formatTime(o.start + o.length, { fraction: true })}\nDrag to move, drag the ends to trim`
      },
      h('span', { class: 'oclip-name' }, icon(o.kind === 'video' ? 'webcam' : 'image', { size: 11 }), o.name || 'Overlay'),
      ...[...times].map((t) => h('span', { class: 'kf-diamond', style: { left: `${t * view.pps}px` }, title: `Keyframe at ${formatTime(o.start + t, { fraction: true })}` })),
      h('div', { class: 'handle start', dataset: { edge: 'start' } }),
      h('div', { class: 'handle end', dataset: { edge: 'end' } })));
    }
    if (!p.overlays?.length) els.push(h('div', { class: 'tl-hint' }, 'Overlay a logo, picture or video: the Overlay button'));
    track.replaceChildren(...els);
  }

  function pointerdown(e) {
    if (!track.contains(e.target)) return false;
    const el = e.target.closest('.oclip');
    if (!el) return false;
    const p0 = store.project;
    const id = el.dataset.id;
    const o0 = p0.overlays.find((o) => o.id === id);
    const edge = e.target.dataset?.edge;
    editor.select({ kind: 'overlay', id });
    const rowsTop = track.getBoundingClientRect().top;
    const rows = rowsFor(p0);
    const points = [...view.snapPoints(), ...p0.overlays.filter((o) => o.id !== id).flatMap((o) => [o.start, o.start + o.length])];
    const change = (patch) => store.apply(() => P.updateOverlay(p0, id, patch), { gesture: `overlay:${id}:${edge ?? 'move'}` });
    view.beginDrag(e, {
      move(ev) {
        const dt = (ev.clientX - e.clientX) / view.pps;
        if (edge === 'start') {
          // A video's left end starts it later in its file too.
          const lo = o0.kind === 'video' ? Math.max(-o0.start, -o0.from) : -o0.start;
          let s = clamp(view.snapped(o0.start + dt, points) - o0.start, lo, o0.length - MIN_SECONDS);
          s = Math.round(s * 1000) / 1000;
          change({ start: o0.start + s, length: o0.length - s, from: o0.kind === 'video' ? o0.from + s : o0.from });
        } else if (edge === 'end') {
          const most = o0.kind === 'video' && o0.fileDuration > 0 ? o0.fileDuration - o0.from : Infinity;
          change({ length: clamp(view.snapped(o0.start + o0.length + dt, points) - o0.start, MIN_SECONDS, most) });
        } else {
          const row = clamp(Math.floor((ev.clientY - rowsTop) / ROW_HEIGHT), -1, rows - 1);
          const lane = clamp(rows - 1 - row, 0, MAX_LANES - 1);
          dragRows = Math.min(MAX_LANES, Math.max(rows, lane + 1));
          let start = Math.max(0, o0.start + dt);
          const s = view.snap(start, points);
          if (s !== start) { start = s; view.showGuide(s); } else view.showGuide(null);
          change({ start, lane });
        }
      },
      end() { dragRows = 0; render(); },
      click() { dragRows = 0; }
    });
    return true;
  }

  return { label, track, render, pointerdown };
}
