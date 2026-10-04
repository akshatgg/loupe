// The right side of the editor: one panel at a time. With nothing selected
// it shows the video's own settings, on tabs (Look, Cursor, Camera, Captions,
// Audio); with something selected, that thing's settings, under its name and
// a back arrow -- the way an editor's inspector follows what you click.
//
// The panels themselves are the modules in panels/ ({ id, title, icon,
// mount(container, editor) -> { update(what) } }), mounted the first time
// they show and kept.

import { h, icon } from './ui.js';

// Which panel holds the settings of each kind of thing.
const PANEL_FOR_KIND = {
  zoom: 'zoom', clip: 'clip', overlay: 'clip', speed: 'clip',
  annotation: 'annotations', caption: 'captions', audio: 'audio'
};

// The panel to show for what's selected: the last tab with nothing (or only
// something without settings, such as a marker), that kind's panel for one
// thing, and the "several things" panel for more.
export function panelFor(selected, lastTab) {
  if (!selected?.length) return lastTab;
  if (selected.length > 1) return 'multi';
  return PANEL_FOR_KIND[selected[0].kind] ?? lastTab;
}

const ANNOTATION_NAMES = { text: 'Text', title: 'Title card', arrow: 'Arrow', box: 'Box', blur: 'Blur' };

// What the header calls the selected thing.
export function itemTitle(project, selected) {
  if (!selected?.length) return null;
  if (selected.length > 1) return `${selected.length} items selected`;
  const it = selected[0];
  switch (it.kind) {
    case 'zoom': return 'Zoom';
    case 'speed': return 'Speed';
    case 'caption': return 'Caption';
    case 'clip': {
      const i = project.clips.findIndex((c) => c.id === it.id);
      const clip = project.clips[i];
      if (!clip) return 'Clip';
      if (clip.gap) return 'Gap';
      if (clip.hold > 0) return 'Freeze frame';
      return project.clips.length > 1 ? `Clip ${i + 1}` : 'Clip';
    }
    case 'annotation': return ANNOTATION_NAMES[project.annotations.find((a) => a.id === it.id)?.type] ?? 'Annotation';
    case 'audio': return project.audio.clips.find((c) => c.id === it.id)?.name || 'Audio';
    case 'overlay': return project.overlays.find((o) => o.id === it.id)?.name || 'Overlay';
    default: return null;
  }
}

export function createInspector({ sidebar, tabsEl, titleEl, backEl, panelBox, store, editor, tabs, panelById }) {
  const mounted = new Map();
  let current = null;
  let lastTab = tabs[0].id;
  const isTab = (id) => tabs.some((t) => t.id === id);

  for (const panel of tabs) {
    tabsEl.append(h('button', {
      type: 'button', role: 'tab', class: 'tab', title: panel.title, 'aria-label': panel.title,
      dataset: { panel: panel.id }, onclick: () => { store.select(null); show(panel.id); }
    }, icon(panel.icon, { size: 18 }), h('span', {}, panel.title)));
  }
  backEl.replaceChildren(icon('back', { size: 18 }));
  backEl.onclick = () => store.select(null);

  function header() {
    const name = itemTitle(store.project, store.selected);
    const item = Boolean(name) && panelFor(store.selected, null) === current;
    // The tabs are the video's settings: they step aside for a selected thing.
    tabsEl.hidden = item;
    backEl.hidden = !item;
    titleEl.hidden = !item && isTab(current);
    titleEl.textContent = item ? name : panelById(current)?.title ?? '';
    sidebar.dataset.panel = current ?? '';
    sidebar.dataset.mode = item ? 'item' : 'video';
  }

  function show(id, { focus = false } = {}) {
    const panel = panelById(id);
    if (!panel) return;
    // Another panel opens at its top, not at the last one's scroll position.
    if (current !== id) panelBox.closest('.panel-wrap').scrollTop = 0;
    current = id;
    if (isTab(id) && !store.selected.length) lastTab = id;
    for (const b of tabsEl.children) b.setAttribute('aria-selected', String(b.dataset.panel === id));
    for (const [pid, m] of mounted) m.el.hidden = pid !== id;
    if (!mounted.has(id)) {
      const el = h('div', { class: 'panel-body', dataset: { panel: id } });
      panelBox.append(el);
      mounted.set(id, { el, api: panel.mount(el, editor) });
    }
    header();
    mounted.get(id).api.update('panel');
    if (focus) mounted.get(id).el.querySelector('input, button')?.focus();
  }

  store.subscribe((what) => {
    if (what === 'selection') {
      const want = panelFor(store.selected, lastTab);
      if (want !== current) show(want);
      else header();
    } else {
      header();
    }
    mounted.get(current)?.api.update(what);
  });

  return {
    show,
    get current() { return current; },
    api: (id) => mounted.get(id)?.api ?? null,
    updateCurrent: (what) => mounted.get(current)?.api.update(what)
  };
}
