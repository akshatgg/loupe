'use strict';
let selected = null;
let latestPermissions = null;

const BROWSERS = ['Chrome', 'Chromium', 'Edge', 'Brave', 'Arc', 'Safari'];

async function refreshPermissions() {
  const p = await window.loupe.permissions();
  latestPermissions = p;
  const banner = document.getElementById('banner');
  if (!p.screenRecording) {
    banner.hidden = false;
    banner.innerHTML = 'Loupe needs Screen Recording permission to capture your screen. ';
    addPaneButton(banner, 'Open Settings', 'screenRecording');
  } else if (!p.accessibility) {
    banner.hidden = false;
    banner.innerHTML = 'Zoom is off: Loupe needs Accessibility permission to read the scroll wheel. Recording still works. ';
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

function card(source) {
  const el = document.createElement('div');
  el.className = 'card';

  const img = document.createElement('img');
  img.src = source.thumbnail ?? '';
  img.alt = '';
  el.appendChild(img);

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = source.app ? `${source.app} — ${source.title}` : source.title;
  el.appendChild(title);

  // PRD FR-7: the OS cannot capture a single browser tab, so tell the user
  // the one move that makes it possible instead of leaving them hunting.
  if (source.kind === 'window' && BROWSERS.some((b) => (source.app ?? '').includes(b))) {
    const hint = document.createElement('div');
    hint.className = 'tabhint';
    hint.textContent = 'Recording one tab? Drag it out into its own window first.';
    el.appendChild(hint);
  }
  el.onclick = () => {
    document.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
    el.classList.add('selected');
    selected = source;
    refreshPermissions();
  };
  return el;
}

async function load() {
  const grid = document.getElementById('grid');
  grid.textContent = 'Loading sources…';
  try {
    const sources = await window.loupe.listSources();
    grid.textContent = '';
    if (sources.length === 0) {
      grid.classList.add('empty');
      grid.textContent = 'No displays or windows found.';
    } else {
      grid.classList.remove('empty');
      sources.forEach((s) => grid.appendChild(card(s)));
    }
  } catch (err) {
    grid.classList.add('empty');
    grid.textContent = `Could not list sources: ${err.message}`;
  }
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
    await window.loupe.startRecording({
      source: selected.id,
      width: selected.width,
      height: selected.height,
      x: selected.x ?? 0,
      y: selected.y ?? 0,
      title: selected.title,
      mic: document.getElementById('mic').checked
    });
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
