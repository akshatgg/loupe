// Project format v2 (docs/EDITOR-V2.md section 3): defaults, migration from
// v1, validation, and every edit the editor can make.
//
// Every edit is a pure function (project, ...args) -> new project. Parts of
// the project an edit doesn't touch are shared with the old project rather
// than copied, so a cache keyed on e.g. `project.zooms` (compose.js's camera
// track) stays valid across edits to anything else. The editor is not a
// trust boundary: each edit checks its arguments and throws a plain-worded
// Error rather than writing something the renderer or exporter can't draw.

import { buildTimeline } from './timeline.js';
import { COLOR_FILTERS } from './look.js';
import { MAX_CURVE_POINTS } from './grade.js';
import { OVERLAY_BLENDS, MASK_SHAPES, defaultMask, defaultKey } from './overlay-effects.js';
import { setKeyframe, removeKeyframe, setKeyframeEase, KEYFRAME_EASES } from './keyframes.js';
import { ZOOM_EASES } from './camera.js';
import { autoZoomRanges } from './auto-zoom.js';
import { clipLength, clipEnd, freeLane, audioName, laneOf, splitPoints, MAX_LANES, MIN_AUDIO_SECONDS } from './audio/clips.js';

export const VERSION = 2;
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 8;
export const SPEED_RAMP_MAX = 2;
export const ZOOM_LEVEL_MIN = 1;
export const ZOOM_LEVEL_MAX = 8;
// Shorter than this and a clip, zoom or speed stretch can't be grabbed in
// the timeline (and a clip that short is a single frame or two anyway).
export const MIN_CLIP_SECONDS = 0.1;
// The longest a freeze frame holds (seconds).
const MAX_HOLD = 3600;
export const MIN_RANGE_SECONDS = 0.1;
// v1 recorded a zoom keyframe on every scroll tick; a stretch whose zoom
// never got past this was a nudge of the wheel, not a zoom anyone meant.
export const RECORDED_ZOOM_THRESHOLD = 1.05;

export const ASPECTS = ['source', '16:9', '9:16', '1:1', '4:5'];
export const BACKGROUND_TYPES = ['none', 'color', 'gradient', 'image'];
export const HIGHLIGHTS = ['none', 'spotlight', 'ring'];
const MAX_TITLE = 200;
export const ANNOTATION_TYPES = ['text', 'title', 'arrow', 'box', 'blur'];
export const TRANSITION_TYPES = [
  'fade', 'crossfade', 'dip', 'dip-white', 'blur',
  'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down', 'slide-left', 'slide-right', 'circle', 'zoom'
];
export const EXPORT_FORMATS = ['mp4', 'webm', 'gif'];
export const EXPORT_RESOLUTIONS = ['720p', '1080p', '1440p', '4k'];
export const EXPORT_QUALITIES = ['high', 'balanced', 'small'];
export const EXPORT_CODECS = ['h264', 'hevc'];
export const EXPORT_GIF_WIDTHS = [480, 720, 960];
export const EXPORT_GIF_FRAME_RATES = [10, 15, 20];
export const WEBCAM_SHAPES = ['circle', 'rounded'];
export const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
export const POSITIONS = ['top', 'bottom'];

const EPS = 1e-9;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function fail(message) {
  throw new Error(message);
}

function num(v, what, lo = -Infinity, hi = Infinity) {
  if (!isNum(v) || v < lo || v > hi) {
    fail(`${what} must be a number${lo > -Infinity ? ` from ${lo}` : ''}${hi < Infinity ? ` to ${hi}` : ''}, got ${JSON.stringify(v)}`);
  }
  return v;
}

function oneOf(v, list, what) {
  if (!list.includes(v)) fail(`${what} must be one of ${list.join(', ')}, got ${JSON.stringify(v)}`);
  return v;
}

function bool(v, what) {
  if (typeof v !== 'boolean') fail(`${what} must be true or false, got ${JSON.stringify(v)}`);
  return v;
}

function str(v, what, { empty = false, max = 10000 } = {}) {
  if (typeof v !== 'string' || (!empty && v.length === 0) || v.length > max) {
    fail(`${what} must be text, got ${JSON.stringify(v)}`);
  }
  return v;
}

function color(v, what) {
  if (typeof v !== 'string' || !COLOR_RE.test(v)) fail(`${what} must be a colour like #1e90ff, got ${JSON.stringify(v)}`);
  return v;
}

// Next free id with this prefix ("z1", "z2", ...). Ids are only unique within
// one project, which is all anything needs, and stay deterministic so tests
// (and undo/redo) see the same ids every time.
export function nextId(prefix, items) {
  let max = 0;
  for (const item of items) {
    const m = typeof item?.id === 'string' && item.id.startsWith(prefix) ? Number(item.id.slice(prefix.length)) : NaN;
    if (Number.isInteger(m) && m > max) max = m;
  }
  return `${prefix}${max + 1}`;
}

// ---------------------------------------------------------------- defaults

export function defaultStyle() {
  return {
    background: { type: 'gradient', value: { angle: 135, stops: ['#4f5bd5', '#962fbf'] } },
    padding: 0.06,
    radius: 12,
    shadow: 0.5,
    aspect: 'source',
    cursor: { show: true, size: 1, hideWhenIdle: false, smooth: true, highlight: 'none', clicks: true },
    keystrokes: { show: false, position: 'bottom' },
    webcam: { show: true, shape: 'circle', size: 0.22, corner: 'bottom-right' }
  };
}

export function defaultAudio() {
  return {
    mic: { volume: 1, muted: false, cleanUp: true, level: true },
    system: { volume: 0.8, muted: false },
    // Songs and sound files on the timeline's audio rows (audio/clips.js),
    // and each row's mute / solo / lock ([{ muted, solo, locked }], by row).
    clips: [],
    lanes: [],
    voiceover: []
  };
}

export function defaultCaptions() {
  return { show: false, language: 'auto', segments: [], style: { size: 1, position: 'bottom', box: true } };
}

// A project saved before a caption style setting existed gets its default.
function mergeCaptions(c) {
  const d = defaultCaptions();
  return { ...d, ...c, style: isObj(c.style) ? { ...d.style, ...c.style } : c.style ?? d.style };
}

