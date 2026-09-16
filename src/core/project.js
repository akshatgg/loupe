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

export const VERSION = 2;
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 8;
export const ZOOM_LEVEL_MIN = 1;
export const ZOOM_LEVEL_MAX = 8;
// Shorter than this and a clip, zoom or speed stretch can't be grabbed in
// the timeline (and a clip that short is a single frame or two anyway).
export const MIN_CLIP_SECONDS = 0.1;
export const MIN_RANGE_SECONDS = 0.1;
// A cut that leaves less than this of a clip takes the rest with it.
const MIN_KEEP_SECONDS = 0.01;
// v1 recorded a zoom keyframe on every scroll tick; a stretch whose zoom
// never got past this was a nudge of the wheel, not a zoom anyone meant.
export const RECORDED_ZOOM_THRESHOLD = 1.05;

export const ASPECTS = ['source', '16:9', '9:16', '1:1', '4:5'];
export const BACKGROUND_TYPES = ['none', 'color', 'gradient', 'image'];
export const HIGHLIGHTS = ['none', 'spotlight', 'ring'];
export const ANNOTATION_TYPES = ['text', 'title', 'arrow', 'box', 'blur'];
export const TRANSITION_TYPES = ['fade', 'crossfade', 'dip'];
export const EXPORT_FORMATS = ['mp4', 'webm', 'gif'];
export const EXPORT_RESOLUTIONS = ['720p', '1080p', '1440p', '4k'];
export const EXPORT_QUALITIES = ['high', 'balanced', 'small'];
export const EXPORT_CODECS = ['h264', 'hevc'];
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
    music: null,
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
  return { format: 'mp4', resolution: '1080p', quality: 'balanced', fps: 60, codec: 'h264' };
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
        id: nextId('z', zooms), source: 'main', start: open.start, end, level: open.level,
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
  const exp = v1.export ?? {};
  const project = {
    version: VERSION,
    title: defaultTitle(createdAt),
    createdAt,
    sources: { main },
    clips: [{ id: 'c1', source: 'main', start: 0, end: duration }],
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
      }
    },
    annotations: [],
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
  return validateProject(project);
}

// Whatever is in project.json -> a valid v2 project, or a thrown Error.
export function loadProjectData(raw, options) {
  if (!isObj(raw)) fail('project.json is not a project');
  if (raw.version === 1) return migrate(raw, options);
  if (raw.version === VERSION) return validateProject(raw);
  fail(`This project was made by a newer version of Loupe (format ${JSON.stringify(raw.version)})`);
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
  return clip;
}

function validateSpeedSegment(s, sources) {
  if (!sources[s?.source]) fail(`Speed uses unknown source ${JSON.stringify(s?.source)}`);
  num(s.start, 'Speed start', 0);
  num(s.end, 'Speed end', 0);
  num(s.rate, 'Speed', SPEED_MIN, SPEED_MAX);
  if (s.end <= s.start) fail('A speed stretch ends before it starts');
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

function validateAudio(audio, sources) {
  if (!isObj(audio)) fail('Audio settings must be an object');
  const { mic, system, music, voiceover } = audio;
  if (!isObj(mic)) fail('Microphone settings must be an object');
  num(mic.volume, 'Microphone volume', 0, 2);
  bool(mic.muted, 'Microphone muted');
  bool(mic.cleanUp, 'Clean up microphone');
  bool(mic.level, 'Even out microphone volume');
  if (!isObj(system)) fail('System audio settings must be an object');
  num(system.volume, 'System audio volume', 0, 2);
  bool(system.muted, 'System audio muted');
  if (music !== null) {
    if (!isObj(music)) fail('Music must be an object');
    str(music.file, 'Music file', { max: 4096 });
    num(music.volume, 'Music volume', 0, 2);
    bool(music.duck, 'Lower music under speech');
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
    title: typeof p.title === 'string' ? p.title : 'Recording',
    createdAt: isNum(p.createdAt) ? p.createdAt : null,
    sources,
    speed: p.speed ?? [],
    zooms: p.zooms ?? [],
    style: p.style ? mergeStyle(defaultStyle(), p.style) : defaultStyle(),
    annotations: p.annotations ?? [],
    transitions: p.transitions ?? [],
    audio: p.audio ? { ...defaultAudio(), ...p.audio } : defaultAudio(),
    captions: p.captions ? mergeCaptions(p.captions) : defaultCaptions(),
    export: p.export ? { ...defaultExport(), ...p.export } : defaultExport()
  };
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

// Splits the clip playing at output time `outT` in two. Splitting within
// MIN_CLIP_SECONDS of either end of a clip would leave a sliver; refused.
export function splitAt(project, outT) {
  num(outT, 'Split time');
  const tl = buildTimeline(project);
  if (outT <= 0 || outT >= tl.duration) fail('Pick a moment inside the video to split');
  const at = tl.toSource(outT);
  const clip = project.clips[at.clipIndex];
  if (at.t - clip.start < MIN_CLIP_SECONDS || clip.end - at.t < MIN_CLIP_SECONDS) {
    fail('Too close to the edge of a clip to split');
  }
  const clips = project.clips.slice();
  const second = { ...clip, id: nextId('c', project.clips), start: at.t };
  clips.splice(at.clipIndex, 1, { ...clip, end: at.t }, second);
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
  project.clips.forEach((clip, i) => {
    const { outStart: cs, outEnd: ce } = bounds[i];
    if (ce <= a + 1e-9 || cs >= b - 1e-9) { clips.push(clip); return; }
    // Output times strictly inside this clip map back into it (the timeline
    // is half-open), so a and b give the exact source moments of the cut.
    const keepBefore = a - cs >= MIN_KEEP_SECONDS;
    const keepAfter = ce - b >= MIN_KEEP_SECONDS;
    if (keepBefore) clips.push({ ...clip, end: tl.toSource(a).t });
    if (keepAfter) {
      const piece = { ...clip, start: tl.toSource(b).t, id: keepBefore ? nextId('c', ids) : clip.id };
      ids.push(piece);
      clips.push(piece);
    }
  });
  if (!clips.length) fail('Can\u2019t cut the whole video');
  return withClips(project, clips);
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

export function deleteClip(project, clipId) {
  const i = clipIndex(project, clipId);
  if (project.clips.length === 1) fail('A video needs at least one clip');
  return withClips(project, project.clips.filter((_, k) => k !== i));
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

const ZOOM_PATCH_KEYS = ['start', 'end', 'level', 'follow', 'x', 'y'];

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
    if (prev && prev.rate === s.rate && s.start - prev.end <= 1e-6) prev.end = s.end;
    else merged.push(s);
  }
  return { ...project, speed: [...others, ...merged] };
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
  const t = str(typeof title === 'string' ? title.trim() : title, 'Title', { max: 200 });
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

// Patch the audio settings: { mic: {volume: 0.5} }, { music: null }, a new
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
