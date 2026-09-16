// "Add recording": pick another recording from the Library and it plays after
// this one, as a new clip at the end of the timeline (one undo step). Main
// checks the choice and adds the recording's files to the project
// (src/main/ipc/append-recording.js); the edit itself is the core's
// appendRecording, plus the zooms that recording already had.

import { h, icon } from './ui.js';
import { plainError } from './export-dialog.js';
import { formatTime } from './timeline-math.js';

export function createAddRecording({ store, player, loupe, core, toast, onAdded = () => {} }) {
  const dialog = h('dialog', { class: 'add-recording', 'aria-labelledby': 'addRecTitle' });
  const list = h('div', { class: 'rec-list', role: 'list' });
  const note = h('p', { class: 'hint rec-note' });
  dialog.append(
    h('button', { type: 'button', class: 'icon-btn close', 'aria-label': 'Close', onclick: () => dialog.close() }, icon('close')),
    h('h2', { id: 'addRecTitle' }, 'Add a recording'),
    h('p', { class: 'hint rec-sub' }, 'It plays after the end of this video. You can move or trim it like any clip.'),
    list, note);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  document.body.append(dialog);
  let busy = false;

  function row(rec) {
    const thumb = h('div', { class: 'rec-thumb' });
    const show = (url) => { if (url) thumb.replaceChildren(h('img', { src: url, alt: '' })); };
    if (rec.thumbnail) show(rec.thumbnail);
    else loupe.recordingThumbnail(rec.id).then(show).catch(() => {});
    const when = new Date(rec.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    return h('button', {
      type: 'button', class: 'rec-row', role: 'listitem', dataset: { id: rec.id },
      onclick: () => add(rec)
    },
    thumb,
    h('span', { class: 'rec-text' },
      h('span', { class: 'rec-title' }, rec.title),
      h('span', { class: 'rec-meta' }, [when, rec.duration ? formatTime(rec.duration) : null].filter(Boolean).join(' · '))),
    h('span', { class: 'rec-add' }, icon('plus', { size: 16 }), 'Add'));
  }

  async function add(rec) {
    if (busy) return;
    busy = true;
    note.textContent = 'Adding…';
    try {
      const added = await loupe.appendRecording(rec.id);
      const next = store.apply((p) => {
        let q = core.appendRecording(p, added.key, added.meta);
        for (const z of added.zooms) {
          try {
            q = core.addZoom(q, { source: added.key, ...z });
          } catch {
            // A zoom that no longer fits is left out; the recording matters.
          }
        }
        return q;
      });
      if (!next) return;
      player.addSource(added.key, added.files);
      dialog.close();
      // Show where it went: the start of the new clip.
      const first = next.clips.findIndex((c) => c.source === added.key);
      const bounds = store.tl.clipBounds()[first];
      if (bounds) player.seek(bounds.outStart);
      onAdded(added);
      toast(`Added “${rec.title}” at the end`);
    } catch (err) {
      note.textContent = plainError(err);
    } finally {
      busy = false;
      if (note.textContent === 'Adding…') note.textContent = '';
    }
  }

  async function show() {
    note.textContent = '';
    list.replaceChildren(h('p', { class: 'hint rec-empty' }, 'Loading your recordings…'));
    if (!dialog.open) dialog.showModal();
    let recordings = [];
    try {
      recordings = await loupe.listRecordings();
    } catch (err) {
      list.replaceChildren(h('p', { class: 'hint rec-empty' }, `Your recordings couldn’t be listed: ${plainError(err)}`));
      return;
    }
    if (!recordings.length) {
      list.replaceChildren(h('div', { class: 'rec-empty' },
        h('div', { class: 'empty-icon' }, icon('clips', { size: 26 })),
        h('p', {}, 'There are no other recordings yet. Make another recording, then add it here.')));
      return;
    }
    list.replaceChildren(...recordings.map(row));
  }

  return {
    show,
    close: () => dialog.close(),
    get isOpen() { return dialog.open; }
  };
}
