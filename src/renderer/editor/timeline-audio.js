// The timeline's sound strip, under the clips: each clip's recorded sound
// (microphone and computer sound) as a waveform where it plays, voiceover
// takes as blue blocks at their moments, and a purple line along the bottom
// while there is music. Drag a take to move it; click one to jump to it.
//
//   createAudioLane({ store, player, editor, view }) -> { label, track, draw() }
//
// `view` is the timeline's geometry: { x(t), pps, scroller }. Only the part
// in view is drawn, on one canvas the width of the timeline's window, so a
// long recording zoomed in doesn't need a canvas thousands of pixels wide.

import * as P from '../../core/project.js';
import { anchorAt } from '../../core/audio/voiceover.js';
import { h, icon } from './ui.js';
import { clipLayout, sourceInClip, clamp } from './timeline-math.js';
import { peakBetween } from './audio-math.js';

const HEIGHT = 40;
const DRAG_PX = 4;
const TAKE_MIN_SECONDS = 0.5;

export function createAudioLane({ store, player, editor, view }) {
  const canvas = h('canvas', { class: 'tl-audio-canvas' });
  const track = h('div', { class: 'tl-track tl-audio', 'aria-label': 'Sound' }, canvas);
  const label = h('div', { class: 'tl-label lbl-audio' }, icon('audio', { size: 15 }), 'Sound');
  let boxes = []; // takes as drawn: { take, x0, x1 }

  const audio = () => player.audio;

  function takeLength(take) {
    return Math.max(TAKE_MIN_SECONDS, audio()?.file('take', take.file)?.duration || 1);
  }

  function draw() {
    const { scroller, pps } = view;
    const w = scroller.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${HEIGHT}px`;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== HEIGHT * dpr) {
      canvas.width = Math.round(w * dpr);
      canvas.height = HEIGHT * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, HEIGHT);
    const left = scroller.scrollLeft;
    const p = store.project;
    const tl = store.tl;
    const layout = clipLayout(p, tl);
    const sx = (t) => view.x(t) - left;
    const mid = HEIGHT / 2 - 2;
    const muted = p.audio.mic.muted && p.audio.system.muted;

    // Recorded sound per clip.
    for (const [i, l] of layout.entries()) {
      const a = Math.max(0, Math.floor(sx(l.outStart)));
      const b = Math.min(w, Math.ceil(sx(l.outEnd)));
      if (b <= a) continue;
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      roundRect(ctx, sx(l.outStart) + 1, 3, Math.max(1, (l.outEnd - l.outStart) * pps - 2), HEIGHT - 6, 6);
      ctx.fill();
      const peaks = audio()?.peaks(l.clip.source);
      if (!peaks) continue;
      const max = Math.max(1e-3, peakBetween(peaks, 0, Infinity));
      ctx.fillStyle = muted ? 'rgba(232,234,237,0.12)' : 'rgba(232,234,237,0.38)';
      const at = (px) => sourceInClip(p, layout, i, (px + left - view.x(0)) / pps);
      let prev = at(a);
      for (let px = a; px < b; px++) {
        const next = at(px + 1);
        const v = Math.sqrt(peakBetween(peaks, Math.min(prev, next), Math.max(prev, next)) / max);
        const bar = Math.max(1, v * (HEIGHT - 12));
        ctx.fillRect(px, mid - bar / 2, 1, bar);
        prev = next;
      }
    }

    // Music along the whole video.
    if (p.audio.music) {
      ctx.fillStyle = 'rgba(197, 138, 249, 0.75)';
      const a = Math.max(0, sx(0));
      const b = Math.min(w, sx(tl.duration));
      if (b > a) {
        roundRect(ctx, a + 1, HEIGHT - 6, b - a - 2, 4, 2);
        ctx.fill();
        // Its name where the line starts in view, so the line reads as music.
        const name = String(p.audio.music.file ?? '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
        if (name && b - a > 60) {
          ctx.font = '600 10.5px system-ui, sans-serif';
          ctx.textBaseline = 'top';
          const text = `♪ ${name}`;
          const width = Math.min(ctx.measureText(text).width, b - a - 12);
          ctx.fillStyle = 'rgba(28, 28, 32, 0.85)';
          roundRect(ctx, a + 4, 3, width + 10, 15, 4);
          ctx.fill();
          ctx.save();
          ctx.beginPath();
          ctx.rect(a + 4, 3, width + 10, 15);
          ctx.clip();
          ctx.fillStyle = 'rgba(215, 174, 251, 0.95)';
          ctx.fillText(text, a + 9, 5.5);
          ctx.restore();
        }
      }
    }

    // Voiceover takes.
    boxes = [];
    for (const take of p.audio.voiceover) {
      const at = tl.toOutput(take.source, take.t);
      if (at === null) continue;
      const len = Math.min(takeLength(take), tl.duration - at);
      const x0 = sx(at);
      const x1 = sx(at + len);
      boxes.push({ take, x0, x1 });
      if (x1 < 0 || x0 > w) continue;
      ctx.fillStyle = 'rgba(138, 180, 248, 0.2)';
      ctx.strokeStyle = 'rgba(138, 180, 248, 0.7)';
      ctx.lineWidth = 1;
      roundRect(ctx, x0 + 0.5, 5.5, Math.max(3, x1 - x0 - 1), HEIGHT - 13, 5);
      ctx.fill();
      ctx.stroke();
      const peaks = audio()?.file('take', take.file)?.peaks;
      if (peaks) {
        const max = Math.max(1e-3, peakBetween(peaks, 0, Infinity));
        ctx.fillStyle = 'rgba(168, 199, 250, 0.9)';
        for (let px = Math.max(0, Math.ceil(x0 + 2)); px < Math.min(w, x1 - 2); px++) {
          const t0 = (px - x0) / pps;
          const v = Math.sqrt(peakBetween(peaks, t0, t0 + 1 / pps) / max);
          const bar = Math.max(1, v * (HEIGHT - 20));
          ctx.fillRect(px, mid - bar / 2 + 0.5, 1, bar);
        }
      }
    }
  }

  function takeAt(clientX) {
    const r = canvas.getBoundingClientRect();
    const px = clientX - r.left;
    // The last drawn is on top.
    return [...boxes].reverse().find((b) => px >= b.x0 - 2 && px <= b.x1 + 2) ?? null;
  }

  track.addEventListener('pointermove', (e) => {
    if (!e.buttons) track.style.cursor = takeAt(e.clientX) ? 'grab' : '';
  });

  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const hit = takeAt(e.clientX);
    if (!hit) return; // the timeline scrubs as anywhere else
    e.stopPropagation();
    e.preventDefault();
    const p0 = store.project;
    const tl0 = store.tl;
    const startOut = tl0.toOutput(hit.take.source, hit.take.t);
    const startX = e.clientX;
    let moved = false;
    track.setPointerCapture(e.pointerId);
    track.style.cursor = 'grabbing';
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - startX) < DRAG_PX) return;
      moved = true;
      const out = clamp(startOut + (ev.clientX - startX) / view.pps, 0, Math.max(0, tl0.duration - 0.1));
      store.apply(() => P.setAudio(p0, {
        voiceover: p0.audio.voiceover.map((v) => (v.id === hit.take.id ? { ...v, ...anchorAt(tl0, out) } : v))
      }), { gesture: `voiceover:${hit.take.id}` });
    };
    const end = () => {
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', end);
      track.removeEventListener('pointercancel', end);
      track.style.cursor = '';
      store.endGesture();
      if (!moved) player.seek(startOut);
      editor.showPanel('audio');
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
  });

  // Waveforms arrive as the sound is decoded.
  player.audio?.onState(() => draw());

  return { label, track, draw };
}

function roundRect(ctx, x, y, w, hgt, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(0, w), Math.max(0, hgt), Math.min(r, w / 2, hgt / 2));
}