export function defaultExport() {
  // sizeLimit: null or MB for "Fit a size limit" (videos only); gifWidth,
  // gifFps and dither apply to GIFs.
  return {
    format: 'mp4', resolution: '1080p', quality: 'balanced', fps: 60, codec: 'h264',
    sizeLimit: null, gifWidth: 960, gifFps: 15, dither: true
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Recording 16 Sep 2026, 19:24", in the computer's local time.
export function defaultTitle(createdAt) {
  if (!isNum(createdAt)) return 'Recording';
  const d = new Date(createdAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `Recording ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function sourceDefaults() {
  return {
    dir: '.', kind: 'display', id: '', title: '', width: 0, height: 0, originX: 0, originY: 0,
    video: 'raw.mov', duration: 0, fps: 60, mic: false, systemAudio: null, webcam: null,
    cursor: 'cursor.bin', keys: null, clicks: [], pauses: []
  };
}

// A new v2 project for a fresh recording: one clip over all of it, minus any
// stretches the recording was paused for.
export function createProject({ main, title, createdAt = null, style } = {}) {
  const source = normalizeSource({ ...sourceDefaults(), ...main }, 'main');
  const project = {
    version: VERSION,
    title: title ?? defaultTitle(createdAt),
    createdAt,
    sources: { main: source },
    clips: clipsAround(source, 'main', []),
    speed: [],
    zooms: [],
    style: style ? mergeStyle(defaultStyle(), style) : defaultStyle(),
    annotations: [],
    markers: [],
    overlays: [],
    transitions: [],
    audio: defaultAudio(),
    captions: defaultCaptions(),
    export: defaultExport()
  };
  return validateProject(project);
}

function clipsAround(source, key, existing) {
  const pauses = [...source.pauses].sort((a, b) => a.start - b.start);
  const clips = [];
  let at = 0;
  const ids = [...existing];
  const add = (start, end) => {
    if (end - start < MIN_CLIP_SECONDS) return;
    const clip = { id: nextId('c', ids), source: key, start, end };
    ids.push(clip);
    clips.push(clip);
  };
  for (const p of pauses) {
    add(at, Math.min(p.start, source.duration));
    at = Math.max(at, p.end);
  }
  add(at, source.duration);
  // A recording shorter than a clip can be is still one clip, so there is
  // always something to play.
  if (!clips.length) clips.push({ id: nextId('c', ids), source: key, start: 0, end: source.duration });
  return clips;
}

// ---------------------------------------------------------------- migration

// A zoom starts where v1's target zoom rose above 1x and ends where it came
// back down (the same stretches v1's editor showed as zoom segments).
// Stretches that never got past RECORDED_ZOOM_THRESHOLD are dropped. Each
// zoom keeps the v1 keyframes it was made from, so the camera replays the
// exact zoom-in/out the recording had (a stretch can go 4x -> 2x -> 4x);
// editing the zoom's timing or level replaces them with the plain level.
export function zoomsFromKeyframes(keyframes, duration) {
  const zooms = [];
  let open = null;
  const close = (end) => {
    if (open.level > RECORDED_ZOOM_THRESHOLD) {
      zooms.push({
        id: `z${zooms.length + 1}`, source: 'main', start: open.start, end, level: open.level,
        follow: true, x: open.x, y: open.y, recorded: true, keyframes: open.keyframes
      });
    }
    open = null;
  };
  for (const kf of keyframes ?? []) {
    if (!isNum(kf?.t) || !isNum(kf?.zoom)) continue;
    const frame = { t: kf.t, zoom: kf.zoom };
    if (kf.zoom > 1) {
      if (!open) open = { start: kf.t, level: kf.zoom, keyframes: [], x: 0, y: 0 };
      open.level = Math.max(open.level, kf.zoom);
      open.keyframes.push(frame);
      if (isNum(kf.cx) && isNum(kf.cy)) { open.x = kf.cx; open.y = kf.cy; }
    } else if (open) {
      open.keyframes.push(frame);
      close(kf.t);
    }
  }
  if (open) close(duration);
  return zooms;
}

export function migrate(v1, { createdAt = null } = {}) {
  if (!isObj(v1) || v1.version !== 1) fail(`Not a version 1 project: ${JSON.stringify(v1?.version)}`);
  const src = v1.source ?? {};
  const cap = v1.capture ?? {};
  const settings = v1.settings ?? {};
  const duration = cap.duration;
  const main = {
    ...sourceDefaults(),
    kind: src.kind ?? 'display', id: src.id ?? '', title: src.title ?? '',
    width: src.width, height: src.height, originX: src.originX ?? 0, originY: src.originY ?? 0,
    video: cap.file ?? 'raw.mov', duration, fps: cap.fps ?? 60, mic: cap.hasMicTrack === true,
    cursor: typeof v1.cursorTrack === 'string' ? v1.cursorTrack : 'cursor.bin',
    clicks: (v1.clicks ?? []).filter((c) => isNum(c?.t) && isNum(c?.x) && isNum(c?.y))
      .map((c) => ({ t: c.t, x: c.x, y: c.y, button: typeof c.button === 'string' ? c.button : 'left' }))
  };
  // A recording made by this version also wrote its v2 source fields
  // (src/main/recording-v2.js): sound, webcam, shortcuts and pauses.
  const recorded = isObj(v1.sources?.main) ? v1.sources.main : null;
  if (recorded) {
    if (typeof recorded.systemAudio === 'string') main.systemAudio = recorded.systemAudio;
    if (isObj(recorded.webcam) && typeof recorded.webcam.file === 'string') main.webcam = { ...recorded.webcam };
    if (typeof recorded.keys === 'string') main.keys = recorded.keys;
    if (Array.isArray(recorded.pauses)) main.pauses = recorded.pauses.filter((q) => isNum(q?.start) && isNum(q?.end));
  }
  const exp = v1.export ?? {};
  const project = {
    version: VERSION,
    // A v1 recording renamed in the Library keeps its name.
    title: typeof v1.title === 'string' && v1.title.trim() ? v1.title.trim().slice(0, MAX_TITLE) : defaultTitle(createdAt),
    createdAt,
    sources: { main },
    clips: main.pauses.length && isNum(duration)
      ? clipsAround({ ...main, duration }, 'main', [])
      : [{ id: 'c1', source: 'main', start: 0, end: duration }],
    speed: (v1.speedSegments ?? []).map((s) => ({ source: 'main', start: s.srcStart, end: s.srcEnd, rate: s.rate })),
    zooms: zoomsFromKeyframes(v1.zoomKeyframes, duration),
    // Everything v1 had no notion of is off, so a migrated project exports
    // exactly the picture and sound v1 did: no background or frame, and the
    // cursor drawn from the raw samples (v1's export never smoothed it).
    style: {
      ...defaultStyle(),
      background: { type: 'none', value: null },
      padding: 0, radius: 0, shadow: 0, aspect: 'source',
      cursor: {
        show: settings.showCursor !== false, size: 1, hideWhenIdle: false, smooth: false,
        highlight: 'none', clicks: settings.clickHighlights !== false
      },
      // Shortcuts are only recorded when the user asked to show them.
      keystrokes: { show: main.keys !== null, position: 'bottom' }
    },
    annotations: [],
    markers: [],
    overlays: [],
    transitions: [],
    audio: { ...defaultAudio(), mic: { volume: 1, muted: false, cleanUp: false, level: false } },
    captions: defaultCaptions(),
    export: {
      ...defaultExport(),
      resolution: EXPORT_RESOLUTIONS.includes(exp.resolution) ? exp.resolution : '1080p',
      fps: isNum(exp.fps) ? exp.fps : 60,
      codec: EXPORT_CODECS.includes(exp.codec) ? exp.codec : 'h264'
    }
  };
  // A new recording starts from the default style preset, which the
  // recorder writes as `style` (older recordings have none).
  if (isObj(v1.style)) {
    try {
      project.style = validateStyle(mergeStyle(project.style, v1.style));
    } catch {
      // A preset from a newer or hand-edited settings file: the plain look.
    }
  }
  return validateProject(project);
}

// Whatever is in project.json -> a valid v2 project, or a thrown Error.
export function loadProjectData(raw, options) {
  if (!isObj(raw)) fail('project.json is not a project');
  if (raw.version === 1) return migrate(raw, options);
  if (raw.version === VERSION) return removeRecordedPauses(validateProject(raw));
  fail(`This project was made by a newer version of Loupe (format ${JSON.stringify(raw.version)})`);
}

// A recording made with pauses whose clips still run straight through them
// (written before the recorder cut them out, or by hand) gets its paused
// stretches removed when it is opened -- nobody wants to see the "paused"
// minutes. Only an untouched recording is changed: one clip over the whole
// of it. Once someone has edited the clips, what they chose stays.
export function removeRecordedPauses(project) {
  let clips = project.clips;
  for (const [key, source] of Object.entries(project.sources)) {
    if (!source.pauses?.length) continue;
    const own = clips.filter((c) => c.source === key);
    if (own.length !== 1 || own[0].start > 1e-3 || own[0].end < source.duration - 1e-3) continue;
    const at = clips.indexOf(own[0]);
    const pieces = clipsAround(source, key, clips);
    // The last piece keeps the clip's id, so a transition after it stays there.
    pieces[pieces.length - 1] = { ...pieces[pieces.length - 1], id: own[0].id };
    if (pieces.length === 1) continue;
    clips = [...clips.slice(0, at), ...pieces, ...clips.slice(at + 1)];
  }
  return clips === project.clips ? project : validateProject({ ...project, clips });
}

// ---------------------------------------------------------------- validation

function normalizeSource(s, key) {
  if (!isObj(s)) fail(`Source ${key} is missing`);
  const out = { ...sourceDefaults(), ...s };
  str(out.dir, `Source ${key} folder`);
  num(out.width, `Source ${key} width`, EPS);
  num(out.height, `Source ${key} height`, EPS);
  num(out.duration, `Source ${key} duration`, 0);
  num(out.fps, `Source ${key} fps`, EPS);
  num(out.originX, `Source ${key} originX`);
  num(out.originY, `Source ${key} originY`);
  str(out.video, `Source ${key} video`);
  bool(out.mic, `Source ${key} mic`);
  if (out.systemAudio !== null) str(out.systemAudio, `Source ${key} system audio`);
  if (out.keys !== null) str(out.keys, `Source ${key} keys`);
  if (out.cursor !== null) str(out.cursor, `Source ${key} cursor`);
  // An imported video's picture is turned this far clockwise (its file says
  // so); recordings have none.
  if (out.rotation !== undefined && ![0, 90, 180, 270].includes(out.rotation)) {
    fail(`Source ${key} rotation must be 0, 90, 180 or 270`);
  }
  if (out.webcam !== null) {
    if (!isObj(out.webcam)) fail(`Source ${key} webcam must be an object`);
    str(out.webcam.file, `Source ${key} webcam file`);
    num(out.webcam.offset ?? 0, `Source ${key} webcam offset`);
  }
  if (!Array.isArray(out.clicks)) fail(`Source ${key} clicks must be a list`);
  for (const c of out.clicks) { num(c?.t, 'Click time'); num(c?.x, 'Click x'); num(c?.y, 'Click y'); }
  if (!Array.isArray(out.pauses)) fail(`Source ${key} pauses must be a list`);
  for (const p of out.pauses) {
    num(p?.start, 'Pause start'); num(p?.end, 'Pause end');
    if (p.end < p.start) fail('A pause ends before it starts');
  }
  return out;
}

function validateClip(clip, sources) {
  if (!isObj(clip)) fail('A clip is not an object');
  str(clip.id, 'Clip id', { max: 64 });
  const meta = sources[clip.source];
  if (!meta) fail(`Clip ${clip.id} uses unknown source ${JSON.stringify(clip.source)}`);
  num(clip.start, `Clip ${clip.id} start`, 0);
  num(clip.end, `Clip ${clip.id} end`, 0);
  if (clip.start > clip.end || clip.end > meta.duration + 1e-6) {
    fail(`Clip ${clip.id} range ${clip.start}..${clip.end} is outside its recording`);
  }
  // Its sound moved to an audio clip ("detach audio").
  if (clip.detached !== undefined) bool(clip.detached, `Clip ${clip.id} detached`);
  // A freeze frame: the moment `start` held for `hold` seconds.
  if (clip.hold !== undefined) num(clip.hold, 'Freeze frame length', EPS, MAX_HOLD);
  if (clip.reverse !== undefined) bool(clip.reverse, `Clip ${clip.id} reverse`);
  if (clip.hold !== undefined && clip.reverse) fail('A freeze frame can\u2019t be reversed');
  // A gap left where a clip was deleted: black for its `hold` seconds.
  if (clip.gap !== undefined) {
    bool(clip.gap, `Clip ${clip.id} gap`);
    if (clip.gap && !(clip.hold > 0)) fail('A gap needs a length');
  }
  if (clip.transform !== undefined) validateTransform(clip.transform);
  if (clip.keyframes !== undefined) validateKeyframes(clip.keyframes, CLIP_ANIMATABLE);
  if (clip.color !== undefined) validateColor(clip.color);
  return clip;
}

// A clip's place and colour (look.js); every field optional.
function validateTransform(t) {
  if (!isObj(t)) fail('A clip\u2019s position must be an object');
  if (t.x !== undefined) num(t.x, 'Position x', -1, 1);
  if (t.y !== undefined) num(t.y, 'Position y', -1, 1);
  if (t.scale !== undefined) num(t.scale, 'Scale', 0.1, 5);
  if (t.rotate !== undefined) num(t.rotate, 'Rotation', -360, 360);
  if (t.flipH !== undefined) bool(t.flipH, 'Flip left to right');
  if (t.flipV !== undefined) bool(t.flipV, 'Flip upside down');
  if (t.crop !== undefined) {
    if (!isObj(t.crop)) fail('Crop must be an object');
    for (const side of ['left', 'top', 'right', 'bottom']) {
      if (t.crop[side] !== undefined) num(t.crop[side], `Crop ${side}`, 0, 0.45);
    }
  }
}

function validateColor(c) {
  if (!isObj(c)) fail('A clip\u2019s colour must be an object');
  if (c.brightness !== undefined) num(c.brightness, 'Brightness', -1, 1);
  if (c.contrast !== undefined) num(c.contrast, 'Contrast', -1, 1);
  if (c.saturation !== undefined) num(c.saturation, 'Saturation', -1, 1);
  if (c.filter !== undefined) oneOf(c.filter, COLOR_FILTERS, 'Colour filter');
  // A LUT is a file the project copied into its luts/ folder.
  if (c.lut !== undefined && c.lut !== null) {
    str(c.lut, 'LUT file', { max: 1024 });
    if (!/^luts\/[^/\\]+\.cube$/i.test(c.lut) || c.lut.includes('..')) fail('A LUT must be a .cube file in the project\u2019s luts folder');
  }
  if (c.lutMix !== undefined) num(c.lutMix, 'LUT amount', 0, 1);
  // The finer tools (grade.js); every one optional.
  if (c.temperature !== undefined) num(c.temperature, 'Warmth', -1, 1);
  if (c.tint !== undefined) num(c.tint, 'Tint', -1, 1);
  if (c.highlights !== undefined) num(c.highlights, 'Highlights', -1, 1);
  if (c.shadows !== undefined) num(c.shadows, 'Shadows', -1, 1);
  if (c.vignette !== undefined) num(c.vignette, 'Dark corners', 0, 1);
  if (c.sharpen !== undefined) num(c.sharpen, 'Sharpen', 0, 1);
  if (c.curve !== undefined && c.curve !== null) {
    if (!Array.isArray(c.curve) || c.curve.length < 2 || c.curve.length > MAX_CURVE_POINTS) {
      fail(`A colour curve must be a list of 2 to ${MAX_CURVE_POINTS} points`);
    }
    let last = -Infinity;
    for (const pt of c.curve) {
      if (!isObj(pt)) fail('A colour curve point is not an object');
      num(pt.x, 'Curve point position', 0, 1);
      num(pt.y, 'Curve point height', 0, 1);
      if (pt.x <= last) fail('A colour curve\u2019s points must go from left to right');
      last = pt.x;
    }
  }
}

function validateSpeedSegment(s, sources) {
  if (!sources[s?.source]) fail(`Speed uses unknown source ${JSON.stringify(s?.source)}`);
  num(s.start, 'Speed start', 0);
  num(s.end, 'Speed end', 0);
  num(s.rate, 'Speed', SPEED_MIN, SPEED_MAX);
  if (s.end <= s.start) fail('A speed stretch ends before it starts');
  // Seconds to reach the speed and to leave it (timeline.js); none = the usual.
  if (s.rampIn !== undefined) num(s.rampIn, 'Speed ramp in', 0, SPEED_RAMP_MAX);
  if (s.rampOut !== undefined) num(s.rampOut, 'Speed ramp out', 0, SPEED_RAMP_MAX);
  return s;
}

function validateZoom(z, sources) {
  if (!isObj(z)) fail('A zoom is not an object');
  str(z.id, 'Zoom id', { max: 64 });
  const meta = sources[z.source];
  if (!meta) fail(`Zoom ${z.id} uses unknown source ${JSON.stringify(z.source)}`);
  num(z.start, 'Zoom start', 0);
  num(z.end, 'Zoom end', 0);
  if (z.end - z.start < EPS) fail('A zoom must end after it starts');
  num(z.level, 'Zoom level', ZOOM_LEVEL_MIN, ZOOM_LEVEL_MAX);
  bool(z.follow, 'Zoom follow');
  num(z.x, 'Zoom x');
  num(z.y, 'Zoom y');
  bool(z.recorded, 'Zoom recorded');
  // Switched off: kept on the timeline, without effect on the picture.
  if (z.disabled !== undefined) bool(z.disabled, 'Zoom disabled');
  // Made by Loupe from the clicks, not by hand.
  if (z.auto !== undefined) bool(z.auto, 'Zoom auto');
  // How quickly it moves in and out (camera.js); none = smooth.
  if (z.ease !== undefined) oneOf(z.ease, ZOOM_EASES, 'Zoom easing');
  if (z.keyframes !== undefined) {
    if (!Array.isArray(z.keyframes)) fail('Zoom keyframes must be a list');
    for (const k of z.keyframes) { num(k?.t, 'Zoom keyframe time'); num(k?.zoom, 'Zoom keyframe level', 0.01, 100); }
  }
  return z;
}

function noOverlap(zooms) {
  const bySource = [...zooms].sort((a, b) => (a.source === b.source ? a.start - b.start : a.source < b.source ? -1 : 1));
  for (let i = 1; i < bySource.length; i++) {
    const a = bySource[i - 1];
    const b = bySource[i];
    if (a.source === b.source && b.start < a.end - 1e-6) fail('Zooms can’t overlap');
  }
}

function validateBackground(bg) {
  if (!isObj(bg)) fail('Background must be an object');
  oneOf(bg.type, BACKGROUND_TYPES, 'Background type');
  if (bg.type === 'color') color(bg.value, 'Background colour');
  if (bg.type === 'gradient') {
    if (!isObj(bg.value)) fail('Gradient must have colours');
    num(bg.value.angle, 'Gradient angle', -360, 360);
    if (!Array.isArray(bg.value.stops) || bg.value.stops.length < 2 || bg.value.stops.length > 8) {
      fail('A gradient needs 2 to 8 colours');
    }
    bg.value.stops.forEach((c) => color(c, 'Gradient colour'));
  }
  if (bg.type === 'image') str(bg.value, 'Background image', { max: 4096 });
  return bg;
}

function validateStyle(style) {
  if (!isObj(style)) fail('Style must be an object');
  validateBackground(style.background);
  num(style.padding, 'Padding', 0, 0.4);
  num(style.radius, 'Corner radius', 0, 200);
  num(style.shadow, 'Shadow', 0, 1);
  oneOf(style.aspect, ASPECTS, 'Aspect ratio');
  const c = style.cursor;
  if (!isObj(c)) fail('Cursor style must be an object');
  bool(c.show, 'Show cursor');
  num(c.size, 'Cursor size', 0.25, 5);
  bool(c.hideWhenIdle, 'Hide cursor when idle');
  bool(c.smooth, 'Smooth cursor');
  oneOf(c.highlight, HIGHLIGHTS, 'Cursor highlight');
  bool(c.clicks, 'Click effects');
  if (!isObj(style.keystrokes)) fail('Keystroke style must be an object');
  bool(style.keystrokes.show, 'Show keystrokes');
  oneOf(style.keystrokes.position, POSITIONS, 'Keystroke position');
  const w = style.webcam;
  if (!isObj(w)) fail('Webcam style must be an object');
  bool(w.show, 'Show webcam');
  oneOf(w.shape, WEBCAM_SHAPES, 'Webcam shape');
  num(w.size, 'Webcam size', 0.05, 1);
  oneOf(w.corner, CORNERS, 'Webcam corner');
  return style;
}

function validateAnnotation(a, sources) {
  if (!isObj(a)) fail('An annotation is not an object');
  str(a.id, 'Annotation id', { max: 64 });
  oneOf(a.type, ANNOTATION_TYPES, 'Annotation type');
  if (!sources[a.source]) fail(`Annotation uses unknown source ${JSON.stringify(a.source)}`);
  num(a.start, 'Annotation start', 0);
  num(a.end, 'Annotation end', 0);
  if (a.end - a.start < EPS) fail('An annotation must end after it starts');
  for (const k of ['x', 'y', 'w', 'h', 'x2', 'y2']) num(a[k], `Annotation ${k}`, -1, 2);
  str(a.text, 'Annotation text', { empty: true });
  color(a.color, 'Annotation colour');
  num(a.size, 'Annotation size', 0.1, 10);
  return a;
}

// A project saved before audio clips had one `music` setting. It becomes
// the first clip, repeating to the end of the video with the 3-second fade
// it always had, so it sounds as it did.
function upgradeAudio(audio) {
  if (!isObj(audio)) return audio;
  // Clips saved before a setting existed get its default.
  if (Array.isArray(audio.clips)) {
    audio = { ...audio, clips: audio.clips.map((c) => (isObj(c) ? { ...defaultAudioClip(), ...c } : c)) };
  }
  if (!('music' in audio)) return audio;
  const { music, ...rest } = audio;
  if (!isObj(music) || (Array.isArray(rest.clips) && rest.clips.length)) return rest;
  const from = isNum(music.from) ? music.from : 0;
  return {
    ...rest,
    clips: [{
      ...defaultAudioClip(),
      id: 'a1', file: music.file, name: audioName(music.file),
      start: isNum(music.start) ? music.start : 0, from, length: null, fileDuration: null,
      volume: music.volume, fadeIn: from > 0 ? 0.3 : 0, fadeOut: 3,
      duck: music.duck, muted: false, loop: true, lane: 0
    }]
  };
}

export function defaultAudioClip() {
  return {
    name: '', start: 0, from: 0, length: null, fileDuration: null,
    volume: 0.3, fadeIn: 0, fadeOut: 0, duck: true, muted: false, loop: false, lane: 0,
    points: [], beats: false, source: null
  };
}

const MAX_POINTS = 500;

// The finer tools of a clip, the microphone or the computer sound
// (audio/tone.js): pan, a three-band equalizer and a compressor. All
// optional -- a project saved before them has none and sounds as it did.
function validateTone(t, what) {
  if (t.pan !== undefined) num(t.pan, `${what} pan`, -1, 1);
  if (t.eq !== undefined) {
    if (!isObj(t.eq)) fail(`${what} tone settings must be an object`);
    for (const [k, name] of [['low', 'low'], ['mid', 'middle'], ['high', 'high']]) {
      if (t.eq[k] !== undefined) num(t.eq[k], `${what} ${name} tones`, -12, 12);
    }
  }
  if (t.compressor !== undefined) {
    const c = t.compressor;
    if (!isObj(c)) fail(`${what} evening out settings must be an object`);
    if (c.on !== undefined) bool(c.on, `${what} even out loud and quiet parts`);
    if (c.threshold !== undefined) num(c.threshold, `${what} evening out level`, -60, 0);
    if (c.ratio !== undefined) num(c.ratio, `${what} evening out amount`, 1, 20);
    if (c.attack !== undefined) num(c.attack, `${what} evening out attack`, 0.001, 0.5);
    if (c.release !== undefined) num(c.release, `${what} evening out release`, 0.01, 2);
    if (c.makeup !== undefined) num(c.makeup, `${what} evening out boost`, 0, 24);
  }
}

function validateAudioClip(c, sources) {
  if (!isObj(c)) fail('An audio clip is not an object');
  str(c.id, 'Audio clip id', { max: 64 });
  if (c.source !== null && c.source !== undefined) {
    // The video's own sound, detached from it.
    if (!sources?.[c.source]) fail(`Audio uses unknown recording ${JSON.stringify(c.source)}`);
    if (c.file !== null) fail('Detached video sound has no file');
  } else {
    str(c.file, 'Audio file', { max: 4096 });
  }
  str(c.name, 'Audio name', { empty: true, max: 300 });
  num(c.start, 'Audio start', 0);
  num(c.from, 'Song position', 0);
  if (c.length !== null) num(c.length, 'Audio length', MIN_AUDIO_SECONDS);
  if (c.fileDuration !== null) num(c.fileDuration, 'Audio file length', 0);
  num(c.volume, 'Audio volume', 0, 2);
  num(c.fadeIn, 'Fade in', 0);
  num(c.fadeOut, 'Fade out', 0);
  // Against the clip's own length when that is known without the video's.
  const known = c.length ?? (!c.loop && c.fileDuration > 0 ? c.fileDuration - c.from : null);
  if (known !== null && c.fadeIn + c.fadeOut > known + 1e-6) fail('The fades are longer than the clip');
  bool(c.duck, 'Lower audio under speech');
  bool(c.muted, 'Audio muted');
  bool(c.loop, 'Repeat audio');
  bool(c.beats, 'Show beats');
  if (!Array.isArray(c.points)) fail('Volume points must be a list');
  if (c.points.length > MAX_POINTS) fail('Too many volume points');
  let last = -Infinity;
  for (const pt of c.points) {
    if (!isObj(pt)) fail('A volume point is not an object');
    num(pt.t, 'Volume point time', 0);
    num(pt.gain, 'Volume point level', 0, 2);
    if (pt.t < last) fail('Volume points must be in time order');
    last = pt.t;
  }
  if (!Number.isInteger(c.lane) || c.lane < 0 || c.lane >= MAX_LANES) fail(`Audio row must be 0 to ${MAX_LANES - 1}`);
  validateTone(c, 'Audio');
}

function validateAudio(audio, sources) {
  if (!isObj(audio)) fail('Audio settings must be an object');
  const { mic, system, clips, voiceover } = audio;
  if (!isObj(mic)) fail('Microphone settings must be an object');
  num(mic.volume, 'Microphone volume', 0, 2);
  bool(mic.muted, 'Microphone muted');
  bool(mic.cleanUp, 'Clean up microphone');
  bool(mic.level, 'Even out microphone volume');
  validateTone(mic, 'Microphone');
  if (!isObj(system)) fail('System audio settings must be an object');
  num(system.volume, 'System audio volume', 0, 2);
  bool(system.muted, 'System audio muted');
  validateTone(system, 'System audio');
  if (!Array.isArray(clips)) fail('Audio clips must be a list');
  if (clips.length > 500) fail('Too many audio clips');
  clips.forEach((c) => validateAudioClip(c, sources));
  if (new Set(clips.map((c) => c.id)).size !== clips.length) fail('Two audio clips have the same id');
  const { lanes } = audio;
  if (!Array.isArray(lanes) || lanes.length > MAX_LANES) fail('Audio rows must be a list');
  for (const l of lanes) {
    if (l === null) continue;
    if (!isObj(l)) fail('An audio row is not an object');
    for (const k of ['muted', 'solo', 'locked']) if (l[k] !== undefined) bool(l[k], `Audio row ${k}`);
  }
  if (!Array.isArray(voiceover)) fail('Voiceover must be a list');
  for (const v of voiceover) {
    str(v?.id, 'Voiceover id', { max: 64 });
    str(v.file, 'Voiceover file', { max: 4096 });
    if (!sources[v.source]) fail(`Voiceover uses unknown source ${JSON.stringify(v.source)}`);
    num(v.t, 'Voiceover time', 0);
    num(v.volume, 'Voiceover volume', 0, 2);
  }
  return audio;
}

function validateCaptions(c, sources) {
  if (!isObj(c)) fail('Captions must be an object');
  bool(c.show, 'Show captions');
  str(c.language, 'Caption language', { max: 32 });
  if (!Array.isArray(c.segments)) fail('Caption lines must be a list');
  for (const s of c.segments) {
    str(s?.id, 'Caption id', { max: 64 });
    if (!sources[s.source]) fail(`Caption uses unknown source ${JSON.stringify(s.source)}`);
    num(s.start, 'Caption start', 0);
    num(s.end, 'Caption end', 0);
    if (s.end < s.start) fail('A caption ends before it starts');
    str(s.text, 'Caption text', { empty: true });
  }
  if (!isObj(c.style)) fail('Caption style must be an object');
  num(c.style.size, 'Caption size', 0.25, 4);
  oneOf(c.style.position, POSITIONS, 'Caption position');
  bool(c.style.box, 'Caption background box');
  return c;
}

function validateExport(e) {
  if (!isObj(e)) fail('Export settings must be an object');
  oneOf(e.format, EXPORT_FORMATS, 'Export format');
  oneOf(e.resolution, EXPORT_RESOLUTIONS, 'Export resolution');
  oneOf(e.quality, EXPORT_QUALITIES, 'Export quality');
  num(e.fps, 'Export frame rate', 1, 120);
  oneOf(e.codec, EXPORT_CODECS, 'Export codec');
  if (e.sizeLimit !== null) num(e.sizeLimit, 'Export size limit', 1, 4000);
  oneOf(e.gifWidth, EXPORT_GIF_WIDTHS, 'GIF width');
  oneOf(e.gifFps, EXPORT_GIF_FRAME_RATES, 'GIF frame rate');
  bool(e.dither, 'GIF dithering');
  return e;
}

function validateTransition(t, clips) {
  if (!clips.some((c) => c.id === t?.after)) fail(`Transition after unknown clip ${JSON.stringify(t?.after)}`);
  oneOf(t.type, TRANSITION_TYPES, 'Transition type');
  num(t.duration, 'Transition length', 0.05, 5);
  return t;
}

// Checks a whole v2 project (filling in sections a hand-edited or older v2
// file lacks) and returns it; throws on anything that can't be drawn.
export function validateProject(p) {
  if (!isObj(p) || p.version !== VERSION) fail('Not a version 2 project');
  if (!isObj(p.sources) || !p.sources.main) fail('The project has no recording');
  const sources = {};
  for (const [key, s] of Object.entries(p.sources)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(key)) fail(`Bad source name ${JSON.stringify(key)}`);
    sources[key] = normalizeSource(s, key);
  }
  const out = {
    ...p,
    // Names are short (setTitle allows 200); a hand-edited or hostile file's
    // megabytes of title would otherwise be read and sent on every listing.
    title: typeof p.title === 'string' ? p.title.slice(0, MAX_TITLE) : 'Recording',
    createdAt: isNum(p.createdAt) ? p.createdAt : null,
    sources,
    speed: p.speed ?? [],
    zooms: p.zooms ?? [],
    style: p.style ? mergeStyle(defaultStyle(), p.style) : defaultStyle(),
    annotations: p.annotations ?? [],
    markers: p.markers ?? [],
    overlays: p.overlays ?? [],
    transitions: p.transitions ?? [],
    audio: p.audio ? upgradeAudio({ ...defaultAudio(), ...p.audio }) : defaultAudio(),
    captions: p.captions ? mergeCaptions(p.captions) : defaultCaptions(),
    export: p.export ? { ...defaultExport(), ...p.export } : defaultExport()
  };
  if (out.autoZoomNote !== undefined && out.autoZoomNote !== true) delete out.autoZoomNote;
  // What the transcript's switches cut (transcript-edit.js); anything that
  // isn't a list of ranges is dropped rather than refused.
  if (out.transcript !== undefined) {
    const cuts = Array.isArray(out.transcript?.cuts) ? out.transcript.cuts.filter((c) => isObj(c) && sources[c.source] &&
      isNum(c.start) && isNum(c.end) && c.end > c.start && ['filler', 'silence'].includes(c.reason)).slice(0, 5000) : [];
    if (cuts.length) out.transcript = { cuts };
    else delete out.transcript;
  }
  if (!Array.isArray(p.clips) || p.clips.length === 0) fail('The project has no clips');
  p.clips.forEach((c) => validateClip(c, sources));
  if (new Set(p.clips.map((c) => c.id)).size !== p.clips.length) fail('Two clips have the same id');
  out.clips = p.clips;
  if (!Array.isArray(out.speed)) fail('Speed must be a list');
  out.speed.forEach((s) => validateSpeedSegment(s, sources));
  if (!Array.isArray(out.zooms)) fail('Zooms must be a list');
  out.zooms.forEach((z) => validateZoom(z, sources));
  noOverlap(out.zooms);
  validateStyle(out.style);
  if (!Array.isArray(out.annotations)) fail('Annotations must be a list');
  out.annotations.forEach((a) => validateAnnotation(a, sources));
  if (!Array.isArray(out.overlays)) fail('Overlays must be a list');
  out.overlays.forEach(validateOverlay);
  if (new Set(out.overlays.map((o) => o.id)).size !== out.overlays.length) fail('Two overlays have the same id');
  if (!Array.isArray(out.markers)) fail('Markers must be a list');
  out.markers.forEach(validateMarker);
  if (new Set(out.markers.map((m) => m.id)).size !== out.markers.length) fail('Two markers have the same id');
  if (!Array.isArray(out.transitions)) fail('Transitions must be a list');
  out.transitions.forEach((t) => validateTransition(t, out.clips));
  validateAudio(out.audio, sources);
  validateCaptions(out.captions, sources);
  validateExport(out.export);
  return out;
}

// ---------------------------------------------------------------- clip edits

function clipIndex(project, clipId) {
  const i = project.clips.findIndex((c) => c.id === clipId);
  if (i < 0) fail(`No clip ${JSON.stringify(clipId)}`);
  return i;
}

function withClips(project, clips) {
  // A transition belongs to the clip it follows; if that clip is gone, so is it.
  const ids = new Set(clips.map((c) => c.id));
  const transitions = project.transitions.every((t) => ids.has(t.after))
    ? project.transitions : project.transitions.filter((t) => ids.has(t.after));
  return { ...project, clips, transitions };
}

// Moves a clip's first frame to source time `t` (dragging its left edge).
// Clamped to the recording and to MIN_CLIP_SECONDS before its end.
export function trimStart(project, clipId, t) {
  num(t, 'Trim time');
  const i = clipIndex(project, clipId);
  const clip = project.clips[i];
  const latest = clip.end - MIN_CLIP_SECONDS;
  if (latest < 0) fail('That clip is too short to trim');
  const clips = project.clips.slice();
  clips[i] = { ...clip, start: clamp(t, 0, latest) };
  return withClips(project, clips);
}

// Moves a clip's end to source time `t` (dragging its right edge).
export function trimEnd(project, clipId, t) {
  num(t, 'Trim time');
  const i = clipIndex(project, clipId);
  const clip = project.clips[i];
  const duration = project.sources[clip.source].duration;
  const earliest = clip.start + MIN_CLIP_SECONDS;
  if (earliest > duration) fail('That clip is too short to trim');
  const clips = project.clips.slice();
  clips[i] = { ...clip, end: clamp(t, earliest, duration) };
  return withClips(project, clips);
}

// Clip i's part between output times o1 and o2 (inside it): a freeze frame
// holds for that long; a reversed clip's part runs from later to earlier.
// The clip's own ends are kept exactly (no rounding through the timeline).
function pieceOf(project, tl, i, o1, o2) {
  const clip = project.clips[i];
  const b = tl.clipBounds()[i];
  if (clip.hold > 0) return { ...clip, hold: o2 - o1 };
  const at = (o) => (Math.abs(o - b.outStart) < 1e-9 ? (clip.reverse ? clip.end : clip.start)
    : Math.abs(o - b.outEnd) < 1e-9 ? (clip.reverse ? clip.start : clip.end) : tl.clipSourceAt(i, o));
  const s1 = at(o1);
  const s2 = at(o2);
  return clip.reverse ? { ...clip, start: s2, end: s1 } : { ...clip, start: s1, end: s2 };
}

const pieceLength = (c) => (c.hold > 0 ? c.hold : c.end - c.start);

// Splits the clip playing at output time `outT` in two. Splitting within
// MIN_CLIP_SECONDS of either end of a clip would leave a sliver; refused.
export function splitAt(project, outT) {
  num(outT, 'Split time');
  const tl = buildTimeline(project);
  if (outT <= 0 || outT >= tl.duration) fail('Pick a moment inside the video to split');
  const i = tl.toSource(outT).clipIndex;
  const clip = project.clips[i];
  const b = tl.clipBounds()[i];
  const first = pieceOf(project, tl, i, b.outStart, outT);
  const second = { ...pieceOf(project, tl, i, outT, b.outEnd), id: nextId('c', project.clips) };
  if (pieceLength(first) < MIN_CLIP_SECONDS || pieceLength(second) < MIN_CLIP_SECONDS) {
    fail('Too close to the edge of a clip to split');
  }
  const clips = project.clips.slice();
  clips.splice(i, 1, first, second);
  // A transition after the old clip now follows the second half.
  const transitions = project.transitions.map((t) => (t.after === clip.id ? { ...t, after: second.id } : t));
  return { ...project, clips, transitions };
}

// Removes output range [outStart, outEnd): clips entirely inside it go, a
// clip it crosses is shortened, and a clip it falls inside is split around
// it. Refuses to cut the whole video away.
export function cutRange(project, outStart, outEnd) {
  num(outStart, 'Cut start');
  num(outEnd, 'Cut end');
  const tl = buildTimeline(project);
  const a = clamp(Math.min(outStart, outEnd), 0, tl.duration);
  const b = clamp(Math.max(outStart, outEnd), 0, tl.duration);
  if (b - a < 1e-6) fail('Select a stretch of the video to cut');
  const bounds = tl.clipBounds();
  const clips = [];
  const ids = project.clips.slice();
  let transitions = project.transitions;
  project.clips.forEach((clip, i) => {
    const { outStart: cs, outEnd: ce } = bounds[i];
    if (ce <= a + 1e-9 || cs >= b - 1e-9) { clips.push(clip); return; }
    // A piece shorter than a split or trim could leave takes the rest with
    // it: a sliver can't be grabbed and shows no frame.
    const before = a > cs + 1e-9 ? pieceOf(project, tl, i, cs, a) : null;
    const after = b < ce - 1e-9 ? pieceOf(project, tl, i, b, ce) : null;
    const keepBefore = Boolean(before) && pieceLength(before) >= MIN_CLIP_SECONDS;
    const keepAfter = Boolean(after) && pieceLength(after) >= MIN_CLIP_SECONDS;
    if (keepBefore) clips.push(before);
    if (keepAfter) {
      const piece = { ...after, id: keepBefore ? nextId('c', ids) : clip.id };
      ids.push(piece);
      clips.push(piece);
      // Cut out of the middle: the clip's transition stays at its end, which
      // is now the second piece's end (as splitAt does).
      if (keepBefore) transitions = transitions.map((t) => (t.after === clip.id ? { ...t, after: piece.id } : t));
    }
  });
  if (!clips.length) fail('Can\u2019t cut the whole video');
  return withClips({ ...project, transitions }, clips);
}

// ---------------------------------------------------------------- freeze, reverse

// A freeze frame of the moment at output time `outT`, `seconds` long: the
// clip there is split and the still goes between (before the first clip at
// its very start, after the last at the very end). One on a freeze frame
// lengthens it.
export function freezeFrame(project, outT, seconds = 2) {
  num(outT, 'Freeze time', 0);
  num(seconds, 'Freeze frame length', MIN_CLIP_SECONDS, MAX_HOLD);
  const tl = buildTimeline(project);
  const o = Math.min(outT, tl.duration);
  const at = tl.toSource(Math.min(o, Math.max(0, tl.duration - 1e-9)));
  const i = at.clipIndex;
  const clip = project.clips[i];
  if (clip.hold > 0) return setHold(project, clip.id, clip.hold + seconds);
  const b = tl.clipBounds()[i];
  const atEnd = o >= tl.duration - 1e-9;
  const t = atEnd ? (clip.reverse ? clip.start : clip.end) : at.t;
  const still = { id: nextId('c', project.clips), source: clip.source, start: t, end: t, hold: seconds };
  let p = project;
  let insertAt;
  if (o - b.outStart < MIN_CLIP_SECONDS && !atEnd) insertAt = i;
  else if (b.outEnd - o < MIN_CLIP_SECONDS || atEnd) insertAt = i + 1;
  else {
    p = splitAt(project, o);
    insertAt = i + 1;
  }
  const clips = p.clips.slice();
  clips.splice(insertAt, 0, { ...still, id: nextId('c', p.clips) });
  return validateProject({ ...p, clips });
}

export function setHold(project, clipId, seconds) {
  const i = clipIndex(project, clipId);
  if (!(project.clips[i].hold > 0)) fail('That clip isn\u2019t a freeze frame');
  num(seconds, 'Freeze frame length', MIN_CLIP_SECONDS, MAX_HOLD);
  const clips = project.clips.slice();
  clips[i] = { ...clips[i], hold: seconds };
  return { ...project, clips };
}

// A clip's look: { transform: patch | null, color: patch | null } -- a
// patch merges (crop by side), null takes that part back to as recorded.
export function setClipLook(project, clipId, { transform, color } = {}) {
  const i = clipIndex(project, clipId);
  const clip = { ...project.clips[i] };
  if (transform === null) delete clip.transform;
  else if (transform !== undefined) {
    if (!isObj(transform)) fail('A clip\u2019s position must be an object');
    const was = clip.transform ?? {};
    clip.transform = { ...was, ...transform };
    if (transform.crop !== undefined) clip.transform.crop = { ...(was.crop ?? {}), ...transform.crop };
  }
  if (color === null) delete clip.color;
  else if (color !== undefined) clip.color = { ...(clip.color ?? {}), ...color };
  const clips = project.clips.slice();
  clips[i] = clip;
  validateClip(clip, project.sources);
  return { ...project, clips };
}

// Plays clip `clipId` backwards (its sound is left out), or forwards again.
export function setClipReverse(project, clipId, on) {
  bool(on, 'Reverse');
  const i = clipIndex(project, clipId);
  if (project.clips[i].hold > 0) fail('A freeze frame can\u2019t be reversed');
  const clips = project.clips.slice();
  clips[i] = { ...clips[i], reverse: on };
  return { ...project, clips };
}

export function moveClip(project, from, to) {
  const n = project.clips.length;
  if (!Number.isInteger(from) || from < 0 || from >= n) fail(`No clip at position ${JSON.stringify(from)}`);
  if (!Number.isInteger(to) || to < 0 || to >= n) fail(`Can’t move a clip to position ${JSON.stringify(to)}`);
  if (from === to) return project;
  const clips = project.clips.slice();
  const [clip] = clips.splice(from, 1);
  clips.splice(to, 0, clip);
  return { ...project, clips };
}

export const isGap = (clip) => Boolean(clip?.gap) && clip.hold > 0;

// Removes a clip, the later ones closing up -- or with `leaveGap`, leaving
// black for as long as it played, so nothing after it moves.
export function deleteClip(project, clipId, { leaveGap = false } = {}) {
  const i = clipIndex(project, clipId);
  if (leaveGap) {
    const clip = project.clips[i];
    if (isGap(clip)) return project;
    const b = buildTimeline(project).clipBounds()[i];
    const hold = b.outEnd - b.outStart;
    if (hold < MIN_CLIP_SECONDS) fail('That clip is too short to leave a gap');
    const clips = project.clips.slice();
    clips[i] = { id: clip.id, source: clip.source, start: clip.start, end: clip.start, hold, gap: true };
    // A gap is the only thing a video can't be made of.
    if (clips.every(isGap)) fail('A video needs at least one clip');
    return withClips(project, clips);
  }
  if (project.clips.length === 1) fail('A video needs at least one clip');
  return withClips(project, project.clips.filter((_, k) => k !== i));
}

// Removes everything in `items` (the editor's selection: { kind, id }, or a
// speed stretch { kind: 'speed', source, start, end }) as one edit.
export function removeItems(project, items, { leaveGap = false } = {}) {
  if (!Array.isArray(items) || !items.length) fail('Select something to delete first');
  let p = project;
  const clips = [];
  for (const it of items) {
    switch (it?.kind) {
      case 'clip': clips.push(it.id); break;
      case 'zoom': p = removeZoom(p, it.id); break;
      case 'annotation': p = removeAnnotation(p, it.id); break;
      case 'caption':
        if (!p.captions.segments.some((c) => c.id === it.id)) fail(`No caption ${JSON.stringify(it.id)}`);
        p = setCaptions(p, { segments: p.captions.segments.filter((c) => c.id !== it.id) });
        break;
      case 'audio': p = removeAudioClip(p, it.id); break;
      case 'overlay': p = removeOverlay(p, it.id); break;
      case 'marker': p = removeMarker(p, it.id); break;
      case 'speed': p = paintSpeed(p, { source: it.source, start: it.start, end: it.end, rate: 1 }); break;
      default: fail(`Can\u2019t delete ${JSON.stringify(it?.kind)}`);
    }
  }
  if (!leaveGap && clips.length >= p.clips.length) fail('A video needs at least one clip. Drag its edges to trim it instead.');
  for (const id of clips) p = deleteClip(p, id, { leaveGap });
  return p;
}

// Adds another recording to the end of the video. `sourceKey` must be new.
export function appendRecording(project, sourceKey, sourceMeta) {
  if (typeof sourceKey !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(sourceKey)) {
    fail(`Bad source name ${JSON.stringify(sourceKey)}`);
  }
  if (project.sources[sourceKey]) fail(`There is already a recording called ${sourceKey}`);
  const meta = normalizeSource({ ...sourceDefaults(), ...sourceMeta }, sourceKey);
  const added = clipsAround(meta, sourceKey, project.clips);
  return {
    ...project,
    sources: { ...project.sources, [sourceKey]: meta },
    clips: [...project.clips, ...added]
  };
}

// ---------------------------------------------------------------- zooms

function checkRange(project, source, start, end, what) {
  const meta = project.sources[source];
  if (!meta) fail(`${what} uses unknown recording ${JSON.stringify(source)}`);
  num(start, `${what} start`);
  num(end, `${what} end`);
  const s = clamp(Math.min(start, end), 0, meta.duration);
  const e = clamp(Math.max(start, end), 0, meta.duration);
  if (e - s < MIN_RANGE_SECONDS - EPS) fail(`${what} is too short`);
  return { start: s, end: e };
}

function withZooms(project, zooms) {
  noOverlap(zooms);
  return { ...project, zooms };
}

// A new zoom (not recorded). Defaults: 2x, following the cursor, pinned
// point at the middle of the recording if it's switched to fixed.
export function addZoom(project, { source = 'main', start, end, level = 2, follow = true, x, y } = {}) {
  const range = checkRange(project, source, start, end, 'Zoom');
  const meta = project.sources[source];
  const zoom = validateZoom({
    id: nextId('z', project.zooms), source, ...range, level, follow,
    x: x ?? meta.width / 2, y: y ?? meta.height / 2, recorded: false
  }, project.sources);
  const zooms = [...project.zooms, zoom].sort((a, b) => a.start - b.start);
  return withZooms(project, zooms);
}

const ZOOM_PATCH_KEYS = ['start', 'end', 'level', 'follow', 'x', 'y', 'disabled', 'auto', 'ease'];

export function updateZoom(project, zoomId, patch) {
  const i = project.zooms.findIndex((z) => z.id === zoomId);
  if (i < 0) fail(`No zoom ${JSON.stringify(zoomId)}`);
  if (!isObj(patch)) fail('Zoom changes must be an object');
  for (const k of Object.keys(patch)) {
    if (!ZOOM_PATCH_KEYS.includes(k)) fail(`Can’t change a zoom's ${k}`);
  }
  const old = project.zooms[i];
  const next = { ...old, ...patch };
  if ('start' in patch || 'end' in patch) Object.assign(next, checkRange(project, old.source, next.start, next.end, 'Zoom'));
  // A recorded zoom's own ups and downs only make sense over its recorded
  // time and level; once either is edited the zoom becomes the plain level.
  if (old.keyframes && ['start', 'end', 'level'].some((k) => k in patch && patch[k] !== old[k])) {
    delete next.keyframes;
  }
  validateZoom(next, project.sources);
  const zooms = project.zooms.slice();
  zooms[i] = next;
  zooms.sort((a, b) => a.start - b.start);
  return withZooms(project, zooms);
}

export function removeZoom(project, zoomId) {
  if (!project.zooms.some((z) => z.id === zoomId)) fail(`No zoom ${JSON.stringify(zoomId)}`);
  return { ...project, zooms: project.zooms.filter((z) => z.id !== zoomId) };
}

// ---- zooms made from clicks (auto-zoom.js)

// Whether any recording in the project has clicks to zoom on.
export function hasClicks(project) {
  return Object.values(project.sources).some((s) => s.clicks?.length > 0);
}

// Replaces the automatic zooms with ones made from the clicks, at `strength`
// (subtle, moderate, intense). Zooms made by hand are left alone and keep
// their place: no automatic zoom is put over one.
export function applyAutoZooms(project, { strength = 'moderate' } = {}) {
  const kept = project.zooms.filter((z) => !z.auto);
  const made = [];
  for (const [key, meta] of Object.entries(project.sources)) {
    const taken = kept.filter((z) => z.source === key);
    for (const r of autoZoomRanges(meta.clicks, meta.duration, { strength, taken })) {
      made.push(validateZoom({
        id: nextId('z', [...kept, ...made]), source: key, start: r.start, end: r.end, level: r.level,
        follow: true, x: meta.width / 2, y: meta.height / 2, recorded: false, auto: true
      }, project.sources));
    }
  }
  const zooms = [...kept, ...made].sort((a, b) => (a.source === b.source ? a.start - b.start : 0));
  const next = withZooms(project, zooms);
  delete next.autoZoomNote;
  return next;
}

// How many zooms are automatic.
export const autoZoomCount = (project) => project.zooms.filter((z) => z.auto).length;

export function removeAutoZooms(project) {
  const next = { ...project, zooms: project.zooms.filter((z) => !z.auto) };
  delete next.autoZoomNote;
  return next;
}

// The one-time note a new recording carries ("Loupe added 6 zooms where you
// clicked"): set when the recorder made them, gone once it is answered.
export function setAutoZoomNote(project, on) {
  const next = { ...project };
  if (on) next.autoZoomNote = true;
  else delete next.autoZoomNote;
  return next;
}

// ---------------------------------------------------------------- speed

// Paints `rate` over a source range, replacing whatever was there (as
// src/main/speed.js paintSpeed): 1x puts the range back to normal, and
// touching stretches at the same rate merge.
export function paintSpeed(project, { source = 'main', start, end, rate } = {}) {
  const range = checkRange(project, source, start, end, 'Speed');
  num(rate, 'Speed', SPEED_MIN, SPEED_MAX);
  const others = project.speed.filter((s) => s.source !== source);
  const mine = [];
  for (const s of project.speed) {
    if (s.source !== source) continue;
    if (s.end <= range.start || s.start >= range.end) { mine.push({ ...s }); continue; }
    if (s.start < range.start) mine.push({ ...s, end: range.start });
    if (s.end > range.end) mine.push({ ...s, start: range.end });
  }
  if (rate !== 1) mine.push({ source, ...range, rate });
  mine.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of mine) {
    if (s.end - s.start < MIN_RANGE_SECONDS - EPS) continue;
    const prev = merged.at(-1);
    if (prev && prev.rate === s.rate && prev.rampIn === s.rampIn && prev.rampOut === s.rampOut &&
        s.start - prev.end <= 1e-6) prev.end = s.end;
    else merged.push(s);
  }
  return { ...project, speed: [...others, ...merged] };
}

// How the speed stretches inside a source range reach and leave their
// speed: { rampIn, rampOut } in seconds, 0 for at once; undefined puts that
// one back to the usual short ease.
export function setSpeedRamp(project, { source = 'main', start, end, rampIn, rampOut } = {}) {
  if (!project.sources[source]) fail(`Speed uses unknown recording ${JSON.stringify(source)}`);
  num(start, 'Speed start');
  num(end, 'Speed end');
  if (rampIn !== undefined) num(rampIn, 'Speed ramp in', 0, SPEED_RAMP_MAX);
  if (rampOut !== undefined) num(rampOut, 'Speed ramp out', 0, SPEED_RAMP_MAX);
  let touched = false;
  const speed = project.speed.map((s) => {
    if (s.source !== source || s.end <= start + 1e-6 || s.start >= end - 1e-6) return s;
    touched = true;
    const next = { ...s };
    if (rampIn === undefined) delete next.rampIn; else next.rampIn = rampIn;
    if (rampOut === undefined) delete next.rampOut; else next.rampOut = rampOut;
    return next;
  });
  if (!touched) fail('There is no speed change there to shape');
  return { ...project, speed };
}

// ---------------------------------------------------------------- annotations

const ANNOTATION_DEFAULTS = { x: 0.1, y: 0.1, w: 0.3, h: 0.15, x2: 0.4, y2: 0.25, text: '', color: '#ffffff', size: 1 };

export function addAnnotation(project, annotation) {
  if (!isObj(annotation)) fail('Annotation must be an object');
  const { source = 'main' } = annotation;
  const range = checkRange(project, source, annotation.start, annotation.end, 'Annotation');
  const a = validateAnnotation({
    ...ANNOTATION_DEFAULTS, ...annotation, id: nextId('a', project.annotations), source, ...range
  }, project.sources);
  return { ...project, annotations: [...project.annotations, a] };
}

export function updateAnnotation(project, id, patch) {
  const i = project.annotations.findIndex((a) => a.id === id);
  if (i < 0) fail(`No annotation ${JSON.stringify(id)}`);
  if (!isObj(patch) || 'id' in patch || 'source' in patch) fail('Invalid annotation change');
  const next = { ...project.annotations[i], ...patch };
  if ('start' in patch || 'end' in patch) Object.assign(next, checkRange(project, next.source, next.start, next.end, 'Annotation'));
  validateAnnotation(next, project.sources);
  const annotations = project.annotations.slice();
  annotations[i] = next;
  return { ...project, annotations };
}

export function removeAnnotation(project, id) {
  if (!project.annotations.some((a) => a.id === id)) fail(`No annotation ${JSON.stringify(id)}`);
  return { ...project, annotations: project.annotations.filter((a) => a.id !== id) };
}

// ---------------------------------------------------------------- settings

// Merges a (possibly nested) patch into a style. Only keys the style already
// has can be set, so a typo can't silently add a setting nothing reads.
// `background` is replaced whole: its value's shape depends on its type.
function mergeStyle(base, patch) {
  if (!isObj(patch)) fail('Style changes must be an object');
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in base)) fail(`Unknown style setting ${JSON.stringify(k)}`);
    if (k === 'background') out[k] = v;
    else if (isObj(base[k])) out[k] = mergeStyle(base[k], v);
    else out[k] = v;
  }
  return out;
}

