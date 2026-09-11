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
// Two slots, each set by clicking it and then pressing the button you want.
// Saved in main.js (settings.js) and handed to bin/inputtap at record time.
// Only buttons you can HOLD while scrolling without side effects are taken:
// modifier keys and the middle/side mouse buttons. A letter key would type
// into whatever is being recorded; left/right click are needed for the demo.

const TRIGGERS = {
  option: { label: '⌥ Option', key: '⌥' },
  control: { label: '⌃ Control', key: '⌃' },
  command: { label: '⌘ Command', key: '⌘' },
  shift: { label: '⇧ Shift', key: '⇧' },
  'mouse-side': { label: '🖱 Mouse side button', words: 'a mouse side button' },
  'mouse-middle': { label: '🖱 Middle mouse button', words: 'the middle mouse button' }
};
const KEY_TRIGGERS = { Alt: 'option', Control: 'control', Meta: 'command', Shift: 'shift' };
// MouseEvent.button: 1 middle, 3 back, 4 forward (0/2 are left/right).
const MOUSE_TRIGGERS = { 1: 'mouse-middle', 3: 'mouse-side', 4: 'mouse-side' };

const PROMPT = 'Press a key or mouse button…';
const captureEls = [...document.querySelectorAll('.capture')];
const clearEls = [...document.querySelectorAll('.clear')];

let zoomTriggers = [null, null];
let capturing = null; // slot index being set, or null
let refusedTimer = null;

// The header line spells out whatever is currently set. Built with DOM nodes
// rather than innerHTML, like the rest of this window.
function renderZoomHelp() {
  const help = document.getElementById('zoomHelp');
  help.textContent = '';
  const set = zoomTriggers.filter(Boolean);
  if (set.length === 0) {
    help.textContent = 'Zoom is off — set a zoom shortcut below to turn it on.';
    return;
  }
  help.append('Hold ');
  set.forEach((t, i) => {
    if (i > 0) help.append(' or ');
    if (TRIGGERS[t].key) {
      const kbd = document.createElement('kbd');
      kbd.textContent = TRIGGERS[t].key;
      help.append(kbd);
    } else {
      help.append(TRIGGERS[t].words);
    }
  });
  help.append(' and scroll while recording: scroll up to zoom in, back down to zoom out.');
}

function renderShortcuts() {
  captureEls.forEach((el, slot) => {
    const t = zoomTriggers[slot];
    el.classList.toggle('capturing', capturing === slot);
    el.classList.remove('refused');
    el.classList.toggle('empty', !t && capturing !== slot);
    el.textContent = capturing === slot ? PROMPT : (t ? TRIGGERS[t].label : 'Click to set');
    clearEls[slot].hidden = !t || capturing === slot;
  });
  renderZoomHelp();
}

function stopCapture() {
  clearTimeout(refusedTimer);
  capturing = null;
  renderShortcuts();
}

// Says why a button wasn't taken, in the field itself, then goes back to
// waiting for another press.
function refuse(message) {
  const el = captureEls[capturing];
  clearTimeout(refusedTimer);
  el.classList.add('refused');
  el.textContent = message;
  refusedTimer = setTimeout(() => {
    if (capturing === null) return;
    el.classList.remove('refused');
    el.textContent = PROMPT;
  }, 1600);
}

async function saveTriggers(next) {
  try {
    ({ zoomTriggers } = await window.loupe.setSettings({ zoomTriggers: next }));
  } catch (err) {
    const banner = document.getElementById('banner');
    banner.hidden = false;
    banner.textContent = `Could not save the zoom shortcut: ${err.message}`;
  }
  renderShortcuts();
}

function commit(trigger) {
  const slot = capturing;
  if (zoomTriggers[1 - slot] === trigger) {
    refuse('Already your other shortcut');
    return;
  }
  const next = [...zoomTriggers];
  next[slot] = trigger;
  capturing = null;
  clearTimeout(refusedTimer);
  saveTriggers(next);
}

captureEls.forEach((el, slot) => {
  el.addEventListener('click', () => {
    capturing = slot;
    renderShortcuts();
  });
});
clearEls.forEach((el, slot) => {
  el.addEventListener('click', () => {
    const next = [...zoomTriggers];
    next[slot] = null;
    saveTriggers(next);
  });
});

// Capture phase, so nothing else in the window reacts to the press being
// recorded (e.g. Space/Enter re-"clicking" the focused field).
document.addEventListener('keydown', (e) => {
  if (capturing === null) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { stopCapture(); return; }
  const trigger = KEY_TRIGGERS[e.key];
  if (trigger) commit(trigger);
  else refuse('Use ⌥ ⌃ ⌘ ⇧ or a mouse button');
}, true);

document.addEventListener('mousedown', (e) => {
  if (capturing === null) return;
  const trigger = MOUSE_TRIGGERS[e.button];
  if (trigger) {
    e.preventDefault();
    e.stopPropagation();
    commit(trigger);
  } else if (e.button === 2) {
    e.preventDefault();
    refuse('Use a side or middle mouse button');
  } else if (e.target !== captureEls[capturing]) {
    stopCapture(); // an ordinary click elsewhere just cancels
  }
}, true);

// A side button's release would otherwise also count as browser Back/Forward.
for (const type of ['mouseup', 'auxclick']) {
  document.addEventListener(type, (e) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  }, true);
}
window.addEventListener('blur', () => { if (capturing !== null) stopCapture(); });

window.loupe.getSettings().then((s) => {
  zoomTriggers = s.zoomTriggers;
  renderShortcuts();
});

window.addEventListener('focus', refreshPermissions);
load();
