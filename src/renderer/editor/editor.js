// The editor window (docs/EDITOR-V2.md section 11, wave 2): the preview, the
// sidebar panels, the timeline and the export dialog, all working on one
// project held here and edited with the pure core.
//
// Main (src/main/ipc/project.js) loads the project -- migrating a v1 one --
// and saves whatever this page sends back; every change is sent, and main
// writes the latest shortly after.

import * as P from '../../core/project.js';
import { copyItems, pasteItems, itemsEnd } from '../../core/clipboard.js';
import { createStore } from './store.js';
import { createPlayer } from './player.js';
import { createTimeline } from './timeline-view.js';
import { createExportDialog, plainError } from './export-dialog.js';
import { createCheatSheet } from './cheat-sheet.js';
import { commandFor } from './shortcuts.js';
import { VIDEO_TABS, panelById } from './panels/index.js';
import { createInspector } from './inspector.js';
import { createToolbar } from './toolbar.js';
import { createTranscriptPanel } from './transcript-panel.js';
import { createAutoZoomNote } from './auto-zoom-note.js';
import { installMusicDrop, addAudioFiles, splitSelectedAudio } from './panels/audio.js';
import { h, icon } from './ui.js';
import { clipLayout, newZoomRange, formatTime } from './timeline-math.js';
import { newAnnotation } from './annotation-math.js';
import { createAnnotationOverlay } from './annotation-overlay.js';
import { createAddRecording } from './add-recording.js';
import { createCutDialog } from './cut-dialog.js';
import { createMarkerDialog } from './marker-dialog.js';
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
// matters, so one in flight is followed by at most one more. Main answers a
// save once it has checked it and writes it a moment later, reporting each
// write as project:written -- so "All changes saved" waits for the disk, and a
// write that failed (the folder was deleted, the disk is full) says so.
function createSaver() {
  let inFlight = null;
  let queued = null;
  let failed = false;
  async function send(project) {
    setSaveState('Saving…');
    try {
      await loupe.saveProject(project);
      if (!loupe.onProjectWritten) setSaveState('All changes saved');
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
  loupe.onProjectWritten?.((result) => {
    if (result?.ok) {
      failed = false;
      if (!inFlight && !queued) setSaveState('All changes saved');
      return;
    }
    setSaveState('Couldn’t save', true);
    // Once per run of failures, not for every edit after it.
    if (!failed) toast(result?.message || 'Your changes couldn’t be saved.');
    failed = true;
  });
  return { save, flush: async () => { while (inFlight) await inFlight; }, get failed() { return failed; } };
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
  const damaged = Object.entries(loaded.sources).filter(([key, s]) => s.damaged &&
    store.project.clips.some((c) => c.source === key));
  if (missing.length || damaged.length) {
    $('stageNotice').hidden = false;
    $('stageNotice').replaceChildren(icon('alert', { size: 18 }),
      h('span', {}, missing.length
        ? 'The video file for this recording is missing, so the preview is blank. It may have been moved or deleted.'
        : 'The video file for this recording is damaged and can’t be played, so the preview is blank.'));
  }

  // ---- panels

  // inspector.js: the video's settings on tabs, or the selected thing's.
  let inspector = null;
  const showPanel = (id, opts) => inspector?.show(id, opts);

  const editor = {
    store, player, core: P, platform: loupe.platform, toast, sources: loaded.sources,
    // Selects one thing ({ add } or { toggle } to select it with the others);
    // the inspector then shows its settings. `seek` brings the playhead to it.
    select(sel, { seek = false, add = false, toggle = false } = {}) {
      store.select(sel, { add, toggle });
      if (!seek || !sel) return;
      if (sel.kind === 'annotation') {
        const a = store.project.annotations.find((q) => q.id === sel.id);
        const at = store.tl.toSource(player.time);
        // Past its fade-in, so it's fully there to drag.
        const onScreen = a && at.source === a.source && at.t >= a.start + 0.25 && at.t < a.end - 0.25;
        if (a && !onScreen) {
          const t = store.tl.toOutput(a.source, Math.min((a.start + a.end) / 2, a.start + 0.3));
          if (t !== null && t !== undefined) player.seek(t);
        }
      } else if (sel.kind === 'zoom') {
        const z = store.project.zooms.find((q) => q.id === sel.id);
        const t = z && store.tl.toOutput(z.source, z.start);
        if (t !== null && t !== undefined) player.seek(t);
      }
    },
    deleteSelected: () => deleteSelection(),
    showPanel: (id, opts) => showPanel(id, opts),
    revealCaption: (id, opts) => { showPanel('captions'); inspector.api('captions')?.reveal?.(id, opts); },
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
    // A picture or video over the video at the playhead (the Overlay button),
    // selected so its settings show.
    async addOverlay() {
      try {
        const got = await loupe.chooseMedia();
        if (!got) return null;
        const next = store.apply((p) => P.addOverlay(p, {
          kind: got.kind, file: got.file, name: got.name, start: Math.min(player.time, Math.max(0, store.tl.duration - 0.1)),
          fileDuration: got.fileDuration, mediaRotation: got.rotation ?? 0
        }));
        const added = next?.overlays.at(-1);
        if (added) {
          editor.select({ kind: 'overlay', id: added.id });
          toast(`Added “${added.name}” over the video`);
        }
        return added ?? null;
      } catch (err) {
        toast(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
        return null;
      }
    },
    // A 2-second still of the frame at the playhead, selected.
    freezeAtPlayhead(seconds = 2) {
      player.pause();
      const t = player.time;
      const next = store.apply((p) => P.freezeFrame(p, t, seconds));
      if (!next) return null;
      const tl = store.tl;
      const i = next.clips.findIndex((c, k) => c.hold > 0 && tl.clipBounds()[k].outEnd > t + 1e-6);
      if (i >= 0) editor.select({ kind: 'clip', id: next.clips[i].id });
      toast(`Freeze frame: ${seconds} seconds`);
      return next;
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

  inspector = createInspector({
    sidebar: $('sidebar'), tabsEl: $('tabs'), titleEl: $('panelTitle'), backEl: $('inspectorBack'), panelBox: $('panel'),
    store, editor, tabs: VIDEO_TABS, panelById
  });
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
  const cutDialog = createCutDialog({ store, player, core: P, toast });
  const markerDialog = createMarkerDialog({ store, core: P, editor });
  editor.editMarker = (id) => markerDialog.show(id);
  const firstRun = createFirstRunHint({ parent: $('stage') });
  const zoomNote = createAutoZoomNote({ parent: $('stage'), store, toast });
  const overlay = createAnnotationOverlay({ canvas: $('preview'), stage: $('stage'), store, player, editor });
  // A click on the empty space around the preview lets go of what's selected,
  // as a click on an empty part of the picture does.
  $('stage').addEventListener('pointerdown', (e) => {
    if (e.button === 0 && (e.target === $('stage') || e.target === $('canvasBox'))) editor.select(null);
  });
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

  let toolbar = null;
  let clipboard = null;
  // Pastes `clip` at output time `t`, as one undo step, and selects what landed.
  function pasteAt(clip, t, said) {
    if (!clip) { toast('Copy something first.'); return; }
    let landed = null;
    const next = store.apply((p) => {
      const out = pasteItems(p, clip, t);
      landed = out.items;
      return out.project;
    });
    if (!next) return;
    store.selectMany(landed);
    toast(landed.length === 1 ? said : `${said} ${landed.length} items`);
  }
  function deleteSelection() {
    // A marked In..Out part goes first, closing the gap (an editor's extract).
    const { in: a, out: b } = timeline.marks;
    if (a !== null && b !== null) {
      const next = store.apply((p) => P.cutRange(p, a, b));
      if (next) {
        timeline.clearMarks();
        refresh('marks');
        player.seek(a);
        toast(`Removed ${formatTime(a, { fraction: true })}–${formatTime(b, { fraction: true })}`);
      }
      return;
    }
    const items = store.selected;
    if (!items.length) {
      toast('Select a clip, zoom, speed change or annotation first.');
      return;
    }
    if (items.length === 1 && items[0].kind === 'clip' && store.project.clips.length === 1) {
      toast('A video needs at least one clip. Drag its edges to trim it instead.');
      return;
    }
    // One undo step, however many things were selected.
    const next = store.apply((p) => P.removeItems(p, items, { leaveGap: !closeGaps() }));
    if (next) {
      if (items.length > 1) toast(`Deleted ${items.length} items`);
      store.select(null);
    }
  }
  // Deleting a clip pulls the later ones left unless "Close gaps" is off
  // (the toolbar's switch).
  const closeGaps = () => toolbar?.closeGaps ?? true;

  function split() {
    // A selected song or sound is split, as the selected clip is in any editor.
    if (splitSelectedAudio(editor)) return;
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
    cut: () => { player.pause(); cutDialog.show(timeline.marks); },
    markIn: () => { timeline.setMark('in', player.time); refresh('marks'); toast(`In at ${formatTime(player.time, { fraction: true })}`); },
    markOut: () => { timeline.setMark('out', player.time); refresh('marks'); toast(`Out at ${formatTime(player.time, { fraction: true })}`); },
    clearMarks: () => { timeline.clearMarks(); refresh('marks'); toast('In and Out cleared'); },
    // J/K/L: L plays forward, pressed again 2x, 4x, 8x; J the same backward; K stops.
    shuttleForward: () => player.shuttle(player.speed >= 1 ? Math.min(8, player.speed * 2) : 1),
    shuttleBack: () => player.shuttle(player.speed <= -1 ? Math.max(-8, player.speed * 2) : -1),
    shuttleStop: () => player.pause(),
    addMarker: () => {
      const next = store.apply((p) => P.addMarker(p, { t: player.time }));
      if (next) toast('Marker added. Double-click it on the ruler to name it');
    },
    freezeFrame: () => editor.freezeAtPlayhead(),
    nextMarker: () => {
      const m = store.project.markers.find((q) => q.t > player.time + 1e-3);
      if (m) player.seek(m.t);
      else toast(store.project.markers.length ? 'No more markers after the playhead' : 'No markers yet: press M to add one');
    },
    addZoom: () => editor.addZoomAtPlayhead(),
    // Zooms where the person clicked (core/auto-zoom.js), replacing the
    // automatic ones there were; zooms made by hand stay.
    canAutoZoom: () => P.hasClicks(store.project),
    autoZoomCount: () => P.autoZoomCount(store.project),
    autoZoom: (strength) => {
      const next = store.apply((p) => P.applyAutoZooms(p, { strength }));
      if (!next) return;
      const n = P.autoZoomCount(next);
      toast(n ? `${n} ${n === 1 ? 'zoom' : 'zooms'} where you clicked` : 'No clicks to zoom on with that setting');
    },
    removeAutoZooms: () => { if (store.apply((p) => P.removeAutoZooms(p))) toast('Automatic zooms removed'); },
    addText: () => editor.addAnnotation('text'),
    addBlur: () => editor.addAnnotation('blur'),
    addAnnotation: (type) => editor.addAnnotation(type),
    // The Audio tab's own recorder, at the playhead.
    recordVoiceover: () => {
      store.select(null);
      showPanel('audio');
      document.getElementById('recordVoiceover')?.click();
    },
    selectAll: () => timeline.selectAll(),
    // Copy, cut, paste and duplicate what's selected. The copy is kept in
    // this window (not the system clipboard), and pasted at the playhead.
    copy: () => {
      const got = copyItems(store.project, store.selected);
      if (!got) { toast('Select something to copy first.'); return false; }
      clipboard = got;
      toast(got.entries.length === 1 ? 'Copied' : `Copied ${got.entries.length} items`);
      return true;
    },
    cutSelection: () => {
      const got = copyItems(store.project, store.selected);
      if (!got) { toast('Select something to cut first.'); return; }
      const items = store.selected.filter((it) => it.kind !== 'speed');
      if (store.apply((p) => P.removeItems(p, items, { leaveGap: !closeGaps() }))) {
        clipboard = got;
        store.select(null);
        toast(got.entries.length === 1 ? 'Cut' : `Cut ${got.entries.length} items`);
      }
    },
    paste: () => pasteAt(clipboard, player.time, 'Pasted'),
    duplicate: () => {
      const got = copyItems(store.project, store.selected);
      if (!got) { toast('Select something to duplicate first.'); return; }
      pasteAt(got, itemsEnd(store.project, store.selected), 'Duplicated');
    },
    delete: deleteSelection,
    timelineZoomIn: () => timeline.zoomIn(),
    timelineZoomOut: () => timeline.zoomOut(),
    timelineFit: () => timeline.fit(),
    cheatSheet: () => cheat.toggle(),
    escape: () => {
      if (cheat.open) cheat.toggle();
      else if (toolbar.menuOpen) toolbar.closeMenus();
      else if (timeline.menuOpen) timeline.closeMenu();
      else if (firstRun.open && !store.selected.length) firstRun.dismiss();
      else store.select(null);
    },
    addRecording: () => addRecording.show(),
    addAudio: () => addAudioFiles(editor, () => loupe.chooseMusic()),
    addOverlay: () => editor.addOverlay()
  };

  $('undo').onclick = actions.undo;
  $('redo').onclick = actions.redo;
  $('exportBtn').onclick = actions.export;
  $('play').onclick = actions.playPause;
  toolbar = createToolbar({ tools: $('tools'), options: $('tlOptions'), actions });
  timeline.setSnap(toolbar.snap);
  // The transcript beside the preview (the toolbar's Transcript switch).
  const transcript = createTranscriptPanel({
    root: $('transcript'), store, player, editor,
    onClose: () => $('transcriptBtn').click()
  });
  const showTranscript = (on) => {
    transcript.setOpen(on);
    $('workspace').classList.toggle('with-transcript', on);
  };
  showTranscript(toolbar.transcript);
  toolbar.onChange((key, on) => {
    if (key === 'snap') timeline.setSnap(on);
    if (key === 'transcript') showTranscript(on);
  });
  $('tlOut').onclick = actions.timelineZoomOut;
  $('tlIn').onclick = actions.timelineZoomIn;
  $('tlFit').onclick = actions.timelineFit;
  $('shortcutsBtn').onclick = actions.cheatSheet;
  $('backBtn').onclick = () => loupe.backToLibrary();
  $('newRecBtn').onclick = () => loupe.newRecording();
  $('settingsBtn').onclick = () => loupe.openSettings();

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
    if (['copy', 'cutSelection', 'paste'].includes(command)) lastKeyCommand = performance.now();
    actions[command]();
  });

  // Edit > Copy, Cut and Paste from the app menu arrive as the page's own
  // clipboard events; outside a text field they mean the timeline's.
  let lastKeyCommand = 0;
  for (const [event, command] of [['copy', 'copy'], ['cut', 'cutSelection'], ['paste', 'paste']]) {
    document.addEventListener(event, (e) => {
      if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
      if (exportDialog.isOpen || addRecording.isOpen || cheat.open) return;
      e.preventDefault();
      // The key already did it (a keydown the page handled).
      if (performance.now() - lastKeyCommand < 250) return;
      actions[command]();
    });
  }

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

  function refresh() {
    $('undo').disabled = !store.canUndo;
    $('redo').disabled = !store.canRedo;
    const { in: markA, out: markB } = timeline.marks;
    $('deleteBtn').disabled = !store.selected.length && !(markA !== null && markB !== null);
    if (document.activeElement !== title) title.value = store.project.title;
    document.title = store.project.title || 'Loupe';
  }
  store.subscribe(refresh);

  // ---- level meter: left and right, -60..0 dBFS, with a peak that holds a
  // moment -- the meter beside any editor's timeline, while it plays.
  const meterRows = [...$('meter').querySelectorAll('.meter-row')];
  const meterState = { levels: null, held: [-120, -120], heldAt: [0, 0] };
  const toPct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const drawMeter = (now) => {
    const levels = player.audio?.levels?.() ?? null;
    meterState.levels = levels;
    meterRows.forEach((row, i) => {
      const peak = levels ? levels[i].peak : -120;
      if (peak >= meterState.held[i] || now - meterState.heldAt[i] > 1200) {
        meterState.held[i] = peak;
        meterState.heldAt[i] = now;
      }
      row.firstElementChild.style.width = `${toPct(peak)}%`;
      row.lastElementChild.style.left = `${toPct(meterState.held[i])}%`;
      row.lastElementChild.hidden = meterState.held[i] <= -60;
    });
    $('meter').classList.toggle('clipping', meterState.held.some((d) => d > -0.5));
    requestAnimationFrame(drawMeter);
  };
  requestAnimationFrame(drawMeter);
  player.onTime(() => {
    // The zoom panel's "Add a zoom here" depends on where the playhead is.
    if (inspector.current === 'zoom' && !store.selection && !player.playing) inspector.updateCurrent('time');
    // Keyframed values and their ◆ state depend on where the playhead is.
    if (inspector.current === 'clip' && store.selection && !player.playing) inspector.updateCurrent('time');
  });
  refresh('load');
  player.seek(0);
  setSaveState('All changes saved');
  // Renamed in the Library while open here: the name becomes an edit, so the
  // next save keeps it (main holds it until then) and undo can take it back.
  loupe.onProjectRenamed?.((name) => {
    if (typeof name === 'string' && name.trim() && name !== store.project.title) {
      store.apply((p) => P.setTitle(p, name));
    }
  });

  // For the end-to-end tests (test/e2e/editor.js), which drive this page.
  window.__editor = {
    store, player, timeline, exportDialog, cheat, editor, actions, saver, overlay, addRecording, cutDialog, thumbnails, firstRun, inspector, toolbar, transcript, zoomNote,
    meter: meterState
  };
  document.body.dataset.ready = 'true';
  // After the page is up, so the tests (and people) see a settled editor.
  firstRun.show();
}

start().catch((err) => {
  console.error(err);
  showFatal('Something went wrong opening the editor', plainError(err));
});
