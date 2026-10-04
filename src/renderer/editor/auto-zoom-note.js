// The note over the preview of a new recording that Loupe zoomed for:
// "Loupe added 6 zooms where you clicked", with Keep, Fewer and Remove all.
// The project carries it (`autoZoomNote`) until one is chosen; any of the
// three is an ordinary edit, so undo brings the zooms (and the note) back.

import { h } from './ui.js';
import { applyAutoZooms, removeAutoZooms, setAutoZoomNote, autoZoomCount } from '../../core/project.js';

// "Loupe added 1 zoom where you clicked." / "... 6 zooms ..."
export function noteText(count) {
  return `Loupe added ${count} ${count === 1 ? 'zoom' : 'zooms'} where you clicked.`;
}

export function createAutoZoomNote({ parent, store, toast }) {
  let card = null;
  const answer = (edit, said) => {
    store.apply(edit);
    if (said) toast(said);
  };
  function render() {
    const p = store.project;
    const count = autoZoomCount(p);
    const wanted = p.autoZoomNote === true && count > 0;
    if (!wanted) {
      card?.remove();
      card = null;
      return;
    }
    const body = [
      h('p', { id: 'zoomNoteText' }, noteText(count)),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn small primary', id: 'zoomNoteKeep', onclick: () => answer((q) => setAutoZoomNote(q, false)) }, 'Keep'),
        h('button', {
          type: 'button', class: 'btn small', id: 'zoomNoteFewer', title: 'Gentler zooms, only where you clicked more than once',
          onclick: () => answer((q) => applyAutoZooms(q, { strength: 'subtle' }), 'Fewer, gentler zooms')
        }, 'Fewer'),
        h('button', {
          type: 'button', class: 'btn small', id: 'zoomNoteRemove',
          onclick: () => answer((q) => removeAutoZooms(q), 'Automatic zooms removed. The Zoom button brings them back.')
        }, 'Remove all'))
    ];
    if (!card) {
      card = h('section', { class: 'zoom-note', role: 'note', 'aria-labelledby': 'zoomNoteText' });
      parent.append(card);
    }
    card.replaceChildren(...body);
  }
  store.subscribe((what) => { if (what !== 'selection') render(); });
  render();
  return { get open() { return Boolean(card); } };
}
