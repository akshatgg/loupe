// The Style panel's larger sections, kept apart from its sliders:
//
//  - presetsSection: apply a saved style, save the current one, and pick the
//    one new recordings start with (window.loupe.presets, src/main/ipc/presets.js)
//  - picturesRow: the bundled wallpapers and "your own picture", which is
//    copied into the recording's folder (window.loupe.background)
//  - keystrokesSection: show keyboard shortcuts, and where

import { h, icon, toggle, segmented, section } from '../ui.js';
import { setStyle } from '../../../core/project.js';
import { WALLPAPERS, wallpaperValue, isProjectBackground } from '../../../core/wallpapers.js';

const wallpaperUrl = (id) => new URL(`../../../assets/wallpapers/${id}.png`, import.meta.url).href;

// ---------------------------------------------------------------- presets

export function presetsSection(editor) {
  const { store, toast } = editor;
  const presets = window.loupe?.presets;
  const list = h('div', { class: 'preset-list', role: 'list' });
  const nameInput = h('input', { type: 'text', class: 'text-input', placeholder: 'Preset name', maxlength: '80', 'aria-label': 'Preset name' });
  const saveRow = h('form', { class: 'preset-save', hidden: true },
    nameInput,
    h('button', { type: 'submit', class: 'btn primary small' }, 'Save'),
    h('button', { type: 'button', class: 'btn small', onclick: () => { saveRow.hidden = true; saveBtn.hidden = false; } }, 'Cancel'));
  const saveBtn = h('button', {
    type: 'button', class: 'btn wide', onclick: () => {
      saveBtn.hidden = true;
      saveRow.hidden = false;
      nameInput.value = '';
      nameInput.focus();
    }
  }, icon('plus', { size: 16 }), 'Save this style as a preset');
  let state = { presets: [], defaultPresetId: null };

  async function refresh() {
    if (!presets) return;
    try {
      state = await presets.list();
    } catch {
      state = { presets: [], defaultPresetId: null };
    }
    render();
  }

  async function apply(preset) {
    let style;
    try {
      style = await presets.apply(preset.id);
    } catch (err) {
      toast(err.message ?? String(err));
      return;
    }
    // A picture from another recording's folder isn't in this one.
    const bg = style.background;
    if (bg?.type === 'image' && !(await window.loupe.background?.url(bg.value).catch(() => null))) {
      delete style.background;
      toast('That preset’s background picture isn’t in this recording, so the background was kept.');
    }
    if (store.apply((p) => setStyle(p, style))) toast(`Applied “${preset.name}”`);
  }

  async function makeDefault(preset) {
    const id = state.defaultPresetId === preset.id ? null : preset.id;
    try {
      await presets.setDefault(id);
      toast(id ? `New recordings will start with “${preset.name}”` : 'New recordings will start with the standard style');
    } catch (err) {
      toast(err.message ?? String(err));
    }
    refresh();
  }

  saveRow.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    try {
      const saved = await presets.save({ name, style: store.project.style });
      toast(`Saved “${saved.name}”`);
      saveRow.hidden = true;
      saveBtn.hidden = false;
    } catch (err) {
      toast(err.message ?? String(err));
    }
    refresh();
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { saveRow.hidden = true; saveBtn.hidden = false; }
  });

  function render() {
    if (!state.presets.length) {
      list.replaceChildren(h('p', { class: 'hint' }, 'Save how this video looks to use it again in one click.'));
      return;
    }
    list.replaceChildren(...state.presets.map((p) => {
      const isDefault = state.defaultPresetId === p.id;
      return h('div', { class: 'preset-row', role: 'listitem', dataset: { id: p.id } },
        h('button', { type: 'button', class: 'preset-apply', title: `Apply “${p.name}”`, onclick: () => apply(p) },
          h('span', { class: 'preset-swatch', style: swatchPaint(p.style) }),
          h('span', { class: 'preset-name' }, p.name)),
        h('button', {
          type: 'button', class: `icon-btn small preset-default${isDefault ? ' on' : ''}`,
          title: isDefault ? 'New recordings start with this style (click to stop)' : 'Start new recordings with this style',
          'aria-label': 'Use for new recordings', 'aria-pressed': String(isDefault), onclick: () => makeDefault(p)
        }, icon('star', { size: 16 })));
    }));
  }

  window.loupe?.onSettingsChanged?.(() => refresh());
  refresh();
  const el = section('Presets', list, saveBtn, saveRow);
  if (!presets) el.hidden = true;
  return { el, refresh };
}

