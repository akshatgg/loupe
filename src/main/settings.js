'use strict';

const fs = require('node:fs');
const path = require('node:path');

// User preferences that outlive a session, stored as JSON in Electron's
// userData directory (main.js supplies the path). Today that's only the zoom
// shortcuts: two slots, each a button you hold while scrolling to zoom (or
// null for an empty slot). The picker sets them by "press the button you
// want" -- only holdable buttons are offered, since a letter key held as a
// zoom shortcut would type into whatever is being recorded.
const ZOOM_TRIGGERS = ['option', 'control', 'command', 'shift', 'mouse-side', 'mouse-middle'];
const MODIFIERS = ['option', 'control', 'command', 'shift'];

const DEFAULT_SETTINGS = Object.freeze({ zoomTriggers: Object.freeze(['option', 'mouse-side']) });

function validTriggers(v) {
  return Array.isArray(v) && v.length === 2
    && v.every((t) => t === null || ZOOM_TRIGGERS.includes(t))
    && !(v[0] !== null && v[0] === v[1]);
}

const VALIDATORS = { zoomTriggers: validTriggers };

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

// Reading is forgiving -- a hand-edited, older or corrupt file falls back to
// the defaults -- because a bad settings file must never stop Loupe from
// recording.
function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const triggers = validTriggers(src.zoomTriggers) ? src.zoomTriggers : fromLegacy(src);
  return { zoomTriggers: [...(triggers ?? DEFAULT_SETTINGS.zoomTriggers)] };
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

// Writing from the renderer is strict, unlike reading: the picker only ever
// sends known keys with valid values, so anything else is a bug (or a hostile
// renderer) and is refused rather than quietly coerced.
function applySettingsPatch(current, patch) {
  if (!patch || typeof patch !== 'object') {
    throw new Error(`Invalid settings patch: ${JSON.stringify(patch)}`);
  }
  for (const [key, value] of Object.entries(patch)) {
    const valid = VALIDATORS[key];
    if (!valid) throw new Error(`Unknown setting: ${JSON.stringify(key)}`);
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
  ZOOM_TRIGGERS, DEFAULT_SETTINGS,
  loadSettings, saveSettings, applySettingsPatch, inputTapArgs
};
