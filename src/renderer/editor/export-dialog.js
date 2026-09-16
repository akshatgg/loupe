// The export dialog (docs/EDITOR-V2.md section 6).
//
//  settings  format (MP4 / WebM / GIF); for videos the size, the quality or
//            "Fit a size limit"; for GIFs the width, smoothness and gradient
//            dithering; what the file will be ("up to about 12 MB") with a
//            warning for long GIFs; this recording's recent exports.
//  running   progress, Cancel.
//  done      the file: drag it out, Show in Finder/Explorer, Copy, Share link
//            (only when sharing is available), Done.
//
// Choices are saved in the project (project.export). A project whose export
// settings were never changed starts from the Settings window's export
// defaults.

import { h, icon, segmented, toggle } from './ui.js';
import { setExport, defaultExport } from '../../core/project.js';
import {
  describeExport, formatBytes, SIZE_LIMITS, SIZE_LIMIT_MIN, SIZE_LIMIT_MAX, GIF_WIDTHS
} from '../../core/export-plan.js';
import { createExportCaptions } from './export-captions.js';

const FORMATS = [
  { value: 'mp4', label: 'MP4', hint: 'Plays everywhere. The best choice for most videos.' },
  { value: 'webm', label: 'WebM', hint: 'For websites. Smaller files, but not every app opens them.' },
  { value: 'gif', label: 'GIF', hint: 'Plays on its own in chats and docs. No sound; best for a few seconds.' }
];
const RESOLUTIONS = [
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: '1440p', label: '1440p' },
  { value: '4k', label: '4K' }
];
const QUALITIES = [
  { value: 'high', label: 'High', title: 'Best picture, bigger file' },
  { value: 'balanced', label: 'Balanced', title: 'Great picture, sensible size' },
  { value: 'small', label: 'Small file', title: 'Good for sharing in chat or email' }
];
const GIF_WIDTH_LABELS = { 480: 'Small', 720: 'Medium', 960: 'Large' };
const GIF_FRAME_RATES = [
  { value: 10, label: 'Light', title: '10 frames a second' },
  { value: 15, label: 'Smooth', title: '15 frames a second' },
  { value: 20, label: 'Smoother', title: '20 frames a second, bigger file' }
];
const COPIED_MS = 1800;

// A few line icons only this dialog uses (same 24-unit grid as ui.js).
const SVG = 'http://www.w3.org/2000/svg';
const LOCAL_ICONS = {
  copy: 'M9 9h10v11H9zM5 15V4h10',
  link: 'M10 14a4.5 4.5 0 0 0 6.4 0l2.8-2.8a4.5 4.5 0 0 0-6.4-6.4L11.5 6M14 10a4.5 4.5 0 0 0-6.4 0l-2.8 2.8a4.5 4.5 0 0 0 6.4 6.4l1.3-1.2',
  film: 'M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2.5-2.5L20 17M15.5 8.5h.01',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01'
};
function localIcon(name, size = 18) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', LOCAL_ICONS[name]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', name === 'grip' ? '2.6' : '1.7');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

// ipcRenderer.invoke wraps a main-process error as "Error invoking remote
// method 'export:start': Error: <message>"; only the message is for people.
export const plainError = (err) =>
  String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const seconds = (s) => {
  const n = Math.max(1, Math.round(s));
  if (n < 60) return `${n} second${n === 1 ? '' : 's'}`;
  const m = Math.floor(n / 60);
  const rest = n % 60;
  return rest ? `${m} min ${rest} s` : `${m} min`;
};

export function timeAgo(at, now = Date.now()) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86400);
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}

const fileName = (file) => String(file).split(/[\\/]/).pop();
const isUntouched = (exp) => {
  const d = defaultExport();
  return Object.keys(d).every((k) => exp[k] === d[k]);
};

