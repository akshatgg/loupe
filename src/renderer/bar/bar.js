'use strict';

// 'full' reads as "Full window" for a window source -- same mode, no crop.
const AREA_MODES = [
  { mode: 'full', label: { display: 'Full screen', window: 'Full window' } },
  { mode: 'rect', label: 'Rectangle' },
  { mode: 'draw', label: 'Draw' }
];

const armedEl = document.getElementById('armed');
const recordingEl = document.getElementById('recording');
const countdownEl = document.getElementById('countdown');
const pauseBtn = document.getElementById('pause');
const cancelCountdownBtn = document.getElementById('cancelCountdown');
// The OS's own way of writing a shortcut, for the pause button's tooltip.
const IS_WINDOWS = window.loupe.platform === 'win32';
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

function shortcutText(accelerator) {
  if (!accelerator) return '';
  const parts = accelerator.split('+');
  if (IS_WINDOWS) return parts.map((p) => (p === 'Control' ? 'Ctrl' : p)).join('+');
  const mac = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' };
  return parts.map((p) => mac[p] ?? p).join('');
}

function renderArmed(d) {
  armedEl.hidden = false;
  recordingEl.hidden = true;
  countdownEl.hidden = true;
  document.getElementById('armedNote').textContent = d.cameraError ? `Camera: ${d.cameraError}` : '';
  sourceLabelEl.textContent = d.sourceLabel || '';
  currentAreaMode = d.areaMode || 'full';
  if (!modesBuilt || !d.canPickArea) buildAreaModes(d.canPickArea, d.sourceKind);
  else {
    for (const b of areaModesEl.children) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === currentAreaMode));
    }
  }
}

function renderCountdown(d) {
  armedEl.hidden = true;
  recordingEl.hidden = true;
  countdownEl.hidden = false;
  document.getElementById('count').textContent = String(d.count ?? '');
}

function renderRecording(d) {
  armedEl.hidden = true;
  countdownEl.hidden = true;
  recordingEl.hidden = false;
  document.getElementById('time').textContent = clock(d.elapsed ?? 0);

  // Paused: the timer stands still (main leaves paused time out of elapsed).
  const paused = Boolean(d.paused);
  recordingEl.classList.toggle('paused', paused);
  document.getElementById('recDot').className = paused ? 'dot paused' : 'dot rec';
  document.getElementById('pausedLabel').hidden = !paused;
  // SVG elements have no `hidden` property: the attribute itself is toggled.
  document.getElementById('pauseIcon').toggleAttribute('hidden', paused);
  document.getElementById('resumeIcon').toggleAttribute('hidden', !paused);
  const keys = shortcutText(d.pauseShortcut);
  const label = paused ? 'Resume' : 'Pause';
  pauseBtn.title = keys ? `${label} (${keys})` : label;
  pauseBtn.setAttribute('aria-label', label);
  pauseBtn.dataset.paused = String(paused);
  document.getElementById('zoom').textContent = `${(d.zoom ?? 1).toFixed(1)}×`;
  document.getElementById('mic').textContent = d.hasMic ? '🎤' : '';

  const warn = document.getElementById('warn');
  if (d.micRequested && !d.hasMic) warn.textContent = 'mic off';
  else if (d.cameraError) warn.textContent = 'camera off';
  else if (d.warnings?.length) warn.textContent = 'computer sound off';
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
  else if (d.state === 'countdown') renderCountdown(d);
  // A plain status update mid-countdown (no number): the countdown stays.
  else if (d.state === 'counting') return;
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
    // { cancelled: true } after Esc/Cancel in the countdown: main has sent
    // the armed view back, ready to start again.
    const result = await window.loupe.startRecording();
    if (result?.cancelled) {
      startBtn.disabled = false;
      backBtn.disabled = false;
      setStartLabel('Start recording');
    }
  } catch (err) {
    startBtn.disabled = false;
    backBtn.disabled = false;
    setStartLabel('Start recording');
    sourceLabelEl.textContent = `Could not start recording: ${err.message}`;
  }
};

backBtn.onclick = () => { window.loupe.stopRecording(); };
stopBtn.onclick = () => { window.loupe.stopRecording(); };
pauseBtn.onclick = () => {
  if (pauseBtn.dataset.paused === 'true') window.loupe.resumeRecording();
  else window.loupe.pauseRecording();
};
cancelCountdownBtn.onclick = () => { window.loupe.cancelCountdown(); };