export function setStyle(project, patch) {
  const style = validateStyle(mergeStyle(project.style, patch));
  return { ...project, style };
}

export function setTitle(project, title) {
  const t = str(typeof title === 'string' ? title.trim() : title, 'Title', { max: MAX_TITLE });
  return { ...project, title: t };
}

function mergeKnown(base, patch, what) {
  if (!isObj(patch)) fail(`${what} changes must be an object`);
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in base)) fail(`Unknown ${what.toLowerCase()} setting ${JSON.stringify(k)}`);
    out[k] = isObj(base[k]) && isObj(v) ? { ...base[k], ...v } : v;
  }
  return out;
}

// ---------------------------------------------------------------- overlays
//
// Pictures and videos on rows above the main video (layers/overlays.js).

export const OVERLAY_KINDS = ['image', 'video'];
const OVERLAY_ANIMATABLE = ['x', 'y', 'scale', 'rotate', 'opacity'];
const CLIP_ANIMATABLE = ['x', 'y', 'scale', 'rotate'];
// How long a new picture shows, in seconds.
const DEFAULT_PICTURE_SECONDS = 5;

function validateKeyframes(kf, allowed) {
  if (!isObj(kf)) fail('Keyframes must be an object');
  for (const [prop, list] of Object.entries(kf)) {
    if (!allowed.includes(prop)) fail(`${prop} can\u2019t be animated`);
    if (!Array.isArray(list) || list.length > 500) fail('Keyframes must be a list');
    let last = -Infinity;
    for (const k of list) {
      if (!isObj(k)) fail('A keyframe is not an object');
      num(k.t, 'Keyframe time', 0);
      num(k.v, 'Keyframe value', -360, 360);
      if (k.ease !== undefined) oneOf(k.ease, KEYFRAME_EASES, 'Keyframe easing');
      if (k.t < last) fail('Keyframes must be in time order');
      last = k.t;
    }
  }
}

