// "Cut": type a From and a To time, then remove that part of the video or
// keep only it. Times are the timeline's own (what the time readout shows).
// timeline-math.js cutRanges decides what to cut away; the core's cutRange
// does each cut, and the whole thing is one undo step.

import { h, icon } from './ui.js';
import { plainError } from './export-dialog.js';
import { formatTime, parseTime, cutRanges } from './timeline-math.js';

export function createCutDialog({ store, player, core, toast }) {
  const dialog = h('dialog', { class: 'cut-dialog', 'aria-labelledby': 'cutTitle' });
  const field = (id, label) => {
    const input = h('input', {
      type: 'text', id, class: 'time-input', inputMode: 'decimal', spellcheck: 'false', autocomplete: 'off',
      placeholder: '0:00'
    });
    return { input, el: h('label', { class: 'field cut-field', for: id }, h('span', { class: 'label' }, label), input) };
  };
  const from = field('cutFrom', 'From');
  const to = field('cutTo', 'To');
  const length = h('p', { class: 'hint cut-length' });
  const note = h('p', { class: 'hint cut-note', role: 'alert' });
  const remove = h('button', { type: 'button', class: 'btn', id: 'cutRemove', onclick: () => run('remove') }, 'Remove this part');
  const keep = h('button', { type: 'button', class: 'btn primary', id: 'cutKeep', onclick: () => run('keep') }, 'Keep only this part');
  dialog.append(
    h('button', { type: 'button', class: 'icon-btn close', 'aria-label': 'Close', onclick: () => dialog.close() }, icon('close')),
    h('h2', { id: 'cutTitle' }, 'Cut by time'),
    h('p', { class: 'hint cut-sub' }, 'Type times like 1:30 or 90 (seconds).'),
    h('div', { class: 'cut-fields' }, from.el, to.el),
    length, note,
    h('div', { class: 'cut-actions' }, remove, keep));
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  for (const f of [from, to]) f.input.addEventListener('input', () => { note.textContent = ''; });
  document.body.append(dialog);

  function run(mode) {
    const duration = store.tl.duration;
    const a = parseTime(from.input.value);
    const b = parseTime(to.input.value);
    const plan = cutRanges(duration, a, b, mode);
    if (plan.error) {
      note.textContent = plan.error;
      (plan.error.includes('From') ? from : to).input.focus();
      return;
    }
    // Made here rather than inside apply(), so a refusal shows in the dialog.
    let next;
    try {
      next = plan.ranges.reduce((p, [start, end]) => core.cutRange(p, start, end), store.project);
    } catch (err) {
      note.textContent = plainError(err);
      return;
    }
    store.apply(() => next);
    dialog.close();
    const span = `${formatTime(a, { fraction: true })}–${formatTime(Math.min(b, duration), { fraction: true })}`;
    player.seek(mode === 'keep' ? 0 : a);
    toast(mode === 'keep' ? `Kept ${span}` : `Removed ${span}`);
  }

  // From starts at the playhead (or the In mark), To at the end of the
  // video (or the Out mark).
  function show(marks = {}) {
    const duration = store.tl.duration;
    const a = marks.in ?? Math.min(player.time, duration);
    const b = marks.out ?? duration;
    from.input.value = formatTime(a, { fraction: true });
    to.input.value = formatTime(b, { fraction: true });
    length.textContent = `The video is ${formatTime(duration, { fraction: true })} long.`;
    note.textContent = '';
    if (!dialog.open) dialog.showModal();
    from.input.focus();
    from.input.select();
  }

  return {
    show,
    close: () => dialog.close(),
    get isOpen() { return dialog.open; }
  };
}
