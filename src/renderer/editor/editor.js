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
  document.getElementById('tend').textContent = clock(duration);
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
  const note = document.getElementById('notracks');
  note.hidden = state.segments.length > 0;
  note.textContent = 'No zooms in this recording — hold ⌥ and scroll while recording to add one.';
  for (const seg of state.segments) {
    const el = document.createElement('div');
    el.className = 'seg';
    el.style.left = `${(seg.start / duration) * 100}%`;
    el.style.width = `${Math.max(0.5, ((seg.end - seg.start) / duration) * 100)}%`;
    el.textContent = `${seg.peak.toFixed(1)}×`;
    el.title = 'Click to delete this zoom';
    el.addEventListener('click', async () => {
      el.style.pointerEvents = 'none';
      try {
        const update = await window.loupe.deleteZoom({ start: seg.start, end: seg.end });
        state = { ...state, ...update };
        renderTimeline();
      } catch (err) {
        setStatus(`Failed to delete zoom: ${err.message}`);
      }
    });
    track.appendChild(el);
  }
}

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
    const file = await window.loupe.exportVideo({ preset, codec: 'h264' });
    setStatus(`Saved ${file}`);
  } catch (err) {
    setStatus(`Export failed: ${err.message}`);
  } finally {
    exportBtn.disabled = false;
  }
};

window.loupe.onExportProgress((p) => {
  setStatus(`Exporting… frame ${p.frame ?? ''}`.trim());
});

(async function load() {
  try {
    state = await window.loupe.loadProject();
    video.src = `file://${state.video}`;
    video.load();
    renderTimeline();
    if (!rafStarted) {
      rafStarted = true;
      requestAnimationFrame(draw);
    }
  } catch (err) {
    setStatus(`Failed to load project: ${err.message}`);
  }
})();
