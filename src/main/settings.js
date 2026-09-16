'use strict';

const fs = require('node:fs');
const path = require('node:path');

// User preferences that outlive a session, stored as JSON in Electron's
// userData directory (main.js supplies the path).
//
// Zoom shortcuts: two slots, each a button you hold while scrolling to zoom
// (or null for an empty slot). The picker and the Settings window set them by
// "press the button you want" -- only holdable buttons are offered, since a
// letter key held as a zoom shortcut would type into whatever is being
// recorded.
//
// Everything else belongs to the Settings window (src/renderer/settings) and
// the features that read it: the recorder (countdown, devices, system audio,
// keystrokes), the exporter (exportDefaults), updates.js, diagnostics.js and
// the editor's Style panel (presets).
const ZOOM_TRIGGERS = ['option', 'control', 'command', 'shift', 'mouse-side', 'mouse-middle'];
const MODIFIERS = ['option', 'control', 'command', 'shift'];

const EXPORT_FORMATS = ['mp4', 'webm', 'gif'];
const EXPORT_RESOLUTIONS = ['720p', '1080p', '1440p', '4k'];
const EXPORT_QUALITIES = ['high', 'balanced', 'small'];

// The top-level keys of project.style (docs/EDITOR-V2.md section 3) a preset
// may carry. Anything else in a saved style is dropped rather than stored.
const STYLE_KEYS = ['background', 'padding', 'radius', 'shadow', 'aspect', 'cursor', 'keystrokes', 'webcam'];
const MAX_PRESETS = 100;
const MAX_NAME = 80;
const MAX_STYLE_BYTES = 64 * 1024;

const DEFAULT_SETTINGS = deepFreeze({
  zoomTriggers: ['option', 'mouse-side'],
  // null = the platform default (~/Movies/Loupe, Videos\Loupe).
  recordingsFolder: null,
  countdown: true,
  openAtLogin: false,
  // A chosen device is kept as its browser deviceId plus its label: the id
  // is what getUserMedia wants, the label is what survives the id changing
  // (and what a native helper can match on). null = the system default.
  microphone: null,
  camera: null,
  systemAudio: false,
  showKeystrokes: false,
  exportDefaults: { format: 'mp4', resolution: '1080p', quality: 'balanced' },
  checkForUpdates: true,
  lastUpdateCheck: 0,       // ms; written by updates.js, not the renderer
  lastNotifiedVersion: null, // the newest version we already told the user about
  saveCrashReports: true,
  presets: [],              // [{ id, name, style }]
  defaultPresetId: null
});

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isBool = (v) => typeof v === 'boolean';

function validTriggers(v) {
  return Array.isArray(v) && v.length === 2
    && v.every((t) => t === null || ZOOM_TRIGGERS.includes(t))
    && !(v[0] !== null && v[0] === v[1]);
}

function validDevice(v) {
  return v === null || (isPlainObject(v) && Object.keys(v).length === 2
    && typeof v.id === 'string' && v.id.length > 0 && v.id.length <= 512
    && typeof v.label === 'string' && v.label.length <= 512);
}

function validExportDefaults(v) {
  return isPlainObject(v) && Object.keys(v).length === 3
    && EXPORT_FORMATS.includes(v.format)
    && EXPORT_RESOLUTIONS.includes(v.resolution)
    && EXPORT_QUALITIES.includes(v.quality);
}

// An absolute path, or null for the default. Only main.js's folder chooser
// sets this (the renderer can't type one in), but a hand-edited file might.
function validFolder(v) {
  return v === null || (typeof v === 'string' && v.length > 0 && v.length < 4096
    && path.isAbsolute(v) && !v.includes('\0'));
}

// Only JSON values, bounded in depth -- a style is data the compositor reads,
// so there is never a reason for it to hold anything else.
function jsonOnly(v, depth = 0) {
  if (depth > 6) return false;
  if (v === null || typeof v === 'string' || isBool(v)) return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length <= 64 && v.every((x) => jsonOnly(x, depth + 1));
  if (isPlainObject(v)) return Object.values(v).every((x) => jsonOnly(x, depth + 1));
  return false;
}

// Keeps the known style keys and refuses anything that isn't plain JSON or is
// implausibly large. Returns the cleaned style, or null when it isn't one.
function cleanStyle(style) {
  if (!isPlainObject(style)) return null;
  const out = {};
  for (const key of STYLE_KEYS) if (key in style) out[key] = style[key];
  if (!jsonOnly(out)) return null;
  const json = JSON.stringify(out);
  if (json.length > MAX_STYLE_BYTES) return null;
  return JSON.parse(json);
}

function cleanName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return trimmed.length > 0 && trimmed.length <= MAX_NAME ? trimmed : null;
}

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function cleanPresets(v) {
  if (!Array.isArray(v)) return null;
  const seen = new Set();
  const out = [];
  for (const p of v.slice(0, MAX_PRESETS)) {
    if (!isPlainObject(p) || typeof p.id !== 'string' || !PRESET_ID_RE.test(p.id) || seen.has(p.id)) continue;
    const name = cleanName(p.name);
    const style = cleanStyle(p.style);
    if (!name || !style) continue;
    seen.add(p.id);
    out.push({ id: p.id, name, style });
  }
  return out;
}