export function defaultOverlay() {
  return {
    name: '', start: 0, from: 0, length: DEFAULT_PICTURE_SECONDS, fileDuration: null, lane: 0,
    x: 0.3, y: 0.3, scale: 0.35, rotate: 0, opacity: 1, fadeIn: 0, fadeOut: 0, keyframes: {},
    // A video file's own quarter turn (a phone video), as video-probe.js reads it.
    mediaRotation: 0,
    // Effects (overlay-effects.js): how it mixes with the video, a shape it
    // is cut to, a green screen.
    blend: 'normal', mask: defaultMask(), key: defaultKey()
  };
}

// An overlay's effects; every one optional (a project from before them).
function validateOverlayEffects(o) {
  if (o.blend !== undefined) oneOf(o.blend, OVERLAY_BLENDS, 'Blend');
  if (o.mask !== undefined) {
    if (!isObj(o.mask)) fail('An overlay\u2019s mask must be an object');
    if (o.mask.shape !== undefined) oneOf(o.mask.shape, MASK_SHAPES, 'Mask shape');
    if (o.mask.feather !== undefined) num(o.mask.feather, 'Mask edge softness', 0, 1);
  }
  if (o.key !== undefined) {
    if (!isObj(o.key)) fail('An overlay\u2019s green screen must be an object');
    if (o.key.on !== undefined) bool(o.key.on, 'Green screen on');
    if (o.key.color !== undefined && (typeof o.key.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(o.key.color))) {
      fail(`Green screen colour must be a colour like #00ff00, got ${JSON.stringify(o.key.color)}`);
    }
    if (o.key.tolerance !== undefined) num(o.key.tolerance, 'Green screen tolerance', 0, 1);
    if (o.key.softness !== undefined) num(o.key.softness, 'Green screen softness', 0, 1);
  }
}

