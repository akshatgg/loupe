// The timeline under the preview: a ruler, the playhead and three tracks.
//
//   Clips  drag an edge to trim, drag a clip to move it, click to select
//   Zoom   drag across empty space to add one, drag one to move it, drag its
//          edges to change its length, double-click to open its settings
//          right-click to switch it off, make it manual or remove it
//   Speed  shown on the clip as a badge: ⌥-drag across a clip, then pick a
//          speed from the little menu; click a badge to change it
//   Text   annotations, and the transition buttons on each join between
//          clips (timeline-visuals.js)
//
// ⌘-click or ⇧-click selects several things; dragging across empty space
// draws a box around them.
//
// Everything is laid out in output time (timeline-math.js). Drags edit from
// the project as it was when the drag began, so the pointer always means the
// same thing however the layout shifts under it, and each drag is a single
// undo step (a `gesture`). Edges and zooms snap to clip edges, the playhead
// and other zooms.

import * as P from '../../core/project.js';
import { h, icon } from './ui.js';
import { createAudioLane } from './timeline-audio.js';
import { createMusicLanes } from './timeline-music.js';
import { buildTimeline } from '../../core/timeline.js';
import { createOverlayLanes } from './timeline-overlays.js';
import {
  clipLayout, zoomPieces, speedPieces, sourceInClip, clipIndexAt, newZoomRange, movedZoom,
  resizedZoom, snap, snapPoints, insertionIndex, tickStep, formatTime, clamp, stripTiles, thumbStep, outputAtSource, outputInClip,
  boxHits
} from './timeline-math.js';
import { hasItem } from './selection.js';
import { createVisualTracks } from './timeline-visuals.js';
import { createCaptionsTrack } from './captions-track.js';

const PAD = 16;           // px before 0:00 and after the end
const SNAP_PX = 8;
const DRAG_PX = 4;        // movement before a press becomes a drag
const MAX_PPS = 600;      // closest timeline zoom, px per second
export const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 8];

