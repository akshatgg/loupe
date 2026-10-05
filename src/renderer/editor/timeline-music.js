// The timeline's audio rows, under the Sound strip: every song or sound file
// (project.audio.clips, core/audio/clips.js) as a block where it plays, on
// its row, with its waveform and fades -- as audio clips look in CapCut or
// Final Cut. Click a block to select it (the Audio panel shows its
// settings); drag it to move it, up or down to another row; drag its ends
// to trim it; drag the small knobs at its top corners to fade it in or out;
// hold ⌥ (Alt) while dragging to move a copy. The line across a block is its
// volume: drag it up or down; ⌥-click it to add a point, drag points to
// shape the volume over time, double-click one to remove it. Each row has
// Mute, Solo and Lock beside its name. Songs with beat marks on show them as
// ticks, and drags snap to them.
//
//   createMusicLanes({ store, player, editor, view })
//     -> { label, track, render(), pointerdown(e), beatTimes() }
//
// `view` is the timeline's geometry and drag machinery:
//   { x(t), pps, timeAt(clientX, opts), shown(), beginDrag(e, handlers),
//     snapPoints(), snap(t, points), showGuide(t) }

import { hasItem } from './selection.js';
import * as P from '../../core/project.js';
import { clipLength, clipEnd, clipGainAt, shiftPoints, laneOf, MAX_LANES, MIN_AUDIO_SECONDS } from '../../core/audio/clips.js';
import { h, icon } from './ui.js';
import { clamp, formatTime } from './timeline-math.js';
import { peakBetween } from './audio-math.js';

export const ROW_HEIGHT = 34;
// Volume line: 0 at the block's bottom, 200% at its top.
const MAX_GAIN = 2;
// How close (px) a press must be to the volume line or a point to grab it.
const LINE_PX = 4;
const POINT_PX = 6;
// Widest a block's waveform canvas is drawn; wider blocks stretch it.
const MAX_WAVE_PX = 4096;

