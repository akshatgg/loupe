'use strict';

const crypto = require('node:crypto');
const { cleanStyle, cleanName, MAX_PRESETS, PRESET_ID_RE } = require('./settings');

// Style presets: a named copy of a project's `style` (docs/EDITOR-V2.md
// section 3), kept in settings.presets so they work across recordings, plus
// an optional default that new recordings start with.
//
// Everything here is pure: each operation takes the current settings and
// returns { patch, result }, where `patch` goes to the settings store as a
// trusted patch. The IPC layer (ipc/presets.js) does the storing.

const newId = () => `p_${crypto.randomBytes(6).toString('hex')}`;

function requireId(id) {
  if (typeof id !== 'string' || !PRESET_ID_RE.test(id)) {
    throw new Error(`Invalid preset id: ${JSON.stringify(id)}`);
  }
  return id;
}

function requireName(name) {
  const clean = cleanName(name);
  if (!clean) throw new Error('A preset needs a name (up to 80 characters).');
  return clean;
}

function requireStyle(style) {
  const clean = cleanStyle(style);
  if (!clean) throw new Error('That style could not be saved.');
  return clean;
}

function listPresets(settings) {
  return { presets: settings.presets, defaultPresetId: settings.defaultPresetId };
}

// Saves a new preset, or -- given the id of an existing one -- replaces its
// style (and name, if one is given). A new preset whose name matches an
// existing one gets " 2", " 3"... so the list never shows two identical names.
function savePreset(settings, { id, name, style } = {}, makeId = newId) {
  const cleanStyleValue = requireStyle(style);
  const presets = settings.presets.map((p) => ({ ...p }));
  if (id !== undefined && id !== null) {
    requireId(id);
    const existing = presets.find((p) => p.id === id);
    if (!existing) throw new Error('That preset no longer exists.');
    if (name !== undefined) existing.name = requireName(name);
    existing.style = cleanStyleValue;
    return { patch: { presets }, result: existing };
  }
  if (presets.length >= MAX_PRESETS) throw new Error(`You can keep up to ${MAX_PRESETS} presets.`);
  const base = requireName(name);
  const names = new Set(presets.map((p) => p.name));
  let unique = base;
  for (let n = 2; names.has(unique); n++) unique = `${base} ${n}`;
  const preset = { id: makeId(), name: unique, style: cleanStyleValue };
  presets.push(preset);
  return { patch: { presets }, result: preset };
}

function renamePreset(settings, { id, name } = {}) {
  requireId(id);
  const clean = requireName(name);
  let found = null;
  const presets = settings.presets.map((p) => {
    if (p.id !== id) return p;
    found = { ...p, name: clean };
    return found;
  });
  if (!found) throw new Error('That preset no longer exists.');
  return { patch: { presets }, result: found };
}

function deletePreset(settings, id) {
  requireId(id);
  const presets = settings.presets.filter((p) => p.id !== id);
  const patch = { presets };
  if (settings.defaultPresetId === id) patch.defaultPresetId = null;
  return { patch, result: presets.length !== settings.presets.length };
}

function setDefaultPreset(settings, id) {
  if (id !== null) {
    requireId(id);
    if (!settings.presets.some((p) => p.id === id)) throw new Error('That preset no longer exists.');
  }
  return { patch: { defaultPresetId: id }, result: id };
}

// The style to apply for a preset, as a fresh copy the caller may change.
function presetStyle(settings, id) {
  requireId(id);
  const preset = settings.presets.find((p) => p.id === id);
  if (!preset) throw new Error('That preset no longer exists.');
  return JSON.parse(JSON.stringify(preset.style));
}

// What a brand-new recording's style should start from: the default preset's
// style, or null for "the project defaults".
function defaultPresetStyle(settings) {
  const preset = settings.presets.find((p) => p.id === settings.defaultPresetId);
  return preset ? JSON.parse(JSON.stringify(preset.style)) : null;
}

module.exports = {
  listPresets, savePreset, renamePreset, deletePreset, setDefaultPreset,
  presetStyle, defaultPresetStyle
};
