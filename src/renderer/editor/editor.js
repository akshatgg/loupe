// The editor window (docs/EDITOR-V2.md section 11, wave 2): the preview, the
// sidebar panels, the timeline and the export dialog, all working on one
// project held here and edited with the pure core.
//
// Main (src/main/ipc/project.js) loads the project -- migrating a v1 one --
// and saves whatever this page sends back; every change is sent, and main
// writes the latest shortly after.

import * as P from '../../core/project.js';
import { createStore } from './store.js';
import { createPlayer } from './player.js';
import { createTimeline } from './timeline-view.js';
import { createExportDialog, plainError } from './export-dialog.js';
import { createCheatSheet } from './cheat-sheet.js';
import { commandFor } from './shortcuts.js';
import { PANELS, panelById } from './panels/index.js';
import { installMusicDrop } from './panels/audio.js';
import { h, icon } from './ui.js';
import { clipLayout, newZoomRange, formatTime } from './timeline-math.js';
import { newAnnotation } from './annotation-math.js';
import { createAnnotationOverlay } from './annotation-overlay.js';
import { createAddRecording } from './add-recording.js';
import { createThumbnails } from './thumbnails.js';
import { createFirstRunHint } from './first-run.js';

const loupe = window.loupe;
const $ = (id) => document.getElementById(id);

// ---- toasts and the save indicator

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth; // restart the fade-in
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, 3200);
}