export function createMusicLanes({ store, player, editor, view }) {
  const track = h('div', { class: 'tl-track tl-music', 'aria-label': 'Audio' });
  const label = h('div', { class: 'tl-music-labels' });
  let labelRows = 0;
  let labelLanes = '';

  // A row's name with its Mute, Solo and Lock buttons.
  function rowLabel(p, i) {
    const lane = laneOf(p.audio, i);
    const btn = (key, text, on, title) => h('button', {
      type: 'button', class: `lane-btn ${key}${on ? ' on' : ''}`, dataset: { lane: String(i), key },
      'aria-pressed': String(on), title, 'aria-label': title,
      onclick: (e) => {
        e.stopPropagation();
        store.apply((q) => P.setAudioLane(q, i, { [key]: !laneOf(q.audio, i)[key] }));
      }
    }, text);
    return h('div', { class: `tl-label lbl-music${lane.locked ? ' locked' : ''}` },
      h('span', { class: 'lane-name' }, `A${i + 1}`),
      btn('muted', 'M', lane.muted, lane.muted ? `Unmute audio row ${i + 1}` : `Mute audio row ${i + 1}`),
      btn('solo', 'S', lane.solo, lane.solo ? `Stop soloing audio row ${i + 1}` : `Solo audio row ${i + 1}: hear only it`),
      btn('locked', lane.locked ? icon('lock', { size: 11 }) : icon('unlock', { size: 11 }), lane.locked,
        lane.locked ? `Unlock audio row ${i + 1}` : `Lock audio row ${i + 1} so its clips can\u2019t be changed`));
  }
  // While a block is dragged down, one more (empty) row shows to drop it on.
  let dragRows = 0;
  // The last press on a volume point, for double-clicks.
  let lastPointPress = null;

  const rowsFor = (p) => Math.max(1, dragRows, ...p.audio.clips.map((c) => c.lane + 1));

  function render() {
    const { project: p, tl } = view.shown();
    const duration = tl.duration;
    const rows = rowsFor(p);
    track.style.height = `${rows * ROW_HEIGHT}px`;
    label.style.height = `${rows * ROW_HEIGHT}px`;
    const laneKey = JSON.stringify(Array.from({ length: rows }, (_, i) => laneOf(p.audio, i)));
    if (rows !== labelRows || laneKey !== labelLanes) {
      labelRows = rows;
      labelLanes = laneKey;
      label.replaceChildren(...Array.from({ length: rows }, (_, i) => rowLabel(p, i)));
    }
    const sel = store.selected;
    const els = [];
    for (let i = 0; i < rows; i++) els.push(h('div', { class: 'aclip-row', style: { top: `${i * ROW_HEIGHT}px` } }));
    for (const clip of p.audio.clips) els.push(block(clip, duration, hasItem(sel, { kind: 'audio', id: clip.id })));
    if (!p.audio.clips.length) {
      els.push(h('div', { class: 'tl-hint' }, 'Add songs or sounds with the Add button, or drop audio files on the window'));
    }
    track.replaceChildren(...els);
  }

  function block(clip, duration, selected) {
    const length = clipLength(clip, duration);
    const width = Math.max(4, length * view.pps);
    const inner = ROW_HEIGHT - 4;
    const wave = h('canvas', { class: 'aclip-wave', 'aria-hidden': 'true' });
    const p = view.shown().project;
    const lane = laneOf(p.audio, clip.lane);
    const soloed = (p.audio.lanes ?? []).some((l) => l?.solo);
    const silent = clip.muted || lane.muted || (soloed && !lane.solo);
    const el = h('div', {
      class: `aclip${selected ? ' selected' : ''}${silent ? ' muted' : ''}${lane.locked ? ' locked' : ''}${clip.source ? ' source' : ''}`,
      dataset: { id: clip.id },
      style: { left: `${view.x(clip.start)}px`, width: `${width}px`, top: `${clip.lane * ROW_HEIGHT + 2}px`, height: `${inner}px` },
      title: `${clip.name || 'Audio'} · ${formatTime(clip.start, { fraction: true })}–${formatTime(clip.start + length, { fraction: true })}` +
        (lane.locked ? '\nIts row is locked' : '\nDrag to move (⌥ for a copy), drag the ends to trim, the top corners to fade,' +
          '\nthe line to change its volume (⌥-click it for a point)')
    },
    wave,
    h('span', { class: 'aclip-name' }, clip.muted ? icon('close', { size: 11 }) : null, clip.name || 'Audio'),
    h('div', { class: 'handle start', dataset: { edge: 'start' } }),
    h('div', { class: 'handle end', dataset: { edge: 'end' } }),
    h('div', { class: 'fade-knob in', dataset: { fade: 'in' }, style: { left: `${Math.min(width - 6, clip.fadeIn * view.pps)}px` }, title: 'Drag to fade in' }),
    h('div', { class: 'fade-knob out', dataset: { fade: 'out' }, style: { right: `${Math.min(width - 6, clip.fadeOut * view.pps)}px` }, title: 'Drag to fade out' }));
    drawWave(wave, clip, length, width, inner);
    return el;
  }

  // The file's waveform along the block (repeating when the clip repeats),
  // with its fades shaded.
  function drawWave(canvas, clip, length, width, height) {
    const w = Math.max(1, Math.min(MAX_WAVE_PX, Math.round(width)));
    canvas.width = w;
    canvas.height = height;
    canvas.style.width = `${width}px`;
    const ctx = canvas.getContext('2d');
    // Detached video sound: the recording's own waveform (in its time).
    const peaks = clip.source ? player.audio?.peaks(clip.source) : player.audio?.file('music', clip.file)?.peaks;
    const span = clip.fileDuration > 0 ? clip.fileDuration - clip.from : Infinity;
    if (peaks) {
      const max = Math.max(1e-3, peakBetween(peaks, 0, Infinity));
      const perPx = length / w;
      ctx.fillStyle = clip.source ? 'rgba(178, 235, 242, 0.55)' : 'rgba(233, 210, 253, 0.55)';
      for (let px = 0; px < w; px++) {
        let at = px * perPx;
        if (clip.loop && Number.isFinite(span) && span > 0) at %= span;
        const t0 = clip.from + at;
        const v = Math.sqrt(peakBetween(peaks, t0, t0 + perPx) / max);
        const bar = Math.max(1, v * (height - 10));
        ctx.fillRect(px, height / 2 - bar / 2 + 3, 1, bar);
      }
    }
    // Fades: the part above the ramp is shaded, like a volume line falling
    // to nothing at the clip's edge.
    const k = w / Math.max(1e-6, length);
    ctx.fillStyle = 'rgba(20, 16, 28, 0.55)';
    if (clip.fadeIn > 0) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(clip.fadeIn * k, 0);
      ctx.lineTo(0, height);
      ctx.fill();
    }
    if (clip.fadeOut > 0) {
      ctx.beginPath();
      ctx.moveTo(w, 0);
      ctx.lineTo(w - clip.fadeOut * k, 0);
      ctx.lineTo(w, height);
      ctx.fill();
    }
    // Beat marks: a tick at the top for each beat of the song in the clip.
    const beats = clip.beats && !clip.source ? player.audio?.file('music', clip.file)?.beats?.beats : null;
    if (beats?.length) {
      ctx.fillStyle = 'rgba(255, 236, 150, 0.9)';
      for (const t of beatOffsets(clip, beats, length)) ctx.fillRect(Math.round(t * k) - 0.5, 0, 1.5, 5);
    }
    // The volume line, and its points.
    const y = (g) => height - 2 - (Math.min(MAX_GAIN, g) / MAX_GAIN) * (height - 4);
    ctx.strokeStyle = 'rgba(255, 244, 180, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const pts = clip.points ?? [];
    if (!pts.length) {
      ctx.moveTo(0, y(clip.volume));
      ctx.lineTo(w, y(clip.volume));
    } else {
      ctx.moveTo(0, y(pts[0].gain));
      for (const pt of pts) ctx.lineTo(pt.t * k, y(pt.gain));
      ctx.lineTo(w, y(pts.at(-1).gain));
    }
    ctx.stroke();
    ctx.fillStyle = '#fff4b4';
    for (const pt of pts) {
      ctx.beginPath();
      ctx.arc(pt.t * k, y(pt.gain), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Seconds into the clip of each beat of its song that plays in it.
  function beatOffsets(clip, beats, length) {
    const span = clip.fileDuration > 0 ? clip.fileDuration - clip.from : Infinity;
    const out = [];
    for (let pass = 0; pass * span < length && pass < 1000; pass++) {
      for (const b of beats) {
        const t = pass * span + (b - clip.from);
        if (b >= clip.from && t >= 0 && t <= length) out.push(t);
      }
      if (!clip.loop || !Number.isFinite(span)) break;
    }
    return out;
  }

  // Output times of the beats of every clip showing them: drags snap here.
  function beatTimes() {
    const { project: p, tl } = view.shown();
    const out = [];
    for (const clip of p.audio.clips) {
      const beats = clip.beats && !clip.source ? player.audio?.file('music', clip.file)?.beats?.beats : null;
      if (!beats?.length) continue;
      for (const t of beatOffsets(clip, beats, clipLength(clip, tl.duration))) out.push(clip.start + t);
    }
    return out;
  }

  // Handles a press on the audio rows; false when it isn't on a block (the
  // timeline then scrubs as anywhere else).
  function pointerdown(e) {
    if (!track.contains(e.target)) return false;
    const el = e.target.closest('.aclip');
    if (!el) {
      store.select(null);
      return false;
    }
    let p0 = store.project;
    let id = el.dataset.id;
    const d = store.tl.duration;
    let edge = e.target.dataset?.edge;
    const fade = e.target.dataset?.fade;
    // Measured before selecting: selecting redraws the rows, and `el` with them.
    const pressX = e.clientX - el.getBoundingClientRect().left;
    const hit = !edge && !fade ? lineHit(el, p0.audio.clips.find((c) => c.id === id), d, e) : null;
    editor.select({ kind: 'audio', id });
    const lane0 = laneOf(p0.audio, p0.audio.clips.find((c) => c.id === id).lane);
    if (lane0.locked) {
      // Selected (to see its settings), but not moved.
      e.preventDefault();
      editor.toast('This audio row is locked. Unlock it (the lock beside its name) to change its clips.');
      return true;
    }
    // On the volume line or one of its points? A point pressed twice in a
    // row, quickly, is removed (a double-click; pointer capture sends the
    // browser's own dblclick elsewhere).
    if (hit?.point !== undefined) {
      const now = performance.now();
      const again = lastPointPress && lastPointPress.id === id && lastPointPress.point === hit.point && now - lastPointPress.at < 450;
      lastPointPress = again ? null : { id, point: hit.point, at: now };
      if (again) {
        e.preventDefault();
        const c = p0.audio.clips.find((q) => q.id === id);
        store.apply(() => P.updateAudioClip(p0, id, { points: c.points.filter((_, k) => k !== hit.point) }));
        return true;
      }
    }
    if (hit) edge = 'volume';
    // ⌥-drag moves a copy, leaving the original where it was.
    let copied = false;
    const gesture = () => `audio:${id}:${edge ?? fade ?? 'move'}`;
    const c0 = () => p0.audio.clips.find((c) => c.id === id);
    const start0 = c0().start;
    const len0 = clipLength(c0(), d);
    const others = () => p0.audio.clips.filter((c) => c.id !== id).flatMap((c) => [c.start, clipEnd(c, d)]);
    const points = () => [...view.snapPoints(), ...others()];
    const rowsTop = track.getBoundingClientRect().top;
    const change = (patch) => store.apply(() => P.updateAudioClip(p0, id, patch), { gesture: gesture() });

    view.beginDrag(e, {
      move(ev) {
        const dt = (ev.clientX - e.clientX) / view.pps;
        const clip = c0();
        if (edge === 'volume') {
          dragVolume(ev, clip, hit, change);
        } else if (edge === 'start') {
          // The left end: later start, later into the song; the right end stays.
          let at = view.snapped(clip.start + dt, points());
          const s = clamp(at - clip.start, Math.max(-clip.start, -clip.from), len0 - MIN_AUDIO_SECONDS);
          at = clip.start + s;
          change({
            start: at, from: clip.from + s,
            length: clip.length === null ? null : clip.length - s,
            fadeIn: Math.min(clip.fadeIn, len0 - s - clip.fadeOut),
            points: shiftPoints(clip.points, s)
          });
        } else if (edge === 'end') {
          const most = !clip.loop && clip.fileDuration > 0 ? clip.fileDuration - clip.from : Infinity;
          const end = view.snapped(clip.start + len0 + dt, points());
          const length = clamp(end - clip.start, MIN_AUDIO_SECONDS, most);
          change({ length, fadeOut: Math.min(clip.fadeOut, length - clip.fadeIn), points: clip.points.filter((q) => q.t <= length) });
        } else if (fade === 'in') {
          const t = clamp(clip.fadeIn + dt, 0, len0 - clip.fadeOut);
          change({ fadeIn: Math.round(t * 20) / 20 });
        } else if (fade === 'out') {
          const t = clamp(clip.fadeOut - dt, 0, len0 - clip.fadeIn);
          change({ fadeOut: Math.round(t * 20) / 20 });
        } else {
          if (ev.altKey && !copied) {
            copied = true;
            const next = store.apply(() => P.duplicateAudioClip(p0, id), { gesture: `audio:${id}:copy` });
            if (next) {
              p0 = next;
              id = next.audio.clips.at(-1).id;
              editor.select({ kind: 'audio', id });
            }
          }
          const lane = clamp(Math.floor((ev.clientY - rowsTop) / ROW_HEIGHT), 0, MAX_LANES - 1);
          dragRows = Math.min(MAX_LANES, lane + 1);
          // Whichever end is nearer something to snap to.
          let start = Math.max(0, start0 + dt);
          const s = view.snap(start, points());
          const e2 = view.snap(start + len0, points());
          if (s !== start && (e2 === start + len0 || Math.abs(s - start) <= Math.abs(e2 - start - len0))) start = s;
          else if (e2 !== start + len0) start = Math.max(0, e2 - len0);
          view.showGuide(start !== Math.max(0, start0 + dt) ? (Math.abs(start - s) < 1e-9 ? start : start + len0) : null);
          change({ start, lane });
        }
      },
      end() {
        dragRows = 0;
        render();
      },
      click() {
        dragRows = 0;
        // ⌥-click on the line: a new volume point there, at the line's level.
        if (edge === 'volume' && e.altKey && hit.point === undefined) {
          const clip = c0();
          const t = clamp(pressX / view.pps, 0, len0);
          const pts = clip.points.length ? clip.points : [];
          store.apply(() => P.updateAudioClip(p0, id, { points: [...pts, { t: Math.round(t * 100) / 100, gain: clipGainAt(clip, t) }] }));
        }
      }
    });
    return true;
  }

  // Where a press on block `el` meets its volume line: { point: i } on a
  // point, {} on the line itself, or null.
  function lineHit(el, clip, d, e) {
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const height = r.height;
    const yOf = (g) => height - 2 - (Math.min(MAX_GAIN, g) / MAX_GAIN) * (height - 4);
    const i = (clip.points ?? []).findIndex((pt) => Math.hypot(pt.t * view.pps - x, yOf(pt.gain) - y) <= POINT_PX);
    if (i >= 0) return { point: i, height };
    const t = x / view.pps;
    if (t < 0 || t > clipLength(clip, d)) return null;
    return Math.abs(yOf(clipGainAt(clip, t)) - y) <= LINE_PX ? { height } : null;
  }

  // Dragging the volume line (the whole clip's volume, or every point by
  // the same amount) or one point (its time and level).
  function dragVolume(ev, clip, hit, change) {
    const r = [...track.querySelectorAll('.aclip')].find((b) => b.dataset.id === clip.id)?.getBoundingClientRect();
    if (!r) return;
    const gainOf = (clientY) => clamp(((r.bottom - 2 - clientY) / (hit.height - 4)) * MAX_GAIN, 0, MAX_GAIN);
    const g = Math.round(gainOf(ev.clientY) * 100) / 100;
    if (hit.point !== undefined) {
      const len = clipLength(clip, store.tl.duration);
      const pts = clip.points.slice();
      const lo = hit.point > 0 ? pts[hit.point - 1].t : 0;
      const hi = hit.point < pts.length - 1 ? pts[hit.point + 1].t : len;
      const t = clamp((ev.clientX - r.left) / view.pps, lo, hi);
      pts[hit.point] = { t: Math.round(t * 100) / 100, gain: g };
      change({ points: pts });
    } else if (clip.points.length) {
      // The line between points moves them all, keeping their shape.
      const t = clamp((ev.clientX - r.left) / view.pps, 0, clipLength(clip, store.tl.duration));
      const was = Math.max(1e-3, clipGainAt(clip, t));
      const k = g / was;
      change({ points: clip.points.map((pt) => ({ ...pt, gain: clamp(Math.round(pt.gain * k * 100) / 100, 0, MAX_GAIN) })) });
    } else {
      change({ volume: g });
    }
  }

  // Waveforms arrive as the files are decoded.
  player.audio?.onState(() => render());

  // Cursors: a line or point to grab shows it.
  track.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    const el = e.target.closest?.('.aclip');
    if (!el || e.target.dataset?.edge || e.target.dataset?.fade) { if (el) el.style.cursor = ''; return; }
    const clip = store.project.audio.clips.find((c) => c.id === el.dataset.id);
    const hit = clip && !laneOf(store.project.audio, clip.lane).locked ? lineHit(el, clip, store.tl.duration, e) : null;
    el.style.cursor = !clip ? '' : laneOf(store.project.audio, clip.lane).locked ? 'not-allowed'
      : hit?.point !== undefined ? 'move' : hit ? 'ns-resize' : '';
  });

  return { label, track, render, pointerdown, beatTimes };
}
