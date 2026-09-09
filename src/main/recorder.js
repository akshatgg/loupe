'use strict';

const path = require('node:path');
const { createZoomState, applyScroll } = require('./zoom');
const { createProject, saveProject, writeCursorTrack } = require('./project');

function createRecorder({ binDir, spawnHelper, stopHelper, onError }) {
  let captureChild = null;
  let inputChild = null;
  let captureClock = null;
  let dir = null;
  let source = null;
  let sourceWidth = 0;
  let sourceHeight = 0;
  let sourceTitle = '';
  // The source's top-left origin in global display space, in points -- see
  // Sources.swift's SourceOut.x/y. bin/inputtap reports cursor/click
  // coordinates in that same global space (CGEvent.location), so consume()
  // below subtracts these to store cursorTrack/clicks in source-local
  // points, matching what camera.js and Render.swift already assume.
  // Defaults to 0 so a source picked before this field existed, or a
  // display/window at the primary origin, behaves exactly as before.
  let sourceOriginX = 0;
  let sourceOriginY = 0;
  let hasMic = false;
  let zoomEnabled = true;
  let recording = false;
  let duration = 0;
  let tapReenables = 0;
  let error = null;
  // Bumped on every start(); a spawned helper's callbacks capture the
  // generation current at spawn time and become inert once it no longer
  // matches, so a delayed message/exit/error from a session that has since
  // ended (or been superseded by a new start()) cannot mutate state that
  // belongs to whatever is current.
  let generation = 0;
  // True once a stop() call has completed its work for the current session.
  // Distinct from `source === null` ("never started"): source stays set
  // after a successful stop() (it is not part of what start() needs to reset
  // before spawning), so a second stop() call needs its own signal to
  // recognise "already stopped" and short-circuit to a no-op rather than
  // re-saving the project. Reset in start() alongside the rest of the
  // per-session state.
  let stopped = false;

  let zoomState = createZoomState();
  let clicks = [];
  let cursorTrack = [];
  const pending = [];

  function consume(msg) {
    const t = msg.clock - captureClock;
    if (t < 0) return; // happened before the first frame
    switch (msg.type) {
      case 'zoom':
        if (zoomEnabled) {
          applyScroll(zoomState, {
            t, dy: msg.dy, x: msg.x - sourceOriginX, y: msg.y - sourceOriginY
          });
        }
        break;
      case 'click':
        clicks.push({ t, x: msg.x - sourceOriginX, y: msg.y - sourceOriginY, button: msg.button });
        break;
      case 'cursor':
        cursorTrack.push({ t, x: msg.x - sourceOriginX, y: msg.y - sourceOriginY, shape: msg.shape });
        break;
      default:
        break;
    }
  }

  function onInput(msg) {
    if (msg.type === 'tap_reenabled') { tapReenables++; return; }
    if (msg.type === 'ready') return;
    // inputtap reports its own fatal errors (e.g. it lost the event tap and
    // could not recover) the same way capture does: one {"type":"error"}
    // NDJSON line while the process is still alive. Route it through the
    // exact same path a spawn failure takes so the user is told either way.
    if (msg.type === 'error') { onInputError({ message: msg.message }); return; }
    // Buffer until the capture clock origin is known, then rebase.
    if (captureClock === null) { pending.push(msg); return; }
    consume(msg);
  }

  function onCapture(msg) {
    if (msg.type === 'started') {
      captureClock = msg.clock;
      for (const m of pending) consume(m);
      pending.length = 0;
    } else if (msg.type === 'stopped') {
      duration = msg.duration;
    } else if (msg.type === 'error') {
      // A writer failure (or "no microphone available" / "cannot attach
      // audio output") reported by the still-running capture helper. Same
      // path as a spawn failure: mark the session errored, stop an
      // already-running inputtap so it isn't orphaned, and notify the host.
      onCaptureError({ message: msg.message });
    }
  }

  // A missing/mis-packaged capture binary means there is no recording at
  // all: this stops the session and is distinguished (source: 'capture')
  // from losing the gesture hook, which is merely an inconvenience for zoom
  // and should not be treated as recording failure (source: 'inputtap').
  function notifyError() {
    if (typeof onError === 'function') {
      try {
        onError(error);
      } catch {
        // A caller's error handler must not take down the recorder.
      }
    }
  }

  function onCaptureError(err) {
    error = { source: 'capture', message: err.message };
    recording = false;
    // A dead capture process means the recording is over. inputtap may
    // already be running (it is spawned after capture) and would otherwise
    // be orphaned, holding the system-wide event tap with no recording in
    // progress. Tear it down here; stopHelper() is a harmless no-op on an
    // already-exited child, and clearing the reference means a later
    // stop() call won't try to stop it a second time.
    if (inputChild) {
      const toStop = inputChild;
      inputChild = null;
      stopHelper(toStop).catch(() => {});
    }
    notifyError();
  }

  function onInputError(err) {
    error = { source: 'inputtap', message: err.message };
    notifyError();
  }

  async function start(opts) {
    generation++;
    const gen = generation;
    stopped = false;
    dir = opts.dir;
    source = opts.source;
    sourceWidth = opts.width || 0;
    sourceHeight = opts.height || 0;
    sourceTitle = opts.title || '';
    // opts.x/y may legitimately be negative (a display left of or above the
    // primary one) so `|| 0` (which would treat -0-ish falsy numbers oddly)
    // is avoided in favor of an explicit undefined check.
    sourceOriginX = opts.x === undefined ? 0 : opts.x;
    sourceOriginY = opts.y === undefined ? 0 : opts.y;
    hasMic = Boolean(opts.mic);
    zoomEnabled = opts.zoomEnabled !== false;
    captureClock = null;
    zoomState = createZoomState();
    clicks = [];
    cursorTrack = [];
    pending.length = 0;
    tapReenables = 0;
    error = null;
    duration = 0;
    captureChild = null;
    inputChild = null;

    const args = ['--source', source, '--out', path.join(dir, 'raw.mov'),
                  '--mic', hasMic ? '1' : '0'];
    if (opts.hudWindowId) args.push('--exclude-window', String(opts.hudWindowId));

    captureChild = spawnHelper(path.join(binDir, 'capture'), args, {
      onMessage: (msg) => { if (gen === generation) onCapture(msg); },
      onMalformed: (l) => console.error('capture malformed:', l),
      onExit: () => { if (gen === generation) recording = false; },
      onError: (err) => { if (gen === generation) onCaptureError(err); }
    });

    if (zoomEnabled) {
      inputChild = spawnHelper(path.join(binDir, 'inputtap'), [], {
        onMessage: (msg) => { if (gen === generation) onInput(msg); },
        onMalformed: (l) => console.error('inputtap malformed:', l),
        onExit: () => {},
        onError: (err) => { if (gen === generation) onInputError(err); }
      });
    }

    recording = true;
  }

  async function stop() {
    // stop() can be reached from a stop button or a global hotkey, either of
    // which may fire with no recording ever started (source is still null).
    // Rather than throwing out of an async function, resolve to null: a
    // caller-recognisable "there was nothing to stop", matching the falsy
    // shape callers already have to handle for other empty results.
    // A second call after a completed stop() must also be a no-op: without
    // `stopped`, source stays non-null after a successful stop() (start()
    // owns resetting session state, not stop()), so a stop-button-plus-
    // hotkey double call would otherwise rebuild and re-save the project a
    // second time and return a second success result.
    if (source === null || stopped) return null;
    stopped = true;

    // Capture and clear the shared references before awaiting, the same way
    // onCaptureError already does. Otherwise a delayed capture 'error' that
    // lands while this await is pending would still see a non-null
    // inputChild/captureChild and race stopHelper() against the calls below
    // on the same live process.
    const toStopInput = inputChild;
    const toStopCapture = captureChild;
    inputChild = null;
    captureChild = null;

    if (toStopInput) await stopHelper(toStopInput);
    if (toStopCapture) await stopHelper(toStopCapture);
    recording = false;

    const project = createProject(
      { kind: source.split(':')[0], id: source, title: sourceTitle,
        width: sourceWidth, height: sourceHeight,
        // Recorded for reference/debugging only: cursorTrack and clicks are
        // already rebased to source-local points by consume() above, so
        // camera.js, Render.swift and the editor preview never need to read
        // these back out.
        originX: sourceOriginX, originY: sourceOriginY },
      { file: 'raw.mov', fps: 60, duration, hasMicTrack: hasMic }
    );
    project.zoomKeyframes = zoomState.keyframes;
    project.clicks = clicks;

    saveProject(dir, project);
    writeCursorTrack(dir, cursorTrack);
    return { dir, project, cursorTrack };
  }

  function state() {
    return {
      recording, zoomEnabled, tapReenables, duration, error, hasMic,
      zoomKeyframes: zoomState.keyframes, clicks, cursorTrack,
      zoom: zoomState.target
    };
  }

  return { start, stop, state };
}

module.exports = { createRecorder };
