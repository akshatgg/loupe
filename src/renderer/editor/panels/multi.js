// Several things selected: what can be done to all of them at once.

import { h, icon, section } from '../ui.js';

const NAMES = {
  clip: ['clip', 'clips'], zoom: ['zoom', 'zooms'], annotation: ['annotation', 'annotations'],
  caption: ['caption', 'captions'], audio: ['audio clip', 'audio clips'], overlay: ['overlay', 'overlays'],
  marker: ['marker', 'markers'], speed: ['speed change', 'speed changes']
};

// "2 zooms, 1 clip"
export function describeItems(items) {
  const counts = new Map();
  for (const it of items) counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
  return [...counts].map(([kind, n]) => `${n} ${(NAMES[kind] ?? [kind, `${kind}s`])[n === 1 ? 0 : 1]}`).join(', ');
}

export default {
  id: 'multi',
  title: 'Selection',
  icon: 'clips',
  mount(container, editor) {
    const { store } = editor;
    const what = h('p', { class: 'muted', id: 'multiWhat' });
    const remove = h('button', {
      type: 'button', class: 'btn danger-quiet', id: 'multiDelete', title: 'Delete everything selected (Delete)',
      onclick: () => editor.deleteSelected()
    }, icon('trash'), 'Delete all');
    const clear = h('button', { type: 'button', class: 'btn', id: 'multiClear', onclick: () => store.select(null) }, 'Deselect');
    container.append(section(null, what), section(null, h('div', { class: 'btn-row' }, remove, clear)),
      section(null, h('p', { class: 'hint' }, 'Select one thing to change its settings.')));
    function update() {
      what.textContent = describeItems(store.selected);
    }
    update();
    return { update };
  }
};
