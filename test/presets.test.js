'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_SETTINGS, MAX_PRESETS, normalizeSettings } = require('../src/main/settings');
const {
  listPresets, savePreset, renamePreset, deletePreset, setDefaultPreset,
  presetStyle, defaultPresetStyle
} = require('../src/main/presets');
const { createSettingsStore } = require('../src/main/settings-store');
const { registerPresetsIpc } = require('../src/main/ipc/presets');

const STYLE = {
  background: { type: 'gradient', value: ['#1e3a8a', '#9333ea'] },
  padding: 0.06, radius: 12, shadow: 0.5, aspect: '16:9',
  cursor: { show: true, size: 1.2, hideWhenIdle: false, smooth: true, highlight: 'ring', clicks: true }
};

let n = 0;
const ids = () => `p_test${++n}`;
const apply = (settings, { patch }) => normalizeSettings({ ...settings, ...patch });

test('saving a preset adds it with a fresh id and a cleaned style', () => {
  const { patch, result } = savePreset(DEFAULT_SETTINGS, { name: ' Launch video ', style: { ...STYLE, junk: 1 } }, ids);
  assert.strictEqual(result.name, 'Launch video');
  assert.match(result.id, /^p_test\d+$/);
  assert.deepStrictEqual(result.style, STYLE);
  assert.deepStrictEqual(patch.presets, [result]);
});

test('a repeated name is numbered rather than duplicated', () => {
  let s = DEFAULT_SETTINGS;
  const names = [];
  for (let i = 0; i < 3; i++) {
    const r = savePreset(s, { name: 'Dark', style: STYLE }, ids);
    s = apply(s, r);
    names.push(r.result.name);
  }
  assert.deepStrictEqual(names, ['Dark', 'Dark 2', 'Dark 3']);
});

test('saving with an id overwrites that preset\'s style (and name if given)', () => {
  let s = DEFAULT_SETTINGS;
  const first = savePreset(s, { name: 'A', style: STYLE }, ids);
  s = apply(s, first);
  const upd = savePreset(s, { id: first.result.id, style: { padding: 0 } });
  s = apply(s, upd);
  assert.deepStrictEqual(s.presets, [{ id: first.result.id, name: 'A', style: { padding: 0 } }]);
  s = apply(s, savePreset(s, { id: first.result.id, name: 'B', style: { padding: 1 } }));
  assert.strictEqual(s.presets[0].name, 'B');
  assert.throws(() => savePreset(s, { id: 'p_missing', style: STYLE }), /no longer exists/);
});

test('invalid names, ids and styles are refused', () => {
  assert.throws(() => savePreset(DEFAULT_SETTINGS, { name: '', style: STYLE }), /name/);
  assert.throws(() => savePreset(DEFAULT_SETTINGS, { name: 'x'.repeat(81), style: STYLE }), /name/);
  assert.throws(() => savePreset(DEFAULT_SETTINGS, { name: 'ok', style: 'red' }), /style/);
  assert.throws(() => savePreset(DEFAULT_SETTINGS, { name: 'ok', style: { padding: Infinity } }), /style/);
  assert.throws(() => savePreset(DEFAULT_SETTINGS, { name: 'ok', style: { background: { value: 'x'.repeat(70000) } } }), /style/);
  assert.throws(() => savePreset(DEFAULT_SETTINGS, { id: '../etc', name: 'ok', style: STYLE }), /Invalid preset id/);
  assert.throws(() => savePreset(DEFAULT_SETTINGS), /style/);
});

test('there is a limit on how many presets are kept', () => {
  const presets = Array.from({ length: MAX_PRESETS }, (_, i) => ({ id: `p${i}`, name: `P${i}`, style: {} }));
  const s = normalizeSettings({ presets });
  assert.strictEqual(s.presets.length, MAX_PRESETS);
  assert.throws(() => savePreset(s, { name: 'One more', style: STYLE }), /up to/);
});

test('rename, delete and the default preset', () => {
  let s = DEFAULT_SETTINGS;
  const a = savePreset(s, { name: 'A', style: STYLE }, ids); s = apply(s, a);
  const b = savePreset(s, { name: 'B', style: { radius: 0 } }, ids); s = apply(s, b);

  s = apply(s, renamePreset(s, { id: a.result.id, name: 'Alpha' }));
  assert.deepStrictEqual(s.presets.map((p) => p.name), ['Alpha', 'B']);
  assert.throws(() => renamePreset(s, { id: a.result.id, name: '   ' }), /name/);
  assert.throws(() => renamePreset(s, { id: 'p_nope', name: 'x' }), /no longer exists/);

  s = apply(s, setDefaultPreset(s, b.result.id));
  assert.strictEqual(s.defaultPresetId, b.result.id);
  assert.deepStrictEqual(defaultPresetStyle(s), { radius: 0 });
  assert.throws(() => setDefaultPreset(s, 'p_nope'), /no longer exists/);

  // Deleting the default preset clears the default.
  const del = deletePreset(s, b.result.id);
  assert.strictEqual(del.result, true);
  s = apply(s, del);
  assert.strictEqual(s.defaultPresetId, null);
  assert.strictEqual(defaultPresetStyle(s), null);
  assert.strictEqual(deletePreset(s, b.result.id).result, false);

  s = apply(s, setDefaultPreset(s, null));
  assert.deepStrictEqual(listPresets(s), { presets: s.presets, defaultPresetId: null });
});

test('applying a preset hands out a copy, so changing it doesn\'t change the preset', () => {
  let s = DEFAULT_SETTINGS;
  const a = savePreset(s, { name: 'A', style: STYLE }, ids); s = apply(s, a);
  const style = presetStyle(s, a.result.id);
  style.cursor.size = 9;
  assert.strictEqual(s.presets[0].style.cursor.size, 1.2);
});

test('the IPC handlers store every change in settings.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-presets-'));
  const file = path.join(dir, 'settings.json');
  const store = createSettingsStore({ file: () => file });
  const handlers = {};
  registerPresetsIpc({ ipcMain: { handle: (c, fn) => { handlers[c] = fn; } }, store });

  const saved = await handlers['presets:save']({}, { name: 'Demo', style: STYLE });
  await handlers['presets:setDefault']({}, saved.id);
  await handlers['presets:rename']({}, { id: saved.id, name: 'Demo look' });
  assert.deepStrictEqual(await handlers['presets:apply']({}, saved.id), STYLE);

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(onDisk.presets, [{ id: saved.id, name: 'Demo look', style: STYLE }]);
  assert.strictEqual(onDisk.defaultPresetId, saved.id);
  assert.deepStrictEqual(await handlers['presets:list'](), { presets: onDisk.presets, defaultPresetId: saved.id });

  assert.throws(() => handlers['presets:save']({}, { name: 'Bad', style: null }));
  assert.strictEqual(await handlers['presets:delete']({}, saved.id), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).presets, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
