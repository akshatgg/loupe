'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createWindowState, restoreBounds } = require('../src/main/window-state');

const MAIN = { x: 0, y: 25, width: 1440, height: 875 };
const DEFAULTS = { width: 1040, height: 700, minWidth: 560, minHeight: 420 };

test('a remembered place on a connected display is used', () => {
  const saved = { x: 100, y: 80, width: 900, height: 600 };
  assert.deepStrictEqual(restoreBounds(saved, DEFAULTS, [MAIN]), saved);
});

test('a place on a display that is gone, or barely on screen, falls back to the default size', () => {
  assert.deepStrictEqual(restoreBounds({ x: 3000, y: 100, width: 900, height: 600 }, DEFAULTS, [MAIN]),
    { width: 1040, height: 700 });
  assert.deepStrictEqual(restoreBounds({ x: 1400, y: 100, width: 900, height: 600 }, DEFAULTS, [MAIN]),
    { width: 1040, height: 700 }, 'only 40px showing');
  const external = { x: 1440, y: 0, width: 2560, height: 1415 };
  assert.deepStrictEqual(restoreBounds({ x: 1600, y: 100, width: 900, height: 600 }, DEFAULTS, [MAIN, external]),
    { x: 1600, y: 100, width: 900, height: 600 });
});

test('nonsense, too small or bigger than any display: the default size', () => {
  for (const saved of [null, 'x', { x: 'a', y: 0, width: 900, height: 600 }, { x: 0, y: 0, width: 100, height: 600 },
    { x: 0, y: 30, width: 4000, height: 600 }, { x: NaN, y: 0, width: 900, height: 600 }]) {
    assert.deepStrictEqual(restoreBounds(saved, DEFAULTS, [MAIN]), { width: 1040, height: 700 }, JSON.stringify(saved));
  }
});

class FakeWindow extends EventEmitter {
  constructor(bounds) { super(); this.bounds = bounds; this.max = false; this.maximizeCalls = 0; }
  isDestroyed() { return false; }
  isMinimized() { return false; }
  isFullScreen() { return false; }
  isMaximized() { return this.max; }
  maximize() { this.maximizeCalls++; this.max = true; }
  getNormalBounds() { return this.bounds; }
}

test('a tracked window is remembered when it moves and when it closes, and reopens there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-winstate-'));
  const file = () => path.join(dir, 'window-state.json');
  const screen = () => ({ getAllDisplays: () => [{ workArea: MAIN }] });
  const state = createWindowState({ file, screen, delayMs: 1 });
  assert.deepStrictEqual(state.options('library', DEFAULTS), { ...DEFAULTS });

  const win = new FakeWindow({ x: 50, y: 60, width: 800, height: 500 });
  state.track(win, 'library');
  win.emit('move');
  win.bounds = { x: 70, y: 90, width: 820, height: 510 };
  win.emit('close');
  const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
  assert.deepStrictEqual(saved.library, { x: 70, y: 90, width: 820, height: 510, maximized: false });

  const again = createWindowState({ file, screen });
  assert.deepStrictEqual(again.options('library', DEFAULTS), { ...DEFAULTS, x: 70, y: 90, width: 820, height: 510 });

  // Left maximised: opens maximised, keeping the size to go back to.
  const w2 = new FakeWindow({ x: 0, y: 0, width: 1440, height: 875 });
  again.track(w2, 'library');
  w2.max = true;
  w2.emit('close');
  const third = createWindowState({ file, screen });
  const w3 = new FakeWindow({});
  third.track(w3, 'library');
  assert.strictEqual(w3.maximizeCalls, 1);
  assert.strictEqual(third.options('library', DEFAULTS).width, 820);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unreadable file or no screen: defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-winstate-'));
  fs.writeFileSync(path.join(dir, 'window-state.json'), '{nope');
  const state = createWindowState({
    file: () => path.join(dir, 'window-state.json'), screen: () => { throw new Error('no screen'); }
  });
  assert.deepStrictEqual(state.options('editor', DEFAULTS), { ...DEFAULTS });
  fs.rmSync(dir, { recursive: true, force: true });
});
