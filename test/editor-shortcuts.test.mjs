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
    ['End', 'toEnd'], ['s', 'split'], ['S', 'split'], ['z', 'addZoom'], ['Delete', 'delete'], ['Backspace', 'delete'],
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
