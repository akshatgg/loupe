// The editor's state: the project with its undo history, the timeline built
// from it, and what's selected (a list: selection.js). Every edit goes through apply(), which runs a
// pure core edit (src/core/project.js), records it for undo and hands the new
// project to `save`. A refused edit (the core throws plain-worded Errors)
// changes nothing and is reported through `onError`.
//
// Dragging produces an edit per mouse move; passing the same `gesture` key
// makes the whole drag one undo step (core/history.js).

import * as H from '../../core/history.js';
import { buildTimeline } from '../../core/timeline.js';
import { aliveItems, hasItem, toggleItem } from './selection.js';

export function createStore(project, { save = () => {}, onError = () => {} } = {}) {
  let history = H.createHistory(project);
  let tl = buildTimeline(project);
  let selected = [];
  const listeners = new Set();

  const emit = (what) => {
    for (const fn of listeners) fn(what);
  };

  // A selection pointing at something undo (or an edit) removed is dropped.
  function checkSelection() {
    selected = aliveItems(history.present, selected);
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
    // Everything selected (selection.js items); never null.
    get selected() { return selected; },
    // The selected item when there is exactly one, else null: what a panel
    // that edits one thing asks for.
    get selection() { return selected.length === 1 ? selected[0] : null; },
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
    // select(item) selects just that; { add } keeps what was selected as
    // well (⇧-click); { toggle } adds it or takes it out (⌘-click). null clears.
    select(sel, { add = false, toggle = false } = {}) {
      if (!sel) selected = [];
      else if (toggle) selected = toggleItem(selected, sel);
      else if (add) selected = hasItem(selected, sel) ? selected : [...selected, sel];
      else selected = [sel];
      checkSelection();
      emit('selection');
    },
    selectMany(list) {
      selected = [];
      for (const it of list ?? []) if (!hasItem(selected, it)) selected.push(it);
      checkSelection();
      emit('selection');
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}
