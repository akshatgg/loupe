// Annotations: text, title cards, arrows, boxes and hidden areas on the video.
// The buttons add one at the playhead; it's then dragged into place on the
// preview (annotation-overlay.js) and along the timeline's annotation track.
// Selected, this panel edits its words, colour, size and how long it shows.

import { h, icon, slider, section } from '../ui.js';
import { updateAnnotation, removeAnnotation, MIN_RANGE_SECONDS } from '../../../core/project.js';
import { clipLayout, rangePieces, formatTime } from '../timeline-math.js';
import { KINDS, COLOURS, kindOf, annotationLabel } from '../annotation-math.js';

const HINTS = {
  text: 'Drag it on the video to move it, or double-click to change the words.',
  title: 'A full-screen card that fades in and out. Put one at the start or the end.',
  arrow: 'Drag either end on the video to point it.',
  box: 'Drag the corners on the video to fit it around something.',
  blur: 'Drag it over a password or an email address to hide it. It follows zooms.'
};

export default {
  id: 'annotations',
  title: 'Annotations',
  icon: 'annotations',
  mount(container, editor) {
    const { store, player } = editor;
    const selected = () => {
      const sel = store.selection;
      return sel?.kind === 'annotation' ? store.project.annotations.find((a) => a.id === sel.id) ?? null : null;
    };
    const change = (patch, gesture = null) => {
      const a = selected();
      if (a) store.apply((p) => updateAnnotation(p, a.id, patch), { gesture });
    };
    const done = () => store.endGesture();

    // ---- adding
    const adders = KINDS.map((k) => h('button', {
      type: 'button', class: 'add-tile', dataset: { type: k.type }, title: `Add ${k.label.toLowerCase()} at the playhead`,
      onclick: () => editor.addAnnotation(k.type)
    }, icon(k.icon, { size: 22 }), h('span', {}, k.label)));
    const addSection = section('Add at the playhead', h('div', { class: 'add-grid' }, adders));
    const list = h('div', { class: 'zoom-list' });
    const intro = h('p', { class: 'hint' }, 'Point things out, add a title, or hide something private. Select one to change it.');

    // ---- one selected
    const heading = h('h3', { class: 'zoom-heading' });
    const when = h('p', { class: 'muted zoom-when' });
    const hint = h('p', { class: 'hint' });
    const text = h('textarea', { class: 'text-input anno-text', rows: '2', spellcheck: 'true', 'aria-label': 'Words', maxlength: '500' });
    text.addEventListener('input', () => change({ text: text.value }, 'annotation:text'));
    text.addEventListener('change', done);
    const textField = h('label', { class: 'field' }, h('span', { class: 'label' }, 'Words'), text);
    const swatches = COLOURS.map((c) => {
      const b = h('button', {
        type: 'button', class: 'swatch small', title: c, 'aria-label': `Colour ${c}`, dataset: { colour: c },
        onclick: () => { change({ color: c }); done(); }
      });
      b.style.background = c;
      return b;
    });
    const colourLabel = h('span', { class: 'label' }, 'Colour');
    const colourField = h('div', { class: 'field' }, colourLabel, h('div', { class: 'swatches colours' }, swatches));
    const size = slider({
      label: 'Size', min: 0.4, max: 3, step: 0.05, value: 1, format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => change({ size: v }, 'annotation:size'), onChange: done
    });
    const length = slider({
      label: 'Shows for', min: 0.5, max: 20, step: 0.1, value: 3, format: (v) => `${v.toFixed(1)} s`,
      onInput: (v) => {
        const a = selected();
        if (!a) return;
        const end = Math.min(store.project.sources[a.source].duration, a.start + Math.max(MIN_RANGE_SECONDS, v));
        change({ end }, 'annotation:length');
      },
      onChange: done
    });
    const toPlayhead = h('button', {
      type: 'button', class: 'chip', title: 'Start it where the playhead is',
      onclick: () => {
        const a = selected();
        if (!a) return;
        const at = store.tl.toSource(player.time);
        if (at.source !== a.source) { editor.toast('The playhead is in a different recording.'); return; }
        const len = a.end - a.start;
        const start = Math.max(0, Math.min(at.t, store.project.sources[a.source].duration - MIN_RANGE_SECONDS));
        change({ start, end: Math.min(store.project.sources[a.source].duration, start + len) });
        done();
      }
    }, 'Start at the playhead');
    const remove = h('button', {
      type: 'button', class: 'btn danger-quiet', onclick: () => {
        const a = selected();
        if (a) store.apply((p) => removeAnnotation(p, a.id));
      }
    }, icon('trash'), 'Remove');
    const detail = h('div', {},
      section(null, heading, when, hint),
      section(null, textField, colourField, size),
      section('Timing', length, h('div', { class: 'chips' }, toPlayhead)),
      section(null, remove));

    const top = h('div', { class: 'anno-top' }, intro, addSection, list);
    const back = h('button', {
      type: 'button', class: 'chip anno-back', onclick: () => editor.select(null)
    }, icon('back', { size: 14 }), 'All annotations');
    detail.prepend(back);
    container.append(top, detail);

    function renderList() {
      const p = store.project;
      const layout = clipLayout(p, store.tl);
      const rows = p.annotations.map((a) => {
        const piece = rangePieces(p, layout, a.source, a.start, a.end)[0];
        return h('button', {
          type: 'button', class: 'zoom-row anno-row', dataset: { id: a.id },
          onclick: () => editor.select({ kind: 'annotation', id: a.id }, { seek: true })
        },
        h('span', { class: 'anno-icon' }, icon(kindOf(a.type).icon, { size: 15 })),
        h('span', {}, annotationLabel(a)),
        h('span', { class: 'muted' }, piece ? formatTime(piece.outStart) : 'Cut'));
      });
      list.replaceChildren(...(rows.length ? [h('h4', {}, `In this video (${rows.length})`), ...rows] : []));
    }

    function update() {
      const a = selected();
      detail.hidden = !a;
      // The add buttons stay: with one selected they sit under its settings,
      // so a second annotation is one click away.
      top.hidden = Boolean(a);
      if (a) detail.append(addSection);
      else top.insertBefore(addSection, list);
      if (!a) {
        renderList();
        return;
      }
      const p = store.project;
      const pieces = rangePieces(p, clipLayout(p, store.tl), a.source, a.start, a.end);
      heading.textContent = kindOf(a.type).label;
      when.textContent = pieces.length
        ? `${formatTime(pieces[0].outStart, { fraction: true })} – ${formatTime(pieces.at(-1).outEnd, { fraction: true })}`
        : 'This part of the recording is cut from the video.';
      hint.textContent = HINTS[a.type];
      const words = a.type === 'text' || a.type === 'title';
      textField.hidden = !words;
      if (words && document.activeElement !== text) text.value = a.text;
      colourField.hidden = a.type === 'blur';
      colourLabel.textContent = a.type === 'title' ? 'Background' : 'Colour';
      for (const s of swatches) s.setAttribute('aria-pressed', String(s.dataset.colour.toLowerCase() === a.color.toLowerCase()));
      size.querySelector('.label').textContent = a.type === 'blur' ? 'Block size' : a.type === 'title' ? 'Text size' : 'Size';
      size.set(a.size);
      length.set(Math.round((a.end - a.start) * 10) / 10);
    }
    update();
    return { update };
  }
};
