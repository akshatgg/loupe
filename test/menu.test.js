'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildMenuTemplate, appShortcuts } = require('../src/main/menu');

function build(platform, isDev = false) {
  const called = [];
  const names = ['newRecording', 'openRecordings', 'openSettings', 'checkForUpdates',
    'showShortcuts', 'openWebsite', 'reportProblem', 'showLogs'];
  const actions = Object.fromEntries(names.map((n) => [n, (...args) => called.push([n, ...args])]));
  return { template: buildMenuTemplate({ platform, appName: 'Loupe', isDev, actions }), called };
}

const flat = (template) => template.flatMap((m) => m.submenu.map((i) => ({ ...i, menu: m.label })));
const byId = (template, id) => flat(template).find((i) => i.id === id);

test('macOS: the app menu has About, Settings… ⌘,, Check for Updates…, Hide and Quit', () => {
  const { template, called } = build('darwin');
  assert.deepStrictEqual(template.map((m) => m.label), ['Loupe', 'File', 'Edit', 'View', 'Window', 'Help']);
  const app = template[0].submenu;
  assert.deepStrictEqual(app.filter((i) => i.label || i.role).map((i) => i.label ?? i.role),
    ['About Loupe', 'Settings…', 'Check for Updates…', 'services', 'Hide Loupe', 'hideOthers', 'unhide', 'Quit Loupe']);
  assert.strictEqual(byId(template, 'settings').accelerator, 'CmdOrCtrl+,');
  byId(template, 'about').click();
  byId(template, 'settings').click();
  byId(template, 'check-for-updates').click();
  assert.deepStrictEqual(called, [['openSettings', 'about'], ['openSettings'], ['checkForUpdates']]);
});

test('File: New Recording ⌘N, Open Recordings ⌘O, Close', () => {
  const { template, called } = build('darwin');
  const file = template[1].submenu;
  assert.strictEqual(file[0].label, 'New Recording');
  assert.strictEqual(file[0].accelerator, 'CmdOrCtrl+N');
  assert.strictEqual(file[1].label, 'Open Recordings');
  assert.strictEqual(file[1].accelerator, 'CmdOrCtrl+O');
  assert.strictEqual(file.at(-1).role, 'close');
  file[0].click();
  file[1].click();
  assert.deepStrictEqual(called, [['newRecording'], ['openRecordings']]);
});

test('Edit uses the standard roles, so text fields everywhere get undo, copy and paste', () => {
  const { template } = build('darwin');
  const roles = template[2].submenu.filter((i) => i.role).map((i) => i.role);
  assert.deepStrictEqual(roles, ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll']);
});

test('Help: website, keyboard shortcuts, report a problem, show logs', () => {
  const { template, called } = build('darwin');
  const help = template.at(-1);
  assert.strictEqual(help.role, 'help');
  for (const id of ['website', 'keyboard-shortcuts', 'report-problem', 'show-logs']) byId(template, id).click();
  assert.deepStrictEqual(called, [['openWebsite'], ['showShortcuts'], ['reportProblem'], ['showLogs']]);
});

test('developer items only appear when running from source', () => {
  const roles = (t) => flat(t).map((i) => i.role);
  assert.ok(!roles(build('darwin').template).includes('toggleDevTools'));
  assert.ok(roles(build('darwin', true).template).includes('toggleDevTools'));
});

test('Windows: no app menu; Settings and Exit in File, updates and About in Help, Alt-key access', () => {
  const { template } = build('win32');
  assert.deepStrictEqual(template.map((m) => m.label), ['&File', '&Edit', '&View', '&Window', '&Help']);
  const file = template[0].submenu;
  assert.ok(file.some((i) => i.id === 'settings' && i.label === 'Settings'));
  assert.strictEqual(file.at(-1).role, 'quit');
  assert.strictEqual(file.at(-1).label, 'Exit');
  const help = template.at(-1).submenu;
  assert.ok(help.some((i) => i.id === 'check-for-updates'));
  assert.ok(help.some((i) => i.id === 'about'));
  assert.strictEqual(byId(template, 'keyboard-shortcuts').accelerator, 'F1');
  assert.ok(!flat(template).some((i) => i.role === 'services' || i.role === 'hide'));
});

test('every menu item id is unique on each platform', () => {
  for (const platform of ['darwin', 'win32']) {
    const ids = flat(build(platform).template).map((i) => i.id).filter(Boolean);
    assert.strictEqual(new Set(ids).size, ids.length, platform);
  }
});

test('the app-wide shortcut list names keys the way each OS does', () => {
  assert.deepStrictEqual(appShortcuts('darwin')[0], ['New recording', '⌘N']);
  assert.deepStrictEqual(appShortcuts('win32')[0], ['New recording', 'Ctrl+N']);
});
