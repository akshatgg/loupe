'use strict';

const stage = document.getElementById('stage');
const video = document.getElementById('src');
const ctx = stage.getContext('2d');
let state = null;
let rafStarted = false;
// True while the user is dragging the scrub handle. The draw loop writes the
// playback position into that same control, so without this the two fight and
// the handle snaps back under the cursor on every frame.
let scrubbing = false;

function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function sampleCamera(t) {
  const cam = state.camera;
  const src = state.project.source;
  if (!cam || !cam.length) {
    return { zoom: 1, cx: src.width / 2, cy: src.height / 2 };
  }
  const i = Math.min(cam.length - 1, Math.max(0, Math.round(t * 120)));
  return cam[i];
}

// Nearest cursor sample to t -- the same lookup Render.swift's sampleCursor
// does, so the preview and the export put the cursor in the same place.
function sampleCursor(t) {
  const track = state.cursor;
  if (!track || !track.length) return null;
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t <= t) lo = mid; else hi = mid;
  }
  return Math.abs(track[lo].t - t) <= Math.abs(track[hi].t - t) ? track[lo] : track[hi];
}

// The recording never contains the cursor (it's captured without one), so
// it's drawn back in here -- the same arrow, shadow and outline as
// Render.swift's drawCursor, scaled with the zoom the same way.
function drawCursor(x, y, s) {
  const path = new Path2D();
  path.moveTo(x, y);
  path.lineTo(x, y + 17 * s);
  path.lineTo(x + 4.5 * s, y + 13 * s);
  path.lineTo(x + 7.5 * s, y + 19 * s);
  path.lineTo(x + 10.5 * s, y + 17.5 * s);
  path.lineTo(x + 7.5 * s, y + 11.5 * s);
  path.lineTo(x + 12 * s, y + 11.5 * s);
  path.closePath();
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, .45)';
  ctx.shadowBlur = 3 * s;
  ctx.shadowOffsetY = 1 * s;
  ctx.fillStyle = '#fff';
  ctx.fill(path);
  ctx.strokeStyle = 'rgba(0, 0, 0, .85)';
  ctx.lineWidth = 1.2 * s;
  ctx.stroke(path);
  ctx.restore();
}

const showCursor = () => state.project.settings?.showCursor !== false;

// Playback speed at a recording time, with the same ~200ms ease in and out
// at each stretch's edges the export uses. Kept in sync BY HAND with
// src/main/timemap.js's rateAt (test/timemap.test.js covers that one) --
// renderer scripts can't require main-process modules; see region.js for
// the same convention.
function smoothstep(t) { return t * t * (3 - 2 * t); }
function rateAt(tSrc, segments, rampMs = 200) {
  const rampSeconds = rampMs / 1000;
  for (const seg of segments) {
    if (tSrc < seg.srcStart || tSrc > seg.srcEnd) continue;
    const ramp = Math.min(rampSeconds, (seg.srcEnd - seg.srcStart) / 2);
    let k = 1;
    if (ramp > 0) {
      const into = tSrc - seg.srcStart;
      const outOf = seg.srcEnd - tSrc;
      if (into < ramp) k = smoothstep(into / ramp);
      else if (outOf < ramp) k = smoothstep(outOf / ramp);
    }
    return 1 + (seg.rate - 1) * k;
  }
  return 1;
}

const speedSegments = () => state.project.speedSegments ?? [];

// The preview plays each stretch at its speed by driving the video element's
// own playbackRate -- which also time-stretches the audio, keeping pitch
// natural unless the project says otherwise, just as the export does.
function applyPlaybackRate() {
  const rate = rateAt(video.currentTime, speedSegments(), state.project.settings?.rampMs ?? 200);
  if (Math.abs(video.playbackRate - rate) > 0.005) video.playbackRate = rate;
}

