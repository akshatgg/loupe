// The toolbar between the preview and the timeline: the things to add (a
// zoom, text, a blur, a voiceover, more video or sound), and the two
// switches for how the timeline behaves -- Snap and Close gaps.
//
// The switches are remembered in this page's localStorage (the app's own
// profile), like the first-run card: they are how a person likes to work,
// not part of any one video.

import { h, icon } from './ui.js';
import { LOWER_THIRDS } from '../../core/text-style.js';

const KEYS = { snap: 'loupe.snap', closeGaps: 'loupe.closeGaps', transcript: 'loupe.transcript' };

// A remembered on/off choice; on unless it was switched off.
export function readSwitch(storage, key, fallback = true) {
  try {
    const v = storage?.getItem(key);
    return v === null || v === undefined ? fallback : v !== 'off';
  } catch {
    return fallback;
  }
}

export function writeSwitch(storage, key, on) {
  try {
    storage?.setItem(key, on ? 'on' : 'off');
  } catch {
    // Storage unavailable: the choice lasts until the window closes.
  }
}

export { KEYS as SWITCH_KEYS };

// A button that opens a small menu above it. items: [{ id, icon, label, hint?, run }]
function menuButton({ id, iconName, label, title, items, menus }) {
  const menu = h('div', { class: 'tool-menu', role: 'menu', hidden: true, 'aria-label': label },
    items.map((it) => h('button', {
      type: 'button', role: 'menuitem', id: it.id, class: 'tool-menu-item', title: it.hint,
      onclick: () => { close(); it.run(); }
    }, icon(it.icon, { size: 17 }), h('span', {}, it.label))));
  const button = h('button', {
    type: 'button', class: 'tool', id, title, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onclick: () => (menu.hidden ? open() : close())
  }, icon(iconName), label, h('span', { class: 'tool-caret', 'aria-hidden': 'true' }, '▾'));
  const wrap = h('div', { class: 'tool-wrap' }, button, menu);
  function open() {
    for (const m of menus) m.close();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    menu.querySelector('button')?.focus();
  }
  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }
  menu.addEventListener('keydown', (e) => {
    const all = [...menu.querySelectorAll('button')];
    const i = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      button.focus();
    }
  });
  const api = { el: wrap, close, get open() { return !menu.hidden; }, contains: (t) => wrap.contains(t) };
  menus.push(api);
  return api;
}

function switchButton({ id, iconName, label, title, on, onChange }) {
  const b = h('button', { type: 'button', class: 'tool tool-switch', id, title, 'aria-pressed': String(on) }, icon(iconName, { size: 16 }), label);
  b.addEventListener('click', () => {
    const next = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(next));
    onChange(next);
  });
  return b;
}

// `actions`: the editor's commands (editor.js). Returns the switches' state.
export function createToolbar({ tools, options, actions, storage = globalThis.localStorage }) {
  const menus = [];
  const state = {
    snap: readSwitch(storage, KEYS.snap),
    closeGaps: readSwitch(storage, KEYS.closeGaps),
    transcript: readSwitch(storage, KEYS.transcript, false)
  };
  const listeners = new Set();
  const set = (key, on) => {
    state[key] = on;
    writeSwitch(storage, KEYS[key], on);
    for (const fn of listeners) fn(key, on);
  };
  const tool = (id, iconName, label, title, run) => h('button', { type: 'button', class: 'tool', id, title, onclick: run }, icon(iconName), label);

  const text = menuButton({
    id: 'textBtn', iconName: 'text', label: 'Text', title: 'Add text, a title card, an arrow or a box at the playhead', menus,
    items: [
      { id: 'addText', icon: 'text', label: 'Text', hint: 'Words on the video (T)', run: () => actions.addText() },
      { id: 'addTitle', icon: 'titleCard', label: 'Title card', hint: 'A full-screen card that fades in and out', run: () => actions.addAnnotation('title') },
      { id: 'addArrow', icon: 'arrow', label: 'Arrow', hint: 'Point at something', run: () => actions.addAnnotation('arrow') },
      { id: 'addBox', icon: 'box', label: 'Box', hint: 'Frame something', run: () => actions.addAnnotation('box') },
      // Ready-made text styles (core/text-style.js).
      ...LOWER_THIRDS.map((t) => ({ id: `addLowerThird-${t.id}`, icon: 'text', label: t.label, hint: t.hint, run: () => actions.addLowerThird(t.id) }))
    ]
  });
  const add = menuButton({
    id: 'addBtn', iconName: 'plus', label: 'Add', title: 'Add another recording, sound, or a picture or video over the video', menus,
    items: [
      { id: 'addRecBtn', icon: 'clips', label: 'Another recording or video', hint: 'Plays after this one', run: () => actions.addRecording() },
      { id: 'addAudioBtn', icon: 'music', label: 'Songs or sound files', hint: 'Each becomes a clip on the audio rows', run: () => actions.addAudio() },
      { id: 'addOverlayBtn', icon: 'image', label: 'Picture or video on top', hint: 'A logo, picture or video over the video', run: () => actions.addOverlay() }
    ]
  });
  tools.replaceChildren(
    tool('splitBtn', 'split', 'Split', 'Split at the playhead (S)', () => actions.split()),
    tool('zoomBtn', 'zoomAdd', 'Zoom', 'Add a zoom at the playhead (Z)', () => actions.addZoom()),
    text.el,
    tool('blurBtn', 'blur', 'Blur', 'Hide something at the playhead (B)', () => actions.addBlur()),
    tool('voiceBtn', 'mic', 'Voice', 'Record a voiceover at the playhead', () => actions.recordVoiceover()),
    add.el,
    h('span', { class: 'tool-sep', 'aria-hidden': 'true' }),
    tool('cutBtn', 'cut', 'Cut', 'Cut by typing times (X)', () => actions.cut()),
    tool('deleteBtn', 'trash', 'Delete', 'Delete what’s selected (Delete)', () => actions.delete())
  );
  options.replaceChildren(
    switchButton({
      id: 'transcriptBtn', iconName: 'captions', label: 'Transcript', on: state.transcript,
      title: 'Show what was said beside the video', onChange: (on) => set('transcript', on)
    }),
    switchButton({
      id: 'snapBtn', iconName: 'snap', label: 'Snap', on: state.snap,
      title: 'Edges and clips jump to the playhead, clip edges and markers when dragged near them', onChange: (on) => set('snap', on)
    }),
    switchButton({
      id: 'gapsBtn', iconName: 'gaps', label: 'Close gaps', on: state.closeGaps,
      title: 'When a clip is deleted, the later ones move up. Off: its place stays, black.', onChange: (on) => set('closeGaps', on)
    })
  );
  document.addEventListener('pointerdown', (e) => {
    for (const m of menus) if (m.open && !m.contains(e.target)) m.close();
  });
  return {
    get snap() { return state.snap; },
    get closeGaps() { return state.closeGaps; },
    get transcript() { return state.transcript; },
    get menuOpen() { return menus.some((m) => m.open); },
    closeMenus: () => { for (const m of menus) m.close(); },
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
