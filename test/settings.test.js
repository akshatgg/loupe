'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_SETTINGS, loadSettings, saveSettings, applySettingsPatch, inputTapArgs
} = require('../src/main/settings');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-settings-'));
  return path.join(dir, 'settings.json');
}

test('defaults: two zoom shortcuts, Option and a mouse side button', () => {
  assert.deepStrictEqual(DEFAULT_SETTINGS, { zoomTriggers: ['option', 'mouse-side'] });
});

test('a missing or corrupt settings file loads as the defaults', () => {
  const file = tmpFile();
  assert.deepStrictEqual(loadSettings(file), DEFAULT_SETTINGS);
  fs.writeFileSync(file, '{not json');
  assert.deepStrictEqual(loadSettings(file), DEFAULT_SETTINGS);
});

test('saved shortcuts round-trip, including an empty slot', () => {
  const file = tmpFile();
  saveSettings(file, { zoomTriggers: ['shift', null] });
  assert.deepStrictEqual(loadSettings(file), { zoomTriggers: ['shift', null] });
});

test('an invalid stored value falls back to the defaults', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ zoomTriggers: ['hyper', 'mouse-side'] }));
  assert.deepStrictEqual(loadSettings(file), DEFAULT_SETTINGS);
});

test('settings saved by the earlier key-dropdown version carry over', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ zoomModifier: 'control', zoomSideButton: true }));
  assert.deepStrictEqual(loadSettings(file), { zoomTriggers: ['control', 'mouse-side'] });
  fs.writeFileSync(file, JSON.stringify({ zoomModifier: 'none', zoomSideButton: false }));
  assert.deepStrictEqual(loadSettings(file), { zoomTriggers: [null, null] });
});

test('a patch from the renderer replaces the shortcuts', () => {
  const next = applySettingsPatch(DEFAULT_SETTINGS, { zoomTriggers: ['command', 'mouse-middle'] });
  assert.deepStrictEqual(next, { zoomTriggers: ['command', 'mouse-middle'] });
});

test('a bad patch is rejected outright', () => {
  const bad = [
    { zoomTriggers: ['hyper', null] },          // unknown shortcut
    { zoomTriggers: ['option'] },               // not exactly two slots
    { zoomTriggers: ['shift', 'shift'] },       // same shortcut twice
    { zoomTriggers: 'option' },
    { somethingElse: true },
    null
  ];
  for (const patch of bad) {
    assert.throws(() => applySettingsPatch(DEFAULT_SETTINGS, patch), undefined, JSON.stringify(patch));
  }
});

test('inputtap gets the shortcuts as one comma list -- empty meaning none', () => {
  assert.deepStrictEqual(inputTapArgs(DEFAULT_SETTINGS), ['--zoom-triggers', 'option,mouse-side']);
  assert.deepStrictEqual(inputTapArgs({ zoomTriggers: [null, 'mouse-middle'] }),
    ['--zoom-triggers', 'mouse-middle']);
  assert.deepStrictEqual(inputTapArgs({ zoomTriggers: [null, null] }), ['--zoom-triggers', '']);
});
