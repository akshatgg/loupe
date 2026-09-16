'use strict';
let selected = null;
let latestPermissions = null;
let allSources = [];
let activeTab = 'display';

const BROWSERS = ['Chrome', 'Chromium', 'Edge', 'Brave', 'Arc', 'Safari'];

// Displays first: recording the whole screen is the commonest case, and it is
// also the tab that is never empty.
const TABS = [
  { kind: 'display', label: 'Entire screen', empty: 'No displays found.' },
  { kind: 'window', label: 'Window', empty: 'No open windows found.' }
];

const isBrowser = (s) =>
  s.kind === 'window' && BROWSERS.some((b) => (s.app ?? '').includes(b));

const sourceLabel = (s) => (s.app ? `${s.app} — ${s.title}` : s.title);

async function refreshPermissions() {
  const p = await window.loupe.permissions();
  latestPermissions = p;
  const banner = document.getElementById('banner');
  if (!p.screenRecording) {
    banner.hidden = false;
    banner.textContent = 'Loupe needs Screen Recording permission to capture your screen. ';
    addPaneButton(banner, 'Open Settings', 'screenRecording');
  } else if (!p.accessibility) {
    banner.hidden = false;
    banner.textContent = 'Zoom is off: Loupe needs Accessibility permission to read the scroll wheel. Recording still works. ';
    addPaneButton(banner, 'Open Settings', 'accessibility');
  } else {
    banner.hidden = true;
  }
  // canRecord depends on Screen Recording alone (PRD FR-14): a missing
  // Accessibility grant must never disable the Continue button, only zoom.
  const recordButton = document.getElementById('record');
  recordButton.disabled = !p.canRecord || !selected;
  // Backing out of the control bar shows this window again (see bar:back /
  // stopRecording in main.js) without ever reloading it, so a stale
  // "Continuing…" label from the last attempt has to be reset here rather
  // than only ever being set once at load.
  recordButton.textContent = 'Continue';
  return p;
}

function addPaneButton(parent, label, pane) {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => window.loupe.openPane(pane);
  parent.appendChild(b);
}

function renderTabs() {
  const nav = document.getElementById('tabs');
  nav.textContent = '';
  for (const tab of TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(tab.kind === activeTab));
    b.textContent = tab.label;
    b.onclick = () => {
      if (activeTab === tab.kind) return;
      activeTab = tab.kind;
      // Switching tabs clears the selection: leaving a source selected while
      // it is hidden under another tab makes the enabled Continue button look
      // as though it belongs to whatever is on screen now.
      selected = null;
      renderTabs();
      renderList();
      renderPreview();
      renderHint();
      refreshPermissions();
    };
    nav.appendChild(b);
  }
}

function renderList() {
  const list = document.getElementById('list');
  const tab = TABS.find((t) => t.kind === activeTab);
  const shown = allSources.filter((s) => s.kind === activeTab);
  list.textContent = '';

  if (shown.length === 0) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = tab.empty;
    list.appendChild(li);
    return;
  }

  for (const source of shown) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(selected?.id === source.id));

    const icon = document.createElement('img');
    icon.className = 'icon';
    icon.src = source.thumbnail ?? '';
    icon.alt = '';
    li.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'label';
    // textContent, never innerHTML: `title` and `app` are the OS window title
    // and owning-application name, and any process picks its own.
    label.textContent = sourceLabel(source);
    li.appendChild(label);

    li.onclick = () => {
      selected = source;
      renderList();
      renderPreview();
      refreshPermissions();
    };
    list.appendChild(li);
  }
}

// Only windows on the current desktop are listed. SCShareableContent is asked
// for on-screen windows only, so anything minimised or sitting on another Space
// is absent -- and silently absent looks like a bug rather than a Spaces rule.
function renderHint() {
  const hint = document.getElementById('hint');
  hint.textContent = activeTab === 'window'
    ? 'Windows on other desktops, or minimised, are not listed. Bring one to this desktop, then Refresh.'
    : '';
}

