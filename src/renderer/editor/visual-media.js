// The preview's pictures beyond each recording itself, for the layers in
// core/layers (docs/EDITOR-V2.md section 5):
//
//  - the webcam bubble: one muted <video> of webcam.webm per recording, kept
//    at the recording's moment minus the webcam's offset
//  - a crossfade's other side: a second <video> of that recording, seeked to
//    the held frame (transitions.js) a moment before the transition starts
//  - keys.json for the keystroke badges
//  - the background picture, from a bundled wallpaper or a copied picture
//
//   createVisualMedia({ sources, loupe, onChange }) ->
//     { assets, sync({ project, tl, outT, at, rate, playing, jumped }) -> frames,
//       addSource(key, files), destroy() }
//
// sync() runs on every drawn frame and returns the extra frames to hand to
// drawFrame; onChange() asks for a redraw when something finished loading.

import { normalizeKeys } from '../../core/layers/keystrokes.js';
import { webcamFrameKey, webcamTime } from '../../core/layers/webcam.js';
import { transitionAt, TRANSITION_FRAME } from '../../core/layers/transitions.js';

const SEEK_DRIFT = 0.25;
// Start seeking a crossfade's held picture this long before it shows.
const LOOKAHEAD = 0.6;

function mediaElement(url, onChange) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = url;
  for (const ev of ['loadeddata', 'seeked', 'canplay']) v.addEventListener(ev, onChange);
  return v;
}

const ready = (v, t, tolerance) => v.readyState >= 2 && !v.seeking && Math.abs(v.currentTime - t) <= tolerance;

export function createVisualMedia({ sources, loupe, onChange = () => {} }) {
  const webcams = {};
  const holds = {};
  const keys = {};
  const assets = { keys, background: null };
  let backgroundValue = null;

  function addSource(key, files) {
    if (files.webcam && !webcams[key]) webcams[key] = mediaElement(files.webcam, onChange);
    if (files.keys && !keys[key]) {
      fetch(files.keys)
        .then((r) => (r.ok ? r.json() : []))
        .then((list) => { keys[key] = normalizeKeys(list); onChange(); })
        .catch(() => {}); // no badges, nothing else lost
    }
  }
  for (const [key, files] of Object.entries(sources)) addSource(key, files);

  function syncBackground(project) {
    const bg = project.style.background;
    const value = bg.type === 'image' ? bg.value : null;
    if (value === backgroundValue) return;
    backgroundValue = value;
    assets.background = null;
    if (!value || !loupe?.background?.url) return;
    loupe.background.url(value).then((url) => {
      if (!url || backgroundValue !== value) return;
      const img = document.createElement('img');
      img.onload = () => {
        if (backgroundValue !== value) return;
        assets.background = img;
        onChange();
      };
      img.src = url;
    }).catch(() => {});
  }

  function syncWebcam(project, at, rate, playing, frames) {
    for (const [key, v] of Object.entries(webcams)) {
      const meta = project.sources[key];
      const wt = key === at.source ? webcamTime(meta, at.t) : null;
      const inRange = wt !== null && wt >= 0 && (!Number.isFinite(v.duration) || wt <= v.duration);
      if (!inRange || !project.style.webcam.show) {
        if (!v.paused) v.pause();
        continue;
      }
      if (v.readyState < 1) continue;
      const drift = v.currentTime - wt;
      if (playing) {
        if (Math.abs(drift) > SEEK_DRIFT) v.currentTime = wt;
        const target = Math.min(16, Math.max(0.0625, rate));
        if (Math.abs(v.playbackRate - target) > 0.01) v.playbackRate = target;
        if (v.paused) v.play().catch(() => {});
      } else {
        if (!v.paused) v.pause();
        if (Math.abs(drift) > 0.02 && !v.seeking) v.currentTime = wt;
      }
      if (ready(v, wt, playing ? SEEK_DRIFT + 0.1 : 0.05)) frames[webcamFrameKey(key)] = v;
    }
  }

  // Both held pictures of a crossfade are made ready before it starts: the
  // next clip's first frame (shown up to the join) and the previous clip's
  // last frame (after it), each in its own element.
  function holdElement(side, source) {
    const url = sources[source]?.video;
    if (!url) return null;
    if (holds[side]?.source !== source) {
      holds[side]?.el.removeAttribute('src');
      holds[side] = { source, el: mediaElement(url, onChange) };
    }
    return holds[side].el;
  }

  function syncHold(project, tl, outT, frames) {
    const now = transitionAt(project, tl, outT);
    const tr = now ?? transitionAt(project, tl, Math.min(tl.duration, outT + LOOKAHEAD));
    if (tr?.type !== 'crossfade') return;
    const pictures = {
      next: transitionAt(project, tl, tr.join - tr.half / 2)?.other,
      prev: transitionAt(project, tl, tr.join)?.other
    };
    for (const [side, want] of Object.entries(pictures)) {
      const v = want && holdElement(side, want.source);
      if (!v || v.readyState < 1) continue;
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - want.t) > 0.01 && !v.seeking) v.currentTime = want.t;
      const showing = now && (side === 'next') === (outT < now.join);
      if (showing && ready(v, want.t, 0.04)) frames[TRANSITION_FRAME] = v;
    }
  }

  return {
    assets,
    sync({ project, tl, outT, at, rate, playing }) {
      const frames = {};
      syncBackground(project);
      syncWebcam(project, at, rate, playing, frames);
      syncHold(project, tl, outT, frames);
      return frames;
    },
    // A recording added after the editor opened (Add recording).
    addSource,
    get webcams() { return webcams; },
    destroy() {
      for (const v of [...Object.values(webcams), ...Object.values(holds).map((h) => h.el)]) {
        v.pause();
        v.removeAttribute('src');
        v.load();
      }
    }
  };
}