function validateOverlay(o) {
  if (!isObj(o)) fail('An overlay is not an object');
  str(o.id, 'Overlay id', { max: 64 });
  oneOf(o.kind, OVERLAY_KINDS, 'Overlay kind');
  str(o.file, 'Overlay file', { max: 1024 });
  if (!/^media\/[^/\\]+$/.test(o.file) || o.file.includes('..')) fail('An overlay must be a file in the project\u2019s media folder');
  str(o.name, 'Overlay name', { empty: true, max: 300 });
  num(o.start, 'Overlay start', 0);
  num(o.from, 'Overlay start in its file', 0);
  num(o.length, 'Overlay length', MIN_CLIP_SECONDS);
  if (o.fileDuration !== null) num(o.fileDuration, 'Overlay file length', 0);
  if (!Number.isInteger(o.lane) || o.lane < 0 || o.lane >= MAX_LANES) fail(`Overlay row must be 0 to ${MAX_LANES - 1}`);
  num(o.x, 'Overlay x', -1.5, 1.5);
  num(o.y, 'Overlay y', -1.5, 1.5);
  num(o.scale, 'Overlay scale', 0.02, 5);
  num(o.rotate, 'Overlay rotation', -360, 360);
  num(o.opacity, 'Opacity', 0, 1);
  num(o.fadeIn, 'Overlay fade in', 0);
  num(o.fadeOut, 'Overlay fade out', 0);
  validateKeyframes(o.keyframes, OVERLAY_ANIMATABLE);
  if (![0, 90, 180, 270].includes(o.mediaRotation)) fail('An overlay\u2019s turn must be 0, 90, 180 or 270');
  validateOverlayEffects(o);
}

