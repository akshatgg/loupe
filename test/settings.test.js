'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_SETTINGS, RENDERER_KEYS, loadSettings, saveSettings, applySettingsPatch, inputTapArgs
} = require('../src/main/settings');
const { createSettingsStore } = require('../src/main/settings-store');

const made = [];
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-settings-'));
  made.push(dir);
  return path.join(dir, 'settings.json');
}
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const withTriggers = (zoomTriggers) => ({ ...DEFAULT_SETTINGS, zoomTriggers });

test('defaults: two zoom shortcuts, Option and a mouse side button', () => {
  assert.deepStrictEqual(DEFAULT_SETTINGS.zoomTriggers, ['option', 'mouse-side']);
});

test('defaults for everything else are the quiet, safe choices', () => {
  assert.strictEqual(DEFAULT_SETTINGS.recordingsFolder, null);
  assert.strictEqual(DEFAULT_SETTINGS.countdown, true);
  assert.strictEqual(DEFAULT_SETTINGS.openAtLogin, false);
  assert.strictEqual(DEFAULT_SETTINGS.microphone, null);
  assert.strictEqual(DEFAULT_SETTINGS.camera, null);
  assert.strictEqual(DEFAULT_SETTINGS.systemAudio, false);
  assert.strictEqual(DEFAULT_SETTINGS.showKeystrokes, false);
  assert.deepStrictEqual(DEFAULT_SETTINGS.exportDefaults, { format: 'mp4', resolution: '1080p', quality: 'balanced' });
  assert.strictEqual(DEFAULT_SETTINGS.checkForUpdates, true);
  assert.strictEqual(DEFAULT_SETTINGS.saveCrashReports, true);
  assert.deepStrictEqual(DEFAULT_SETTINGS.presets, []);
  assert.strictEqual(DEFAULT_SETTINGS.defaultPresetId, null);
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.exportDefaults), 'nested defaults are frozen too');
});

test('a missing or corrupt settings file loads as the defaults', () => {
  const file = tmpFile();
  assert.deepStrictEqual(loadSettings(file), DEFAULT_SETTINGS);
  fs.writeFileSync(file, '{not json');
  assert.deepStrictEqual(loadSettings(file), DEFAULT_SETTINGS);
  fs.writeFileSync(file, '[1,2]');
  assert.deepStrictEqual(loadSettings(file), DEFAULT_SETTINGS);
});

test('saved shortcuts round-trip, including an empty slot', () => {
  const file = tmpFile();
  saveSettings(file, withTriggers(['shift', null]));
  assert.deepStrictEqual(loadSettings(file), withTriggers(['shift', null]));
});

test('an invalid stored value falls back to the defaults', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ zoomTriggers: ['hyper', 'mouse-side'] }));
  assert.deepStrictEqual(loadSettings(file), DEFAULT_SETTINGS);
});

test('settings saved by the earlier key-dropdown version carry over', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ zoomModifier: 'control', zoomSideButton: true }));
  assert.deepStrictEqual(loadSettings(file), withTriggers(['control', 'mouse-side']));
  fs.writeFileSync(file, JSON.stringify({ zoomModifier: 'none', zoomSideButton: false }));
  assert.deepStrictEqual(loadSettings(file), withTriggers([null, null]));
});

test('a settings file from before the Settings window keeps its shortcuts and gains the new keys', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ zoomTriggers: ['command', 'mouse-middle'] }));
  const loaded = loadSettings(file);
  assert.deepStrictEqual(loaded, withTriggers(['command', 'mouse-middle']));
  // Saving writes the whole, current shape.
  saveSettings(file, loaded);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(),
    Object.keys(DEFAULT_SETTINGS).sort());
});

test('one bad value costs only that value, not the rest', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    zoomTriggers: ['shift', null],
    countdown: 'yes',                              // wrong type
    systemAudio: true,
    exportDefaults: { format: 'avi', resolution: '1080p', quality: 'high' },
    microphone: { id: 'abc', label: 'Studio mic' },
    camera: { id: '', label: 'x' },                // empty id
    recordingsFolder: 'relative/path',             // not absolute
    unknownKey: 42
  }));
  const s = loadSettings(file);
  assert.deepStrictEqual(s.zoomTriggers, ['shift', null]);
  assert.strictEqual(s.countdown, true);
  assert.strictEqual(s.systemAudio, true);
  assert.deepStrictEqual(s.exportDefaults, DEFAULT_SETTINGS.exportDefaults);
  assert.deepStrictEqual(s.microphone, { id: 'abc', label: 'Studio mic' });
  assert.strictEqual(s.camera, null);
  assert.strictEqual(s.recordingsFolder, null);
  assert.ok(!('unknownKey' in s));
});

