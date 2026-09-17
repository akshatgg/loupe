// The editor's state: the project with its undo history, the timeline built
// from it, and what's selected. Every edit goes through apply(), which runs a
// pure core edit (src/core/project.js), records it for undo and hands the new
// project to `save`. A refused edit (the core throws plain-worded Errors)
// changes nothing and is reported through `onError`.
//
// Dragging produces an edit per mouse move; passing the same `gesture` key
// makes the whole drag one undo step (core/history.js).

import * as H from '../../core/history.js';
import { buildTimeline } from '../../core/timeline.js';

export function createStore(project, { save = () => {}, onError = () => {} } = {}) {
  let history = H.createHistory(project);
  let tl = buildTimeline(project);
  let selection = null;
  const listeners = new Set();

  const emit = (what) => {
    for (const fn of listeners) fn(what);
  };

  // A selection pointing at something undo (or an edit) removed is dropped.
  function checkSelection() {
    if (!selection) return;
    const p = history.present;
    const alive = selection.kind === 'clip' ? p.clips.some((c) => c.id === selection.id)
      : selection.kind === 'zoom' ? p.zooms.some((z) => z.id === selection.id)
        : selection.kind === 'speed' ? p.speed.some((s) => s.source === selection.source &&
          s.start === selection.start && s.end === selection.end)
          : selection.kind === 'annotation' ? p.annotations.some((a) => a.id === selection.id)
          : selection.kind === 'caption' ? p.captions.segments.some((c) => c.id === selection.id)
            : false;
    if (!alive) selection = null;
  }

  function replace(next) {
    const changed = next.present !== history.present;
    history = next;
    if (changed) {
      tl = buildTimeline(history.present);
      checkSelection();
      save(history.present);
    }
    emit('project');
  }

  return {
    get project() { return history.present; },
    get tl() { return tl; },
    get selection() { return selection; },
    get canUndo() { return H.canUndo(history); },
    get canRedo() { return H.canRedo(history); },

    // edit(project) -> project. Returns the new project, or null if refused.
    apply(edit, { gesture = null } = {}) {
      let next;
      try {
        next = edit(history.present);
      } catch (err) {
        onError(err);
        return null;
      }
      if (next !== history.present) replace(H.commit(history, next, { gesture }));
      return next;
    },
    endGesture() {
      history = H.endGesture(history);
    },
    undo() {
      if (H.canUndo(history)) replace(H.undo(history));
    },
    redo() {
      if (H.canRedo(history)) replace(H.redo(history));
    },
    select(sel) {
      selection = sel;
      checkSelection();
      emit('selection');
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}
