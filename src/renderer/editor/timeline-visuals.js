// The timeline's visual parts (timeline-view.js places them):
//
//   Annotations  a track of bars in output time: click to select, drag to
//                move, drag an edge to change how long it shows, double-click
//                to open its settings. Overlapping ones stack in lanes.
//   Joins        a small button on each join between two clips: click it to
//                pick a transition (none, fade, crossfade, dip to black) and
//                its length.
//
// It reuses the timeline's drag machinery (`t.beginDrag`, snapping) through
// the helpers object, so drags feel and undo the same as clips and zooms.

import * as P from '../../core/project.js';
import { h, icon } from './ui.js';
import { clipLayout, sourceInClip, clamp } from './timeline-math.js';
import {
  annotationPieces, stackLanes, movedRange, resizedRange, kindOf, annotationLabel
} from './annotation-math.js';

export const TRANSITIONS = [
  { type: null, label: 'None' },
  { type: 'fade', label: 'Fade' },
  { type: 'crossfade', label: 'Crossfade' },
  { type: 'dip', label: 'Dip to black' }
];
export const TRANSITION_LENGTHS = [0.25, 0.5, 1, 2];
const LANE_PX = 28;

// helpers: { x(t), timeAt(clientX, opts), pps(), beginDrag(e, handlers),
//            snapPoints(), snap(t, points), showGuide(t|null), rootEl, scroller }
export function createVisualTracks({ store, player, editor, helpers: t }) {
  const track = h('div', { class: 'tl-track tl-annotations', 'aria-label': 'Annotations' });
  const label = h('div', { class: 'tl-label lbl-annotations' }, icon('annotations', { size: 15 }), 'Notes');
  const joins = h('div', { class: 'tl-joins' });
  const menu = h('div', { class: 'speed-menu join-menu', role: 'menu', hidden: true });
  let picking = null; // the clip id whose join menu is open

  // ---- rendering

  function renderAnnotations(p, layout) {
    const sel = store.selection;
    const pieces = annotationPieces(p, layout);
    // The track grows a lane for each annotation overlapping another.
    const lanes = Math.min(4, stackLanes(pieces));
    const height = `${8 + lanes * LANE_PX}px`;
    track.style.height = height;
    label.style.height = height;
    const els = pieces.map((piece) => {
      const a = piece.annotation;
      const lane = Math.min(lanes - 1, piece.lane);
      return h('div', {
        class: `anno-bar kind-${a.type}${sel?.kind === 'annotation' && sel.id === a.id ? ' selected' : ''}`,
        dataset: { id: a.id, clip: String(piece.clipIndex) },
        style: {
          left: `${t.x(piece.outStart)}px`, width: `${Math.max(4, (piece.outEnd - piece.outStart) * t.pps())}px`,
          top: `${4 + lane * LANE_PX}px`, height: `${LANE_PX - 4}px`
        },
        title: `${annotationLabel(a)} — drag to move, drag the edges to change how long it shows`
      },
      h('div', { class: 'handle start', dataset: { edge: 'start' } }),
      h('span', { class: 'anno-bar-label' }, icon(kindOf(a.type).icon, { size: 12 }), annotationLabel(a)),
      h('div', { class: 'handle end', dataset: { edge: 'end' } }));
    });
    if (!pieces.length) els.push(h('div', { class: 'tl-hint' }, 'Text, arrows and title cards you add show here'));
    track.replaceChildren(...els);
  }

  function renderJoins(p, layout, clipsTrack) {
    joins.style.top = `${clipsTrack.offsetTop}px`;
    joins.style.height = `${clipsTrack.offsetHeight}px`;
    const els = [];
    for (let i = 0; i < layout.length - 1; i++) {
      const clip = layout[i].clip;
      const tr = p.transitions.find((q) => q.after === clip.id);
      const name = tr ? TRANSITIONS.find((k) => k.type === tr.type).label : null;
      els.push(h('button', {
        type: 'button', class: `tl-join${tr ? ' on' : ''}${picking === clip.id ? ' open' : ''}`,
        dataset: { after: clip.id },
        style: { left: `${t.x(layout[i].outEnd)}px` },
        title: tr ? `${name} (${tr.duration} s) — click to change` : 'Add a transition between these clips',
        'aria-label': tr ? `Transition: ${name}` : 'Add a transition'
      }, icon('transition', { size: 13 })));
    }
    joins.replaceChildren(...els);
  }

  function render(p, layout, clipsTrack) {
    renderAnnotations(p, layout);
    renderJoins(p, layout, clipsTrack);
  }

  // ---- the transition menu

  function openMenu(afterId, button) {
    picking = afterId;
    const current = store.project.transitions.find((q) => q.after === afterId);
    const pick = (type, duration) => {
      store.apply((p) => P.setTransition(p, afterId, type, duration));
      if (type === null) closeMenu();
      else openMenu(afterId, joins.querySelector(`[data-after="${afterId}"]`) ?? button);
    };
    const kinds = TRANSITIONS.map((k) => h('button', {
      type: 'button', role: 'menuitemradio', class: (current?.type ?? null) === k.type ? 'current' : '',
      'aria-checked': String((current?.type ?? null) === k.type), dataset: { transition: String(k.type) },
      onclick: () => pick(k.type, current?.duration ?? 0.5)
    }, k.label));
    const lengths = current ? [h('span', { class: 'menu-sep' }),
      ...TRANSITION_LENGTHS.map((d) => h('button', {
        type: 'button', class: current.duration === d ? 'current' : '', dataset: { length: String(d) },
        title: `${d} seconds long`, onclick: () => pick(current.type, d)
      }, `${d} s`))] : [];
    menu.replaceChildren(h('span', { class: 'menu-label' }, 'Transition'), ...kinds, ...lengths);
    menu.hidden = false;
    for (const b of joins.children) b.classList.toggle('open', b.dataset.after === afterId);
    const rootRect = t.rootEl.getBoundingClientRect();
    const r = (button ?? joins.querySelector(`[data-after="${afterId}"]`)).getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = `${clamp(r.left + r.width / 2 - rootRect.left - w / 2, 8, rootRect.width - w - 8)}px`;
    menu.style.top = `${r.top - rootRect.top - menu.offsetHeight - 8}px`;
  }

  function closeMenu() {
    if (menu.hidden && picking === null) return;
    menu.hidden = true;
    picking = null;
    for (const b of joins.children) b.classList.remove('open');
  }

  // ---- drags

  function annotationDrag(e, el) {
    const p0 = store.project;
    const layout0 = clipLayout(p0, store.tl);
    const a0 = p0.annotations.find((a) => a.id === el.dataset.id);
    const ci = Number(el.dataset.clip);
    const piece = annotationPieces(p0, layout0).find((pc) => pc.annotation.id === a0.id && pc.clipIndex === ci);
    const edge = e.target.dataset?.edge;
    const L = layout0[ci];
    const srcAt = (o) => (o < L.outStart ? L.clip.start - (L.outStart - o)
      : o > L.outEnd ? L.clip.end + (o - L.outEnd) : sourceInClip(p0, layout0, ci, o));
    const o0 = t.timeAt(e.clientX, { clampToVideo: false });
    const points = t.snapPoints();
    editor.select({ kind: 'annotation', id: a0.id });
    const gesture = `annotation:${a0.id}`;
    t.beginDrag(e, {
      move(ev) {
        const o = t.timeAt(ev.clientX, { clampToVideo: false });
        let range;
        if (edge) {
          range = resizedRange(p0, a0, edge, srcAt(t.snapped(o, points)));
        } else {
          let delta = o - o0;
          const s = t.snap(piece.outStart + delta, points);
          if (s !== piece.outStart + delta) { delta = s - piece.outStart; t.showGuide(s); } else t.showGuide(null);
          range = movedRange(p0, a0, srcAt(piece.outStart + delta) - (piece.srcStart - a0.start));
        }
        store.apply(() => P.updateAnnotation(p0, a0.id, range), { gesture });
      },
      click: () => {
        // Selecting one on the timeline shows it: jump there if it's not on screen.
        const at = store.tl.toSource(player.time);
        if (at.source !== a0.source || at.t < a0.start || at.t >= a0.end) player.seek(piece.outStart + 0.05);
      }
    });
  }

  // Returns true when the press was for these tracks.
  function pointerdown(e) {
    const join = e.target.closest('.tl-join');
    if (join) {
      e.preventDefault();
      if (picking === join.dataset.after) closeMenu();
      else openMenu(join.dataset.after, join);
      return true;
    }
    const bar = e.target.closest('.anno-bar');
    if (bar) {
      closeMenu();
      annotationDrag(e, bar);
      return true;
    }
    return false;
  }

  function dblclick(e) {
    const bar = e.target.closest('.anno-bar');
    if (!bar) return false;
    editor.select({ kind: 'annotation', id: bar.dataset.id });
    editor.showPanel('annotations', { focus: true });
    return true;
  }

  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest?.('.tl-join')) closeMenu();
  });

  return {
    track, label, joins, menu, render, pointerdown, dblclick, closeMenu,
    get menuOpen() { return !menu.hidden; }
  };
}