function swatchPaint(style) {
  const bg = style?.background;
  if (bg?.type === 'gradient') return { background: `linear-gradient(${bg.value.angle}deg, ${bg.value.stops.join(', ')})` };
  if (bg?.type === 'color') return { background: bg.value };
  if (bg?.type === 'image' && bg.value?.startsWith('wallpaper:')) {
    return { background: `center / cover url("${wallpaperUrl(bg.value.slice(10))}")` };
  }
  return { background: '#000' };
}

// ---------------------------------------------------------------- pictures

export function picturesRow(editor, { onPick }) {
  const { store, toast } = editor;
  const buttons = WALLPAPERS.map((w) => {
    const b = h('button', {
      type: 'button', class: 'swatch swatch-picture', title: `${w.name} wallpaper`, 'aria-label': `${w.name} wallpaper`,
      onclick: () => onPick({ type: 'image', value: wallpaperValue(w.id) })
    });
    b.style.background = `center / cover url("${wallpaperUrl(w.id)}")`;
    b.bg = { type: 'image', value: wallpaperValue(w.id) };
    return b;
  });
  const own = h('button', {
    type: 'button', class: 'swatch swatch-own', title: 'Use your own picture', 'aria-label': 'Use your own picture',
    onclick: async () => {
      try {
        const picked = await window.loupe.background.choose();
        if (picked) onPick({ type: 'image', value: picked.value });
      } catch (err) {
        toast(err.message ?? String(err));
      }
    }
  }, icon('image', { size: 18 }));
  let ownValue = null;

  function update() {
    const bg = store.project.style.background;
    for (const b of buttons) b.setAttribute('aria-pressed', String(bg.type === 'image' && bg.value === b.bg.value));
    const mine = bg.type === 'image' && isProjectBackground(bg.value);
    own.setAttribute('aria-pressed', String(mine));
    if (mine && ownValue !== bg.value) {
      ownValue = bg.value;
      window.loupe.background.url(bg.value).then((url) => {
        if (url && ownValue === bg.value) {
          own.style.background = `center / cover url("${url}")`;
          own.classList.add('has-picture');
        }
      }).catch(() => {});
    } else if (!mine && ownValue !== null) {
      ownValue = null;
      own.style.background = '';
      own.classList.remove('has-picture');
    }
  }
  return { el: h('div', { class: 'swatches pictures' }, ...buttons, own), buttons, own, update };
}

// ---------------------------------------------------------------- keystrokes

export function keystrokesSection(editor) {
  const { store } = editor;
  const edit = (patch) => { store.apply((p) => setStyle(p, { keystrokes: patch })); store.endGesture(); };
  const ks = () => store.project.style.keystrokes;
  const show = toggle({
    label: 'Show keyboard shortcuts', hint: 'Shortcuts you pressed appear as little keys',
    checked: ks().show, onChange: (v) => edit({ show: v })
  });
  const position = segmented({
    label: 'Where',
    options: [{ value: 'bottom', label: 'Bottom' }, { value: 'top', label: 'Top' }],
    value: ks().position,
    onChange: (v) => edit({ position: v })
  });
  const none = h('p', { class: 'hint' }, 'This recording has no shortcuts in it. Turn on “Show keyboard shortcuts in videos” in Settings before you record.');
  const el = section('Keyboard', show, position, none);
  function update() {
    const recorded = Object.values(store.project.sources).some((s) => s.keys);
    show.set(ks().show);
    position.set(ks().position);
    position.classList.toggle('disabled', !ks().show);
    none.hidden = recorded;
    show.classList.toggle('disabled', !recorded);
  }
  update();
  return { el, update };
}