test('stored presets are cleaned: bad ones dropped, unknown style keys removed, dangling default cleared', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    presets: [
      { id: 'p1', name: '  Clean  ', style: { padding: 0.06, radius: 12, evil: 'x' } },
      { id: 'p1', name: 'Duplicate id', style: { padding: 0 } },
      { id: 'bad id!', name: 'Bad id', style: {} },
      { id: 'p2', name: '', style: {} },
      { id: 'p3', name: 'Not a style', style: [1] }
    ],
    defaultPresetId: 'gone'
  }));
  const s = loadSettings(file);
  assert.deepStrictEqual(s.presets, [{ id: 'p1', name: 'Clean', style: { padding: 0.06, radius: 12 } }]);
  assert.strictEqual(s.defaultPresetId, null);
});

test('a patch from the renderer replaces the shortcuts', () => {
  const next = applySettingsPatch(DEFAULT_SETTINGS, { zoomTriggers: ['command', 'mouse-middle'] });
  assert.deepStrictEqual(next, withTriggers(['command', 'mouse-middle']));
});

test('the renderer can change the Settings window options', () => {
  const next = applySettingsPatch(DEFAULT_SETTINGS, {
    countdown: false, openAtLogin: true, systemAudio: true, showKeystrokes: true,
    microphone: { id: 'default', label: 'MacBook Pro Microphone' }, camera: null,
    exportDefaults: { format: 'gif', resolution: '720p', quality: 'small' },
    checkForUpdates: false, saveCrashReports: false
  });
  assert.strictEqual(next.countdown, false);
  assert.strictEqual(next.openAtLogin, true);
  assert.deepStrictEqual(next.exportDefaults, { format: 'gif', resolution: '720p', quality: 'small' });
  assert.deepStrictEqual(next.microphone, { id: 'default', label: 'MacBook Pro Microphone' });
});

test('a bad patch is rejected outright', () => {
  const bad = [
    { zoomTriggers: ['hyper', null] },          // unknown shortcut
    { zoomTriggers: ['option'] },               // not exactly two slots
    { zoomTriggers: ['shift', 'shift'] },       // same shortcut twice
    { zoomTriggers: 'option' },
    { somethingElse: true },
    { countdown: 1 },
    { microphone: { id: 'x' } },                // no label
    { microphone: { id: 'x', label: 'y', extra: 1 } },
    { exportDefaults: { format: 'mp4', resolution: '8k', quality: 'high' } },
    null,
    []
  ];
  for (const patch of bad) {
    assert.throws(() => applySettingsPatch(DEFAULT_SETTINGS, patch), undefined, JSON.stringify(patch));
  }
});

test('the renderer cannot set main-process-only keys, even with valid values', () => {
  for (const patch of [
    { recordingsFolder: '/tmp' },
    { presets: [] },
    { defaultPresetId: null },
    { lastUpdateCheck: 0 },
    { lastNotifiedVersion: '9.9.9' }
  ]) {
    assert.throws(() => applySettingsPatch(DEFAULT_SETTINGS, patch), /Unknown setting/, JSON.stringify(patch));
    // ...while main-process callers may.
    assert.doesNotThrow(() => applySettingsPatch(DEFAULT_SETTINGS, patch, { trusted: true }));
  }
  assert.ok(!RENDERER_KEYS.includes('recordingsFolder'));
});

test('even a trusted patch must be valid', () => {
  assert.throws(() => applySettingsPatch(DEFAULT_SETTINGS, { recordingsFolder: 'not/absolute' }, { trusted: true }));
  assert.throws(() => applySettingsPatch(DEFAULT_SETTINGS, { lastUpdateCheck: -1 }, { trusted: true }));
});

test('inputtap gets the shortcuts as one comma list -- empty meaning none', () => {
  assert.deepStrictEqual(inputTapArgs(DEFAULT_SETTINGS), ['--zoom-triggers', 'option,mouse-side']);
  assert.deepStrictEqual(inputTapArgs({ zoomTriggers: [null, 'mouse-middle'] }),
    ['--zoom-triggers', 'mouse-middle']);
  assert.deepStrictEqual(inputTapArgs({ zoomTriggers: [null, null] }), ['--zoom-triggers', '']);
});

test('the store saves each change, keeps one copy, and tells listeners', () => {
  const file = tmpFile();
  const store = createSettingsStore({ file: () => file });
  const seen = [];
  store.onChange((next, before) => seen.push([before.countdown, next.countdown]));
  store.patch({ countdown: false });
  assert.strictEqual(store.get().countdown, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).countdown, false);
  assert.deepStrictEqual(seen, [[true, false]]);

  // A refused patch changes nothing and tells no one.
  assert.throws(() => store.patch({ recordingsFolder: '/tmp' }));
  assert.strictEqual(store.get().recordingsFolder, null);
  assert.strictEqual(seen.length, 1);

  // A failing listener doesn't stop the change or the other listeners.
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a);
  try {
    store.onChange(() => { throw new Error('boom'); });
    store.onChange((next) => seen.push(['last', next.systemAudio]));
    store.patch({ systemAudio: true });
  } finally {
    console.error = origError;
  }
  assert.strictEqual(store.get().systemAudio, true);
  assert.deepStrictEqual(seen.at(-1), ['last', true]);
  assert.strictEqual(errors.length, 1);
});
