// The first time the editor opens, a small card over the preview says the
// three things worth knowing, in three short lines. It never blocks anything,
// goes away with "Got it" (or Escape), and doesn't come back.
//
// Remembered in this page's localStorage: it lives in the app's own profile,
// and forgetting it (a reset profile) only means seeing the card once more.

import { h, icon } from './ui.js';

const KEY = 'loupe.editor.firstRunHintSeen';

export const HINT_LINES = [
  { icon: 'clips', text: 'Drag the ends of a clip to trim it.' },
  { icon: 'split', text: 'Press S to split the clip at the playhead.' },
  { icon: 'zoom', text: 'Drag across the Zoom track to zoom in there.' }
];

function seen(storage) {
  try {
    return storage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function createFirstRunHint({ parent, storage = globalThis.localStorage } = {}) {
  let card = null;

  function dismiss() {
    if (!card) return;
    try {
      storage?.setItem(KEY, '1');
    } catch {
      // Private storage unavailable: it just shows again next time.
    }
    card.remove();
    card = null;
  }

  function show() {
    if (card || seen(storage)) return false;
    card = h('section', { class: 'first-run', role: 'note', 'aria-labelledby': 'firstRunTitle' },
      h('h2', { id: 'firstRunTitle' }, 'Editing your video'),
      h('ul', {}, ...HINT_LINES.map((line) => h('li', {}, icon(line.icon, { size: 16 }), h('span', {}, line.text)))),
      h('button', { type: 'button', class: 'btn primary small', onclick: dismiss }, 'Got it'));
    parent.append(card);
    return true;
  }

  return {
    show,
    dismiss,
    get open() { return Boolean(card); },
    // For tests: forget that it was seen.
    reset() {
      try { storage?.removeItem(KEY); } catch { /* nothing to forget */ }
    }
  };
}
