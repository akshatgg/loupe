// The captions track on the timeline (shown once a video has captions):
// each caption where it plays, with its words. Click one to select it and
// jump there, drag it to move it, drag its edges to change when it shows,
// double-click it to edit its words in the Captions panel. Captions never
// overlap: a drag stops at the neighbouring captions.
//
// timeline-view.js owns the scale, drags and snapping and hands them over as
// `view`: { x(t), timeAt(clientX, opts), pps, beginDrag(e, handlers),
// snapPoints(), snapped(t, points), snap(t, points) }.

import { setCaptions } from '../../core/project.js';
import { setTiming } from '../../core/captions/edit.js';
import { h, icon } from './ui.js';
import { clipLayout, sourceInClip } from './timeline-math.js';
import { captionPieces, resizedCaption, movedCaption } from './captions-math.js';

export function createCaptionsTrack({ store, player, editor, view }) {
  const track = h('div', { class: 'tl-track tl-captions', 'aria-label': 'Captions', hidden: true });
  const label = h('div', { class: 'tl-label lbl-captions', hidden: true }, icon('captions', { size: 15 }), 'Captions');

  function render(p, layout) {
    const has = p.captions.segments.length > 0;
    track.hidden = !has;
    label.hidden = !has;
    if (!has) { track.replaceChildren(); return; }
    const sel = store.selection?.kind === 'caption' ? store.selection.id : null;
    track.replaceChildren(...captionPieces(p, layout).map((piece) => h('div', {
      class: `caption${piece.seg.id === sel ? ' selected' : ''}`,
      dataset: { id: piece.seg.id, clip: String(piece.clipIndex) },
      style: { left: `${view.x(piece.outStart)}px`, width: `${Math.max(3, (piece.outEnd - piece.outStart) * view.pps)}px` },
      title: piece.seg.text
    },
    h('div', { class: 'handle start', dataset: { edge: 'start' } }),
    h('span', { class: 'caption-label' }, piece.seg.text),
    h('div', { class: 'handle end', dataset: { edge: 'end' } }))));
  }

  function pointerdown(e) {
    const el = e.target.closest('.caption');
    if (!el) {
      // Empty track: behaves like the ruler.
      return false;
    }
    const p0 = store.project;
    const layout0 = clipLayout(p0, store.tl);
    const seg0 = p0.captions.segments.find((s) => s.id === el.dataset.id);
    const ci = Number(el.dataset.clip);
    const piece = captionPieces(p0, layout0).find((pc) => pc.seg.id === seg0.id && pc.clipIndex === ci);
    const edge = e.target.dataset?.edge;
    const L = layout0[ci];
    // Source moment at output o in this caption's clip; past the clip's ends
    // the recording carries on at normal speed.
    const srcAt = (o) => (o < L.outStart ? L.clip.start - (L.outStart - o)
      : o > L.outEnd ? L.clip.end + (o - L.outEnd) : sourceInClip(p0, layout0, ci, o));
    const others = captionPieces(p0, layout0).filter((pc) => pc.seg.id !== seg0.id).flatMap((pc) => [pc.outStart, pc.outEnd]);
    const points = [...view.snapPoints(), ...others];
    const o0 = view.timeAt(e.clientX, { clampToVideo: false });
    const gesture = `caption:${seg0.id}`;
    const apply = (range) => store.apply(() => setCaptions(p0, { segments: setTiming(p0.captions.segments, seg0.id, range) }), { gesture });
    editor.select({ kind: 'caption', id: seg0.id });
    view.beginDrag(e, {
      move(ev) {
        const o = view.timeAt(ev.clientX, { clampToVideo: false });
        if (edge) {
          apply(resizedCaption(p0, seg0, edge, srcAt(view.snapped(o, points))));
        } else {
          let delta = o - o0;
          const s = view.snap(piece.outStart + delta, points);
          if (s !== piece.outStart + delta) delta = s - piece.outStart;
          else {
            const en = view.snap(piece.outEnd + delta, points);
            if (en !== piece.outEnd + delta) delta = en - piece.outEnd;
          }
          const head = srcAt(piece.outStart + delta) - (piece.srcStart - seg0.start);
          apply(movedCaption(p0, seg0, head));
        }
      },
      click: (ev) => player.seek(view.timeAt(ev.clientX))
    });
    return true;
  }

  track.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.caption');
    if (!el) return;
    editor.select({ kind: 'caption', id: el.dataset.id });
    editor.showPanel('captions');
    editor.revealCaption?.(el.dataset.id, { focus: true });
  });

  return { track, label, render, pointerdown };
}