function setSaveState(text, bad = false) {
  const el = $('saveState');
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

// Sends every change; main debounces the writes. Only the newest project
// matters, so one in flight is followed by at most one more.
function createSaver() {
  let inFlight = null;
  let queued = null;
  async function send(project) {
    setSaveState('Saving…');
    try {
      await loupe.saveProject(project);
      setSaveState('All changes saved');
    } catch (err) {
      setSaveState('Couldn’t save', true);
      toast(`Your changes couldn’t be saved: ${plainError(err)}`);
    }
  }
  function save(project) {
    if (inFlight) { queued = project; return; }
    inFlight = send(project).finally(() => {
      inFlight = null;
      if (queued) { const q = queued; queued = null; save(q); }
    });
  }
  return { save, flush: async () => { while (inFlight) await inFlight; } };
}

function showFatal(heading, message) {
  $('app').hidden = true;
  const box = $('fatal');
  box.replaceChildren(h('div', { class: 'fatal-card' },
    h('div', { class: 'empty-icon' }, icon('alert', { size: 30 })),
    h('h1', {}, heading),
    h('p', {}, message)));
  box.hidden = false;
}

async function start() {
  let loaded;
  try {
    loaded = await loupe.loadProject();
  } catch (err) {
    showFatal('This recording couldn’t be opened', plainError(err));
    return;
  }
  const saver = createSaver();
  const store = createStore(loaded.project, {
    save: (p) => saver.save(p),
    onError: (err) => toast(plainError(err))
  });
  const player = createPlayer({ canvas: $('preview'), store, sources: loaded.sources, folder: loaded.folder });

  const missing = Object.entries(loaded.sources).filter(([key, s]) => s.missing &&
    store.project.clips.some((c) => c.source === key));
  if (missing.length) {
    $('stageNotice').hidden = false;
    $('stageNotice').replaceChildren(icon('alert', { size: 18 }),
      h('span', {}, 'The video file for this recording is missing, so the preview is blank. It may have been moved or deleted.'));
  }

  // ---- panels

  const tabs = $('tabs');
  const panelBox = $('panel');
  const mounted = new Map();
  let currentPanel = null;

  const editor = {
    store, player, core: P, platform: loupe.platform, toast, sources: loaded.sources,
    select(sel, { seek = false } = {}) {
      store.select(sel);
      if (sel?.kind === 'annotation') {
        showPanel('annotations');
        const a = store.project.annotations.find((q) => q.id === sel.id);
        const at = store.tl.toSource(player.time);
        // Past its fade-in, so it's fully there to drag.
        const onScreen = a && at.source === a.source && at.t >= a.start + 0.25 && at.t < a.end - 0.25;
        if (seek && a && !onScreen) {
          const t = store.tl.toOutput(a.source, Math.min((a.start + a.end) / 2, a.start + 0.3));
          if (t !== null && t !== undefined) player.seek(t);
        }
      }
      if (sel?.kind === 'zoom') {
        showPanel('zoom');
        if (seek) {
          const z = store.project.zooms.find((q) => q.id === sel.id);
          const t = z && store.tl.toOutput(z.source, z.start);
          if (t !== null && t !== undefined) player.seek(t);
        }
      } else if (sel?.kind === 'caption') {
        showPanel('captions');
      }
    },
    showPanel: (id, opts) => showPanel(id, opts),
    revealCaption: (id, opts) => mounted.get('captions')?.api.reveal?.(id, opts),
    addZoom(range) {
      const before = new Set(store.project.zooms.map((z) => z.id));
      const next = store.apply((p) => P.addZoom(p, { ...range, level: 2, follow: true }));
      const added = next?.zooms.find((z) => !before.has(z.id));
      if (added) editor.select({ kind: 'zoom', id: added.id });
      return added ?? null;
    },
    // A new annotation at the playhead, selected and ready to drag into place.
    addAnnotation(type) {
      const draft = newAnnotation(store.project, clipLayout(store.project, store.tl), player.time, type);
      if (!draft) return null;
      player.pause();
      const before = new Set(store.project.annotations.map((a) => a.id));
      const next = store.apply((p) => P.addAnnotation(p, draft));
      const added = next?.annotations.find((a) => !before.has(a.id));
      if (added) editor.select({ kind: 'annotation', id: added.id }, { seek: true });
      return added ?? null;
    },
    addZoomAtPlayhead() {
      const range = newZoomRange(store.project, clipLayout(store.project, store.tl), player.time);
      if (!range) {
        toast('There’s already a zoom here. Move the playhead to add another.');
        return null;
      }
      return editor.addZoom(range);
    }
  };

  function showPanel(id, { focus = false } = {}) {
    const panel = panelById(id);
    if (!panel) return;
    currentPanel = id;
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.panel === id));
    for (const [pid, m] of mounted) m.el.hidden = pid !== id;
    if (!mounted.has(id)) {
      const el = h('div', { class: 'panel-body', dataset: { panel: id } });
      panelBox.append(el);
      mounted.set(id, { el, api: panel.mount(el, editor) });
    }
    $('panelTitle').textContent = panel.title;
    mounted.get(id).api.update('panel');
    if (focus) mounted.get(id).el.querySelector('input, button')?.focus();
  }

  for (const panel of PANELS) {
    tabs.append(h('button', {
      type: 'button', role: 'tab', class: 'tab', title: panel.title, 'aria-label': panel.title,
      dataset: { panel: panel.id }, onclick: () => showPanel(panel.id)
    }, icon(panel.icon, { size: 20 }), h('span', {}, panel.title)));
  }
  showPanel('style');
  // A song dropped anywhere on the window becomes the video's music.
  installMusicDrop(editor);

  // ---- timeline, transport, top bar

  // Pictures along the clips, from each recording's video.
  const thumbnails = createThumbnails({ onReady: () => timeline.redrawPictures() });
  for (const [key, files] of Object.entries(loaded.sources)) thumbnails.addSource(key, files.video);
  const timeline = createTimeline({ root: $('timeline'), store, player, editor, thumbnails });
  const addRecording = createAddRecording({
    store, player, loupe, core: P, toast,
    onAdded: (added) => thumbnails.addSource(added.key, added.files.video)
  });
  const firstRun = createFirstRunHint({ parent: $('stage') });
  const overlay = createAnnotationOverlay({ canvas: $('preview'), stage: $('stage'), store, player, editor });
  const exportDialog = createExportDialog({ store, loupe, player, beforeExport: () => saver.flush() });
  const cheat = createCheatSheet(loupe.platform);

  const title = $('title');
  title.value = store.project.title;
  const commitTitle = () => {
    const v = title.value.trim();
    if (!v) { title.value = store.project.title; return; }
    if (v !== store.project.title) store.apply((p) => P.setTitle(p, v));
  };
  title.addEventListener('change', commitTitle);
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
    if (e.key === 'Escape') { title.value = store.project.title; title.blur(); }
  });

  const mod = loupe.platform === 'darwin' ? '⌘' : 'Ctrl+';
  $('undo').title = `Undo (${mod}Z)`;
  $('redo').title = loupe.platform === 'darwin' ? 'Redo (⇧⌘Z)' : 'Redo (Ctrl+Y)';
  $('exportBtn').title = `Export (${mod}E)`;

  function deleteSelection() {
    const sel = store.selection;
    if (!sel) {
      toast('Select a clip, zoom, speed change or annotation first.');
      return;
    }
    if (sel.kind === 'clip') {
      if (store.project.clips.length === 1) {
        toast('A video needs at least one clip. Drag its edges to trim it instead.');
        return;
      }
      store.apply((p) => P.deleteClip(p, sel.id));
    } else if (sel.kind === 'zoom') {
      store.apply((p) => P.removeZoom(p, sel.id));
    } else if (sel.kind === 'annotation') {
      store.apply((p) => P.removeAnnotation(p, sel.id));
    } else if (sel.kind === 'caption') {
      store.apply((p) => P.setCaptions(p, { segments: p.captions.segments.filter((c) => c.id !== sel.id) }));
    } else if (sel.kind === 'speed') {
      store.apply((p) => P.paintSpeed(p, { source: sel.source, start: sel.start, end: sel.end, rate: 1 }));
    }
    store.select(null);
  }

  function split() {
    const t = player.time;
    const next = store.apply((p) => P.splitAt(p, t));
    if (next) toast('Split into two clips');
  }

  const actions = {
    undo: () => store.undo(),
    redo: () => store.redo(),
    export: () => { timeline.closeMenu(); exportDialog.show(); },
    playPause: () => player.toggle(),
    backFrame: () => player.seek(player.time - player.frameStep()),
    forwardFrame: () => player.seek(player.time + player.frameStep()),
    back1s: () => player.seek(player.time - 1),
    forward1s: () => player.seek(player.time + 1),
    toStart: () => player.seek(0),
    toEnd: () => player.seek(store.tl.duration),
    split,
    addZoom: () => editor.addZoomAtPlayhead(),
    delete: deleteSelection,
    timelineZoomIn: () => timeline.zoomIn(),
    timelineZoomOut: () => timeline.zoomOut(),
    timelineFit: () => timeline.fit(),
    cheatSheet: () => cheat.toggle(),
    escape: () => {
      if (cheat.open) cheat.toggle();
      else if (timeline.menuOpen) timeline.closeMenu();
      else if (firstRun.open && !store.selection) firstRun.dismiss();
      else store.select(null);
    },
    addRecording: () => addRecording.show()
  };

  $('undo').onclick = actions.undo;
  $('redo').onclick = actions.redo;
  $('exportBtn').onclick = actions.export;
  $('play').onclick = actions.playPause;
  $('splitBtn').onclick = actions.split;
  $('zoomBtn').onclick = actions.addZoom;
  $('deleteBtn').onclick = actions.delete;
  $('addRecBtn').onclick = actions.addRecording;
  $('tlOut').onclick = actions.timelineZoomOut;
  $('tlIn').onclick = actions.timelineZoomIn;
  $('tlFit').onclick = actions.timelineFit;
  $('shortcutsBtn').onclick = actions.cheatSheet;

  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest?.('input[type="text"], input:not([type]), textarea, [contenteditable="true"]');
    const command = commandFor(e, loupe.platform);
    if (!command) return;
    // In a text field only the app-wide shortcuts apply; undo there undoes typing.
    if (typing && !['export'].includes(command)) return;
    if (exportDialog.isOpen || addRecording.isOpen) return;
    if (cheat.open && command !== 'cheatSheet' && command !== 'escape') return;
    // Space on a focused button would press it as well as play.
    if (command === 'playPause' || command === 'delete') e.preventDefault();
    // A slider or segmented button keeps its own arrow keys.
    if (/Frame|1s/.test(command) && e.target.matches?.('input[type="range"]')) return;
    e.preventDefault();
    actions[command]();
  });

  // Edit > Undo/Redo and Help > Keyboard shortcuts from the app menu, sent
  // here while the editor is in front. In a text field undo means typing.
  loupe.onAppCommand?.((command) => {
    if (command === 'shortcuts') {
      if (!cheat.open) cheat.toggle();
      return;
    }
    if (command !== 'undo' && command !== 'redo') return;
    if (document.activeElement?.closest?.('input[type="text"], input:not([type]), textarea')) {
      document.execCommand(command);
      return;
    }
    if (exportDialog.isOpen || addRecording.isOpen) return;
    actions[command]();
  });

  // ---- keeping everything in step

  const tlLabel = $('time');
  player.onTime((t, playing) => {
    tlLabel.textContent = `${formatTime(t, { fraction: true })} / ${formatTime(store.tl.duration, { fraction: true })}`;
    const play = $('play');
    const want = playing ? 'pause' : 'play';
    if (play.dataset.state !== want) {
      play.dataset.state = want;
      play.replaceChildren(icon(want, { size: 20 }));
      play.title = playing ? 'Pause (Space)' : 'Play (Space)';
      play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }
  });

  function refresh(what) {
    $('undo').disabled = !store.canUndo;
    $('redo').disabled = !store.canRedo;
    $('deleteBtn').disabled = !store.selection;
    if (document.activeElement !== title) title.value = store.project.title;
    document.title = store.project.title || 'Loupe';
    for (const [id, m] of mounted) if (id === currentPanel) m.api.update(what);
  }
  store.subscribe(refresh);
  player.onTime(() => {
    // The zoom panel's "Add a zoom here" depends on where the playhead is.
    if (currentPanel === 'zoom' && !store.selection && !player.playing) mounted.get('zoom').api.update('time');
  });
  refresh('load');
  player.seek(0);
  setSaveState(loaded.migrated ? 'Opened from an older version' : 'All changes saved');

  // For the end-to-end tests (test/e2e/editor.js), which drive this page.
  window.__editor = {
    store, player, timeline, exportDialog, cheat, editor, actions, saver, overlay, addRecording, thumbnails, firstRun
  };
  document.body.dataset.ready = 'true';
  // After the page is up, so the tests (and people) see a settled editor.
  firstRun.show();
}

start().catch((err) => {
  console.error(err);
  showFatal('Something went wrong opening the editor', plainError(err));
});