function overlayAt(project, id) {
  const i = project.overlays.findIndex((o) => o.id === id);
  if (i < 0) fail(`No overlay ${JSON.stringify(id)}`);
  return i;
}

const withOverlays = (project, overlays) => {
  overlays.forEach(validateOverlay);
  return { ...project, overlays };
};

// A picture (5 s) or video (its length) from the project's media folder at
// `start`, on the first overlay row where it fits, in the corner (a
// picture-in-picture) until moved.
export function addOverlay(project, { kind, file, name, start = 0, fileDuration = null, ...rest } = {}) {
  oneOf(kind, OVERLAY_KINDS, 'Overlay kind');
  const length = kind === 'video' && fileDuration > 0 ? fileDuration : DEFAULT_PICTURE_SECONDS;
  const o = {
    ...defaultOverlay(), length, ...rest, id: nextId('o', project.overlays), kind, file,
    name: name ?? String(file).split('/').pop().replace(/\.[^.]+$/, ''), start, fileDuration
  };
  validateOverlay(o);
  o.lane = freeLane(project.overlays, o.start, o.start + o.length, Infinity, {});
  if (o.lane < 0) fail(`Every overlay row is taken there (${MAX_LANES} rows)`);
  return withOverlays(project, [...project.overlays, o]);
}