function draw() {
  if (!state || video.readyState < 2 || !video.videoWidth) {
    requestAnimationFrame(draw);
    return;
  }
  const { width: sw, height: sh } = state.project.source;
  const scale = video.videoWidth / sw;
  const cam = sampleCamera(video.currentTime);
  const vw = (sw / cam.zoom) * scale;
  const vh = (sh / cam.zoom) * scale;
  const x0 = cam.cx * scale - vw / 2;
  const y0 = cam.cy * scale - vh / 2;

  stage.width = video.videoWidth;
  stage.height = video.videoHeight;
  ctx.drawImage(video, x0, y0, vw, vh, 0, 0, stage.width, stage.height);

  const c = showCursor() ? sampleCursor(video.currentTime) : null;
  if (c) {
    const k = stage.width / vw; // output pixels per source pixel
    drawCursor((c.x * scale - x0) * k, (c.y * scale - y0) * k, k * scale);
  }
  applyPlaybackRate();
  syncTransport(cam.zoom);
  requestAnimationFrame(draw);
}

// Nothing was driving the scrub handle, the clock or the playhead from the
// video's own position, so they sat wherever they were last put and playback
// looked frozen even while the picture moved.
function syncTransport(zoom) {
  const duration = state.project.capture.duration || 0;
  const t = video.currentTime;
  if (!scrubbing) {
    const pos = duration > 0 ? (t / duration) * 1000 : 0;
    document.getElementById('scrub').value = String(Math.min(1000, Math.max(0, pos)));
    document.getElementById('playhead').style.left =
      `${duration > 0 ? Math.min(100, (t / duration) * 100) : 0}%`;
  }
  document.getElementById('tnow').textContent = clock(t);
  // The timeline is in recording time; with speed stretches the video
  // itself ends up a different length, so say that too.
  const out = state.outputDuration ?? duration;
  document.getElementById('tend').textContent = Math.abs(out - duration) > 0.05
    ? `${clock(duration)} · video ${clock(out)}` : clock(duration);
  document.getElementById('zoomnow').textContent = `${zoom.toFixed(1)}×`;
  document.getElementById('play').textContent = video.paused ? 'Play' : 'Pause';
}

// Segments are built as DOM nodes with textContent, never innerHTML: project
// data (the source window title) comes from another application and must
// never be interpolated into markup -- see the picker window's earlier
// script-injection bug.
function renderTimeline() {
  const track = document.getElementById('track');
  for (const old of [...track.querySelectorAll('.seg')]) old.remove();
  const duration = state.project.capture.duration || 1;

  // An empty track is ambiguous: it looks the same whether the recording has
  // no zooms or the editor failed to load them. Say which.
  const removed = state.project.removedZooms?.length ?? 0;
  const note = document.getElementById('notracks');
  note.hidden = state.segments.length > 0;
  note.textContent = removed > 0
    ? 'All zooms removed — use Undo or Restore all zooms to bring them back.'
    : 'No zooms in this recording — hold your zoom key (or a mouse side button) and scroll while recording to add one.';
  document.getElementById('undoZoom').hidden = removed === 0;
  const restore = document.getElementById('restoreZooms');
  restore.hidden = removed === 0;
  restore.textContent = `Restore all zooms (${removed})`;

  for (const seg of state.segments) {
    const el = document.createElement('div');
    el.className = 'seg';
    el.style.left = `${(seg.start / duration) * 100}%`;
    el.style.width = `${Math.max(0.5, ((seg.end - seg.start) / duration) * 100)}%`;
    el.textContent = `${seg.peak.toFixed(1)}×`;
    el.title = 'Click to jump to this zoom';
    el.addEventListener('click', () => { video.currentTime = seg.start; });

    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Remove this zoom (you can undo it)';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      changeZooms(() => window.loupe.deleteZoom({ start: seg.start, end: seg.end }), 'Zoom removed');
    });
    el.appendChild(del);
    track.appendChild(el);
  }
}

let zoomChangeBusy = false;

// Every zoom edit returns the new {project, segments, camera}; one at a time,
// so a double-click can't send two removals of the same zoom.
async function changeZooms(call, doneMessage) {
  if (zoomChangeBusy) return;
  zoomChangeBusy = true;
  try {
    state = { ...state, ...(await call()) };
    renderTimeline();
    setStatus(doneMessage);
  } catch (err) {
    setStatus(`Couldn't change zooms: ${err.message}`);
  } finally {
    zoomChangeBusy = false;
  }
}

