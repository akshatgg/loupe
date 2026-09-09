'use strict';

const path = require('node:path');
const { createZoomState, applyScroll } = require('./zoom');
const { createProject, saveProject, writeCursorTrack } = require('./project');

function createRecorder({ binDir, spawnHelper, stopHelper }) {
  let captureChild = null;
  let inputChild = null;
  let captureClock = null;
  let dir = null;
  let source = null;
  let sourceWidth = 0;
  let sourceHeight = 0;
  let sourceTitle = '';
  let hasMic = false;
  let zoomEnabled = true;
  let recording = false;
  let duration = 0;
  let tapReenables = 0;
  let error = null;

  let zoomState = createZoomState();
  let clicks = [];
  let cursorTrack = [];
  const pending = [];

  function consume(msg) {
    const t = msg.clock - captureClock;
    if (t < 0) return; // happened before the first frame
    switch (msg.type) {
      case 'zoom':
        if (zoomEnabled) applyScroll(zoomState, { t, dy: msg.dy, x: msg.x, y: msg.y });
        break;
      case 'click':
        clicks.push({ t, x: msg.x, y: msg.y, button: msg.button });
        break;
      case 'cursor':
        cursorTrack.push({ t, x: msg.x, y: msg.y, shape: msg.shape });
        break;
      default:
        break;
    }
  }

  function onInput(msg) {
    if (msg.type === 'tap_reenabled') { tapReenables++; return; }
    if (msg.type === 'ready' || msg.type === 'error') return;
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
    }
  }

  // A missing/mis-packaged capture binary means there is no recording at
  // all: this stops the session and is distinguished (source: 'capture')
  // from losing the gesture hook, which is merely an inconvenience for zoom
  // and should not be treated as recording failure (source: 'inputtap').
  function onCaptureError(err) {
    error = { source: 'capture', message: err.message };
    recording = false;
  }

  function onInputError(err) {
    error = { source: 'inputtap', message: err.message };
  }

  async function start(opts) {
    dir = opts.dir;
    source = opts.source;
    sourceWidth = opts.width || 0;
    sourceHeight = opts.height || 0;
    sourceTitle = opts.title || '';
    hasMic = Boolean(opts.mic);
    zoomEnabled = opts.zoomEnabled !== false;
    captureClock = null;
    zoomState = createZoomState();
    clicks = [];
    cursorTrack = [];
    pending.length = 0;
    tapReenables = 0;
    error = null;

    const args = ['--source', source, '--out', path.join(dir, 'raw.mov'),
                  '--mic', hasMic ? '1' : '0'];
    if (opts.hudWindowId) args.push('--exclude-window', String(opts.hudWindowId));

    captureChild = spawnHelper(path.join(binDir, 'capture'), args, {
      onMessage: onCapture,
      onMalformed: (l) => console.error('capture malformed:', l),
      onExit: () => { recording = false; },
      onError: onCaptureError
    });

    if (zoomEnabled) {
      inputChild = spawnHelper(path.join(binDir, 'inputtap'), [], {
        onMessage: onInput,
        onMalformed: (l) => console.error('inputtap malformed:', l),
        onExit: () => {},
        onError: onInputError
      });
    }

    recording = true;
  }

  async function stop() {
    if (inputChild) await stopHelper(inputChild);
    if (captureChild) await stopHelper(captureChild);
    recording = false;

    const project = createProject(
      { kind: source.split(':')[0], id: source, title: sourceTitle,
        width: sourceWidth, height: sourceHeight },
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
      recording, zoomEnabled, tapReenables, duration, error,
      zoomKeyframes: zoomState.keyframes, clicks, cursorTrack,
      zoom: zoomState.target
    };
  }

  return { start, stop, state };
}

module.exports = { createRecorder };
