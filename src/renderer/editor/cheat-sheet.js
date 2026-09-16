// The "?" keyboard shortcuts sheet.

import { h, icon } from './ui.js';
import { cheatSheet } from './shortcuts.js';

export function createCheatSheet(platform) {
  const dialog = h('dialog', { class: 'cheat-sheet', 'aria-labelledby': 'cheatTitle' });
  const groups = cheatSheet(platform).map((g) => h('section', {},
    h('h3', {}, g.group),
    ...g.items.map((item) => h('div', { class: 'cheat-row' },
      h('span', {}, item.what),
      h('span', { class: 'keys' }, ...item.keys.map((k) => h('kbd', {}, k)))))));
  dialog.append(
    h('button', { type: 'button', class: 'icon-btn close', 'aria-label': 'Close', onclick: () => dialog.close() }, icon('close')),
    h('h2', { id: 'cheatTitle' }, 'Keyboard shortcuts'),
    h('div', { class: 'cheat-grid' }, ...groups));
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  document.body.append(dialog);
  return {
    toggle() {
      if (dialog.open) dialog.close();
      else dialog.showModal();
    },
    get open() { return dialog.open; }
  };
}
