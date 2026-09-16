// The preview: plays the edited video in real time by drawing every frame
// with the same compositor as the export (core/compose.js drawFrame).
//
// The output time is the clock. Each recording is a muted <video>; while
// playing, the one the timeline needs is kept at the right moment and speed
// (cuts and reordering are jumps, speed stretches are its playbackRate),
// nudged gently when it drifts and seeked when it's far off or a clip
// changes. Paused, it is simply seeked to the frame under the playhead.
// Sound plays through audio-preview.js on the same clock.

import { drawFrame, exportSize } from '../../core/compose.js';
import { parseCursorTrack } from '../../core/cursor.js';
import { clipLayout, clipIndexAt, rateAt } from './timeline-math.js';
import { createAudioPreview } from './audio-preview.js';
import { createVisualMedia } from './visual-media.js';

// Beyond this the video is seeked rather than sped up or slowed down.
const SEEK_DRIFT = 0.25;
// Chromium plays media from 1/16x to 16x.
const RATE_MIN = 0.0625;
const RATE_MAX = 16;

export function createPlayer({ canvas, store, sources }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const videos = {};
  const cursors = {};
  const listeners = new Set();
  const audio = createAudioPreview({ sources });
  let outT = 0;
  let playing = false;
  let wallStart = 0;
  let outStart = 0;
  let lastClip = -1;
  let dirty = true;
  let raf = 0;
  let size = { width: 2, height: 2 };
  let lastState = null;
  // Webcam, crossfade pictures, shortcuts and the background picture.
  const visuals = createVisualMedia({ sources, loupe: window.loupe, onChange: () => { dirty = true; } });

  for (const [key, files] of Object.entries(sources)) {
    if (!files.video) continue;
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    v.src = files.video;
    // Every new frame the element has (after a seek, or once loaded) is a
    // reason to redraw while paused.
    for (const ev of ['loadeddata', 'seeked', 'canplay']) v.addEventListener(ev, () => { dirty = true; });
    videos[key] = v;
    if (files.cursor) {
      fetch(files.cursor)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((buf) => {
          if (buf) cursors[key] = parseCursorTrack(buf);
          dirty = true;
        })
        .catch(() => {}); // no cursor track: the preview just has no cursor
    }
  }

  const project = () => store.project;
  const duration = () => store.tl.duration;

  // Fits the canvas to its box with the video's shape, at the screen's
  // pixel density so the picture is sharp on a Retina display.
  function resize() {
    const box = canvas.parentElement.getBoundingClientRect();
    const shape = exportSize(project(), '1080p');
    const ratio = shape.width / shape.height;
    let w = box.width;
    let h = w / ratio;
    if (h > box.height) {
      h = box.height;
      w = h * ratio;
    }
    w = Math.max(2, Math.floor(w));
    h = Math.max(2, Math.floor(h));
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    size = { width: pw, height: ph };
    dirty = true;
  }

  function syncVideo(at, rate, jumped) {
    for (const [key, v] of Object.entries(videos)) {
      if (key !== at.source) {
        if (!v.paused) v.pause();
        continue;
      }
      if (v.readyState < 1) continue;
      const drift = v.currentTime - at.t;
      if (playing) {
        // A new clip is a jump -- unless it carries straight on from the last
        // one (a split nobody moved).
        if ((jumped && Math.abs(drift) > 0.05) || Math.abs(drift) > SEEK_DRIFT) v.currentTime = at.t;
        // Ahead: a touch slower; behind: a touch faster.
        const target = Math.min(RATE_MAX, Math.max(RATE_MIN, rate * (1 - Math.max(-0.2, Math.min(0.2, drift * 2)))));
        if (Math.abs(v.playbackRate - target) > 0.01) v.playbackRate = target;
        if (v.paused) v.play().catch(() => {});
      } else {
        if (!v.paused) v.pause();
        if (Math.abs(drift) > 0.001 && !v.seeking) v.currentTime = at.t;
      }
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const tl = store.tl;
    if (playing) {
      outT = outStart + (now - wallStart) / 1000;
      if (outT >= tl.duration) {
        outT = tl.duration;
        setPlaying(false);
      }
      dirty = true;
      emitTime();
    }
    if (!dirty) return;
    dirty = false;
    const p = project();
    const layout = clipLayout(p, tl);
    const at = tl.toSource(outT);
    const jumped = at.clipIndex !== lastClip;
    lastClip = at.clipIndex;
    const rate = rateAt(p, layout, outT);
    syncVideo(at, rate, jumped);
    audio.sync({ project: p, at, rate, playing, jumped });
    const frames = visuals.sync({ project: p, tl, outT, at, rate, playing });
    const v = videos[at.source];
    if (v && v.readyState >= 2) frames[at.source] = v;
    lastState = drawFrame(ctx, { project: p, tl, outT, frames, size, assets: { ...visuals.assets, cursors } });
    // Seeks land asynchronously; keep drawing until the frame has arrived.
    if (!playing && v && (v.seeking || v.readyState < 2)) dirty = true;
  }

  function emitTime() {
    for (const fn of listeners) fn(outT, playing);
  }

  function setPlaying(on) {
    if (on === playing) return;
    playing = on;
    if (on) {
      if (outT >= duration() - 1e-3) outT = 0;
      wallStart = performance.now();
      outStart = outT;
      lastClip = -1;
    }
    dirty = true;
    emitTime();
  }

  store.subscribe((what) => {
    if (what !== 'project') return;
    // Edits can shorten the video under the playhead.
    if (outT > duration()) outT = duration();
    if (playing) { outStart = outT; wallStart = performance.now(); }
    resize();
    emitTime();
  });

  const observer = new ResizeObserver(() => resize());
  observer.observe(canvas.parentElement);
  resize();
  raf = requestAnimationFrame(frame);

  return {
    get time() { return outT; },
    get playing() { return playing; },
    get state() { return lastState; },
    get videos() { return videos; },
    get audio() { return audio; },
    get cursors() { return cursors; },
    get visuals() { return visuals; },
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    toggle: () => setPlaying(!playing),
    seek(t) {
      outT = Math.min(duration(), Math.max(0, Number.isFinite(t) ? t : 0));
      if (playing) { outStart = outT; wallStart = performance.now(); lastClip = -1; }
      dirty = true;
      emitTime();
    },
    // The source frame index at the playhead, for stepping a frame.
    frameStep() {
      const p = project();
      const at = store.tl.toSource(outT);
      return 1 / (p.sources[at.source].fps || 60);
    },
    redraw() { dirty = true; },
    onTime(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    clipAt: () => clipIndexAt(clipLayout(project(), store.tl), outT),
    destroy() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      audio.stop();
      visuals.destroy();
      for (const v of Object.values(videos)) { v.pause(); v.removeAttribute('src'); v.load(); }
    }
  };
}