// `thumbnails` (thumbnails.js, optional): pictures along the clips.
export function createTimeline({ root, store, player, editor, thumbnails = null }) {
  // Where drags snap: clip edges, zooms and the playhead (timeline-math.js),
  // and the beats of songs showing beat marks (timeline-music.js; only
  // called once a drag begins, after it exists).
  // With Snap switched off (the toolbar) there is nothing to snap to.
  let snapOn = true;
  const snapsWithBeats = (p, layout, opts) => (snapOn ? [
    ...snapPoints(p, layout, opts), ...(musicLanes?.beatTimes() ?? []), ...(p.markers ?? []).map((m) => m.t)
  ] : []);
  const ruler = h('canvas', { class: 'tl-ruler' });
  const clipsTrack = h('div', { class: 'tl-track tl-clips', 'aria-label': 'Clips' });
  const zoomTrack = h('div', { class: 'tl-track tl-zooms', 'aria-label': 'Zooms' });
  const visuals = createVisualTracks({
    store, player, editor,
    helpers: {
      x: (t) => x(t), pps: () => pps, timeAt: (cx, o) => timeAt(cx, o), beginDrag: (e, hs) => beginDrag(e, hs),
      snapPoints: () => snapsWithBeats(store.project, clipLayout(store.project, store.tl), { playhead: player.time }),
      snap: (v, points) => snap(v, points, SNAP_PX / pps), snapped: (v, points) => snapped(v, points),
      showGuide: (v) => showGuide(v), rootEl: root
    }
  });
  // Captions (captions-track.js) get the timeline's scale, drags and snapping.
  const captions = createCaptionsTrack({ store, player, editor, view: {
    x: (t) => x(t), timeAt: (cx, o) => timeAt(cx, o), get pps() { return pps; },
    beginDrag: (e, handlers) => beginDrag(e, handlers), snapped: (t, pts) => snapped(t, pts),
    snap: (t, pts) => snap(t, pts, SNAP_PX / pps),
    snapPoints: () => snapsWithBeats(store.project, clipLayout(store.project, store.tl), { playhead: player.time })
  } });
  const playhead = h('div', { class: 'tl-playhead' }, h('div', { class: 'tl-knob' }));
  // In/Out marks (I, O): the part between them shaded over every track.
  let marks = { in: null, out: null };
  const marksShade = h('div', { class: 'tl-marks', hidden: true, 'aria-hidden': 'true' });
  const inFlag = h('div', { class: 'tl-mark in', hidden: true, title: 'In (I)' });
  const outFlag = h('div', { class: 'tl-mark out', hidden: true, title: 'Out (O)' });
  // Markers (M): flags on the ruler.
  const markersLayer = h('div', { class: 'tl-markers' });
  const guide = h('div', { class: 'tl-guide', hidden: true });
  const insert = h('div', { class: 'tl-insert', hidden: true });
  // The sound strip under the clips (timeline-audio.js) draws itself, from
  // the same timeline the clips show (the frozen one during a trim).
  const audioLane = createAudioLane({
    store, player, editor,
    view: { x: (t) => x(t), get pps() { return pps; }, get scroller() { return scroller; }, shown: () => view() }
  });
  // Songs and sound files, one row each where they overlap (timeline-music.js).
  const musicLanes = createMusicLanes({
    store, player, editor,
    view: {
      x: (t) => x(t), get pps() { return pps; }, timeAt: (cx, o) => timeAt(cx, o), shown: () => view(),
      beginDrag: (e, handlers) => beginDrag(e, handlers),
      snapPoints: () => snapsWithBeats(store.project, clipLayout(store.project, store.tl), { playhead: player.time }),
      snap: (t, pts) => snap(t, pts, SNAP_PX / pps), snapped: (t, pts) => snapped(t, pts), showGuide: (t) => showGuide(t)
    }
  });
  // Pictures and videos over the video, on rows above the clips (timeline-overlays.js).
  const overlayLanes = createOverlayLanes({
    store, editor,
    view: {
      x: (t) => x(t), get pps() { return pps; }, shown: () => view(),
      beginDrag: (e, handlers) => beginDrag(e, handlers),
      snapPoints: () => snapsWithBeats(store.project, clipLayout(store.project, store.tl), { playhead: player.time }),
      snap: (t, pts) => snap(t, pts, SNAP_PX / pps), snapped: (t, pts) => snapped(t, pts), showGuide: (t) => showGuide(t)
    }
  });
  // The box drawn by dragging across empty space, to select what it touches.
  const boxEl = h('div', { class: 'tl-box', hidden: true, 'aria-hidden': 'true' });
  const content = h('div', { class: 'tl-content' }, ruler, overlayLanes.track, clipsTrack, zoomTrack, audioLane.track, musicLanes.track, visuals.track, captions.track, visuals.joins, guide, insert, marksShade, inFlag, outFlag, markersLayer, boxEl, playhead);
  const scroller = h('div', { class: 'tl-scroll' }, content);
  const labels = h('div', { class: 'tl-labels' },
    h('div', { class: 'tl-label lbl-ruler' }),
    overlayLanes.label,
    h('div', { class: 'tl-label lbl-clips' }, icon('clips', { size: 15 }), 'Clips'),
    h('div', { class: 'tl-label lbl-zooms' }, icon('zoom', { size: 15 }), 'Zoom'),
    audioLane.label,
    musicLanes.label,
    visuals.label,
    captions.label);
  const menu = h('div', { class: 'speed-menu', role: 'menu', hidden: true });
  // A zoom's right-click menu.
  const zoomMenu = h('div', { class: 'tool-menu ctx-menu', role: 'menu', hidden: true, 'aria-label': 'Zoom' });
  root.replaceChildren(labels, scroller, menu, zoomMenu, visuals.menu);

  let pps = 50;
  let fitted = true;
  let drag = null;
  let speedPick = null; // { source, start, end, clipIndex, outStart, outEnd } awaiting a speed
  // While a clip's edge is dragged the timeline stays laid out as it was when
  // the drag began, the part being cut shown dimmed under its pictures
  // (renderTrim), instead of closing up under the pointer at every move:
  // { project, tl, clipIndex, edge, at } -- `at` is where the edge is now, in
  // that timeline's time. The edit itself is live (preview, undo, save).
  let frozen = null;
  // Dragging an edge outward (bringing back footage trimmed earlier) is shown
  // live instead: the clip grows -- the rest of the timeline moving along,
  // as an editor's ripple trim does -- and the part coming back is drawn
  // with its pictures, highlighted (`frozen.restoring`).
  const view = () => (frozen && !frozen.restoring ? frozen : { project: store.project, tl: store.tl });
  const playheadTime = () => (frozen ? frozen.at : player.time);

  const duration = () => view().tl.duration;
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
    const sel = store.selected;
    const many = layout.length > 1;
    clipsTrack.replaceChildren(...layout.map((l, i) => {
      const len = l.outEnd - l.outStart;
      const held = l.clip.hold > 0;
      const gap = P.isGap(l.clip);
      const el = h('div', {
        class: `clip${hasItem(sel, { kind: 'clip', id: l.clip.id }) ? ' selected' : ''}${p.clips.length > 1 && l.clip.source !== 'main' ? ' other-source' : ''}` +
          `${gap ? ' gap' : held ? ' freeze' : ''}${l.clip.reverse ? ' reversed' : ''}`,
        dataset: { index: String(i), id: l.clip.id },
        style: { left: `${x(l.outStart)}px`, width: `${Math.max(2, len * pps)}px` },
        title: gap ? 'A gap: black for this long. Drag its edges to change its length, or delete it to close it.'
          : 'Drag the edges to trim, or drag the clip to move it'
      },
      thumbnails && !gap ? h('div', { class: 'clip-strip', 'aria-hidden': 'true' }) : null,
      h('div', { class: 'handle start', dataset: { edge: 'start' } }),
      h('div', { class: 'clip-label' },
        gap ? h('span', { class: 'clip-name' }, 'Gap')
          : held ? h('span', { class: 'clip-name' }, 'Freeze frame')
          : l.clip.reverse ? h('span', { class: 'clip-name' }, '◀◀ Backwards')
            : many ? h('span', { class: 'clip-name' }, `Clip ${i + 1}`) : null,
        h('span', { class: 'clip-dur' }, formatTime(len, { fraction: true }))),
      h('div', { class: 'handle end', dataset: { edge: 'end' } }));
      return el;
    }));
  }

  function renderZooms(p, layout) {
    const sel = store.selected;
    const pieces = zoomPieces(p, layout);
    const els = pieces.map((piece) => h('div', {
      class: `zoom${hasItem(sel, { kind: 'zoom', id: piece.zoom.id }) ? ' selected' : ''}${piece.zoom.follow ? '' : ' fixed'}` +
        `${piece.zoom.disabled ? ' disabled' : ''}${piece.zoom.auto ? ' auto' : ''}`,
      dataset: { id: piece.zoom.id, clip: String(piece.clipIndex) },
      style: { left: `${x(piece.outStart)}px`, width: `${Math.max(3, (piece.outEnd - piece.outStart) * pps)}px` },
      title: piece.zoom.disabled ? 'Switched off: right-click to switch it back on'
        : 'Drag to move, drag the edges to resize, right-click for more'
    },
    h('div', { class: 'handle start', dataset: { edge: 'start' } }),
    h('span', { class: 'zoom-label' }, icon('zoom', { size: 12 }),
      piece.zoom.auto ? h('span', { class: 'zoom-auto' }, 'Auto') : null,
      piece.zoom.disabled ? 'Off' : `${Number(piece.zoom.level.toFixed(2))}×`),
    h('div', { class: 'handle end', dataset: { edge: 'end' } })));
    if (!pieces.length) els.push(h('div', { class: 'tl-hint' }, 'Drag here to add a zoom'));
    zoomTrack.replaceChildren(...els, h('div', { class: 'ghost zoom-ghost', hidden: true }));
  }

  // Speed changes, as badges along the bottom of the clips they are on.
  function renderSpeed(p, layout) {
    const sel = store.selected;
    const pieces = speedPieces(p, layout);
    const els = pieces.map((piece) => {
      const s = piece.seg;
      const chosen = hasItem(sel, { kind: 'speed', source: s.source, start: s.start, end: s.end });
      return h('div', {
        class: `speed ${s.rate > 1 ? 'fast' : 'slow'}${chosen ? ' selected' : ''}`,
        dataset: { source: s.source, start: String(s.start), end: String(s.end), clip: String(piece.clipIndex) },
        style: { left: `${x(piece.outStart)}px`, width: `${Math.max(3, (piece.outEnd - piece.outStart) * pps)}px` },
        title: `${s.rate}× speed — click to change`
      }, `${s.rate}×`);
    });
    const ghost = h('div', { class: 'ghost speed-ghost', hidden: !speedPick });
    clipsTrack.append(...els, ghost);
    if (speedPick) placeGhost(ghost, speedPick.outStart, speedPick.outEnd);
  }

  // The trim in progress over the frozen timeline: the part being cut dimmed
  // (or the part being brought back outlined), a bright line at the new
  // edge, and the clip's new length on its label.
  function renderTrim(layout) {
    if (!frozen) return;
    if (frozen.restoring) {
      // Live layout: the footage coming back runs from the clip's new edge
      // to where its old edge now is.
      const L = layout[frozen.clipIndex];
      const [a, b] = frozen.edge === 'start' ? [L.outStart, frozen.oldEdge] : [frozen.oldEdge, L.outEnd];
      if (b - a > 1e-6) {
        clipsTrack.append(h('div', {
          class: 'trim-shade add restored', 'aria-hidden': 'true', title: 'Coming back',
          style: { left: `${x(a)}px`, width: `${(b - a) * pps}px` }
        }));
      }
      clipsTrack.append(h('div', { class: 'trim-edge', 'aria-hidden': 'true', style: { left: `${x(frozen.at)}px` } }));
      return;
    }
    const L = layout[frozen.clipIndex];
    const was = frozen.edge === 'start' ? L.outStart : L.outEnd;
    const a = Math.min(was, frozen.at);
    const b = Math.max(was, frozen.at);
    const cutting = frozen.edge === 'start' ? frozen.at > was : frozen.at < was;
    if (b - a > 1e-6) {
      clipsTrack.append(h('div', {
        class: `trim-shade ${cutting ? 'cut' : 'add'}`, 'aria-hidden': 'true',
        style: { left: `${x(a)}px`, width: `${(b - a) * pps}px` }
      }));
    }
    clipsTrack.append(h('div', { class: 'trim-edge', 'aria-hidden': 'true', style: { left: `${x(frozen.at)}px` } }));
    const live = store.tl.clipBounds()[frozen.clipIndex];
    const label = clipsTrack.querySelector(`.clip[data-index="${frozen.clipIndex}"] .clip-dur`);
    if (live && label) label.textContent = formatTime(live.outEnd - live.outStart, { fraction: true });
  }

  function render() {
    const { project: p, tl } = view();
    const layout = clipLayout(p, tl);
    // Fitted, the scale follows the video's length -- but not mid-drag, where
    // the pointer would then mean a different moment on every move.
    if (fitted && !drag) pps = Math.min(MAX_PPS, fitPps());
    content.style.width = `${Math.max(scroller.clientWidth, x(duration()) + PAD)}px`;
    renderClips(p, layout);
    renderTrim(layout);
    renderSpeed(p, layout);
    renderZooms(p, layout);
    musicLanes.render();
    overlayLanes.render();
    // Rows with nothing on them stay out of the way until they are needed.
    overlayLanes.track.hidden = overlayLanes.label.hidden = !(p.overlays ?? []).length;
    musicLanes.track.hidden = musicLanes.label.hidden = !p.audio.clips.length;
    visuals.track.hidden = visuals.label.hidden = !p.annotations.length;
    renderMarks();
    renderMarkers(p);
    visuals.render(p, layout, clipsTrack);
    captions.render(p, layout);
    movePlayhead(playheadTime());
    drawRuler();
    drawStrips();
  }

  // The pictures along each clip, for the part of the timeline in view (and
  // a screen either side, so scrolling finds them ready).
  function drawStrips() {
    if (!thumbnails) return;
    const { project: p, tl } = view();
    const layout = clipLayout(p, tl);
    const w = scroller.clientWidth;
    const viewStart = scroller.scrollLeft - w;
    const viewEnd = scroller.scrollLeft + 2 * w;
    for (const el of clipsTrack.querySelectorAll('.clip')) {
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

  function renderMarks() {
    const on = (t) => t !== null && t !== undefined;
    inFlag.hidden = !on(marks.in);
    outFlag.hidden = !on(marks.out);
    if (on(marks.in)) inFlag.style.left = `${x(marks.in)}px`;
    if (on(marks.out)) outFlag.style.left = `${x(marks.out)}px`;
    const both = on(marks.in) && on(marks.out);
    marksShade.hidden = !both;
    if (both) {
      marksShade.style.left = `${x(marks.in)}px`;
      marksShade.style.width = `${Math.max(1, (marks.out - marks.in) * pps)}px`;
    }
  }

  function renderMarkers(p) {
    const sel = store.selected;
    // The name beside the flag, not in it: the flag's shape would clip it.
    markersLayer.replaceChildren(...(p.markers ?? []).flatMap((m) => [h('div', {
      class: `marker-flag ${m.color}${hasItem(sel, { kind: 'marker', id: m.id }) ? ' selected' : ''}`,
      dataset: { id: m.id }, style: { left: `${x(m.t)}px` },
      title: `${m.label || 'Marker'} · ${formatTime(m.t, { fraction: true })}\nClick to go there, drag to move, double-click to name it`
    }), m.label ? h('span', { class: 'marker-label', style: { left: `${x(m.t) + 8}px` } }, m.label) : null].filter(Boolean)));
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
    const startY = e.clientY;
    drag = {
      moved: false,
      // The last event with the button down: where a drag whose release
      // went missing ends.
      last: e,
      move(ev) {
        this.last = ev;
        // Any direction: an audio clip dragged straight down to another row moves.
        if (!this.moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_PX) return;
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

  // A marker: click to go there, drag to move it, double-click to name it.
  let lastMarkerPress = null;
  function markerDrag(e, id) {
    const p0 = store.project;
    const m0 = p0.markers.find((m) => m.id === id);
    editor.select({ kind: 'marker', id });
    const now = performance.now();
    if (lastMarkerPress?.id === id && now - lastMarkerPress.at < 450) {
      lastMarkerPress = null;
      e.preventDefault();
      editor.editMarker?.(id);
      return;
    }
    lastMarkerPress = { id, at: now };
    const points = snapsWithBeats(p0, clipLayout(p0, store.tl), { playhead: player.time }).filter((t) => Math.abs(t - m0.t) > 1e-6);
    beginDrag(e, {
      move(ev) {
        const t = snapped(timeAt(ev.clientX), points);
        store.apply(() => P.updateMarker(p0, id, { t }), { gesture: `marker:${id}` });
      },
      click: () => player.seek(m0.t)
    });
  }

  function clipDrag(e, el) {
    const i = Number(el.dataset.index);
    const p0 = store.project;
    const layout0 = clipLayout(p0, store.tl);
    const L = layout0[i];
    const clip = L.clip;
    const edge = e.target.dataset?.edge;
    editor.select({ kind: 'clip', id: clip.id });
    // A freeze frame's edges set how long it holds.
    if (edge && clip.hold > 0) {
      beginDrag(e, {
        move(ev) {
          const o = timeAt(ev.clientX, { clampToVideo: false });
          const len = edge === 'end' ? o - L.outStart : L.outEnd - o;
          store.apply(() => P.setHold(p0, clip.id, clamp(len, 0.1, 3600)), { gesture: `hold:${clip.id}` });
        },
        click: (ev) => player.seek(timeAt(ev.clientX))
      });
      return;
    }
    // A reversed clip plays from its end: its left edge trims the recording's
    // end and its right edge the start, applied live.
    if (edge && clip.reverse) {
      beginDrag(e, {
        move(ev) {
          const o = timeAt(ev.clientX, { clampToVideo: false });
          if (edge === 'start') {
            const t = o >= L.outStart ? sourceInClip(p0, layout0, i, o) : clip.end + (L.outStart - o);
            store.apply(() => P.trimEnd(p0, clip.id, t), { gesture: `trim:${clip.id}:start` });
          } else {
            const t = o <= L.outEnd ? sourceInClip(p0, layout0, i, o) : clip.start - (o - L.outEnd);
            store.apply(() => P.trimStart(p0, clip.id, t), { gesture: `trim:${clip.id}:end` });
          }
        },
        click: (ev) => player.seek(timeAt(ev.clientX))
      });
      return;
    }
    if (edge) {
      const rest = snapsWithBeats(p0, layout0, { playhead: player.time }).filter((t) => Math.abs(t - (edge === 'start' ? L.outStart : L.outEnd)) > 1e-6);
      const tl0 = store.tl;
      const unfreeze = () => { frozen = null; };
      beginDrag(e, {
        start() {
          frozen = { project: p0, tl: tl0, clipIndex: i, edge, at: edge === 'start' ? L.outStart : L.outEnd };
        },
        move(ev) {
          const o = snapped(timeAt(ev.clientX, { clampToVideo: false }), rest);
          const t = edge === 'start'
            ? (o >= L.outStart ? sourceInClip(p0, layout0, i, o) : clip.start - (L.outStart - o))
            : (o <= L.outEnd ? sourceInClip(p0, layout0, i, o) : clip.end + (o - L.outEnd));
          let next;
          try {
            next = edge === 'start' ? P.trimStart(p0, clip.id, t) : P.trimEnd(p0, clip.id, t);
          } catch {
            return; // too short to trim: the edge stays where it was
          }
          const c = next.clips[i];
          // Out past where it was: footage coming back, shown live.
          frozen.restoring = edge === 'start' ? c.start < clip.start - 1e-9 : c.end > clip.end + 1e-9;
          if (frozen.restoring) {
            const nextLayout = clipLayout(next, buildTimeline(next));
            const n = nextLayout[i];
            frozen.at = edge === 'start' ? n.outStart : n.outEnd;
            // Where the old edge sits now, the far side of what came back.
            frozen.oldEdge = outputInClip(next, nextLayout, i, edge === 'start' ? clip.start : clip.end);
          } else {
            // Where the edge really went (the core clamps to the recording
            // and to the shortest clip), on the timeline as it was.
            frozen.at = outputAtSource(p0, layout0, i, edge === 'start' ? c.start : c.end);
          }
          store.apply(() => next, { gesture: `trim:${clip.id}:${edge}` });
          // The preview shows the frame at the edge being dragged.
          const now = store.tl.clipBounds()[i];
          player.seek(edge === 'start' ? now.outStart : now.outEnd - 1e-3);
          movePlayhead(frozen.at);
        },
        end: unfreeze,
        click: (ev) => { unfreeze(); player.seek(timeAt(ev.clientX)); }
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
    const points = snapsWithBeats(p0, layout0, { playhead: player.time });
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
    const points = snapsWithBeats(p0, layout0, { playhead: player.time, exceptZoom: z0.id });
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
    const ghost = clipsTrack.querySelector('.speed-ghost');
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
    const trackRect = clipsTrack.getBoundingClientRect();
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

  // ---- selecting several things

  const ITEM_KINDS = [['.clip', 'clip'], ['.zoom', 'zoom'], ['.aclip', 'audio'], ['.oclip', 'overlay'], ['.anno-bar', 'annotation'], ['.caption', 'caption']];
  // The timeline item an element belongs to, as a selection item, or null.
  function itemOf(target) {
    for (const [selector, kind] of ITEM_KINDS) {
      const el = target.closest?.(selector);
      if (el?.dataset.id) return { kind, id: el.dataset.id };
    }
    return null;
  }

  // Every item's rectangle on screen (a zoom or annotation cut in two by a
  // clip join has two).
  function itemRects() {
    const rects = [];
    for (const [selector, kind] of ITEM_KINDS) {
      for (const el of content.querySelectorAll(selector)) {
        if (!el.dataset.id) continue;
        const r = el.getBoundingClientRect();
        rects.push({ item: { kind, id: el.dataset.id }, x0: r.left, x1: r.right, y0: r.top, y1: r.bottom });
      }
    }
    return rects;
  }

  // A press on empty space: a click goes there; a drag draws a box and
  // selects what it touches.
  function boxSelect(e) {
    const x0 = e.clientX;
    const y0 = e.clientY;
    beginDrag(e, {
      move(ev) {
        const r = content.getBoundingClientRect();
        boxEl.hidden = false;
        boxEl.style.left = `${Math.min(x0, ev.clientX) - r.left}px`;
        boxEl.style.top = `${Math.min(y0, ev.clientY) - r.top}px`;
        boxEl.style.width = `${Math.abs(ev.clientX - x0)}px`;
        boxEl.style.height = `${Math.abs(ev.clientY - y0)}px`;
        store.selectMany(boxHits(itemRects(), { x0, y0, x1: ev.clientX, y1: ev.clientY }));
      },
      end() { boxEl.hidden = true; },
      click(ev) {
        editor.select(null);
        player.seek(timeAt(ev.clientX));
      }
    });
  }

  // ---- a zoom's right-click menu

  function openZoomMenu(id, clientX, clientY) {
    const z = store.project.zooms.find((q) => q.id === id);
    if (!z) return;
    if (!hasItem(store.selected, { kind: 'zoom', id })) editor.select({ kind: 'zoom', id });
    const item = (itemId, name, label, run) => h('button', {
      type: 'button', role: 'menuitem', class: 'tool-menu-item', id: itemId,
      onclick: () => { closeZoomMenu(); run(); }
    }, icon(name, { size: 16 }), h('span', {}, label));
    zoomMenu.replaceChildren(
      item('zoomToggle', z.disabled ? 'check' : 'close', z.disabled ? 'Switch on' : 'Switch off',
        () => store.apply((p) => P.updateZoom(p, id, { disabled: !z.disabled }))),
      z.auto ? item('zoomManual', 'target', 'Make it mine (keep when zooms are remade)',
        () => store.apply((p) => P.updateZoom(p, id, { auto: false }))) : null,
      item('zoomRemove', 'trash', 'Remove', () => store.apply((p) => P.removeZoom(p, id))));
    zoomMenu.hidden = false;
    const r = root.getBoundingClientRect();
    zoomMenu.style.left = `${clamp(clientX - r.left, 8, r.width - zoomMenu.offsetWidth - 8)}px`;
    zoomMenu.style.top = `${Math.max(8, clientY - r.top - zoomMenu.offsetHeight - 6)}px`;
  }

  function closeZoomMenu() {
    zoomMenu.hidden = true;
  }

  // Everything on the timeline (⌘A).
  function selectAll() {
    const p = store.project;
    store.selectMany([
      ...p.clips.map((c) => ({ kind: 'clip', id: c.id })),
      ...p.zooms.map((z) => ({ kind: 'zoom', id: z.id })),
      ...p.annotations.map((a) => ({ kind: 'annotation', id: a.id })),
      ...p.overlays.map((o) => ({ kind: 'overlay', id: o.id })),
      ...p.audio.clips.map((c) => ({ kind: 'audio', id: c.id })),
      ...p.captions.segments.map((c) => ({ kind: 'caption', id: c.id }))
    ]);
  }

  // ---- events

  content.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    closeZoomMenu();
    // ⌘-click (Ctrl on Windows) or ⇧-click: this one as well as the others.
    if ((e.metaKey || e.ctrlKey || e.shiftKey) && !e.altKey && !e.target.dataset?.edge) {
      const item = itemOf(e.target);
      if (item) {
        e.preventDefault();
        visuals.closeMenu();
        closeMenu();
        store.select(item, { toggle: true });
        return;
      }
    }
    if (visuals.pointerdown(e)) return;
    visuals.closeMenu();
    if (musicLanes.pointerdown(e)) return;
    if (overlayLanes.pointerdown(e)) return;
    const flag = e.target.closest('.marker-flag');
    if (flag) { markerDrag(e, flag.dataset.id); return; }
    const clip = e.target.closest('.clip');
    const zoom = e.target.closest('.zoom');
    const speed = e.target.closest('.speed');
    if (e.target === ruler || e.target.closest('.tl-playhead')) scrub(e);
    else if (speed) speedDrag(e, speed);
    // ⌥-drag across a clip speeds that part up or slows it down.
    else if (clip && e.altKey && !P.isGap(store.project.clips[Number(clip.dataset.index)])) speedDrag(e, null);
    else if (clip) clipDrag(e, clip);
    else if (zoom) zoomDrag(e, zoom);
    else if (e.target.closest('.tl-zooms')) zoomCreate(e);
    else if (e.target.closest('.caption')) captions.pointerdown(e);
    else boxSelect(e);
  });
  content.addEventListener('contextmenu', (e) => {
    const zoom = e.target.closest('.zoom');
    if (!zoom) return;
    e.preventDefault();
    openZoomMenu(zoom.dataset.id, e.clientX, e.clientY);
  });
  const finish = (e) => {
    const d = drag;
    drag = null;
    d?.end(e);
    frozen = null;
    if (d) render();
  };
  // Only a held button drags. A release this page never heard about (let go
  // outside the window, or while something else had the mouse) would
  // otherwise leave the drag running, and the playhead or a clip edge would
  // follow the mouse as it merely passes over the timeline: the drag ends
  // where the button was last down instead.
  content.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if ((e.buttons & 1) === 0) finish(drag.last);
    else drag.move(e);
  });
  content.addEventListener('pointerup', finish);
  content.addEventListener('pointercancel', finish);
  // (Losing pointer capture doesn't end a drag: Chromium drops it when
  // another window takes the focus, with the button still held. The moves
  // still arrive here; a release that went missing shows as a move with no
  // button, above.)
  content.addEventListener('dblclick', (e) => {
    if (visuals.dblclick(e)) return;
    const zoom = e.target.closest('.zoom');
    if (!zoom) return;
    editor.select({ kind: 'zoom', id: zoom.dataset.id });
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest?.('.speed, .clip')) closeMenu();
    if (!zoomMenu.hidden && !zoomMenu.contains(e.target)) closeZoomMenu();
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
    // Mid-trim the playhead sits on the dragged edge, on the frozen timeline.
    if (frozen) return;
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
    closeMenu: () => { closeMenu(); closeZoomMenu(); visuals.closeMenu(); },
    get menuOpen() { return !menu.hidden || !zoomMenu.hidden || visuals.menuOpen; },
    openZoomMenu,
    visuals,
    redrawPictures: drawStripsSoon,
    get pxPerSecond() { return pps; },
    setSnap(on) { snapOn = Boolean(on); },
    get snap() { return snapOn; },
    selectAll,
    // In/Out marks: { in, out } in output seconds (null when not set).
    get marks() { return { ...marks }; },
    setMark(which, t) {
      marks = { ...marks, [which]: t };
      // An Out before the In (or the other way) starts again from this one.
      if (marks.in !== null && marks.out !== null && marks.out <= marks.in) marks = { in: which === 'in' ? t : null, out: which === 'out' ? t : null };
      renderMarks();
    },
    clearMarks() {
      marks = { in: null, out: null };
      renderMarks();
    },
    // For tests: the pixel x (in client coordinates) of output time t.
    clientX: (t) => content.getBoundingClientRect().left + x(t),
    render
  };
}
