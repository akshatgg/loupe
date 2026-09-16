// Style: presets, what's around the recording (background colour, gradient
// or picture, padding, corners, shadow, shape), how the cursor looks and the
// keyboard shortcut badges. Every control is one undo step; a slider dragged
// back and forth is one step too.

import { h, slider, toggle, segmented, section } from '../ui.js';
import { setStyle } from '../../../core/project.js';
import { presetsSection, picturesRow, keystrokesSection } from './style-extras.js';

export const GRADIENTS = [
  { angle: 135, stops: ['#4f5bd5', '#962fbf'] },
  { angle: 135, stops: ['#8ab4f8', '#1a73e8'] },
  { angle: 135, stops: ['#f6d365', '#fda085'] },
  { angle: 135, stops: ['#84fab0', '#8fd3f4'] },
  { angle: 135, stops: ['#ff9a9e', '#fecfef'] },
  { angle: 160, stops: ['#232526', '#414345'] },
  { angle: 135, stops: ['#0f2027', '#2c5364'] },
  { angle: 120, stops: ['#fc466b', '#3f5efb'] }
];
export const COLOURS = ['#ffffff', '#e8eaed', '#1f1f23', '#1a73e8', '#34a853', '#fbbc04'];

const ASPECT_LABELS = [
  { value: 'source', label: 'Original', w: 16, h: 10 },
  { value: '16:9', label: '16:9', w: 16, h: 9 },
  { value: '9:16', label: '9:16', w: 9, h: 16 },
  { value: '1:1', label: '1:1', w: 12, h: 12 },
  { value: '4:5', label: '4:5', w: 11, h: 13.75 }
];

const sameBackground = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function aspectIcon(w, hgt) {
  return h('span', { class: 'aspect-icon', style: { width: `${w}px`, height: `${hgt}px` } });
}

export default {
  id: 'style',
  title: 'Style',
  icon: 'style',
  mount(container, editor) {
    const { store } = editor;
    const edit = (patch, gesture = null) => store.apply((p) => setStyle(p, patch), { gesture });
    const done = () => store.endGesture();
    const style = () => store.project.style;

    // ---- background
    const swatches = [];
    const swatch = (bg, title, paint) => {
      const b = h('button', {
        type: 'button', class: 'swatch', title, 'aria-label': title,
        onclick: () => { edit({ background: bg }); done(); }
      });
      Object.assign(b.style, paint);
      b.bg = bg;
      swatches.push(b);
      return b;
    };
    const none = swatch({ type: 'none', value: null }, 'No background', {});
    none.classList.add('swatch-none');
    const grads = GRADIENTS.map((g, i) => swatch({ type: 'gradient', value: g }, `Gradient ${i + 1}`,
      { background: `linear-gradient(${g.angle}deg, ${g.stops.join(', ')})` }));
    const cols = COLOURS.map((c) => swatch({ type: 'color', value: c }, `Colour ${c}`, { background: c }));
    const picker = h('input', { type: 'color', value: '#1a73e8', 'aria-label': 'Pick any colour' });
    picker.addEventListener('input', () => edit({ background: { type: 'color', value: picker.value } }, 'style:colour'));
    picker.addEventListener('change', done);
    const custom = h('label', { class: 'swatch swatch-custom', title: 'Pick any colour' }, picker);
    const pictures = picturesRow(editor, { onPick: (bg) => { edit({ background: bg }); done(); } });
    const presets = presetsSection(editor);
    const keys = keystrokesSection(editor);

    // ---- frame
    const padding = slider({
      label: 'Padding', min: 0, max: 0.25, step: 0.005, value: style().padding,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => edit({ padding: v }, 'style:padding'), onChange: done
    });
    const radius = slider({
      label: 'Rounded corners', min: 0, max: 48, step: 1, value: style().radius,
      format: (v) => `${v}`, onInput: (v) => edit({ radius: v }, 'style:radius'), onChange: done
    });
    const shadow = slider({
      label: 'Shadow', min: 0, max: 1, step: 0.01, value: style().shadow,
      format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => edit({ shadow: v }, 'style:shadow'), onChange: done
    });
    const aspect = segmented({
      label: null,
      options: ASPECT_LABELS.map((a) => ({ value: a.value, label: a.label, icon: aspectIcon(a.w, a.h), title: a.value === 'source' ? 'The shape of your recording' : `${a.label} video` })),
      value: style().aspect,
      onChange: (v) => { edit({ aspect: v }); done(); }
    });
    aspect.classList.add('aspects');

    // ---- cursor
    const showCursor = toggle({ label: 'Show cursor', checked: style().cursor.show, onChange: (v) => { edit({ cursor: { show: v } }); done(); } });
    const size = slider({
      label: 'Cursor size', min: 0.5, max: 3, step: 0.05, value: style().cursor.size,
      format: (v) => `${v.toFixed(1)}×`, onInput: (v) => edit({ cursor: { size: v } }, 'style:cursor-size'), onChange: done
    });
    const smooth = toggle({ label: 'Smooth movement', hint: 'Glides the cursor instead of jittering', checked: style().cursor.smooth, onChange: (v) => { edit({ cursor: { smooth: v } }); done(); } });
    const idle = toggle({ label: 'Hide when still', hint: 'Fades the cursor out when you stop moving it', checked: style().cursor.hideWhenIdle, onChange: (v) => { edit({ cursor: { hideWhenIdle: v } }); done(); } });
    const highlight = segmented({
      label: 'Highlight',
      options: [{ value: 'none', label: 'None' }, { value: 'spotlight', label: 'Spotlight' }, { value: 'ring', label: 'Ring' }],
      value: style().cursor.highlight,
      onChange: (v) => { edit({ cursor: { highlight: v } }); done(); }
    });
    const clicks = toggle({ label: 'Show clicks', hint: 'A ripple wherever you click', checked: style().cursor.clicks, onChange: (v) => { edit({ cursor: { clicks: v } }); done(); } });
    const cursorOnly = [size, smooth, idle, highlight];

    container.append(
      presets.el,
      section('Background', h('div', { class: 'swatches' }, none, ...grads, ...cols, custom), pictures.el),
      section('Frame', padding, radius, shadow),
      section('Shape', aspect),
      section('Cursor', showCursor, ...cursorOnly),
      section('Clicks', clicks),
      keys.el
    );

    function update() {
      const s = style();
      for (const b of swatches) b.setAttribute('aria-pressed', String(sameBackground(b.bg, s.background)));
      const isCustom = s.background.type === 'color' && !COLOURS.includes(s.background.value);
      custom.setAttribute('aria-pressed', String(isCustom));
      if (isCustom && document.activeElement !== picker) picker.value = s.background.value.slice(0, 7);
      padding.set(s.padding);
      radius.set(s.radius);
      shadow.set(s.shadow);
      aspect.set(s.aspect);
      showCursor.set(s.cursor.show);
      size.set(s.cursor.size);
      smooth.set(s.cursor.smooth);
      idle.set(s.cursor.hideWhenIdle);
      highlight.set(s.cursor.highlight);
      clicks.set(s.cursor.clicks);
      for (const row of cursorOnly) row.classList.toggle('disabled', !s.cursor.show);
      pictures.update();
      keys.update();
    }
    update();
    return { update };
  }
};
