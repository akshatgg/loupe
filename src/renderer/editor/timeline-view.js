// The timeline under the preview: a ruler, the playhead and three tracks.
//
//   Clips  drag an edge to trim, drag a clip to move it, click to select
//   Zoom   drag across empty space to add one, drag one to move it, drag its
//          edges to change its length, double-click to open its settings
//   Speed  drag across a stretch, then pick a speed from the little menu
//   Notes  annotations, and the transition buttons on each join between
//          clips (timeline-visuals.js)
//
// Everything is laid out in output time (timeline-math.js). Drags edit from
// the project as it was when the drag began, so the pointer always means the
// same thing however the layout shifts under it, and each drag is a single
// undo step (a `gesture`). Edges and zooms snap to clip edges, the playhead
// and other zooms.

import * as P from '../../core/project.js';
import { h, icon } from './ui.js';
import { createAudioLane } from './timeline-audio.js';
import {
  clipLayout, zoomPieces, speedPieces, sourceInClip, clipIndexAt, newZoomRange, movedZoom,
  resizedZoom, snap, snapPoints, insertionIndex, tickStep, formatTime, clamp, stripTiles, thumbStep
} from './timeline-math.js';
import { createVisualTracks } from './timeline-visuals.js';
import { createCaptionsTrack } from './captions-track.js';

const PAD = 16;           // px before 0:00 and after the end
const SNAP_PX = 8;
const DRAG_PX = 4;        // movement before a press becomes a drag
const MAX_PPS = 600;      // closest timeline zoom, px per second
export const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 8];

