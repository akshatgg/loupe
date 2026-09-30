'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { registerUpdatesIpc } = require('../src/main/ipc/updates');

// A fake Electron whose app records quit() and lets the test fire will-quit,
// and whose dialog records what it was asked to show and answers `response`.
function harness(state, { busy = false, response = 1, autoState = state } = {}) {
  const handlers = {};
  const events = {};
  const calls = [];
  const dialogs = [];
  const app = {
    quit: () => calls.push('quit'),
    on: (name, fn) => { events[name] = fn; }
  };
  const updater = {
    state: () => state,
    install: (opts) => { calls.push(['install', opts]); return true; },
    requestInstall: () => { calls.push('requestInstall'); return true; },
    installsItself: () => state.kind === 'installer' || state.kind === 'bundle',
    autoCheck: async () => autoState,
    check: () => { calls.push('check'); },
    brewCommand: 'brew upgrade --cask loupe'
  };
  const ipc = registerUpdatesIpc({
    ipcMain: { handle: (c, fn) => { handlers[c] = fn; } },
    electron: {
      app,
      clipboard: { writeText: (t) => calls.push(['copy', t]) },
      shell: { openExternal: (u) => calls.push(['open', u]) },
      dialog: { showMessageBox: async (o) => { dialogs.push(o); return { response }; } }
    },
    getUpdater: () => updater,
    isBusy: () => busy
  });
  return { handlers, events, calls, dialogs, ipc, setState: (s) => { state = s; } };
}

const latest = { version: '0.3.0', url: 'https://github.com/akshatgg/loupe/releases/tag/v0.3.0' };
const tick = () => new Promise((r) => setImmediate(r));

test('Update now quits first and runs the update only once the quit really happens', () => {
  for (const kind of ['installer', 'bundle']) {
    const { handlers, events, calls } = harness({ kind, status: 'ready', latest });
    handlers['updates:install']();
    // Nothing is installing yet: a recording being saved while quitting must
    // not be closed by the installer.
    assert.deepStrictEqual(calls, ['quit']);
    events['will-quit']();
    assert.deepStrictEqual(calls, ['quit', ['install', { relaunch: true }]]);
  }
});

test('a plain quit installs a ready update without starting Loupe again', () => {
  const { events, calls } = harness({ kind: 'installer', status: 'ready', latest });
  events['will-quit']();
  assert.deepStrictEqual(calls, [['install', { relaunch: false }]]);
});

test('Update now before the download is ready is remembered, then restarts Loupe when it is', () => {
  const h = harness({ kind: 'bundle', status: 'downloading', latest });
  h.handlers['updates:install']();
  assert.deepStrictEqual(h.calls, ['requestInstall']);
  h.ipc.stateChanged({ kind: 'bundle', status: 'downloading', latest, pending: true });
  assert.deepStrictEqual(h.calls, ['requestInstall']);
  const ready = { kind: 'bundle', status: 'ready', latest, pending: true };
  h.setState(ready);
  h.ipc.stateChanged(ready);
  assert.deepStrictEqual(h.calls, ['requestInstall', 'quit']);
});

test('a download that finishes mid-recording doesn\'t restart Loupe by itself', () => {
  const ready = { kind: 'installer', status: 'ready', latest, pending: true };
  const h = harness(ready, { busy: true });
  h.ipc.stateChanged(ready);
  assert.deepStrictEqual(h.calls, []);
});

test('where Loupe can\'t update itself, Update now opens the release page', () => {
  const h = harness({ kind: 'download', status: 'available', latest });
  h.handlers['updates:install']();
  assert.deepStrictEqual(h.calls, [['open', latest.url]]);
});

test('opening Loupe with an update out shows the Update now dialog, once per launch', async () => {
  const downloading = { kind: 'installer', status: 'downloading', currentVersion: '0.2.0', latest };
  const h = harness(downloading, { response: 0 });
  const launched = h.ipc.launchCheck();
  h.ipc.stateChanged(downloading);
  await launched;
  await tick();
  assert.strictEqual(h.dialogs.length, 1);
  assert.strictEqual(h.dialogs[0].message, 'Loupe 0.3.0 is available');
  assert.match(h.dialogs[0].detail, /You have 0\.2\.0/);
  assert.deepStrictEqual(h.dialogs[0].buttons, ['Update now', 'Later']);
  // "Update now" was chosen while it downloads.
  assert.deepStrictEqual(h.calls, ['requestInstall']);
  // More state changes this launch don't ask again.
  h.ipc.stateChanged({ ...downloading, status: 'ready' });
  await tick();
  assert.strictEqual(h.dialogs.length, 1);
});

test('no dialog when Loupe is up to date, or when the user pressed Check now', async () => {
  const current = { kind: 'installer', status: 'current', currentVersion: '0.3.0', latest };
  const h = harness(current);
  const launched = h.ipc.launchCheck();
  h.ipc.stateChanged(current);
  await launched;
  await tick();
  assert.strictEqual(h.dialogs.length, 0);

  const available = { kind: 'download', status: 'available', currentVersion: '0.2.0', latest };
  const manual = harness(available);
  manual.ipc.stateChanged(available);
  await tick();
  assert.strictEqual(manual.dialogs.length, 0);
});

test('Update now never does nothing: up to date or after an error, it checks again', () => {
  for (const status of ['current', 'error', 'idle']) {
    const h = harness({ kind: 'bundle', status, latest: status === 'current' ? latest : null });
    h.handlers['updates:install']();
    assert.deepStrictEqual(h.calls, ['requestInstall'], status);
  }
  // Where Loupe can't install itself: checks, then says how to get it.
  const h = harness({ kind: 'download', status: 'current', latest });
  h.handlers['updates:install']();
  assert.deepStrictEqual(h.calls, ['check']);
});