// Moves, trims or changes one overlay; over another on its row, it goes to
// the first free row.
export function updateOverlay(project, id, patch) {
  const i = overlayAt(project, id);
  if (!isObj(patch) || 'id' in patch) fail('An overlay change must be an object without an id');
  const o = { ...project.overlays[i], ...patch };
  validateOverlay(o);
  o.lane = freeLane(project.overlays, o.start, o.start + o.length, Infinity, { prefer: o.lane, except: id });
  if (o.lane < 0) fail(`Every overlay row is taken there (${MAX_LANES} rows)`);
  const overlays = project.overlays.slice();
  overlays[i] = o;
  return withOverlays(project, overlays);
}

export function removeOverlay(project, id) {
  const i = overlayAt(project, id);
  return { ...project, overlays: project.overlays.filter((_, k) => k !== i) };
}

// A keyframe of an overlay's property at `t` seconds from its start.
export function setOverlayKeyframe(project, id, prop, t, v) {
  const i = overlayAt(project, id);
  if (!OVERLAY_ANIMATABLE.includes(prop)) fail(`${prop} can\u2019t be animated`);
  const o = project.overlays[i];
  if (t < -1e-6 || t > o.length + 1e-6) fail('Put the playhead over the overlay to set a keyframe');
  return updateOverlay(project, id, { keyframes: { ...o.keyframes, [prop]: setKeyframe(o.keyframes[prop], clamp(t, 0, o.length), v) } });
}

// How an overlay's property arrives at its keyframe at `t` (KEYFRAME_EASES).
export function setOverlayKeyframeEase(project, id, prop, t, ease) {
  oneOf(ease, KEYFRAME_EASES, 'Keyframe easing');
  const o = project.overlays[overlayAt(project, id)];
  if (!o.keyframes[prop]?.length) fail('There is no keyframe there');
  return updateOverlay(project, id, { keyframes: { ...o.keyframes, [prop]: setKeyframeEase(o.keyframes[prop], t, ease) } });
}

export function removeOverlayKeyframe(project, id, prop, t) {
  const o = project.overlays[overlayAt(project, id)];
  const list = removeKeyframe(o.keyframes[prop], t);
  const keyframes = { ...o.keyframes };
  if (list.length) keyframes[prop] = list;
  else delete keyframes[prop];
  return updateOverlay(project, id, { keyframes });
}

// A keyframe of a main clip's position or size at recording time `t`.
export function setClipKeyframe(project, clipId, prop, t, v) {
  const i = clipIndex(project, clipId);
  if (!CLIP_ANIMATABLE.includes(prop)) fail(`${prop} can\u2019t be animated`);
  const clip = project.clips[i];
  if (t < clip.start - 1e-6 || t > clip.end + 1e-6) fail('Put the playhead inside the clip to set a keyframe');
  const clips = project.clips.slice();
  clips[i] = { ...clip, keyframes: { ...(clip.keyframes ?? {}), [prop]: setKeyframe(clip.keyframes?.[prop], t, v) } };
  validateClip(clips[i], project.sources);
  return { ...project, clips };
}

export function setClipKeyframeEase(project, clipId, prop, t, ease) {
  oneOf(ease, KEYFRAME_EASES, 'Keyframe easing');
  const i = clipIndex(project, clipId);
  const clip = project.clips[i];
  if (!clip.keyframes?.[prop]?.length) fail('There is no keyframe there');
  const clips = project.clips.slice();
  clips[i] = { ...clip, keyframes: { ...clip.keyframes, [prop]: setKeyframeEase(clip.keyframes[prop], t, ease) } };
  validateClip(clips[i], project.sources);
  return { ...project, clips };
}

export function removeClipKeyframe(project, clipId, prop, t) {
  const i = clipIndex(project, clipId);
  const clip = project.clips[i];
  const list = removeKeyframe(clip.keyframes?.[prop], t);
  const keyframes = { ...(clip.keyframes ?? {}) };
  if (list.length) keyframes[prop] = list;
  else delete keyframes[prop];
  const clips = project.clips.slice();
  clips[i] = { ...clip, keyframes };
  return { ...project, clips };
}

// ---------------------------------------------------------------- markers
//
// A note on a moment of the video, as an editor's markers (M): output time,
// so it stays at that moment of the finished video. [{ id, t, label, color }]

export const MARKER_COLORS = ['yellow', 'red', 'green', 'blue', 'purple'];

function validateMarker(m) {
  if (!isObj(m)) fail('A marker is not an object');
  str(m.id, 'Marker id', { max: 64 });
  num(m.t, 'Marker time', 0);
  str(m.label, 'Marker name', { empty: true, max: 200 });
  oneOf(m.color, MARKER_COLORS, 'Marker colour');
}

const sortedMarkers = (markers) => [...markers].sort((a, b) => a.t - b.t);

export function addMarker(project, { t, label = '', color = 'yellow' } = {}) {
  const marker = { id: nextId('m', project.markers), t, label, color };
  validateMarker(marker);
  if (project.markers.some((m) => Math.abs(m.t - t) < 1e-3)) fail('There\u2019s already a marker there');
  return { ...project, markers: sortedMarkers([...project.markers, marker]) };
}

