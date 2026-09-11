'use strict';

// 'full' reads as "Full window" for a window source -- same mode, no crop.
const AREA_MODES = [
  { mode: 'full', label: { display: 'Full screen', window: 'Full window' } },
  { mode: 'rect', label: 'Rectangle' },
  { mode: 'draw', label: 'Draw' }
];

const armedEl = document.getElementById('armed');
const recordingEl = document.getElementById('recording');
const sourceLabelEl = document.getElementById('sourceLabel');
const areaModesEl = document.getElementById('areaModes');
const backBtn = document.getElementById('back');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');

let currentAreaMode = 'full';
let modesBuilt = false;

function clock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Window/app titles are the OS's own, and any process picks its own -- built
// with textContent, never innerHTML, the same rule the picker's source list
// and the region overlay's window menu already follow.
function buildAreaModes(enabled, sourceKind) {
  areaModesEl.textContent = '';
  if (!enabled) { modesBuilt = false; return; }
  for (const { mode, label } of AREA_MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mode = mode;
    b.textContent = typeof label === 'string' ? label : label[sourceKind] ?? label.display;
    b.setAttribute('aria-pressed', String(mode === currentAreaMode));
    b.onclick = () => window.loupe.setAreaMode(mode);
    areaModesEl.appendChild(b);
  }
  modesBuilt = true;
}

function renderArmed(d) {
  armedEl.hidden = false;
  recordingEl.hidden = true;
  sourceLabelEl.textContent = d.sourceLabel || '';
  currentAreaMode = d.areaMode || 'full';
  if (!modesBuilt || !d.canPickArea) buildAreaModes(d.canPickArea, d.sourceKind);
  else {
    for (const b of areaModesEl.children) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === currentAreaMode));
    }
  }
}

function renderRecording(d) {
  armedEl.hidden = true;
  recordingEl.hidden = false;
  document.getElementById('time').textContent = clock(d.elapsed ?? 0);
  document.getElementById('zoom').textContent = `${(d.zoom ?? 1).toFixed(1)}×`;
  document.getElementById('mic').textContent = d.hasMic ? '🎤' : '';

  const warn = document.getElementById('warn');
  if (d.micRequested && !d.hasMic) warn.textContent = 'mic off';
  else if (!d.zoomEnabled) warn.textContent = 'zoom off';
  else if (d.tapReenables > 0) warn.textContent = `tap recovered ×${d.tapReenables}`;
  else warn.textContent = '';

  // A helper-reported error (e.g. the video writer failed mid-recording)
  // must be visible here -- this is untrusted-ish diagnostic text from a
  // native helper, never HTML.
  const err = document.getElementById('error');
  err.textContent = d.error ? `${d.error.source}: ${d.error.message}` : '';
}

window.loupe.onBarUpdate((d) => {
  if (d.state === 'recording') renderRecording(d);
  else renderArmed(d);
});

// The start button is icon-only, so its in-flight state is carried by the
// label (and the pulsing disabled style), not by swapping its content.
function setStartLabel(label) {
  startBtn.title = label;
  startBtn.setAttribute('aria-label', label);
}

startBtn.onclick = async () => {
  startBtn.disabled = true;
  backBtn.disabled = true;
  setStartLabel('Starting…');
  try {
    await window.loupe.startRecording();
  } catch (err) {
    startBtn.disabled = false;
    backBtn.disabled = false;
    setStartLabel('Start recording');
    sourceLabelEl.textContent = `Could not start recording: ${err.message}`;
  }
};

backBtn.onclick = () => { window.loupe.stopRecording(); };
stopBtn.onclick = () => { window.loupe.stopRecording(); };