function renderPreview() {
  const pane = document.getElementById('preview');
  pane.textContent = '';

  if (!selected) {
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.textContent = 'Select a source to record';
    pane.appendChild(ph);
    return;
  }

  if (selected.thumbnail) {
    const img = document.createElement('img');
    img.src = selected.thumbnail;
    img.alt = '';
    pane.appendChild(img);
  }

  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.textContent = sourceLabel(selected);
  pane.appendChild(cap);

  // PRD FR-7: the OS exposes displays, windows and applications to screen
  // capture but never an individual browser tab, so say the one move that
  // makes a single tab recordable rather than leaving the user hunting.
  if (isBrowser(selected)) {
    const hint = document.createElement('div');
    hint.className = 'tabhint';
    hint.textContent = 'Recording one tab? Drag it out into its own window first, then pick it here.';
    pane.appendChild(hint);
  }

  // Area selection (whole source, a rectangle, or freehand) now lives on the
  // control bar that appears after Continue, not here -- the picker is only
  // "what am I recording".
  if (selected.kind === 'display') {
    const hint = document.createElement('div');
    hint.className = 'tabhint';
    hint.textContent = 'Choose a recording area on the next screen.';
    pane.appendChild(hint);
  }
}

async function load() {
  const list = document.getElementById('list');
  const loading = document.createElement('li');
  loading.className = 'none';
  loading.textContent = 'Loading sources…';
  list.textContent = '';
  list.appendChild(loading);

  try {
    allSources = await window.loupe.listSources();
    renderTabs();
    renderList();
  } catch (err) {
    allSources = [];
    renderTabs();
    list.textContent = '';
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = `Could not list sources: ${err.message}`;
    list.appendChild(li);
  }
  renderPreview();
  renderHint();
  await refreshPermissions();
}

const refreshButton = document.getElementById('refresh');
refreshButton.onclick = async () => {
  refreshButton.disabled = true;
  refreshButton.textContent = 'Refreshing…';
  // Keep the current selection across a refresh if that source still exists,
  // so re-scanning to find one window does not discard the one already chosen.
  const previousId = selected?.id;
  await load();
  selected = allSources.find((s) => s.id === previousId) ?? null;
  renderList();
  renderPreview();
  await refreshPermissions();
  refreshButton.textContent = 'Refresh';
  refreshButton.disabled = false;
};

const recordButton = document.getElementById('record');

recordButton.onclick = async () => {
  if (!selected) return;
  recordButton.disabled = true;
  recordButton.textContent = 'Continuing…';
  try {
    // width/height/title/x/y come straight from the bin/sources entry the
    // user picked, in logical points — the camera solver and recorder both
    // expect points, converting to pixels only at render time. x/y are the
    // source's global-space origin; `?? 0` covers a stale/older bin/sources
    // build whose entries don't carry it yet. This only ARMS the control
    // bar -- recording begins when Start is pressed there, not here.
    await window.loupe.armRecording({
      source: selected.id,
      width: selected.width,
      height: selected.height,
      x: selected.x ?? 0,
      y: selected.y ?? 0,
      title: selected.title,
      mic: document.getElementById('mic').checked
    });
  } catch (err) {
    recordButton.textContent = 'Continue';
    recordButton.disabled = !latestPermissions?.canRecord || !selected;
    const banner = document.getElementById('banner');
    banner.hidden = false;
    banner.textContent = `Could not continue: ${err.message}`;
  }
};

// ---- zoom shortcuts ---------------------------------------------------------
// The two shortcut fields (click one, press a button) are shared with the
// Settings window: src/renderer/shared/zoom-shortcuts.js. Only the header
// line that spells out what's set belongs to the picker.
const zoomShortcuts = window.loupeZoomShortcuts.mount({
  captureEls: [...document.querySelectorAll('.capture')],
  clearEls: [...document.querySelectorAll('.clear')],
  onRender: (triggers) => {
    const help = document.getElementById('zoomHelp');
    const any = window.loupeZoomShortcuts.describe(help, triggers, {
      after: ' and scroll while recording: scroll up to zoom in, back down to zoom out.'
    });
    if (!any) help.textContent = 'Zoom is off — set a zoom shortcut below to turn it on.';
  },
  onError: (err) => {
    const banner = document.getElementById('banner');
    banner.hidden = false;
    banner.textContent = `Could not save the zoom shortcut: ${err.message}`;
  }
});

