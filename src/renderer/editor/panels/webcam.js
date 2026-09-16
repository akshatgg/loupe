// Webcam: the bubble of you recorded alongside the screen (style.webcam).
// Show or hide it, its shape, its size and which corner it sits in. Every
// control is one undo step.

import { h, icon, slider, toggle, segmented, section } from '../ui.js';
import { setStyle } from '../../../core/project.js';

const CORNERS = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' }
];

export default {
  id: 'webcam',
  title: 'Webcam',
  icon: 'webcam',
  mount(container, editor) {
    const { store } = editor;
    const hasWebcam = () => Object.values(store.project.sources).some((s) => s.webcam);
    const edit = (patch, gesture = null) => store.apply((p) => setStyle(p, { webcam: patch }), { gesture });
    const done = () => store.endGesture();
    const cam = () => store.project.style.webcam;

    const empty = h('div', { class: 'panel-empty' },
      h('div', { class: 'empty-icon' }, icon('webcam', { size: 28 })),
      h('h3', {}, 'No webcam in this recording'),
      h('p', {}, 'Turn on the camera when you start a recording, and you’ll appear here in a bubble you can resize and move to any corner.'));

    const show = toggle({ label: 'Show webcam', hint: 'Your camera in a bubble over the video', checked: cam().show, onChange: (v) => { edit({ show: v }); done(); } });
    const shape = segmented({
      label: 'Shape',
      options: [
        { value: 'circle', label: 'Circle', icon: h('span', { class: 'shape-icon circle' }) },
        { value: 'rounded', label: 'Rounded', icon: h('span', { class: 'shape-icon rounded' }) }
      ],
      value: cam().shape,
      onChange: (v) => { edit({ shape: v }); done(); }
    });
    const size = slider({
      label: 'Size', min: 0.1, max: 0.45, step: 0.01, value: cam().size,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => edit({ size: v }, 'webcam:size'), onChange: done
    });
    const cornerButtons = CORNERS.map((c) => h('button', {
      type: 'button', class: 'corner-btn', title: c.label, 'aria-label': c.label, dataset: { corner: c.value },
      onclick: () => { edit({ corner: c.value }); done(); }
    }, h('span', { class: 'corner-dot' })));
    const corner = h('div', { class: 'field' }, h('span', { class: 'label' }, 'Corner'),
      h('div', { class: 'corner-picker', role: 'group', 'aria-label': 'Corner' }, cornerButtons));
    const controls = [shape, size, corner];
    const body = h('div', {}, section('Bubble', show, ...controls));

    container.append(empty, body);

    function update() {
      const has = hasWebcam();
      empty.hidden = has;
      body.hidden = !has;
      const w = cam();
      show.set(w.show);
      shape.set(w.shape);
      size.set(w.size);
      for (const b of cornerButtons) b.setAttribute('aria-pressed', String(b.dataset.corner === w.corner));
      for (const row of controls) row.classList.toggle('disabled', !w.show);
    }
    update();
    return { update };
  }
};