export function updateMarker(project, id, patch) {
  const i = project.markers.findIndex((m) => m.id === id);
  if (i < 0) fail(`No marker ${JSON.stringify(id)}`);
  if (!isObj(patch) || 'id' in patch) fail('A marker change must be an object without an id');
  const marker = { ...project.markers[i], ...patch };
  validateMarker(marker);
  const markers = project.markers.slice();
  markers[i] = marker;
  return { ...project, markers: sortedMarkers(markers) };
}

export function removeMarker(project, id) {
  if (!project.markers.some((m) => m.id === id)) fail(`No marker ${JSON.stringify(id)}`);
  return { ...project, markers: project.markers.filter((m) => m.id !== id) };
}

// ---------------------------------------------------------------- audio clips

function audioClipAt(project, id) {
  const i = project.audio.clips.findIndex((c) => c.id === id);
  if (i < 0) fail(`No audio clip ${JSON.stringify(id)}`);
  return i;
}

function withAudioClips(project, clips) {
  const audio = { ...project.audio, clips };
  validateAudio(audio, project.sources);
  return { ...project, audio };
}

const lockedLanes = (project) => new Set(Array.from({ length: MAX_LANES }, (_, i) => i).filter((i) => laneOf(project.audio, i).locked));

function unlocked(project, clip) {
  if (laneOf(project.audio, clip.lane).locked) fail(`Audio row ${clip.lane + 1} is locked. Unlock it to change its clips.`);
}

// The row `clip` goes on among `others`: its own (or `prefer`) when free.
function laneFor(others, clip, duration, prefer = clip.lane, locked = new Set()) {
  const lane = freeLane(others, clip.start, clipEnd(clip, duration), duration, { prefer, except: clip.id, locked });
  if (lane < 0) fail(`Every audio row is taken there (${MAX_LANES} rows). Move a clip or delete one first.`);
  return lane;
}

// A song or sound file (already in the project's music/ folder) at `start`,
// on the first audio row where it fits.
export function addAudioClip(project, { file, name, start = 0, fileDuration = null, ...rest } = {}) {
  const duration = buildTimeline(project).duration;
  const clip = {
    ...defaultAudioClip(), ...rest, id: nextId('a', project.audio.clips), file,
    name: name ?? audioName(file), start, fileDuration
  };
  validateAudioClip({ ...clip, lane: 0 }, project.sources);
  clip.lane = laneFor(project.audio.clips, clip, duration, null, lockedLanes(project));
  return withAudioClips(project, [...project.audio.clips, clip]);
}

// Moves, trims or changes one clip. A clip moved or lengthened over another
// on its row goes to the first free row (as in CapCut); `lane` in the patch
// is the row it was dropped on.
export function updateAudioClip(project, id, patch) {
  const i = audioClipAt(project, id);
  if (!isObj(patch)) fail('An audio change must be an object');
  if ('id' in patch) fail('An audio clip\u2019s id can\'t be changed');
  unlocked(project, project.audio.clips[i]);
  const clip = { ...project.audio.clips[i], ...patch };
  if (Array.isArray(clip.points)) clip.points = [...clip.points].sort((a, b) => a?.t - b?.t);
  validateAudioClip(clip, project.sources);
  const duration = buildTimeline(project).duration;
  clip.lane = laneFor(project.audio.clips, clip, duration, clip.lane, lockedLanes(project));
  const clips = project.audio.clips.slice();
  clips[i] = clip;
  return withAudioClips(project, clips);
}

export function removeAudioClip(project, id) {
  const i = audioClipAt(project, id);
  unlocked(project, project.audio.clips[i]);
  return withAudioClips(project, project.audio.clips.filter((_, k) => k !== i));
}

// Splits a clip at output time `outT` into two that play on from each other:
// the first keeps the fade in, the second the fade out.
export function splitAudioClip(project, id, outT) {
  num(outT, 'Split time');
  const i = audioClipAt(project, id);
  const clip = project.audio.clips[i];
  unlocked(project, clip);
  const duration = buildTimeline(project).duration;
  const end = clipEnd(clip, duration);
  if (outT <= clip.start || outT >= end) fail('Put the playhead inside the audio clip to split it');
  const delta = outT - clip.start;
  if (delta < MIN_AUDIO_SECONDS || end - outT < MIN_AUDIO_SECONDS) fail('Too close to the edge of the audio clip to split');
  // A repeating clip's second half carries on from the same point of the file.
  const span = clip.fileDuration > 0 ? clip.fileDuration - clip.from : null;
  const from = clip.from + (clip.loop && span > 0 ? delta % span : delta);
  const [before, after] = splitPoints(clip.points, delta);
  const first = { ...clip, length: delta, fadeOut: 0, fadeIn: Math.min(clip.fadeIn, delta), points: before };
  const second = {
    ...clip, id: nextId('a', project.audio.clips), start: outT, from,
    length: clip.length === null ? null : clip.length - delta, fadeIn: 0,
    fadeOut: Math.min(clip.fadeOut, end - outT), points: after
  };
  const clips = project.audio.clips.slice();
  clips.splice(i, 1, first, second);
  return withAudioClips(project, clips);
}

// A copy right after the original, on its row when there is room.
export function duplicateAudioClip(project, id) {
  const clip = project.audio.clips[audioClipAt(project, id)];
  const duration = buildTimeline(project).duration;
  const copy = { ...clip, id: nextId('a', project.audio.clips), start: clipEnd(clip, duration) };
  copy.lane = laneFor(project.audio.clips, copy, duration, clip.lane, lockedLanes(project));
  return withAudioClips(project, [...project.audio.clips, copy]);
}

// A row's mute / solo / lock: setAudioLane(p, 1, { solo: true }).
export function setAudioLane(project, lane, patch) {
  if (!Number.isInteger(lane) || lane < 0 || lane >= MAX_LANES) fail(`There is no audio row ${JSON.stringify(lane)}`);
  if (!isObj(patch)) fail('A row change must be an object');
  for (const k of Object.keys(patch)) if (!['muted', 'solo', 'locked'].includes(k)) fail(`Unknown audio row setting ${JSON.stringify(k)}`);
  const lanes = Array.from({ length: Math.max(project.audio.lanes.length, lane + 1) }, (_, i) => project.audio.lanes[i] ?? null);
  lanes[lane] = { ...laneOf(project.audio, lane), ...patch };
  const audio = { ...project.audio, lanes };
  validateAudio(audio, project.sources);
  return { ...project, audio };
}

// ---- detach audio: a video clip's own sound as an audio clip

// Why clip i's sound can't be detached, or null. Its sound must play at the
// recording's own speed: stretched sound would drift from a detached copy.
function detachProblem(project, tl, i) {
  const clip = project.clips[i];
  if (clip.detached) return 'That clip\u2019s sound is already detached';
  const meta = project.sources[clip.source];
  if (!meta.mic && !meta.systemAudio) return 'That clip has no sound to detach';
  const b = tl.clipBounds()[i];
  if (Math.abs((b.outEnd - b.outStart) - (clip.end - clip.start)) > 1e-6) {
    return 'That clip has a speed change, so its sound can\u2019t be detached yet';
  }
  return null;
}

function detachOne(project, tl, i, duration) {
  const clip = project.clips[i];
  const b = tl.clipBounds()[i];
  const meta = project.sources[clip.source];
  const sound = {
    ...defaultAudioClip(), id: nextId('a', project.audio.clips), file: null, source: clip.source,
    name: project.clips.length > 1 ? `Clip ${i + 1} sound` : 'Video sound',
    start: b.outStart, from: clip.start, length: clip.end - clip.start, fileDuration: meta.duration,
    volume: 1, duck: false
  };
  sound.lane = laneFor(project.audio.clips, sound, duration, null, lockedLanes(project));
  const clips = project.clips.slice();
  clips[i] = { ...clip, detached: true };
  return { ...project, clips, audio: { ...project.audio, clips: [...project.audio.clips, sound] } };
}

// Clip `clipId`'s sound leaves the video and becomes an audio clip on the
// first free row, at the same moment: move it, trim it, change it, or
// delete it to keep only the music.
export function detachAudio(project, clipId) {
  const i = clipIndex(project, clipId);
  const tl = buildTimeline(project);
  const problem = detachProblem(project, tl, i);
  if (problem) fail(problem);
  return validateProject(detachOne(project, tl, i, tl.duration));
}

// Every clip's sound that can be detached (speed-changed parts stay).
export function detachAllAudio(project) {
  const tl = buildTimeline(project);
  let p = project;
  project.clips.forEach((_, i) => {
    if (!detachProblem(p, tl, i)) p = detachOne(p, tl, i, tl.duration);
  });
  return p === project ? project : validateProject(p);
}

// A detached sound back on its video: the audio clip goes, and the video
// clips it came from play their own sound again.
export function reattachAudio(project, audioClipId) {
  const i = audioClipAt(project, audioClipId);
  const sound = project.audio.clips[i];
  if (!sound.source) fail('That audio isn\u2019t sound from the video');
  unlocked(project, sound);
  const to = sound.from + (sound.length ?? 0);
  const clips = project.clips.map((c) => (c.detached && c.source === sound.source && c.start < to - 1e-6 && c.end > sound.from + 1e-6
    ? { ...c, detached: false } : c));
  return validateProject({
    ...project, clips, audio: { ...project.audio, clips: project.audio.clips.filter((_, k) => k !== i) }
  });
}

export { clipLength as audioClipLength, clipEnd as audioClipEnd, laneOf as audioLaneOf };
export { clipGainAt as audioClipGainAt } from './audio/clips.js';

// Patch the audio settings: { mic: {volume: 0.5} }, { clips: [...] }, a new
// voiceover list, ...
export function setAudio(project, patch) {
  const audio = validateAudio(mergeKnown(project.audio, patch, 'Audio'), project.sources);
  return { ...project, audio };
}

export function setCaptions(project, patch) {
  const captions = validateCaptions(mergeKnown(project.captions, patch, 'Captions'), project.sources);
  return { ...project, captions };
}

export function setExport(project, patch) {
  const exp = validateExport(mergeKnown(project.export, patch, 'Export'));
  return { ...project, export: exp };
}

// Sets (or with type null, removes) the transition after a clip.
export function setTransition(project, afterClipId, type, duration = 0.5) {
  clipIndex(project, afterClipId);
  const rest = project.transitions.filter((t) => t.after !== afterClipId);
  if (type === null) return { ...project, transitions: rest };
  const t = validateTransition({ after: afterClipId, type, duration }, project.clips);
  return { ...project, transitions: [...rest, t] };
}
