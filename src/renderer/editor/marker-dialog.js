// A marker's name and colour, or deleting it: opened by double-clicking its
// flag on the ruler. Each change is one undo step.

import { h, icon } from './ui.js';
import { formatTime } from './timeline-math.js';

const COLORS = { yellow: '#fdd663', red: '#f28b82', green: '#81c995', blue: '#8ab4f8', purple: '#d7aefb' };

export function createMarkerDialog({ store, core, editor }) {
  const dialog = h('dialog', { class: 'marker-dialog', 'aria-labelledby': 'markerTitle' });
  const name = h('input', { type: 'text', id: 'markerName', class: 'time-input', placeholder: 'Name this moment', maxLength: 200, autocomplete: 'off' });
  const when = h('p', { class: 'hint' });
  const swatches = h('div', { class: 'marker-colors', role: 'radiogroup', 'aria-label': 'Colour' });
  let id = null;

  const change = (patch) => { if (id) store.apply((p) => core.updateMarker(p, id, patch)); };
  for (const [color, css] of Object.entries(COLORS)) {
    swatches.append(h('button', {
      type: 'button', class: 'marker-swatch', role: 'radio', dataset: { color }, title: color,
      'aria-label': color, style: { background: css },
      onclick: () => { change({ color }); show(id); }
    }));
  }
  name.addEventListener('change', () => change({ label: name.value.trim() }));
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); dialog.close(); } });

  dialog.append(
    h('button', { type: 'button', class: 'icon-btn close', 'aria-label': 'Close', onclick: () => dialog.close() }, icon('close')),
    h('h2', { id: 'markerTitle' }, 'Marker'),
    when,
    h('label', { class: 'field', for: 'markerName' }, h('span', { class: 'label' }, 'Name'), name),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Colour'), swatches),
    h('div', { class: 'cut-actions' },
      h('button', {
        type: 'button', class: 'btn danger-quiet', id: 'deleteMarker',
        onclick: () => {
          if (id) store.apply((p) => core.removeMarker(p, id));
          editor.select(null);
          dialog.close();
        }
      }, icon('trash', { size: 16 }), 'Delete'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => { name.blur(); dialog.close(); } }, 'Done')));
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  // A name typed and then closed without Enter is still kept.
  dialog.addEventListener('close', () => {
    const m = store.project.markers.find((q) => q.id === id);
    if (m && name.value.trim() !== m.label) change({ label: name.value.trim() });
  });
  document.body.append(dialog);

  function show(markerId) {
    const m = store.project.markers.find((q) => q.id === markerId);
    if (!m) return;
    id = markerId;
    name.value = m.label;
    when.textContent = `At ${formatTime(m.t, { fraction: true })}`;
    for (const b of swatches.children) b.setAttribute('aria-checked', String(b.dataset.color === m.color));
    if (!dialog.open) dialog.showModal();
    name.focus();
    name.select();
  }

  return { show, get isOpen() { return dialog.open; } };
}