function undoZoom() {
  if (!state?.project.removedZooms?.length) return;
  changeZooms(() => window.loupe.undoZoomDelete(), 'Zoom brought back');
}

document.getElementById('undoZoom').onclick = undoZoom;
document.getElementById('restoreZooms').onclick = () =>
  changeZooms(() => window.loupe.restoreZooms(), 'All zooms restored');
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
    e.preventDefault();
    undoZoom();
  }
});

// ---- speed track ------------------------------------------------------------
// Drag across a stretch (or click an existing one) and pick a speed. Stored
// in recording time via main.js's project:paintSpeed; 1x puts it back.

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4, 8];
const speedTrack = document.getElementById('speedtrack');
const speedSelEl = document.getElementById('speedsel');
const speedMenu = document.getElementById('speedmenu');
let speedSel = null;   // {srcStart, srcEnd} being set, or null
let speedDrag = null;  // recording time where the current drag started

const recordingDuration = () => state.project.capture.duration || 0;
const pct = (t) => `${(t / (recordingDuration() || 1)) * 100}%`;

function timeAtX(clientX) {
  const r = speedTrack.getBoundingClientRect();
  return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * recordingDuration();
}

function renderSpeedTrack() {
  for (const old of [...speedTrack.querySelectorAll('.speedseg')]) old.remove();
  const segs = speedSegments();
  document.getElementById('speedhint').hidden = segs.length > 0 || speedSel !== null;
  for (const seg of segs) {
    const el = document.createElement('div');
    el.className = `speedseg ${seg.rate > 1 ? 'fast' : 'slow'}`;
    el.style.left = pct(seg.srcStart);
    el.style.width = pct(seg.srcEnd - seg.srcStart);
    el.textContent = `${seg.rate}×`;
    el.title = `${seg.rate}× — click to change`;
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', () => openSpeedMenu({ srcStart: seg.srcStart, srcEnd: seg.srcEnd }, seg.rate));
    speedTrack.appendChild(el);
  }
  speedSelEl.hidden = !speedSel;
  if (speedSel) {
    const [a, b] = [Math.min(speedSel.srcStart, speedSel.srcEnd), Math.max(speedSel.srcStart, speedSel.srcEnd)];
    speedSelEl.style.left = pct(a);
    speedSelEl.style.width = pct(b - a);
  }
}

function openSpeedMenu(sel, currentRate = 1) {
  speedSel = sel;
  renderSpeedTrack();
  speedMenu.textContent = '';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = `${clock(sel.srcStart)}–${clock(sel.srcEnd)} speed:`;
  speedMenu.append(label);
  for (const rate of SPEEDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = rate === 1 ? '1× (normal)' : `${rate}×`;
    if (rate === currentRate) b.className = 'current';
    b.addEventListener('click', () => applySpeed(rate));
    speedMenu.append(b);
  }
  speedMenu.hidden = false;
  // Above the stretch, kept inside the timeline.
  const tl = document.getElementById('timeline').getBoundingClientRect();
  const tr = speedTrack.getBoundingClientRect();
  const mid = tr.left + ((sel.srcStart + sel.srcEnd) / 2 / (recordingDuration() || 1)) * tr.width;
  const w = speedMenu.offsetWidth;
  speedMenu.style.left = `${Math.min(tl.width - w - 8, Math.max(8, mid - tl.left - w / 2))}px`;
  speedMenu.style.top = `${tr.top - tl.top - speedMenu.offsetHeight - 6}px`;
}

function closeSpeedMenu() {
  speedMenu.hidden = true;
  speedSel = null;
  renderSpeedTrack();
}

async function applySpeed(rate) {
  const { srcStart, srcEnd } = speedSel;
  try {
    const update = await window.loupe.paintSpeed({ srcStart, srcEnd, rate });
    state = { ...state, project: update.project, outputDuration: update.outputDuration };
    setStatus(rate === 1 ? 'Back to normal speed' : `${clock(srcStart)}–${clock(srcEnd)} now plays at ${rate}×`);
  } catch (err) {
    setStatus(`Couldn't change speed: ${err.message}`);
  }
  closeSpeedMenu();
}

