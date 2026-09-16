'use strict';
// The macOS keystroke rules in InputTap.swift, checked through the built
// helper's --describe-key mode (no event tap, no key presses). Skipped where
// bin/inputtap is not built (CI lint jobs, Windows); `npm run build:native`
// first to run it.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const bin = path.join(__dirname, '..', 'bin', 'inputtap');
const skip = process.platform !== 'darwin' || !fs.existsSync(bin)
  ? 'needs a built bin/inputtap on macOS' : false;

// CGEventFlags bits and ANSI virtual key codes (HIToolbox/Events.h).
const SHIFT = 0x20000;
const CONTROL = 0x40000;
const OPTION = 0x80000;
const COMMAND = 0x100000;
const KEY = { A: 0, E: 14, K: 40, TWO: 19, ESC: 53, LEFT: 123, F1: 122, SPACE: 49, RETURN: 36, DELETE: 51, TAB: 48 };

function label(keyCode, flags) {
  // Output must be read as UTF-8: the labels use ⌘⇧⌥⌃ and arrows.
  return execFileSync(bin, ['--describe-key', String(keyCode), String(flags)], { encoding: 'utf8' }).trim();
}

test('plain typing is never a shortcut', { skip }, () => {
  assert.strictEqual(label(KEY.A, 0), '');
  assert.strictEqual(label(KEY.A, SHIFT), '');
  assert.strictEqual(label(KEY.TWO, SHIFT), '');
  assert.strictEqual(label(KEY.SPACE, 0), '');
  assert.strictEqual(label(KEY.SPACE, SHIFT), '');
});

test('a key with Command, Control or Option is a shortcut, modifiers in menu order', { skip }, () => {
  // Letters depend on the keyboard layout; K is K on QWERTY/QWERTZ/AZERTY.
  assert.strictEqual(label(KEY.K, COMMAND), '⌘K');
  assert.strictEqual(label(KEY.K, COMMAND | SHIFT), '⇧⌘K');
  assert.strictEqual(label(KEY.K, CONTROL | OPTION | SHIFT | COMMAND), '⌃⌥⇧⌘K');
  assert.strictEqual(label(KEY.SPACE, CONTROL), '⌃Space');
  assert.strictEqual(label(KEY.RETURN, OPTION), '⌥↩');
});

test('Shift does not turn a digit into its symbol', { skip }, () => {
  assert.strictEqual(label(KEY.TWO, COMMAND | SHIFT), '⇧⌘2');
});

test('command keys count on their own', { skip }, () => {
  assert.strictEqual(label(KEY.ESC, 0), '⎋');
  assert.strictEqual(label(KEY.LEFT, 0), '←');
  assert.strictEqual(label(KEY.F1, 0), 'F1');
  assert.strictEqual(label(KEY.RETURN, 0), '↩');
  assert.strictEqual(label(KEY.DELETE, 0), '⌫');
  assert.strictEqual(label(KEY.TAB, SHIFT), '⇧⇥');
});

test('Option with a character key types a character, so it is not a shortcut', { skip }, () => {
  assert.strictEqual(label(KEY.E, OPTION), '');
  assert.strictEqual(label(KEY.TWO, OPTION | SHIFT), '');
  // ...but Option with a named key is, and so is Option with Command.
  assert.strictEqual(label(KEY.LEFT, OPTION), '⌥←');
  assert.strictEqual(label(KEY.K, OPTION | COMMAND), '⌥⌘K');
});