// Per key: is a stored value acceptable. Reading keeps every valid key and
// defaults the rest, so one bad value never costs the user their other
// settings -- and a file from an older version (only zoomTriggers, say)
// simply gains the new keys at their defaults.
const VALIDATORS = {
  zoomTriggers: validTriggers,
  recordingsFolder: validFolder,
  countdown: isBool,
  openAtLogin: isBool,
  microphone: validDevice,
  camera: validDevice,
  systemAudio: isBool,
  showKeystrokes: isBool,
  exportDefaults: validExportDefaults,
  checkForUpdates: isBool,
  lastUpdateCheck: (v) => Number.isFinite(v) && v >= 0,
  lastNotifiedVersion: (v) => v === null || (typeof v === 'string' && v.length <= 64),
  saveCrashReports: isBool,
  presets: (v) => Array.isArray(v),
  defaultPresetId: (v) => v === null || (typeof v === 'string' && PRESET_ID_RE.test(v))
};

// What a renderer may change through settings:set. The rest have their own
// narrower channels -- the recordings folder only through the folder chooser,
// presets through presets:*, update bookkeeping only from updates.js -- so a
// renderer can't point recordings at an arbitrary path or corrupt presets.
const RENDERER_KEYS = [
  'zoomTriggers', 'countdown', 'openAtLogin', 'microphone', 'camera', 'systemAudio',
  'showKeystrokes', 'exportDefaults', 'checkForUpdates', 'saveCrashReports'
];

// The first version of this setting (a key dropdown plus a side-button
// switch) stored {zoomModifier, zoomSideButton}; carry that choice over.
function fromLegacy(src) {
  if (!('zoomModifier' in src) && !('zoomSideButton' in src)) return null;
  let key = 'option';
  if (MODIFIERS.includes(src.zoomModifier)) key = src.zoomModifier;
  else if (src.zoomModifier === 'none') key = null;
  const side = typeof src.zoomSideButton === 'boolean' ? src.zoomSideButton : true;
  return [key, side ? 'mouse-side' : null];
}

const copy = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

// Reading is forgiving -- a hand-edited, older or corrupt file falls back to
// the defaults key by key -- because a bad settings file must never stop
// Loupe from recording.
function normalizeSettings(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    out[key] = key in src && VALIDATORS[key](src[key]) ? copy(src[key]) : copy(fallback);
  }
  if (!validTriggers(src.zoomTriggers)) {
    out.zoomTriggers = fromLegacy(src) ?? [...DEFAULT_SETTINGS.zoomTriggers];
  }
  out.presets = cleanPresets(out.presets);
  // A default that points at a deleted preset means "no default".
  if (!out.presets.some((p) => p.id === out.defaultPresetId)) out.defaultPresetId = null;
  return out;
}

function loadSettings(file) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return normalizeSettings(null);
  }
}

// Write-then-rename, so a crash mid-write can't leave a truncated file.
function saveSettings(file, settings) {
  const clean = normalizeSettings(settings);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, file);
  return clean;
}

// Writing from a renderer is strict, unlike reading: the picker and Settings
// window only ever send known keys with valid values, so anything else is a
// bug (or a hostile renderer) and is refused rather than quietly coerced.
// `trusted` is for main-process callers (the folder chooser, updates.js,
// presets), which may set any key.
function applySettingsPatch(current, patch, { trusted = false } = {}) {
  if (!isPlainObject(patch)) {
    throw new Error(`Invalid settings patch: ${JSON.stringify(patch)}`);
  }
  for (const [key, value] of Object.entries(patch)) {
    const valid = VALIDATORS[key];
    if (!valid || (!trusted && !RENDERER_KEYS.includes(key))) {
      throw new Error(`Unknown setting: ${JSON.stringify(key)}`);
    }
    if (!valid(value)) throw new Error(`Invalid value for ${key}: ${JSON.stringify(value)}`);
  }
  return normalizeSettings({ ...current, ...patch });
}

// Always passed, even when empty: bin/inputtap treats a missing flag as the
// original Option-only default, while "" means "no zoom shortcuts".
function inputTapArgs(settings) {
  return ['--zoom-triggers', settings.zoomTriggers.filter(Boolean).join(',')];
}

module.exports = {
  ZOOM_TRIGGERS, DEFAULT_SETTINGS, RENDERER_KEYS, STYLE_KEYS,
  EXPORT_FORMATS, EXPORT_RESOLUTIONS, EXPORT_QUALITIES, MAX_PRESETS, PRESET_ID_RE,
  loadSettings, saveSettings, applySettingsPatch, inputTapArgs,
  normalizeSettings, cleanStyle, cleanName
};
