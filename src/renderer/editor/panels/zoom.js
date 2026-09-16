// Zoom: the selected zoom's level, and whether it follows the cursor or stays
// on a spot picked on a small picture of the recording. With nothing
// selected, it explains how to add one and lists the zooms there are.

import { h, icon, slider, segmented, section } from '../ui.js';
import { updateZoom, removeZoom, ZOOM_LEVEL_MAX } from '../../../core/project.js';
import { viewSize } from '../../../core/camera.js';
import { clipLayout, rangePieces, formatTime, newZoomRange, clamp } from '../timeline-math.js';

const PICKER_WIDTH = 256;

export default {
  id: 'zoom',
  title: 'Zoom',
  icon: 'zoom',
  mount(container, editor) {
    const { store, player } = editor;
    const selected = () => {
      const sel = store.selection;
      return sel?.kind === 'zoom' ? store.project.zooms.find((z) => z.id === sel.id) ?? null : null;
    };
    const change = (patch, gesture = null) => {
      const z = selected();
      if (z) store.apply((p) => updateZoom(p, z.id, patch), { gesture });
    };
    const done = () => store.endGesture();

    // ---- nothing selected
    const list = h('div', { class: 'zoom-list' });
    const empty = h('div', { class: 'panel-empty compact' },
      h('div', { class: 'empty-icon' }, icon('zoomAdd', { size: 28 })),
      h('h3', {}, 'Zoom in on what matters'),
      h('p', {}, 'Drag across the zoom track under the video, or press Z, to zoom in at the playhead. Select a zoom to change it.'),
      h('button', { type: 'button', class: 'btn', id: 'zoomAddHere', onclick: () => editor.addZoomAtPlayhead() }, icon('zoomAdd'), 'Add a zoom here'),
      list);

    // ---- a zoom selected
    const heading = h('h3', { class: 'zoom-heading' });
    const when = h('p', { class: 'muted zoom-when' });
    const level = slider({
      label: 'Zoom level', min: 1.1, max: Math.min(5, ZOOM_LEVEL_MAX), step: 0.05, value: 2,
      format: (v) => `${v.toFixed(2).replace(/\.?0+$/, '')}×`,
      onInput: (v) => change({ level: v }, 'zoom:level'), onChange: done
    });
    level.querySelector('input').id = 'zoomLevel';
    const presets = h('div', { class: 'chips' }, [1.5, 2, 3].map((v) =>
      h('button', { type: 'button', class: 'chip', onclick: () => { change({ level: v }); done(); } }, `${v}×`)));
    const mode = segmented({
      label: 'Where to zoom',
      options: [{ value: 'follow', label: 'Follow the cursor', icon: icon('cursor', { size: 15 }) },
        { value: 'fixed', label: 'A fixed spot', icon: icon('target', { size: 15 }) }],
      value: 'follow',
      onChange: (v) => { change({ follow: v === 'follow' }); done(); }
    });
    mode.classList.add('stacked');
    const canvas = h('canvas', { class: 'spot-picker', title: 'Drag to choose where to zoom' });
    const spotHint = h('p', { class: 'hint' }, 'Drag on the picture to choose the spot.');
    const spot = h('div', { class: 'field spot' }, canvas, spotHint);
    const remove = h('button', { type: 'button', class: 'btn danger-quiet', onclick: () => {
      const z = selected();
      if (z) store.apply((p) => removeZoom(p, z.id));
    } }, icon('trash'), 'Remove zoom');
    const detail = h('div', {},
      section(null, heading, when),
      section(null, level, presets),
      section(null, mode, spot),
      section(null, remove));

    container.append(empty, detail);

    // ---- the spot picker
    const ctx = canvas.getContext('2d');
    function drawPicker() {
      const z = selected();
      if (!z || z.follow) return;
      const meta = store.project.sources[z.source];
      const dpr = window.devicePixelRatio || 1;
      const w = PICKER_WIDTH;
      const hgt = Math.round((w * meta.height) / meta.width);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${hgt}px`;
      if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = hgt * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, hgt);
      const v = player.videos[z.source];
      if (v && v.readyState >= 2) ctx.drawImage(v, 0, 0, w, hgt);
      const k = w / meta.width;
      const { vw, vh } = viewSize(z.level, meta.width, meta.height, null);
      const cx = clamp(z.x, vw / 2, meta.width - vw / 2);
      const cy = clamp(z.y, vh / 2, meta.height - vh / 2);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.rect(0, 0, w, hgt);
      ctx.rect((cx - vw / 2) * k, (cy - vh / 2) * k, vw * k, vh * k);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#8ab4f8';
      ctx.lineWidth = 2;
      ctx.strokeRect((cx - vw / 2) * k, (cy - vh / 2) * k, vw * k, vh * k);
      ctx.fillStyle = '#8ab4f8';
      ctx.beginPath();
      ctx.arc(z.x * k, z.y * k, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    let dragging = false;
    const pickAt = (e) => {
      const z = selected();
      if (!z) return;
      const meta = store.project.sources[z.source];
      const r = canvas.getBoundingClientRect();
      const x = clamp(((e.clientX - r.left) / r.width) * meta.width, 0, meta.width);
      const y = clamp(((e.clientY - r.top) / r.height) * meta.height, 0, meta.height);
      change({ x: Math.round(x), y: Math.round(y) }, 'zoom:spot');
    };
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      pickAt(e);
    });
    canvas.addEventListener('pointermove', (e) => { if (dragging) pickAt(e); });
    canvas.addEventListener('pointerup', () => { dragging = false; done(); });
    player.onTime(() => { if (!detail.hidden) drawPicker(); });

    function renderList() {
      const p = store.project;
      const layout = clipLayout(p, store.tl);
      const rows = p.zooms.map((z) => {
        const piece = rangePieces(p, layout, z.source, z.start, z.end)[0];
        return h('button', { type: 'button', class: 'zoom-row', onclick: () => editor.select({ kind: 'zoom', id: z.id }, { seek: true }) },
          h('span', { class: 'zoom-dot' }),
          h('span', {}, piece ? `${formatTime(piece.outStart)} – ${formatTime(piece.outEnd)}` : 'Cut from the video'),
          h('span', { class: 'muted' }, `${Number(z.level.toFixed(2))}×`));
      });
      list.replaceChildren(...(rows.length ? [h('h4', {}, `Zooms in this video (${rows.length})`), ...rows] : []));
    }

    function update() {
      const z = selected();
      empty.hidden = Boolean(z);
      detail.hidden = !z;
      if (!z) {
        renderList();
        const layout = clipLayout(store.project, store.tl);
        empty.querySelector('#zoomAddHere').disabled = !newZoomRange(store.project, layout, player.time);
        return;
      }
      const p = store.project;
      const pieces = rangePieces(p, clipLayout(p, store.tl), z.source, z.start, z.end);
      heading.textContent = z.recorded ? 'Zoom from your recording' : 'Zoom';
      when.textContent = pieces.length
        ? `${formatTime(pieces[0].outStart, { fraction: true })} – ${formatTime(pieces.at(-1).outEnd, { fraction: true })} · ${(z.end - z.start).toFixed(1)} s`
        : 'This part of the recording is cut from the video.';
      level.set(z.level);
      mode.set(z.follow ? 'follow' : 'fixed');
      spot.hidden = z.follow;
      drawPicker();
    }
    update();
    return { update };
  }
};

