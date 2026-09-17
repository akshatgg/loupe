'use strict';
// What the user is told when the screen capture fails, and tidying up after
// a capture that never recorded anything. The helpers' own messages
// ("display not found: display:1", a ScreenCaptureKit error) mean nothing to
// a person, so they go to the log and a plain sentence goes on screen.
const fs = require('node:fs');
const path = require('node:path');

// Files the recorder or the camera bubble may have left in a recording's
// folder before capture had a single frame. Anything else there (a video)
// means the folder is not ours to delete.
const LEFTOVERS = new Set(['cursor.bin', 'keys.json', 'webcam.webm', 'system.m4a', 'system.wav', 'raw.mov', 'raw.mp4']);

function captureProblem({ started, platform = process.platform }) {
  const permission = platform === 'win32'
    ? 'If it keeps happening, restart Loupe and try again.'
    : 'If the screen was locked or asleep, unlock it first. If it keeps happening, check that Loupe is allowed under Screen Recording in System Settings > Privacy & Security.';
  if (!started) {
    return {
      message: "Loupe couldn't start recording the screen",
      detail: `Nothing was recorded. ${permission}`
    };
  }
  return {
    message: 'The recording stopped early',
    detail: "Loupe lost the screen while recording. What was recorded until then is saved and open in the editor."
  };
}

// Removes the folder of a recording whose capture never started. Only
// removes it when it holds nothing but leftovers, and a video file only
// when it is empty or tiny (a header with no frames).
function discardFailedRecording(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!LEFTOVERS.has(name)) return false;
    if (name.startsWith('raw.')) {
      try {
        if (fs.statSync(path.join(dir, name)).size > 64 * 1024) return false;
      } catch {
        return false;
      }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

module.exports = { captureProblem, discardFailedRecording };