export function createExportDialog({ store, loupe, player, beforeExport }) {
  const mac = loupe.platform !== 'win32';
  const revealLabel = mac ? 'Show in Finder' : 'Show in Explorer';
  const dialog = h('dialog', { class: 'export-dialog', 'aria-labelledby': 'exportTitle' });
  document.body.append(dialog);
  let state = 'settings';
  let unlisten = null;
  const captions = createExportCaptions({ store });
  let shareUnlisten = null;
  let recent = [];
  let share = { enabled: false };
  let defaultsChecked = false;

  const title = h('h2', { id: 'exportTitle' });
  const body = h('div', { class: 'export-body' });
  const actions = h('div', { class: 'export-actions' });
  dialog.append(h('button', { type: 'button', class: 'icon-btn close', 'aria-label': 'Close', onclick: () => close() }, icon('close')), title, body, actions);
  dialog.addEventListener('cancel', (e) => {
    // Escape during an export would hide the progress but not stop it.
    if (state === 'running') e.preventDefault();
  });
  dialog.addEventListener('close', () => {
    shareUnlisten?.();
    shareUnlisten = null;
  });

  const setExp = (patch) => store.apply((q) => setExport(q, patch));
  const hasSound = () => {
    const p = store.project;
    return Object.values(p.sources).some((s) => s.mic || s.systemAudio);
  };

  // A never-changed project starts from Settings > Export defaults.
  async function applyDefaults() {
    if (defaultsChecked) return;
    defaultsChecked = true;
    if (!isUntouched(store.project.export) || recent.length) return;
    try {
      const d = (await loupe.getSettings())?.exportDefaults;
      if (!d) return;
      const patch = {};
      for (const k of ['format', 'resolution', 'quality']) if (d[k] && d[k] !== store.project.export[k]) patch[k] = d[k];
      if (Object.keys(patch).length) setExp(patch);
    } catch {
      // No settings (or a page without them): the project's own defaults.
    }
  }

  async function refreshRecent() {
    try {
      recent = (await loupe.recentExports?.()) ?? [];
    } catch {
      recent = [];
    }
  }

  // ---------------------------------------------------------------- settings

  function settings() {
    state = 'settings';
    title.textContent = 'Export';
    const ex = store.project.export;
    const gif = ex.format === 'gif';
    const rerender = () => settings();

    const format = segmented({
      label: 'Format', options: FORMATS.map(({ value, label }) => ({ value, label })), value: ex.format,
      onChange: (v) => { if (v !== store.project.export.format) { setExp({ format: v }); rerender(); } }
    });
    format.id = 'exportFormat';
    format.append(h('p', { class: 'hint', id: 'exportFormatHint' }, FORMATS.find((f) => f.value === ex.format).hint));

    const fields = [format];
    if (gif) {
      const width = segmented({
        label: 'Size',
        options: GIF_WIDTHS.map((w) => ({ value: w, label: GIF_WIDTH_LABELS[w], title: `${w} pixels wide` })),
        value: ex.gifWidth, onChange: (v) => { setExp({ gifWidth: v }); rerender(); }
      });
      width.id = 'exportGifWidth';
      const fps = segmented({
        label: 'Motion', options: GIF_FRAME_RATES, value: ex.gifFps,
        onChange: (v) => { setExp({ gifFps: v }); rerender(); }
      });
      fps.id = 'exportGifFps';
      const dither = toggle({
        label: 'Smooth colour gradients', hint: 'Softens banding in backgrounds. The file gets a little bigger.',
        checked: ex.dither, onChange: (v) => { setExp({ dither: v }); rerender(); }
      });
      dither.id = 'exportDither';
      fields.push(width, fps, dither);
    } else {
      const res = segmented({
        label: 'Size', options: RESOLUTIONS, value: ex.resolution,
        onChange: (v) => { setExp({ resolution: v }); rerender(); }
      });
      res.id = 'exportResolution';
      fields.push(res);
      const limited = ex.sizeLimit !== null;
      const limit = toggle({
        label: 'Fit a size limit', hint: 'For Slack, email and other places that cap file size.',
        checked: limited, onChange: (v) => { setExp({ sizeLimit: v ? SIZE_LIMITS[0] : null }); rerender(); }
      });
      limit.id = 'exportLimit';
      if (limited) {
        fields.push(limit, limitPicker(ex, rerender));
      } else {
        const quality = segmented({
          label: 'Quality', options: QUALITIES, value: ex.quality,
          onChange: (v) => { setExp({ quality: v }); rerender(); }
        });
        quality.id = 'exportQuality';
        fields.push(quality, limit);
      }
    }

    // Burn-in and .srt, when the video has captions (export-captions.js).
    const captionFields = captions.fields();
    if (captionFields) fields.push(captionFields);

    const plan = describeExport(store.project, store.project.export, { duration: store.tl.duration, audio: !gif && hasSound() });
    const summary = h('div', { class: 'export-summary', id: 'exportSummary' },
      localIcon(gif ? 'image' : 'film', 16),
      h('span', {}, `${plan.width} × ${plan.height}`),
      h('span', { class: 'dot' }, '·'),
      h('span', {}, seconds(plan.duration)),
      h('span', { class: 'dot' }, '·'),
      h('span', { id: 'exportEstimate' }, ex.sizeLimit && !gif ? `under ${ex.sizeLimit} MB` : `up to about ${formatBytes(plan.bytes)}`));
    fields.push(summary);
    if (plan.warning) {
      fields.push(h('div', { class: 'export-warning', id: 'exportWarning', role: 'note' }, icon('alert', { size: 16 }), h('p', {}, plan.warning)));
    }
    if (recent.length) fields.push(recentList());

    body.replaceChildren(...fields);
    actions.replaceChildren(
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Cancel'),
      h('button', {
        type: 'button', class: 'btn primary', id: 'exportStart', disabled: plan.limitTooSmall, onclick: () => run()
      }, gif ? 'Export GIF' : 'Export'));
  }

  function limitPicker(ex, rerender) {
    const preset = SIZE_LIMITS.includes(ex.sizeLimit) ? ex.sizeLimit : 'custom';
    const choice = segmented({
      label: null,
      options: [...SIZE_LIMITS.map((mb) => ({ value: mb, label: `${mb} MB` })), { value: 'custom', label: 'Other' }],
      value: preset,
      onChange: (v) => {
        if (v === 'custom') {
          custom.hidden = false;
          choice.set('custom');
          input.focus();
          input.select();
        } else {
          setExp({ sizeLimit: v });
          rerender();
        }
      }
    });
    choice.id = 'exportLimitChoice';
    const input = h('input', {
      type: 'number', id: 'exportLimitCustom', min: String(SIZE_LIMIT_MIN), max: String(SIZE_LIMIT_MAX), step: '1',
      value: String(ex.sizeLimit), 'aria-label': 'Size limit in MB'
    });
    const commit = () => {
      const mb = Number(input.value);
      if (!Number.isFinite(mb) || mb < SIZE_LIMIT_MIN || mb > SIZE_LIMIT_MAX) {
        input.value = String(store.project.export.sizeLimit);
        return;
      }
      setExp({ sizeLimit: Math.round(mb * 10) / 10 });
      rerender();
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
    });
    const custom = h('label', { class: 'limit-custom' }, input, h('span', {}, 'MB'));
    custom.hidden = preset !== 'custom';
    return h('div', { class: 'field limit-row' }, choice, custom);
  }

  function recentList() {
    const now = Date.now();
    const rows = recent.slice(0, 4).map((r) => {
      const row = h('li', { class: 'recent-row', draggable: true, title: 'Drag into another app' },
        localIcon(r.format === 'gif' ? 'image' : 'film', 16),
        h('span', { class: 'recent-name' }, r.name),
        h('span', { class: 'recent-meta' }, `${formatBytes(r.bytes)} · ${r.at ? timeAgo(r.at, now) : ''}`),
        h('button', {
          type: 'button', class: 'icon-btn small', title: revealLabel, 'aria-label': `${revealLabel}: ${r.name}`,
          onclick: () => loupe.revealFile(r.file)
        }, icon('folder', { size: 16 })),
        copyButton(r.file, { small: true }));
      row.addEventListener('dragstart', (e) => {
        e.preventDefault();
        loupe.startFileDrag(r.file);
      });
      return row;
    });
    return h('div', { class: 'recent', id: 'exportRecent' },
      h('h3', {}, 'Recent exports'), h('ul', {}, rows));
  }

  function copyButton(file, { small = false, onResult = () => {} } = {}) {
    const label = h('span', {}, 'Copy');
    const btn = h('button', {
      type: 'button', class: small ? 'icon-btn small' : 'btn', title: 'Copy the file, then paste it into any app',
      'aria-label': 'Copy the file', id: small ? null : 'exportCopy'
    }, small ? localIcon('copy', 16) : [localIcon('copy', 16), label]);
    btn.addEventListener('click', async () => {
      let result;
      try {
        result = await loupe.copyFile(file);
      } catch (err) {
        result = { ok: false, message: plainError(err) };
      }
      onResult(result);
      if (result?.ok) {
        btn.classList.add('copied');
        if (!small) label.textContent = 'Copied';
        btn.replaceChildren(...(small ? [icon('check', { size: 16 })] : [icon('check', { size: 16 }), label]));
        setTimeout(() => {
          btn.classList.remove('copied');
          label.textContent = 'Copy';
          btn.replaceChildren(...(small ? [localIcon('copy', 16)] : [localIcon('copy', 16), label]));
        }, COPIED_MS);
      }
    });
    return btn;
  }

  // ---------------------------------------------------------------- running

  async function run() {
    state = 'running';
    player.pause();
    const ex = store.project.export;
    const gif = ex.format === 'gif';
    title.textContent = gif ? 'Making your GIF…' : 'Exporting…';
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
        phase.textContent = pr.pass
          ? `Squeezing it under ${ex.sizeLimit} MB (try ${pr.pass + 1})…`
          : gif ? 'Making your GIF…' : 'Making your video…';
      } else if (pr.phase === 'sound') {
        phase.textContent = 'Preparing the sound…';
      } else {
        phase.textContent = pr.sources > 1 ? `Reading recording ${pr.source + 1} of ${pr.sources}…` : 'Reading the recording…';
      }
    });
    try {
      await beforeExport();
      const result = await loupe.exportVideo({
        format: ex.format, resolution: ex.resolution, quality: ex.quality, codec: ex.codec,
        sizeLimit: ex.sizeLimit, gifWidth: ex.gifWidth, gifFps: ex.gifFps, dither: ex.dither,
        ...captions.options()
      });
      await done(result);
    } catch (err) {
      const message = plainError(err);
      if (/cancelled/i.test(message)) settings();
      else failed(message);
    } finally {
      unlisten?.();
      unlisten = null;
    }
  }

  // ---------------------------------------------------------------- done

  async function done(result) {
    state = 'done';
    const file = result.file;
    const gif = result.format === 'gif';
    title.textContent = gif ? 'Your GIF is ready' : 'Your video is ready';
    dialog.dataset.file = file;
    loupe.prepareFileDrag?.(file)?.catch?.(() => {});
    const bytes = Number.isFinite(result.bytes) ? ` · ${formatBytes(result.bytes)}` : '';

    const chip = h('div', { class: 'file-chip', id: 'exportDrag', draggable: true, title: 'Drag into another app' },
      h('div', { class: 'done-icon' }, icon('check', { size: 22 })),
      h('div', { class: 'file-text' },
        h('p', { class: 'file-name', id: 'exportFile' }, fileName(file)),
        h('p', { class: 'hint' }, `${result.width} × ${result.height} · ${seconds(result.duration ?? 0)}${bytes}`),
        captions.doneNote(result)),
      h('span', { class: 'drag-hint' }, localIcon('grip', 16), 'Drag'));
    chip.addEventListener('dragstart', (e) => {
      // The OS carries the real file (main's webContents.startDrag).
      e.preventDefault();
      loupe.startFileDrag(file);
    });

    const status = h('div', { class: 'share-status', id: 'exportStatus', 'aria-live': 'polite' });
    const say = (text, kind = '') => {
      status.className = `share-status ${kind}`;
      status.replaceChildren(text ? h('p', {}, text) : '');
    };

    const buttons = [
      h('button', { type: 'button', class: 'btn', id: 'exportReveal', onclick: () => loupe.revealExport() },
        icon('folder', { size: 16 }), revealLabel),
      copyButton(file, { onResult: (r) => { if (!r?.ok) say(r?.message ?? 'The file couldn’t be copied.', 'bad'); else say(''); } })
    ];
    const shareBtn = h('button', { type: 'button', class: 'btn', id: 'exportShare', hidden: true, onclick: () => upload() },
      localIcon('link', 16), 'Share link');
    buttons.push(shareBtn);

    body.replaceChildren(chip, h('div', { class: 'done-actions' }, buttons), status);
    actions.replaceChildren(h('button', { type: 'button', class: 'btn primary', id: 'exportDone', onclick: () => close() }, 'Done'));

    // Sharing: the button only appears when the service says it's available.
    try {
      share = await loupe.shareStatus();
    } catch {
      share = { enabled: false };
    }
    if (state !== 'done' || dialog.dataset.file !== file) return;
    if (share?.enabled) {
      shareBtn.hidden = false;
      if (share.maxBytes && result.bytes > share.maxBytes) {
        shareBtn.disabled = true;
        say(`This file is too big to share as a link (the limit is ${formatBytes(share.maxBytes)}). Try a smaller size or a size limit.`);
      }
    } else if (share?.offline) {
      say('You’re offline, so share links aren’t available right now.', 'quiet');
    }

    async function upload() {
      shareBtn.disabled = true;
      const fill = h('div', { class: 'progress-fill' });
      const pct = h('span', { class: 'percent' }, '0%');
      const cancel = h('button', { type: 'button', class: 'btn small', id: 'shareCancel', onclick: () => loupe.shareCancel() }, 'Cancel');
      status.className = 'share-status';
      status.replaceChildren(
        h('p', {}, 'Uploading…'),
        h('div', { class: 'progress-row' }, h('div', { class: 'progress', role: 'progressbar' }, fill), pct, cancel));
      shareUnlisten?.();
      shareUnlisten = loupe.onShareProgress((p) => {
        const v = Math.min(100, Math.round((p.fraction ?? 0) * 100));
        fill.style.width = `${v}%`;
        pct.textContent = `${v}%`;
      });
      let res;
      try {
        res = await loupe.shareUpload(file, { title: store.project.title, width: result.width, height: result.height, duration: result.duration });
      } catch (err) {
        res = { ok: false, message: plainError(err) };
      } finally {
        shareUnlisten?.();
        shareUnlisten = null;
      }
      if (!dialog.open || dialog.dataset.file !== file) return;
      if (!res?.ok) {
        shareBtn.disabled = false;
        if (res?.code === 'cancelled') say('');
        else say(res?.message ?? 'The upload didn’t finish. Please try again.', 'bad');
        return;
      }
      const link = h('input', { type: 'text', class: 'share-link', id: 'shareLink', readOnly: true, value: res.url, 'aria-label': 'Share link' });
      link.addEventListener('focus', () => link.select());
      const copyLink = h('button', { type: 'button', class: 'btn primary', id: 'shareCopy' }, localIcon('copy', 16), 'Copy link');
      copyLink.addEventListener('click', async () => {
        const r = await loupe.copyText(res.url).catch(() => null);
        if (r?.ok) {
          copyLink.replaceChildren(icon('check', { size: 16 }), 'Copied');
          setTimeout(() => copyLink.replaceChildren(localIcon('copy', 16), 'Copy link'), COPIED_MS);
        }
      });
      const days = share?.expiresInDays ?? 7;
      status.className = 'share-status ready';
      status.replaceChildren(
        h('div', { class: 'share-row' }, link, copyLink),
        h('p', { class: 'hint' }, `Anyone with the link can watch. It stops working after ${days} day${days === 1 ? '' : 's'}.`));
      shareBtn.hidden = true;
    }
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
    if (dialog.open) dialog.close();
  }

  return {
    // Opens straight away; the recent exports and the Settings defaults
    // arrive a moment later and redraw the choices if nothing else happened.
    show() {
      if (dialog.open) return Promise.resolve();
      settings();
      dialog.showModal();
      return (async () => {
        await refreshRecent();
        await applyDefaults();
        if (dialog.open && state === 'settings' && !dialog.contains(document.activeElement?.closest?.('input') ?? null)) settings();
      })();
    },
    close,
    get isOpen() { return dialog.open; },
    get state() { return state; }
  };
}
