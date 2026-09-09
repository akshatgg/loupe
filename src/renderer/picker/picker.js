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
  // Accessibility grant must never disable the Start button, only zoom.
  document.getElementById('record').disabled = !p.canRecord || !selected;
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
      // it is hidden under another tab makes the enabled Start button look as
      // though it belongs to whatever is on screen now.
      selected = null;
      renderTabs();
      renderList();
      renderPreview();
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
  await refreshPermissions();
}

const recordButton = document.getElementById('record');

recordButton.onclick = async () => {
  if (!selected) return;
  recordButton.disabled = true;
  recordButton.textContent = 'Starting…';
  try {
    // width/height/title/x/y come straight from the bin/sources entry the
    // user picked, in logical points — the camera solver and recorder both
    // expect points, converting to pixels only at render time. x/y are the
    // source's global-space origin; `?? 0` covers a stale/older bin/sources
    // build whose entries don't carry it yet.
    const result = await window.loupe.startRecording({
      source: selected.id,
      width: selected.width,
      height: selected.height,
      x: selected.x ?? 0,
      y: selected.y ?? 0,
      title: selected.title,
      mic: document.getElementById('mic').checked
    });
    // Microphone was requested but denied: main.js already fell back to
    // recording without it rather than failing the whole session outright.
    // The user asked for audio and silently not getting it would confuse.
    if (result?.micRequested && !result.mic) {
      const banner = document.getElementById('banner');
      banner.hidden = false;
      banner.textContent = 'Recording started without audio: microphone permission was denied.';
    }
  } catch (err) {
    recordButton.textContent = 'Start recording';
    recordButton.disabled = !latestPermissions?.canRecord || !selected;
    const banner = document.getElementById('banner');
    banner.hidden = false;
    banner.textContent = `Could not start recording: ${err.message}`;
  }
};

window.addEventListener('focus', refreshPermissions);
load();
