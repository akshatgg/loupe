// The editor's keyboard shortcuts (src/renderer/editor/shortcuts.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { commandFor, cheatSheet } from '../src/renderer/editor/shortcuts.js';

const key = (k, mods = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

test('macOS uses Cmd', () => {
  assert.equal(commandFor(key('z', { metaKey: true }), 'darwin'), 'undo');
  assert.equal(commandFor(key('Z', { metaKey: true, shiftKey: true }), 'darwin'), 'redo');
  assert.equal(commandFor(key('y', { metaKey: true }), 'darwin'), null);
  assert.equal(commandFor(key('z', { ctrlKey: true }), 'darwin'), null);
  assert.equal(commandFor(key('e', { metaKey: true }), 'darwin'), 'export');
  assert.equal(commandFor(key('=', { metaKey: true }), 'darwin'), 'timelineZoomIn');
  assert.equal(commandFor(key('-', { metaKey: true }), 'darwin'), 'timelineZoomOut');
});

test('Windows uses Ctrl, and Ctrl+Y redoes', () => {
  assert.equal(commandFor(key('z', { ctrlKey: true }), 'win32'), 'undo');
  assert.equal(commandFor(key('y', { ctrlKey: true }), 'win32'), 'redo');
  assert.equal(commandFor(key('Z', { ctrlKey: true, shiftKey: true }), 'win32'), 'redo');
  assert.equal(commandFor(key('z', { metaKey: true }), 'win32'), null);
});

test('plain keys', () => {
  const cases = [[' ', 'playPause'], ['ArrowLeft', 'backFrame'], ['ArrowRight', 'forwardFrame'], ['Home', 'toStart'],
    ['End', 'toEnd'], ['s', 'split'], ['S', 'split'], ['x', 'cut'], ['z', 'addZoom'], ['Delete', 'delete'], ['Backspace', 'delete'],
    ['?', 'cheatSheet'], ['Escape', 'escape'], ['q', null]];
  for (const [k, want] of cases) assert.equal(commandFor(key(k), 'darwin'), want, k);
  assert.equal(commandFor(key('ArrowLeft', { shiftKey: true }), 'darwin'), 'back1s');
  assert.equal(commandFor(key('ArrowRight', { shiftKey: true }), 'win32'), 'forward1s');
  assert.equal(commandFor(key('s', { altKey: true }), 'darwin'), null);
});

test('the cheat sheet names keys the platform way', () => {
  const flat = (p) => cheatSheet(p).flatMap((g) => g.items.flatMap((i) => i.keys)).join(' ');
  assert.match(flat('darwin'), /⌘Z/);
  assert.match(flat('win32'), /Ctrl\+Y/);
});

test('pro editing keys: I/O marks, J/K/L shuttle, M markers, ⌥X clears the marks', () => {
  const cases = [['i', 'markIn'], ['o', 'markOut'], ['j', 'shuttleBack'], ['k', 'shuttleStop'], ['l', 'shuttleForward'], ['m', 'addMarker']];
  for (const [k, want] of cases) {
    assert.equal(commandFor(key(k), 'darwin'), want, k);
    assert.equal(commandFor(key(k), 'win32'), want, k);
  }
  assert.equal(commandFor(key('M', { shiftKey: true }), 'darwin'), 'nextMarker');
  assert.equal(commandFor(key('F', { shiftKey: true }), 'darwin'), 'freezeFrame');
  assert.equal(commandFor(key('f'), 'darwin'), null);
  // ⌥X on a Mac types "≈"; the physical key decides.
  assert.equal(commandFor({ ...key('≈', { altKey: true }), code: 'KeyX' }, 'darwin'), 'clearMarks');
  assert.equal(commandFor({ ...key('x', { altKey: true }), code: 'KeyX' }, 'win32'), 'clearMarks');
});

test('select all, text and blur have keys, on both platforms', () => {
  const k = (key, mods = {}) => ({ key, code: `Key${key.toUpperCase()}`, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(commandFor(k('a', { metaKey: true }), 'darwin'), 'selectAll');
  assert.equal(commandFor(k('a', { ctrlKey: true }), 'win32'), 'selectAll');
  assert.equal(commandFor(k('a', { ctrlKey: true }), 'darwin'), null, 'Ctrl is not the Mac’s shortcut key');
  assert.equal(commandFor(k('a'), 'darwin'), null);
  assert.equal(commandFor(k('t'), 'darwin'), 'addText');
  assert.equal(commandFor(k('b'), 'win32'), 'addBlur');
  const all = cheatSheet('darwin').flatMap((g) => g.items.map((i) => i.what));
  for (const what of ['Add text at the playhead', 'Add a blur at the playhead', 'Select everything on the timeline', 'Select several things']) {
    assert.ok(all.includes(what), what);
  }
});