window.loupe.getSettings().then((s) => zoomShortcuts.set(s.zoomTriggers));
// Changed in the Settings window while this one is open.
window.loupe.onSettingsChanged?.((s) => zoomShortcuts.set(s.zoomTriggers));

document.getElementById('recordings').onclick = () => window.loupe.openLibrary();

// ---- recording additions ------------------------------------------------------
// Computer sound, the camera bubble, keyboard shortcuts and the countdown.
// Saved as soon as they change (main.js, recording-settings.js) and read by
// main when recording starts, so nothing here has to be passed along.

const recordingSwitches = ['systemAudio', 'recordKeys', 'countdown'];
const cameraSwitch = document.getElementById('camera');
const cameraSelect = document.getElementById('cameraDevice');
const cameraNote = document.getElementById('cameraNote');

function showBanner(text, pane) {
  const banner = document.getElementById('banner');
  banner.hidden = false;
  banner.textContent = text;
  if (pane) addPaneButton(banner, 'Open Settings', pane);
}

async function saveRecording(patch) {
  try {
    return await window.loupe.setRecordingSettings(patch);
  } catch (err) {
    showBanner(`Could not save that choice: ${err.message}`);
    return null;
  }
}

function setCameraNote(text) {
  cameraNote.textContent = text;
  cameraNote.hidden = !text;
}

async function videoInputs() {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

// Camera names are only shown to a page that has used a camera once, so when
// they are missing the camera is opened for a moment first. Returns the
// cameras found.
async function listCameras(selectedId) {
  let cameras = await videoInputs();
  if (cameras.some((c) => !c.label)) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      for (const track of probe.getTracks()) track.stop();
    } catch {
      // Unnamed cameras are still cameras.
    }
    cameras = await videoInputs();
  }
  cameraSelect.textContent = '';
  cameras.forEach((cam, i) => {
    const option = document.createElement('option');
    option.value = cam.deviceId;
    // Device labels come from drivers: textContent, never innerHTML.
    option.textContent = cam.label || `Camera ${i + 1}`;
    cameraSelect.appendChild(option);
  });
  if (cameras.some((c) => c.deviceId === selectedId)) cameraSelect.value = selectedId;
  cameraSelect.hidden = cameras.length < 2;
  return cameras;
}

async function turnCameraOn(selectedId) {
  setCameraNote('');
  const allowed = await window.loupe.requestCamera();
  if (!allowed) {
    cameraSwitch.checked = false;
    cameraSelect.hidden = true;
    showBanner('Loupe needs permission to use the camera. ', 'camera');
    await saveRecording({ camera: false });
    return;
  }
  const cameras = await listCameras(selectedId);
  if (cameras.length === 0) {
    cameraSwitch.checked = false;
    setCameraNote('No camera found');
    await saveRecording({ camera: false });
    return;
  }
  await saveRecording({ camera: true, cameraDeviceId: cameraSelect.value || null });
}

cameraSwitch.addEventListener('change', async () => {
  if (cameraSwitch.checked) {
    await turnCameraOn(cameraSelect.value || null);
  } else {
    cameraSelect.hidden = true;
    setCameraNote('');
    await saveRecording({ camera: false });
  }
});

cameraSelect.addEventListener('change', () => {
  saveRecording({ cameraDeviceId: cameraSelect.value || null });
});

for (const id of recordingSwitches) {
  document.getElementById(id).addEventListener('change', (e) => {
    saveRecording({ [id]: e.target.checked });
  });
}

// The Settings window changes the same choices; the switches follow it.
window.loupe.onSettingsChanged?.(async () => {
  const s = await window.loupe.getRecordingSettings();
  for (const id of recordingSwitches) document.getElementById(id).checked = s[id];
});

window.loupe.getRecordingSettings().then(async (s) => {
  for (const id of recordingSwitches) document.getElementById(id).checked = s[id];
  cameraSwitch.checked = s.camera;
  // Still there, still allowed? Otherwise the switch goes off with a reason.
  if (s.camera) await turnCameraOn(s.cameraDeviceId);
});

window.addEventListener('focus', refreshPermissions);
load();
