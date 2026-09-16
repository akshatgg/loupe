// Undo/redo for the editor: a stack of whole-project snapshots. Edits in
// project.js share every untouched part with the previous project, so a
// snapshot costs only what the edit changed.
//
// A history is an immutable value ({past, present, future, ...}); every
// function returns a new one. Dragging a zoom's edge produces dozens of
// edits a second -- those are one gesture, and undo should take the whole
// drag back, not one pixel of it. Passing the same `gesture` key to commit
// within GESTURE_WINDOW_MS of the last one replaces the present instead of
// pushing a new step.

export const DEFAULT_LIMIT = 200;
export const GESTURE_WINDOW_MS = 1000;

export function createHistory(project, { limit = DEFAULT_LIMIT } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`Invalid history limit: ${JSON.stringify(limit)}`);
  return { past: [], present: project, future: [], limit, gesture: null, at: -Infinity };
}

// Records `project` as the result of an edit.
//  - gesture: a key naming the ongoing gesture (e.g. "zoom-drag:z3"), or null.
//  - now: the time in ms (Date.now() by default; tests pass their own).
export function commit(history, project, { gesture = null, now = Date.now() } = {}) {
  if (project === history.present) return history;
  const coalesce = gesture !== null && gesture === history.gesture &&
    now - history.at <= GESTURE_WINDOW_MS && history.past.length > 0;
  if (coalesce) {
    return { ...history, present: project, future: [], at: now };
  }
  const past = [...history.past, history.present];
  // Oldest steps fall off the bottom once the cap is reached.
  if (past.length > history.limit) past.splice(0, past.length - history.limit);
  return { ...history, past, present: project, future: [], gesture, at: now };
}

// Ends any ongoing gesture, so the next commit is its own step even with the
// same key (the mouse button went up, say).
export function endGesture(history) {
  return history.gesture === null ? history : { ...history, gesture: null, at: -Infinity };
}

export const canUndo = (history) => history.past.length > 0;
export const canRedo = (history) => history.future.length > 0;

export function undo(history) {
  if (!canUndo(history)) return history;
  const past = history.past.slice(0, -1);
  return {
    ...history, past, present: history.past.at(-1),
    future: [history.present, ...history.future], gesture: null, at: -Infinity
  };
}

export function redo(history) {
  if (!canRedo(history)) return history;
  const [present, ...future] = history.future;
  return {
    ...history, past: [...history.past, history.present], present, future,
    gesture: null, at: -Infinity
  };
}
