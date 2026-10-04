// A folded "Advanced" part at the end of an inspector: the settings most
// people never need, one click away. Whether it is open is remembered per
// inspector in this page's localStorage (the app's own profile), not in the
// project.

import { h } from './ui.js';

const KEY = (name) => `loupe.advanced.${name}`;

function remembered(storage, name) {
  try { return storage?.getItem(KEY(name)) === 'open'; } catch { return false; }
}

// advanced('overlay', { id }, ...children) -> a <details> element.
export function advanced(name, { id, storage = globalThis.localStorage } = {}, ...children) {
  const el = h('details', { class: 'advanced', id },
    h('summary', {}, 'Advanced'),
    h('div', { class: 'advanced-body' }, ...children));
  el.open = remembered(storage, name);
  el.addEventListener('toggle', () => {
    try { storage?.setItem(KEY(name), el.open ? 'open' : 'closed'); } catch { /* private mode: not remembered */ }
  });
  return el;
}
