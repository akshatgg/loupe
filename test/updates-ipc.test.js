'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { registerUpdatesIpc } = require('../src/main/ipc/updates');

// A fake Electron whose app records quit() and lets the test fire will-quit.
function harness(state) {
  const handlers = {};
  const events = {};
  const calls = [];
  const app = {
    quit: () => calls.push('quit'),
    on: (name, fn) => { events[name] = fn; }
  };
  const updater = {
    state: () => state,
    install: (opts) => { calls.push(['install', opts]); return true; },
    brewCommand: 'brew upgrade --cask loupe'
  };
  registerUpdatesIpc({
    ipcMain: { handle: (c, fn) => { handlers[c] = fn; } },
    electron: { app, clipboard: {}, shell: {}, dialog: {} },
    getUpdater: () => updater
  });
  return { handlers, events, calls };
}

test('Restart to update quits first and runs the installer only once the quit really happens', () => {
  const { handlers, events, calls } = harness({ kind: 'installer', status: 'ready' });
  handlers['updates:install']();
  // Nothing is installing yet: a recording being saved while quitting must
  // not be closed by the installer.
  assert.deepStrictEqual(calls, ['quit']);
  events['will-quit']();
  assert.deepStrictEqual(calls, ['quit', ['install', { relaunch: true }]]);
});

test('a plain quit installs a ready update without starting Loupe again', () => {
  const { events, calls } = harness({ kind: 'installer', status: 'ready' });
  events['will-quit']();
  assert.deepStrictEqual(calls, [['install', { relaunch: false }]]);
});

test('Restart to update does nothing when there is no verified installer', () => {
  for (const state of [{ kind: 'installer', status: 'downloading' }, { kind: 'homebrew', status: 'available' }]) {
    const { handlers, calls } = harness(state);
    handlers['updates:install']();
    assert.deepStrictEqual(calls, []);
  }
});
