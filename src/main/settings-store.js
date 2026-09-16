'use strict';

const { loadSettings, saveSettings, applySettingsPatch } = require('./settings');

// The one in-memory copy of settings.json for the whole main process. The
// picker, the Settings window, presets, updates and the recorder all read and
// write through it, so a change made in one window is what the next reader
// sees -- and every change is announced (onChange) so open windows can
// refresh instead of showing a stale value.
//
// `file` is a function because Electron's userData path can only be asked
// for once the app module is loaded, and tests pass a temp file.
function createSettingsStore({ file }) {
  let current = null;
  const listeners = new Set();

  function get() {
    if (!current) current = loadSettings(file());
    return current;
  }

  // Throws on an invalid patch (see applySettingsPatch), leaving the stored
  // settings untouched.
  function patch(changes, { trusted = false } = {}) {
    const before = get();
    current = saveSettings(file(), applySettingsPatch(before, changes, { trusted }));
    for (const fn of listeners) {
      try {
        fn(current, before);
      } catch (err) {
        console.error('Loupe: a settings listener failed:', err);
      }
    }
    return current;
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { get, patch, onChange };
}

module.exports = { createSettingsStore };
