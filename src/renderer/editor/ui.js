// Small DOM helpers for the editor. Text always goes in as text nodes, never
// markup: titles and file names come from other applications and people, and
// must never be able to inject HTML (see the picker's earlier bug).

const SVG = 'http://www.w3.org/2000/svg';

// h('div', { class: 'row', onclick: fn, dataset: { id } }, child, 'text', ...)
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// Line icons on a 24-unit grid, drawn with the current text colour.
const ICONS = {
  play: ['M8 5.5v13l10.5-6.5z', 'fill'],
  pause: ['M7.5 5h3v14h-3zM13.5 5h3v14h-3z', 'fill'],
  undo: ['M9 7 4.5 11.5 9 16M5 11.5h9.5a5 5 0 0 1 0 10H12'],
  redo: ['M15 7l4.5 4.5L15 16M19 11.5H9.5a5 5 0 0 0 0 10H12'],
  split: ['M12 3v18M7.5 8 12 12l-4.5 4M16.5 8 12 12l4.5 4'],
  music: ['M9 17.5V6l10-2v11.5M9 17.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z'],
  duplicate: ['M8 8h11v11H8zM5 16V5h11'],
  lock: ['M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  keyframe: ['M12 4l8 8-8 8-8-8z'],
  unlock: ['M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 6.8-1.2'],
  detach: ['M4 7h10M4 11h10M14 15l4 4M18 15l-4 4M4 17h6'],
  cut: ['M6.5 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM6.5 15a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8.6 7.9 19 17M8.6 16.1 19 7'],
  zoomAdd: ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.2 15.2 20 20M10.5 8v5M8 10.5h5'],
  trash: ['M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13M10.5 11v5.5M13.5 11v5.5'],
  minus: ['M6 12h12'],
  back: ['M14.5 6 8.5 12l6 6'],
  plus: ['M12 6v12M6 12h12'],
  fit: ['M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4'],
  settings: ['M19 12a7 7 0 1 1-14 0a7 7 0 1 1 14 0M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8'],
  keyboard: ['M3.5 7h17v10h-17zM7 10.5h.01M10 10.5h.01M13 10.5h.01M16 10.5h.01M8 14h8'],
  style: ['M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1.1-1.6-1.1-2.8 0-.9.7-1.5 1.6-1.5h2.2a4 4 0 0 0 4-4C20.5 6.6 16.7 3.5 12 3.5zM7.5 12h.01M9.5 8h.01M14.5 8h.01'],
  zoom: ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.2 15.2 20 20'],
  audio: ['M4 10v4h3.5L12 18V6L7.5 10zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11'],
  captions: ['M3.5 6h17v12h-17zM7 11h4M13 11h4M7 14.5h7M16 14.5h1'],
  merge: ['M4 7h5l3 5-3 5H4M20 7h-5l-3 5 3 5h5'],
  annotations: ['M5 19l3.5-1 10-10a1.8 1.8 0 0 0-2.5-2.5l-10 10zM14.5 7l2.5 2.5'],
  speed: ['M4 16a8 8 0 1 1 16 0M12 16l4-5'],
  clips: ['M4 6.5h16v11H4zM9 6.5v11M15 6.5v11'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  close: ['M6 6l12 12M18 6 6 18'],
  folder: ['M3.5 6.5h6l2 2h9v10h-17z'],
  cursor: ['M6 3.5v15l4-4 2.8 6 2.4-1.1-2.8-5.9H18z'],
  target: ['M12 4v4M12 16v4M4 12h4M16 12h4M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
  alert: ['M12 4 2.5 20h19zM12 10v4.5M12 17.2h.01'],
  // Visuals: annotations, webcam, transitions, pictures, presets.
  text: ['M5 6.5V5h14v1.5M12 5v14M9.5 19h5'],
  titleCard: ['M3.5 5.5h17v13h-17zM8 10.5h8M9.5 13.5h5'],
  arrow: ['M5 19 18 6M10 6h8v8'],
  box: ['M5 6.5h14v11H5z'],
  blur: ['M4.5 4.5h4v4h-4zM10 4.5h4v4h-4zM15.5 4.5h4v4h-4zM4.5 10h4v4h-4zM15.5 10h4v4h-4zM4.5 15.5h4v4h-4zM10 15.5h4v4h-4zM15.5 15.5h4v4h-4zM10 10h4v4h-4z'],
  webcam: ['M12 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM12 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM8 20h8M12 16v4'],
  transition: ['M4 6h7v12H4zM13 6h7v12h-7zM9 12h6M13.5 10l1.5 2-1.5 2'],
  image: ['M4 5.5h16v13H4zM4 15.5l4.5-4.5 4 4 2.5-2.5 5 5M15.5 9.5h.01'],
  star: ['M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4 7.2 18.9l.9-5.4-3.9-3.8 5.4-.8z']
};

export function icon(name, { size = 18 } = {}) {
  const [d, mode] = ICONS[name] ?? ICONS.alert;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', d);
  if (mode === 'fill') {
    path.setAttribute('fill', 'currentColor');
  } else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.7');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.append(path);
  return svg;
}

// A labelled slider row. onInput(value) while dragging, onChange(value) once
// let go (the end of an undo gesture).
export function slider({ label, min, max, step, value, format = (v) => String(v), onInput, onChange }) {
  const out = h('span', { class: 'value' }, format(value));
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
  input.addEventListener('input', () => {
    out.textContent = format(Number(input.value));
    onInput?.(Number(input.value));
  });
  input.addEventListener('change', () => onChange?.(Number(input.value)));
  const row = h('label', { class: 'field slider' }, h('span', { class: 'field-row' }, h('span', { class: 'label' }, label), out), input);
  row.set = (v) => {
    if (document.activeElement === input) return;
    input.value = String(v);
    out.textContent = format(v);
  };
  return row;
}

// A switch row.
export function toggle({ label, hint, checked, onChange }) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked: Boolean(checked) });
  input.addEventListener('change', () => onChange(input.checked));
  const row = h('label', { class: 'field toggle' },
    h('span', { class: 'toggle-text' }, h('span', { class: 'label' }, label), hint ? h('span', { class: 'hint' }, hint) : null),
    input, h('span', { class: 'switch', 'aria-hidden': 'true' }));
  row.set = (v) => { input.checked = Boolean(v); };
  row.input = input;
  return row;
}

// Buttons of which one is chosen. options: [{ value, label, title?, icon? }]
export function segmented({ label, options, value, onChange }) {
  const buttons = options.map((o) => h('button', {
    type: 'button', class: 'seg-btn', title: o.title, dataset: { value: String(o.value) },
    onclick: () => onChange(o.value)
  }, o.icon ?? null, o.label));
  const group = h('div', { class: 'segmented', role: 'group', 'aria-label': label }, buttons);
  const row = h('div', { class: 'field' }, label ? h('span', { class: 'label' }, label) : null, group);
  row.set = (v) => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === String(v)));
  };
  row.set(value);
  return row;
}

export function section(title, ...children) {
  return h('section', { class: 'panel-section' }, title ? h('h3', {}, title) : null, ...children);
}