// `thumbnails` (thumbnails.js, optional): pictures along the clips.
export function createTimeline({ root, store, player, editor, thumbnails = null }) {
  const ruler = h('canvas', { class: 'tl-ruler' });
  const clipsTrack = h('div', { class: 'tl-track tl-clips', 'aria-label': 'Clips' });
  const zoomTrack = h('div', { class: 'tl-track tl-zooms', 'aria-label': 'Zooms' });
  const speedTrack = h('div', { class: 'tl-track tl-speed', 'aria-label': 'Speed' });
  const visuals = createVisualTracks({
    store, player, editor,
    helpers: {
      x: (t) => x(t), pps: () => pps, timeAt: (cx, o) => timeAt(cx, o), beginDrag: (e, hs) => beginDrag(e, hs),
      snapPoints: () => snapPoints(store.project, clipLayout(store.project, store.tl), { playhead: player.time }),
      snap: (v, points) => snap(v, points, SNAP_PX / pps), snapped: (v, points) => snapped(v, points),
      showGuide: (v) => showGuide(v), rootEl: root
    }
  });
  // Captions (captions-track.js) get the timeline's scale, drags and snapping.
  const captions = createCaptionsTrack({ store, player, editor, view: {
    x: (t) => x(t), timeAt: (cx, o) => timeAt(cx, o), get pps() { return pps; },
    beginDrag: (e, handlers) => beginDrag(e, handlers), snapped: (t, pts) => snapped(t, pts),
    snap: (t, pts) => snap(t, pts, SNAP_PX / pps),
    snapPoints: () => snapPoints(store.project, clipLayout(store.project, store.tl), { playhead: player.time })
  } });
  const playhead = h('div', { class: 'tl-playhead' }, h('div', { class: 'tl-knob' }));
  const guide = h('div', { class: 'tl-guide', hidden: true });
  const insert = h('div', { class: 'tl-insert', hidden: true });
  // The sound strip under the clips (timeline-audio.js) draws itself.
  const audioLane = createAudioLane({
    store, player, editor,
    view: { x: (t) => x(t), get pps() { return pps; }, get scroller() { return scroller; } }
  });
  const content = h('div', { class: 'tl-content' }, ruler, clipsTrack, audioLane.track, zoomTrack, speedTrack, visuals.track, captions.track, visuals.joins, guide, insert, playhead);
  const scroller = h('div', { class: 'tl-scroll' }, content);
  const labels = h('div', { class: 'tl-labels' },
    h('div', { class: 'tl-label lbl-ruler' }),
    h('div', { class: 'tl-label lbl-clips' }, icon('clips', { size: 15 }), 'Clips'),
    audioLane.label,
    h('div', { class: 'tl-label lbl-zooms' }, icon('zoom', { size: 15 }), 'Zoom'),
    h('div', { class: 'tl-label lbl-speed' }, icon('speed', { size: 15 }), 'Speed'),
    visuals.label,
    captions.label);
  const menu = h('div', { class: 'speed-menu', role: 'menu', hidden: true });
  root.replaceChildren(labels, scroller, menu, visuals.menu);

  let pps = 50;
  let fitted = true;
  let drag = null;
  let speedPick = null; // { source, start, end, clipIndex, outStart, outEnd } awaiting a speed

  const duration = () => store.tl.duration;
  const x = (t) => PAD + t * pps;
  const fitPps = () => Math.max(1, (scroller.clientWidth - 2 * PAD) / Math.max(0.5, duration()));
  const timeAt = (clientX, { clampToVideo = true } = {}) => {
    const r = content.getBoundingClientRect();
    const t = (clientX - r.left - PAD) / pps;
    return clampToVideo ? clamp(t, 0, duration()) : t;
  };

  // ---- layout and drawing

  // The moment a zoom keeps still on screen: the playhead when it's in view,
  // otherwise the middle of what's showing.
  function defaultAnchor() {
    const px = x(player.time) - scroller.scrollLeft;
    if (px >= 0 && px <= scroller.clientWidth) return player.time;
    return clamp((scroller.scrollLeft + scroller.clientWidth / 2 - PAD) / pps, 0, duration());
  }

  function setScale(next, anchorT = defaultAnchor()) {
    const min = fitPps();
    const old = pps;
    pps = clamp(next, Math.min(min, MAX_PPS), MAX_PPS);
    fitted = Math.abs(pps - min) < 1e-6;
    // Keep the anchor moment where it was on screen.
    const anchorX = x(anchorT) - scroller.scrollLeft;
    render();
    if (old !== pps) scroller.scrollLeft = Math.max(0, x(anchorT) - anchorX);
    drawRuler();
  }

  function renderClips(p, layout) {
    const sel = store.selection;
    const many = layout.length > 1;
    clipsTrack.replaceChildren(...layout.map((l, i) => {
      const len = l.outEnd - l.outStart;
      const el = h('div', {
        class: `clip${sel?.kind === 'clip' && sel.id === l.clip.id ? ' selected' : ''}${p.clips.length > 1 && l.clip.source !== 'main' ? ' other-source' : ''}`,
        dataset: { index: String(i), id: l.clip.id },
        style: { left: `${x(l.outStart)}px`, width: `${Math.max(2, len * pps)}px` },
        title: 'Drag the edges to trim, or drag the clip to move it'
      },
      thumbnails ? h('div', { class: 'clip-strip', 'aria-hidden': 'true' }) : null,
      h('div', { class: 'handle start', dataset: { edge: 'start' } }),
      h('div', { class: 'clip-label' },
        many ? h('span', { class: 'clip-name' }, `Clip ${i + 1}`) : null,
        h('span', { class: 'clip-dur' }, formatTime(len, { fraction: len < 10 }))),
      h('div', { class: 'handle end', dataset: { edge: 'end' } }));
      return el;
    }));
  }

  function renderZooms(p, layout) {
    const sel = store.selection;
    const pieces = zoomPieces(p, layout);
    const els = pieces.map((piece) => h('div', {
      class: `zoom${sel?.kind === 'zoom' && sel.id === piece.zoom.id ? ' selected' : ''}${piece.zoom.follow ? '' : ' fixed'}`,
      dataset: { id: piece.zoom.id, clip: String(piece.clipIndex) },
      style: { left: `${x(piece.outStart)}px`, width: `${Math.max(3, (piece.outEnd - piece.outStart) * pps)}px` },
      title: 'Drag to move, drag the edges to resize, double-click for settings'
    },
    h('div', { class: 'handle start', dataset: { edge: 'start' } }),
    h('span', { class: 'zoom-label' }, icon('zoom', { size: 12 }), `${Number(piece.zoom.level.toFixed(2))}×`),
    h('div', { class: 'handle end', dataset: { edge: 'end' } })));
    if (!pieces.length) els.push(h('div', { class: 'tl-hint' }, 'Drag here to add a zoom'));
    zoomTrack.replaceChildren(...els, h('div', { class: 'ghost zoom-ghost', hidden: true }));
  }

  function renderSpeed(p, layout) {
    const sel = store.selection;
    const pieces = speedPieces(p, layout);
    const els = pieces.map((piece) => {
      const s = piece.seg;
      const chosen = sel?.kind === 'speed' && sel.source === s.source && sel.start === s.start && sel.end === s.end;
      return h('div', {
        class: `speed ${s.rate > 1 ? 'fast' : 'slow'}${chosen ? ' selected' : ''}`,
        dataset: { source: s.source, start: String(s.start), end: String(s.end), clip: String(piece.clipIndex) },
        style: { left: `${x(piece.outStart)}px`, width: `${Math.max(3, (piece.outEnd - piece.outStart) * pps)}px` },
        title: `${s.rate}× speed — click to change`
      }, `${s.rate}×`);
    });
    if (!pieces.length && !speedPick) els.push(h('div', { class: 'tl-hint' }, 'Drag across a part to speed it up or slow it down'));
    speedTrack.replaceChildren(...els, h('div', { class: 'ghost speed-ghost', hidden: !speedPick }));
    if (speedPick) placeGhost(speedTrack.querySelector('.speed-ghost'), speedPick.outStart, speedPick.outEnd);
  }

  function render() {
    const p = store.project;
    const layout = clipLayout(p, store.tl);
    // Fitted, the scale follows the video's length -- but not mid-drag, where
    // the pointer would then mean a different moment on every move.
    if (fitted && !drag) pps = Math.min(MAX_PPS, fitPps());
    content.style.width = `${Math.max(scroller.clientWidth, x(duration()) + PAD)}px`;
    renderClips(p, layout);
    renderZooms(p, layout);
    renderSpeed(p, layout);
    visuals.render(p, layout, clipsTrack);
    captions.render(p, layout);
    movePlayhead(player.time);
    drawRuler();
    drawStrips();
  }

  // The pictures along each clip, for the part of the timeline in view (and
  // a screen either side, so scrolling finds them ready).
  function drawStrips() {
    if (!thumbnails) return;
    const p = store.project;
    const layout = clipLayout(p, store.tl);
    const w = scroller.clientWidth;
    const viewStart = scroller.scrollLeft - w;
    const viewEnd = scroller.scrollLeft + 2 * w;
    for (const el of clipsTrack.children) {
      const strip = el.querySelector('.clip-strip');
      const i = Number(el.dataset.index);
      const L = layout[i];
      if (!strip || !L) continue;
      const key = L.clip.source;
      const tileWidth = thumbnails.widthFor(key, strip.clientHeight || 58);
      const step = thumbStep(tileWidth / pps);
      const tiles = stripTiles({ outStart: L.outStart, outEnd: L.outEnd, pps, tileWidth, viewStart, viewEnd, pad: PAD });
      const imgs = [];
      for (const tile of tiles) {
        const url = thumbnails.get(key, sourceInClip(p, layout, i, tile.outT), step);
        if (url) imgs.push(h('img', { src: url, alt: '', draggable: 'false', style: { left: `${tile.x}px`, width: `${tileWidth}px` } }));
      }
      strip.replaceChildren(...imgs);
    }
  }

  let stripFrame = 0;
  const drawStripsSoon = () => {
    if (stripFrame) return;
    stripFrame = requestAnimationFrame(() => { stripFrame = 0; drawStrips(); });
  };

  function drawRuler() {
    const dpr = window.devicePixelRatio || 1;
    const w = scroller.clientWidth;
    const hgt = 26;
    ruler.style.width = `${w}px`;
    if (ruler.width !== Math.round(w * dpr)) { ruler.width = Math.round(w * dpr); ruler.height = hgt * dpr; }
    const ctx = ruler.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const left = scroller.scrollLeft;
    const { major, minor } = tickStep(pps);
    const t0 = Math.max(0, Math.floor((left - PAD) / pps / minor) * minor);
    const t1 = Math.min(duration(), (left + w - PAD) / pps);
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (let i = 0, t = t0; t <= t1 + 1e-9; i++, t = t0 + i * minor) {
      const px = x(t) - left;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.fillStyle = isMajor ? 'rgba(232,234,237,0.45)' : 'rgba(232,234,237,0.18)';
      ctx.fillRect(Math.round(px), isMajor ? 15 : 19, 1, isMajor ? 11 : 7);
      if (isMajor) {
        ctx.fillStyle = 'rgba(232,234,237,0.6)';
        ctx.fillText(formatTime(t, { fraction: major < 1 }), Math.round(px) + 4, 4);
      }
    }
    // The end of the video.
    const endX = x(duration()) - left;
    ctx.fillStyle = 'rgba(232,234,237,0.35)';
    ctx.fillRect(Math.round(endX), 6, 1, 20);
    audioLane.draw();
  }

  function movePlayhead(t) {
    playhead.style.transform = `translateX(${x(t)}px)`;
  }

  function placeGhost(el, a, b) {
    el.hidden = false;
    el.style.left = `${x(Math.min(a, b))}px`;
    el.style.width = `${Math.max(2, Math.abs(b - a) * pps)}px`;
  }

  function showGuide(t) {
    if (t === null) { guide.hidden = true; return; }
    guide.hidden = false;
    guide.style.transform = `translateX(${x(t)}px)`;
  }

  // Snaps output time t to nearby points; shows the guide when it does.
  function snapped(t, points) {
    const s = snap(t, points, SNAP_PX / pps);
    showGuide(s !== t ? s : null);
    return s;
  }

  // ---- drags

  function beginDrag(e, handlers) {
    e.preventDefault();
    closeMenu();
    const startX = e.clientX;
    drag = {
      moved: false,
      move(ev) {
        if (!this.moved && Math.abs(ev.clientX - startX) < DRAG_PX) return;
        this.moved = true;
        handlers.move?.(ev);
      },
      end(ev) {
        showGuide(null);
        insert.hidden = true;
        if (this.moved) handlers.end?.(ev);
        else handlers.click?.(ev);
        store.endGesture();
      }
    };
    content.setPointerCapture(e.pointerId);
    handlers.start?.(e);
  }

  function scrub(e) {
    const wasPlaying = player.playing;
    player.pause();
    const seek = (ev) => player.seek(timeAt(ev.clientX));
    beginDrag(e, { start: seek, move: seek, click: seek, end: () => { if (wasPlaying) player.play(); } });
  }

  function clipDrag(e, el) {
    const i = Number(el.dataset.index);
    const p0 = store.project;
    const layout0 = clipLayout(p0, store.tl);
    const L = layout0[i];
    const clip = L.clip;
    const edge = e.target.dataset?.edge;
    editor.select({ kind: 'clip', id: clip.id });
    if (edge) {
      const rest = snapPoints(p0, layout0, { playhead: player.time }).filter((t) => Math.abs(t - (edge === 'start' ? L.outStart : L.outEnd)) > 1e-6);
      beginDrag(e, {
        move(ev) {
          const o = snapped(timeAt(ev.clientX, { clampToVideo: false }), rest);
          let t;
          if (edge === 'start') {
            t = o >= L.outStart ? sourceInClip(p0, layout0, i, o) : clip.start - (L.outStart - o);
            const next = store.apply(() => P.trimStart(p0, clip.id, t), { gesture: `trim:${clip.id}:start` });
            if (next) player.seek(L.outStart);
          } else {
            t = o <= L.outEnd ? sourceInClip(p0, layout0, i, o) : clip.end + (o - L.outEnd);
            const next = store.apply(() => P.trimEnd(p0, clip.id, t), { gesture: `trim:${clip.id}:end` });
            if (next) player.seek(clipLayout(next, store.tl)[i].outEnd - 1e-3);
          }
        },
        click: (ev) => player.seek(timeAt(ev.clientX))
      });
      return;
    }
    let to = i;
    beginDrag(e, {
      move(ev) {
        if (layout0.length < 2) return;
        const o = timeAt(ev.clientX, { clampToVideo: false });
        to = insertionIndex(layout0, i, o);
        // The marker sits between the clips the dragged one would land between.
        const others = layout0.filter((_, k) => k !== i);
        const at = to === 0 ? others[0].outStart : others[to - 1].outEnd;
        insert.hidden = false;
        insert.style.transform = `translateX(${x(at)}px)`;
        el.classList.add('dragging');
        el.style.transform = `translateX(${(o - timeAt(e.clientX, { clampToVideo: false })) * pps}px)`;
      },
      end() {
        el.classList.remove('dragging');
        el.style.transform = '';
        if (to !== i) store.apply(() => P.moveClip(p0, i, to));
        else render();
      },
      click: (ev) => player.seek(timeAt(ev.clientX))
    });
  }

  function zoomCreate(e) {
    const p0 = store.project;
    const layout0 = clipLayout(p0, store.tl);
    const points = snapPoints(p0, layout0, { playhead: player.time });
    const a = snapped(timeAt(e.clientX), points);
    let b = a;
    const ghost = zoomTrack.querySelector('.zoom-ghost');
    editor.select(null);
    beginDrag(e, {
      move(ev) {
        b = snapped(timeAt(ev.clientX), points);
        placeGhost(ghost, a, b);
      },
      end() {
        ghost.hidden = true;
        const range = newZoomRange(p0, layout0, a, b);
        if (!range) {
          editor.toast('There’s no room for a zoom there. Zooms can’t overlap.');
          return;
        }
        editor.addZoom(range);
      },
      click: () => player.seek(a)
    });
  }

  function zoomDrag(e, el) {
    const p0 = store.project;
    const layout0 = clipLayout(p0, store.tl);
    const z0 = p0.zooms.find((z) => z.id === el.dataset.id);
    const ci = Number(el.dataset.clip);
    const piece = zoomPieces(p0, layout0).find((pc) => pc.zoom.id === z0.id && pc.clipIndex === ci);
    const edge = e.target.dataset?.edge;
    const points = snapPoints(p0, layout0, { playhead: player.time, exceptZoom: z0.id });
    const o0 = timeAt(e.clientX, { clampToVideo: false });
    editor.select({ kind: 'zoom', id: z0.id });
    const L = layout0[ci];
    // Source moment at output o in this zoom's clip; past the clip's ends
    // the recording carries on at normal speed.
    const srcAt = (o) => (o < L.outStart ? L.clip.start - (L.outStart - o)
      : o > L.outEnd ? L.clip.end + (o - L.outEnd) : sourceInClip(p0, layout0, ci, o));
    const gesture = `zoom:${z0.id}`;
    beginDrag(e, {
      move(ev) {
        const o = timeAt(ev.clientX, { clampToVideo: false });
        let range;
        if (edge) {
          const t = snapped(o, points);
          range = resizedZoom(p0, z0, edge, srcAt(t));
        } else {
          let delta = o - o0;
          const s = snap(piece.outStart + delta, points, SNAP_PX / pps);
          const en = snap(piece.outEnd + delta, points, SNAP_PX / pps);
          if (s !== piece.outStart + delta) { delta = s - piece.outStart; showGuide(s); }
          else if (en !== piece.outEnd + delta) { delta = en - piece.outEnd; showGuide(en); }
          else showGuide(null);
          const head = srcAt(piece.outStart + delta) - (piece.srcStart - z0.start);
          range = movedZoom(p0, z0, head);
        }
        store.apply(() => P.updateZoom(p0, z0.id, range), { gesture });
      },
      click: (ev) => player.seek(timeAt(ev.clientX))
    });
  }

  function speedDrag(e, el) {
    const p0 = store.project;
    const layout0 = clipLayout(p0, store.tl);
    const a = timeAt(e.clientX);
    const i = clipIndexAt(layout0, a);
    const L = layout0[i];
    let b = a;
    const ghost = speedTrack.querySelector('.speed-ghost');
    beginDrag(e, {
      move(ev) {
        b = clamp(timeAt(ev.clientX), L.outStart, L.outEnd);
        placeGhost(ghost, a, b);
      },
      end() {
        const s0 = sourceInClip(p0, layout0, i, Math.min(a, b));
        const s1 = sourceInClip(p0, layout0, i, Math.max(a, b));
        if (s1 - s0 < P.MIN_RANGE_SECONDS) { ghost.hidden = true; return; }
        editor.select(null);
        openMenu({ source: L.clip.source, start: s0, end: s1, outStart: Math.min(a, b), outEnd: Math.max(a, b) });
      },
      click() {
        if (el) {
          const pick = { source: el.dataset.source, start: Number(el.dataset.start), end: Number(el.dataset.end) };
          const piece = speedPieces(p0, layout0).find((pc) => pc.seg.source === pick.source &&
            pc.seg.start === pick.start && pc.clipIndex === Number(el.dataset.clip));
          editor.select({ kind: 'speed', source: pick.source, start: pick.start, end: pick.end });
          openMenu({ ...pick, outStart: piece.outStart, outEnd: piece.outEnd });
        } else {
          player.seek(a);
        }
      }
    });
  }

  // ---- the speed menu

  function openMenu(pick) {
    speedPick = pick;
    const current = store.project.speed.find((s) => s.source === pick.source && s.start <= pick.start + 1e-6 && s.end >= pick.end - 1e-6)?.rate ?? 1;
    menu.replaceChildren(
      h('span', { class: 'menu-label' }, 'Speed'),
      ...SPEEDS.map((rate) => h('button', {
        type: 'button', role: 'menuitemradio', 'aria-checked': String(rate === current),
        class: rate === current ? 'current' : '', dataset: { rate: String(rate) },
        onclick: () => applySpeed(rate)
      }, rate === 1 ? 'Normal' : `${rate}×`)));
    menu.hidden = false;
    render();
    const rootRect = root.getBoundingClientRect();
    const trackRect = speedTrack.getBoundingClientRect();
    const mid = trackRect.left + x((pick.outStart + pick.outEnd) / 2) - scroller.scrollLeft;
    const w = menu.offsetWidth;
    menu.style.left = `${clamp(mid - rootRect.left - w / 2, 8, rootRect.width - w - 8)}px`;
    menu.style.top = `${trackRect.top - rootRect.top - menu.offsetHeight - 8}px`;
  }

  function applySpeed(rate) {
    const pick = speedPick;
    closeMenu();
    const next = store.apply((p) => P.paintSpeed(p, { source: pick.source, start: pick.start, end: pick.end, rate }));
    if (next && rate !== 1) {
      const seg = next.speed.find((s) => s.source === pick.source && s.start <= pick.start + 1e-6 && s.end >= pick.end - 1e-6);
      if (seg) editor.select({ kind: 'speed', source: seg.source, start: seg.start, end: seg.end });
    }
  }

  function closeMenu() {
    if (menu.hidden && !speedPick) return;
    menu.hidden = true;
    speedPick = null;
    render();
  }

  // ---- events

  content.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (visuals.pointerdown(e)) return;
    visuals.closeMenu();
    const clip = e.target.closest('.clip');
    const zoom = e.target.closest('.zoom');
    const speed = e.target.closest('.speed');
    if (e.target === ruler || e.target.closest('.tl-playhead')) scrub(e);
    else if (clip) clipDrag(e, clip);
    else if (zoom) zoomDrag(e, zoom);
    else if (e.target.closest('.tl-zooms')) zoomCreate(e);
    else if (e.target.closest('.tl-speed')) speedDrag(e, speed);
    else if (e.target.closest('.caption')) captions.pointerdown(e);
    else scrub(e);
  });
  content.addEventListener('pointermove', (e) => drag?.move(e));
  const finish = (e) => {
    const d = drag;
    drag = null;
    d?.end(e);
    if (d) render();
  };
  content.addEventListener('pointerup', finish);
  content.addEventListener('pointercancel', finish);
  content.addEventListener('dblclick', (e) => {
    if (visuals.dblclick(e)) return;
    const zoom = e.target.closest('.zoom');
    if (!zoom) return;
    editor.select({ kind: 'zoom', id: zoom.dataset.id });
    editor.showPanel('zoom', { focus: true });
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !speedTrack.contains(e.target)) closeMenu();
  });
  scroller.addEventListener('scroll', () => { drawRuler(); drawStripsSoon(); });
  scroller.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      // Pinch or ⌘-scroll zooms the timeline around the pointer.
      e.preventDefault();
      setScale(pps * Math.exp(-e.deltaY * 0.01), timeAt(e.clientX));
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      scroller.scrollLeft += e.deltaY;
    }
  }, { passive: false });
  new ResizeObserver(() => render()).observe(scroller);

  store.subscribe(() => render());
  player.onTime((t, playing) => {
    movePlayhead(t);
    const px = x(t) - scroller.scrollLeft;
    if (playing) {
      // Keep the playhead in view while playing: a page at a time.
      if (px > scroller.clientWidth - 40 || px < 0) scroller.scrollLeft = x(t) - 40;
    } else if (!drag && (px < 0 || px > scroller.clientWidth)) {
      // A jump (Home, End, a clip picked in a panel) to somewhere out of
      // view brings the timeline along, with a little room either side.
      scroller.scrollLeft = Math.max(0, x(t) - scroller.clientWidth / 3);
    }
  });
  render();

  return {
    zoomIn: () => setScale(pps * 1.5),
    zoomOut: () => setScale(pps / 1.5),
    fit: () => { fitted = true; setScale(fitPps()); scroller.scrollLeft = 0; },
    closeMenu: () => { closeMenu(); visuals.closeMenu(); },
    get menuOpen() { return !menu.hidden || visuals.menuOpen; },
    visuals,
    redrawPictures: drawStripsSoon,
    get pxPerSecond() { return pps; },
    // For tests: the pixel x (in client coordinates) of output time t.
    clientX: (t) => content.getBoundingClientRect().left + x(t),
    render
  };
}
