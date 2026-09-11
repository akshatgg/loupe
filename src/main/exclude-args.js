'use strict';

// Builds bin/capture's `--exclude-window <id>` arguments for one or more
// Loupe-owned overlay windows that must never appear in the recording.
//
// The control-bar redesign put TWO Loupe windows on screen at once while
// armed (the control bar itself, and the region
// outline), where the old HUD-only design only ever had one. `--exclude-window`
// used to accept exactly one id; this repeats the flag once per id rather
// than switching to a comma-separated list, since it keeps Capture.swift's
// existing single-value `arg()` helper untouched for every OTHER flag and
// only needs a second, multi-value `args()` helper for this one.
//
// Kept as pure, id-list-in/argv-out logic (no BrowserWindow, no child_process)
// so the argument-building itself is unit-testable apart from window creation
// and process spawning -- see test/exclude-args.test.js.
function buildExcludeWindowArgs(ids) {
  const args = [];
  const seen = new Set();
  for (const id of ids ?? []) {
    if (id === null || id === undefined) continue;
    const s = String(id).trim();
    // A media-source-id-derived window id is always a bare non-negative
    // integer string (see main.js's `getMediaSourceId().split(':')[1]`) --
    // anything else is not a real window id and must not reach the native
    // helper's argv unexamined.
    if (!/^\d+$/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    args.push('--exclude-window', s);
  }
  return args;
}

module.exports = { buildExcludeWindowArgs };