speedTrack.addEventListener('pointerdown', (e) => {
  if (!state || e.button !== 0) return;
  speedMenu.hidden = true;
  speedDrag = timeAtX(e.clientX);
  speedSel = { srcStart: speedDrag, srcEnd: speedDrag };
  // Keeps the drag tracking outside the track; nice to have, never required.
  try { speedTrack.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  renderSpeedTrack();
});
speedTrack.addEventListener('pointermove', (e) => {
  if (speedDrag === null) return;
  const t = timeAtX(e.clientX);
  speedSel = { srcStart: Math.min(speedDrag, t), srcEnd: Math.max(speedDrag, t) };
  renderSpeedTrack();
});
speedTrack.addEventListener('pointerup', (e) => {
  if (speedDrag === null) return;
  speedDrag = null;
  if (speedSel.srcEnd - speedSel.srcStart < 0.1) {
    // A click, not a drag: just jump there.
    video.currentTime = timeAtX(e.clientX);
    closeSpeedMenu();
  } else {
    openSpeedMenu(speedSel);
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!speedMenu.hidden && !speedMenu.contains(e.target) && !speedTrack.contains(e.target)) closeSpeedMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !speedMenu.hidden) closeSpeedMenu();
});

const showCursorEl = document.getElementById('showCursor');
showCursorEl.onchange = async () => {
  try {
    const { project } = await window.loupe.setShowCursor(showCursorEl.checked);
    state = { ...state, project };
  } catch (err) {
    showCursorEl.checked = showCursor();
    setStatus(`Couldn't change the cursor setting: ${err.message}`);
  }
};

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

const scrub = document.getElementById('scrub');
scrub.addEventListener('pointerdown', () => { scrubbing = true; });
// pointerup can land outside the control, so listen on the window.
window.addEventListener('pointerup', () => { scrubbing = false; });
scrub.oninput = (e) => {
  if (!state) return;
  const duration = state.project.capture.duration || 0;
  video.currentTime = (e.target.value / 1000) * duration;
  document.getElementById('playhead').style.left = `${(e.target.value / 1000) * 100}%`;
  document.getElementById('tnow').textContent = clock(video.currentTime);
};

document.getElementById('play').onclick = () => {
  if (video.paused) video.play();
  else video.pause();
};

document.getElementById('export').onclick = async () => {
  const preset = document.getElementById('preset').value;
  const exportBtn = document.getElementById('export');
  exportBtn.disabled = true;
  setStatus('Exporting…');
  try {
    const result = await window.loupe.exportVideo({ resolution: preset, codec: 'h264' });
    setStatus(`Saved ${result.file}`);
  } catch (err) {
    // ipcRenderer.invoke wraps a main-process error as "Error invoking
    // remote method 'export:start': Error: <message>"; show only the message.
    setStatus(`Export failed: ${String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  } finally {
    exportBtn.disabled = false;
  }
};

window.loupe.onExportProgress((p) => {
  if (p.phase === 'video' && p.total) {
    setStatus(`Exporting… ${Math.min(100, Math.round((p.frame / p.total) * 100))}%`);
  } else {
    setStatus(p.phase === 'sound' ? 'Exporting… preparing the sound' : 'Exporting… reading the recording');
  }
});

if (window.loupe.platform === 'win32') {
  document.getElementById('undoZoom').title = 'Bring back the last zoom you removed (Ctrl+Z)';
}

(async function load() {
  try {
    state = await window.loupe.loadProject();
    video.src = state.videoUrl ?? `file://${state.video}`;
    video.load();
    showCursorEl.checked = showCursor();
    video.preservesPitch = state.project.settings?.preserveVoicePitch !== false;
    renderTimeline();
    renderSpeedTrack();
    if (!rafStarted) {
      rafStarted = true;
      requestAnimationFrame(draw);
    }
  } catch (err) {
    setStatus(`Failed to load project: ${err.message}`);
  }
})();
