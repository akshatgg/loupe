'use strict';

// The control bar's lifecycle, as a pure reducer: 'armed' (a source is
// chosen and the bar/outline are on screen, but bin/capture has not been
// spawned yet) -> 'recording' (capture is running) -> 'closed' (the bar is
// gone, either because the user backed out while armed or pressed Stop while
// recording).
//
//   armed -----start----> recording
//   armed -----back -----> closed
//   recording --stop-----> closed
//
// Kept apart from main.js's window/process side effects (creating the bar
// BrowserWindow, spawning bin/capture, closing the outline, ...) the same
// way region.js's validateRegion/clampRegionToBounds are pure and unit-
// tested apart from the region:confirm IPC handler that calls them -- this
// module only answers "is this transition legal, and what does it lead to",
// so that question can be exercised directly (test/bar-state.test.js)
// without spinning up Electron or a native helper.
const TRANSITIONS = {
  armed: { start: 'recording', back: 'closed' },
  recording: { stop: 'closed' }
};

function transition(state, action) {
  const forState = TRANSITIONS[state];
  if (!forState) {
    throw new Error(`Unknown bar state: ${JSON.stringify(state)}`);
  }
  const next = forState[action];
  if (!next) {
    throw new Error(`Cannot '${action}' from bar state '${state}'`);
  }
  return next;
}

module.exports = { transition };
