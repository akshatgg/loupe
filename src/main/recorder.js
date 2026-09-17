'use strict';

const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createZoomState, applyScroll } = require('./zoom');
const { createProject, saveProject, writeCursorTrack } = require('./project');
const { buildExcludeWindowArgs } = require('./exclude-args');
const { helperCommand, captureFileName } = require('./platform');
const { createClockSync } = require('./clock-sync');
const { createPauseTracker, toSourcePauses, clipsFromPauses } = require('./pauses');
const { buildMainSource, writeKeys, validKeyLabel, toProjectV2 } = require('./recording-v2');

const identity = (v) => v;

// `platform` picks the helper binaries and capture file (platform.js).
// `toDipPoint` maps inputtap's coordinates into the space sources and regions
// are measured in, and `toCaptureRect` maps a region the other way for
// bin/capture -- both identities on macOS, where every helper speaks points;
// on Windows the helpers speak physical pixels and main.js supplies
// Electron's DIP conversions.
//
// `now` is the main process's clock in seconds. Pauses and the webcam's
// start are measured on it and mapped into source time through clock-sync.js,
// fed by the timestamps on every helper line.
function createRecorder({
  binDir, spawnHelper, stopHelper, onError,
  platform = process.platform, toDipPoint = identity, toCaptureRect = identity,
  now = () => performance.now() / 1000
}) {
  const captureFile = captureFileName(platform);
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
  // Recording additions (docs/EDITOR-V2.md section 7): shortcut presses,
  // pause ranges, the computer-sound file capture reports writing, and
  // non-fatal helper warnings (e.g. computer sound failed; video carries on).
  let keysEnabled = false;
  let keys = [];
  let systemAudioRequested = false;
  let systemAudioFile = null;
  let warnings = [];
  let sync = createClockSync();
  let pauses = createPauseTracker();
  const pending = [];

  function consume(msg) {
    const t = msg.clock - captureClock;
    if (t < 0) return; // happened before the first frame
    if (msg.type === 'zoom' || msg.type === 'click' || msg.type === 'cursor') {
      const p = toDipPoint({ x: msg.x, y: msg.y });
      msg = { ...msg, x: p.x, y: p.y };
    }
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
      case 'key':
        if (keysEnabled && validKeyLabel(msg.label)) keys.push({ t, label: msg.label });
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
    // Every event is stamped when it happened and sent right away: a clock
    // sample (clock-sync.js), taken on arrival before any buffering.
    sync.observe(msg.clock, now());
    // Buffer until the capture clock origin is known, then rebase.
    if (captureClock === null) { pending.push(msg); return; }
    consume(msg);
  }

  function onCapture(msg) {
    // Only `now` (stamped as the line is written) is a valid sample here: a
    // frame's `clock` is its presentation time, which ScreenCaptureKit can
    // put a few milliseconds after the line was written.
    sync.observe(msg.now, now());
    if (msg.type === 'system_audio') {
      if (systemAudioRequested) systemAudioFile = msg.file;
    } else if (msg.type === 'warning') {
      if (typeof msg.message === 'string') warnings.push(msg.message);
    } else if (msg.type === 'started') {
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
    // A second start() while a recording is already in progress must not
    // silently proceed: it would null out captureChild/inputChild below
    // without ever stopping the still-running processes from the first
    // session, orphaning a capture helper that still holds raw.mov open (see
    // finding 3 in the phase-1 review). The caller (main.js) also guards
    // against this before the HUD window is even created, but that guard
    // lives outside recorder.js's pure logic, so this one exists in case
    // recorder.start() is ever reached by some other path.
    if (recording) {
      throw new Error('A recording is already in progress.');
    }
    generation++;
    const gen = generation;
    stopped = false;
    dir = opts.dir;
    source = opts.source;
    // A region crop, when present, IS the source from here on: bin/capture
    // is told to capture only that rectangle (see the --crop-* args below),
    // so the file on disk only ever contains the cropped pixels. Using the
    // crop's own size/origin as sourceWidth/Height/OriginX/Y -- rather than
    // the full source's -- is what makes consume() below rebase cursor/click
    // coordinates into crop-local points and project.source (set in stop())
    // describe the crop, with no other file needing to know a crop happened.
    const region = opts.region ?? null;
    sourceWidth = (region ? region.width : opts.width) || 0;
    sourceHeight = (region ? region.height : opts.height) || 0;
    sourceTitle = opts.title || '';
    // opts.x/y (or region.x/y) may legitimately be negative (a display left
    // of or above the primary one) so `|| 0` (which would treat -0-ish
    // falsy numbers oddly) is avoided in favor of an explicit undefined
    // check.
    const originX = region ? region.x : opts.x;
    const originY = region ? region.y : opts.y;
    sourceOriginX = originX === undefined ? 0 : originX;
    sourceOriginY = originY === undefined ? 0 : originY;
    hasMic = Boolean(opts.mic);
    zoomEnabled = opts.zoomEnabled !== false;
    // Keystrokes ride on the same event hook as zoom, so they need the same
    // permission (Accessibility on macOS) and come and go with it.
    keysEnabled = Boolean(opts.keys) && zoomEnabled;
    keys = [];
    systemAudioRequested = Boolean(opts.systemAudio);
    systemAudioFile = null;
    warnings = [];
    sync = createClockSync();
    pauses = createPauseTracker();
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

    const args = ['--source', source, '--out', path.join(dir, captureFile),
                  '--mic', hasMic ? '1' : '0'];
    // Computer sound goes into its own file beside the video (system.m4a);
    // capture reports the name it wrote with {"type":"system_audio","file"}.
    if (systemAudioRequested) args.push('--system-audio', '1');
    // The microphone chosen in Settings, by name (the helper falls back to
    // the system default when it isn't there).
    if (hasMic && typeof opts.micName === 'string' && opts.micName) args.push('--mic-name', opts.micName);
    // Every Loupe-owned overlay window that could be on screen when capture
    // starts -- the control bar (always) and, with the outline still
    // open, the region-selection overlay -- must be excluded.
    // Hiding/closing those windows on the Electron side is not relied on as
    // the only protection (see main.js's bar:start): bin/capture is always
    // told about every id that COULD be on screen, whether or not it still
    // is by the time this spawns.
    args.push(...buildExcludeWindowArgs(opts.excludeWindowIds));
    // region.x/y are passed through untouched (global points, same as
    // --exclude-window's coordinate-free id) -- Capture.swift is what
    // rebases them against the target display's own origin, since it's the
    // one that knows which display SCStreamConfiguration.sourceRect is
    // relative to.
    if (region) {
      const crop = toCaptureRect(region);
      args.push('--crop-x', String(crop.x), '--crop-y', String(crop.y),
                 '--crop-w', String(crop.width), '--crop-h', String(crop.height));
    }

    const capture = helperCommand(binDir, 'capture', platform);
    captureChild = spawnHelper(capture.file, [...capture.args, ...args], {
      onMessage: (msg) => { if (gen === generation) onCapture(msg); },
      onMalformed: (l) => console.error('capture malformed:', l),
      onExit: () => { if (gen === generation) recording = false; },
      onError: (err) => { if (gen === generation) onCaptureError(err); }
    });

    if (zoomEnabled) {
      // How zooming is triggered (modifier key / mouse side button) --
      // settings.js's inputTapArgs, from the user's saved choice.
      const inputtap = helperCommand(binDir, 'inputtap', platform);
      const keyArgs = keysEnabled ? ['--keys', '1'] : [];
      inputChild = spawnHelper(inputtap.file, [...inputtap.args, ...(opts.inputTapArgs ?? []), ...keyArgs], {
        onMessage: (msg) => { if (gen === generation) onInput(msg); },
        onMalformed: (l) => console.error('inputtap malformed:', l),
        // A non-zero exit here (e.g. Accessibility revoked mid-recording,
        // which sends InputTap.swift through fail()/exit(1)) used to be
        // completely silent: zoom, clicks and the cursor track all stop and
        // nothing in the HUD or the project ever recorded that they did.
        // Route it through the same onInputError() path a reported
        // {"type":"error"} line already takes -- `!error` skips this when
        // that more specific message already arrived (fail() always emits
        // one before exiting), so a bare exit code never clobbers it. A
        // clean shutdown (SIGTERM from stop()/onCaptureError's cleanup)
        // reports code === null here, not 0, so it never reaches this
        // branch.
        onExit: (code) => {
          if (gen === generation && typeof code === 'number' && code !== 0 && !error) {
            onInputError({ message: `inputtap exited unexpectedly (code ${code})` });
          }
        },
        onError: (err) => { if (gen === generation) onInputError(err); }
      });
    }

    recording = true;
  }

  // Pause/resume while recording: the helpers keep running, only the range
  // is remembered (pauses.js). Each returns whether anything changed.
  function pause() {
    if (!recording) return false;
    return pauses.pause(now());
  }

  function resume() {
    if (!recording) return false;
    return pauses.resume(now());
  }

  // A main-process moment (seconds on `now`) as source time, or null before
  // the helpers have said anything to align with.
  function toSourceTime(localTime) {
    const helperTime = sync.toHelper(localTime);
    if (helperTime === null || captureClock === null || !Number.isFinite(localTime)) return null;
    return helperTime - captureClock;
  }

  // `webcam`, when the camera bubble recorded, is { file, startLocal, width,
  // height } -- or a promise of it, so the bubble can finish its file while
  // the helpers stop (ipc/camera.js finish()). startLocal is when webcam.webm's first frame was taken, on the
  // `now` clock (see ipc/camera.js), so its offset into the recording is
  // that moment in source time -- negative when the camera started first.
  //
  // `style` is the look a new project starts with (the default preset's
  // style), or null for the defaults. Resolves { dir, project, recording,
  // cursorTrack }: `project` is the version-2 project.json written, and
  // `recording` the raw facts it was made from (v1 fields plus
  // sources.main and clips).
  async function stop({ webcam = null, style = null } = {}) {
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
    // Stopping while paused ends the pause here, before the helpers go.
    const stopLocal = now();

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

    // Capture failed before its first frame (a locked screen, a display
    // that went away, permission withdrawn): there is no video at all, so
    // no project is written -- an empty recording would only open as a
    // broken editor and sit in the Library. The caller removes the folder.
    if (captureClock === null && error?.source === 'capture') {
      // Let the camera bubble finish its file first, so the folder can go.
      await Promise.resolve(webcam).catch(() => null);
      return { dir, failed: true, message: error.message };
    }

    const project = createProject(
      { kind: source.split(':')[0], id: source, title: sourceTitle,
        width: sourceWidth, height: sourceHeight,
        // Recorded for reference/debugging only: cursorTrack and clicks are
        // already rebased to source-local points by consume() above, so
        // camera.js, Render.swift and the editor preview never need to read
        // these back out.
        originX: sourceOriginX, originY: sourceOriginY },
      { file: captureFile, fps: 60, duration, hasMicTrack: hasMic }
    );
    project.zoomKeyframes = zoomState.keyframes;
    // The editor's zoom removal is non-destructive (segments.js removeZoom):
    // this copy is never edited, so any removed zoom can be restored.
    project.recordedZoomKeyframes = zoomState.keyframes.map((kf) => ({ ...kf }));
    project.removedZooms = [];
    project.clicks = clicks;

    // Version-2 fields (recording-v2.js documents exactly what is written).
    const sourcePauses = toSourcePauses(pauses.ranges(stopLocal), toSourceTime, duration);
    let webcamSource = null;
    webcam = await Promise.resolve(webcam).catch(() => null);
    if (webcam && typeof webcam.file === 'string') {
      webcamSource = {
        file: webcam.file,
        offset: toSourceTime(webcam.startLocal) ?? 0,
        width: webcam.width,
        height: webcam.height
      };
    }
    project.sources = {
      main: buildMainSource({
        source: project.source, captureFile, duration, hasMic,
        systemAudioFile, webcam: webcamSource, keysRecorded: keysEnabled,
        clicks, pauses: sourcePauses
      })
    };
    project.clips = clipsFromPauses(duration, sourcePauses);
    // The default style preset's style, which the v2 migration starts from.
    if (style && typeof style === 'object') project.style = style;

    // The folder is named by the moment recording started (main.js).
    const folderTime = Number(path.basename(dir));
    const createdAt = Number.isSafeInteger(folderTime) && folderTime > 1e12 ? folderTime : Date.now();
    const v2 = toProjectV2(project, { createdAt, style });
    saveProject(dir, v2 ?? project);
    writeCursorTrack(dir, cursorTrack);
    if (keysEnabled) writeKeys(dir, keys);
    return { dir, project: v2 ?? project, recording: project, cursorTrack };
  }

  function state() {
    return {
      recording, zoomEnabled, tapReenables, duration, error, hasMic,
      zoomKeyframes: zoomState.keyframes, clicks, cursorTrack,
      zoom: zoomState.target,
      keys, systemAudio: systemAudioFile, systemAudioRequested, warnings,
      paused: pauses.isPaused(), pausedSeconds: pauses.pausedTotal(now())
    };
  }

  return { start, stop, state, pause, resume, toSourceTime };
}

module.exports = { createRecorder };
