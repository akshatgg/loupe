// The export dialog: pick a size and quality, watch it export (with Cancel),
// then open the video's folder. MP4 is the only format for now; the choice is
// shown so the dialog has room for more.

import { h, icon, segmented } from './ui.js';
import { exportSize } from '../../core/compose.js';
import { setExport } from '../../core/project.js';

const RESOLUTIONS = [
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: '1440p', label: '1440p' },
  { value: '4k', label: '4K' }
];
const QUALITIES = [
  { value: 'high', label: 'High', title: 'Best picture, bigger file' },
  { value: 'balanced', label: 'Balanced', title: 'Great picture, sensible size' },
  { value: 'small', label: 'Smaller file', title: 'Good for sharing in chat or email' }
];

// ipcRenderer.invoke wraps a main-process error as "Error invoking remote
// method 'export:start': Error: <message>"; only the message is for people.
export const plainError = (err) =>
  String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function createExportDialog({ store, loupe, player, beforeExport }) {
  const mac = loupe.platform !== 'win32';
  const dialog = h('dialog', { class: 'export-dialog', 'aria-labelledby': 'exportTitle' });
  document.body.append(dialog);
  let state = 'settings';
  let unlisten = null;

  const title = h('h2', { id: 'exportTitle' });
  const body = h('div', { class: 'export-body' });
  const actions = h('div', { class: 'export-actions' });
  dialog.append(h('button', { type: 'button', class: 'icon-btn close', 'aria-label': 'Close', onclick: () => close() }, icon('close')), title, body, actions);
  dialog.addEventListener('cancel', (e) => {
    // Escape during an export would hide the progress but not stop it.
    if (state === 'running') e.preventDefault();
  });

  function settings() {
    state = 'settings';
    const p = store.project;
    const ex = p.export;
    title.textContent = 'Export video';
    const sizeNote = h('p', { class: 'hint size-note' });
    const showSize = (res) => {
      const { width, height } = exportSize(store.project, res);
      sizeNote.textContent = `${width} × ${height} pixels · ${Math.round(store.tl.duration)} seconds`;
    };
    const res = segmented({
      label: 'Size', options: RESOLUTIONS, value: ex.resolution,
      onChange: (v) => { store.apply((q) => setExport(q, { resolution: v })); res.set(v); showSize(v); }
    });
    res.id = 'exportResolution';
    const quality = segmented({
      label: 'Quality', options: QUALITIES, value: ex.quality,
      onChange: (v) => { store.apply((q) => setExport(q, { quality: v })); quality.set(v); }
    });
    quality.id = 'exportQuality';
    showSize(ex.resolution);
    body.replaceChildren(
      segmented({ label: 'Format', options: [{ value: 'mp4', label: 'MP4 video' }], value: 'mp4', onChange: () => {} }),
      res, sizeNote, quality);
    actions.replaceChildren(
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary', id: 'exportStart', onclick: () => run() }, 'Export'));
  }

  async function run() {
    state = 'running';
    player.pause();
    const p = store.project;
    title.textContent = 'Exporting…';
    const bar = h('div', { class: 'progress-fill' });
    const phase = h('p', { class: 'hint', id: 'exportPhase' }, 'Getting ready…');
    const percent = h('span', { class: 'percent', id: 'exportPercent' }, '0%');
    body.replaceChildren(h('div', { class: 'progress-row' }, h('div', { class: 'progress', role: 'progressbar' }, bar), percent), phase);
    const cancel = h('button', { type: 'button', class: 'btn', id: 'exportCancel', onclick: async () => {
      cancel.disabled = true;
      cancel.textContent = 'Cancelling…';
      await loupe.cancelExport();
    } }, 'Cancel');
    actions.replaceChildren(cancel);
    unlisten = loupe.onExportProgress((pr) => {
      if (pr.phase === 'video' && pr.total) {
        const pct = Math.min(100, Math.round((pr.frame / pr.total) * 100));
        bar.style.width = `${pct}%`;
        percent.textContent = `${pct}%`;
        phase.textContent = 'Making your video…';
      } else if (pr.phase === 'sound') {
        phase.textContent = 'Preparing the sound…';
      } else {
        phase.textContent = pr.sources > 1 ? `Reading recording ${pr.source + 1} of ${pr.sources}…` : 'Reading the recording…';
      }
    });
    try {
      await beforeExport();
      const result = await loupe.exportVideo({ resolution: p.export.resolution, quality: p.export.quality, codec: p.export.codec });
      done(result);
    } catch (err) {
      const message = plainError(err);
      if (/cancelled/i.test(message)) settings();
      else failed(message);
    } finally {
      unlisten?.();
      unlisten = null;
    }
  }

  function done(result) {
    state = 'done';
    title.textContent = 'Your video is ready';
    const name = String(result.file).split(/[\\/]/).pop();
    body.replaceChildren(h('div', { class: 'export-done' },
      h('div', { class: 'done-icon' }, icon('check', { size: 26 })),
      h('div', {}, h('p', { class: 'file-name', id: 'exportFile' }, name),
        h('p', { class: 'hint' }, `${result.width} × ${result.height} · ${Math.round(result.duration ?? 0)} seconds · made in ${Math.max(1, Math.round(result.seconds ?? 0))} s`))));
    actions.replaceChildren(
      h('button', { type: 'button', class: 'btn', id: 'exportReveal', onclick: () => loupe.revealExport() },
        icon('folder'), mac ? 'Show in Finder' : 'Show in Explorer'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => close() }, 'Done'));
    dialog.dataset.file = result.file;
  }

  function failed(message) {
    state = 'error';
    title.textContent = 'The export didn’t finish';
    body.replaceChildren(h('div', { class: 'export-error' }, icon('alert', { size: 22 }), h('p', { id: 'exportError' }, message)));
    actions.replaceChildren(
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Close'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => settings() }, 'Try again'));
  }

  function close() {
    if (state === 'running') return;
    dialog.close();
  }

  return {
    open() {
      if (dialog.open) return;
      settings();
      dialog.showModal();
    },
    close,
    get open() { return dialog.open; },
    get state() { return state; }
  };
}
