'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createPermissions, PANES, WINDOWS_PANES } = require('../src/main/permissions');

function fake({ screen = 'granted', mic = 'granted', ax = true } = {}) {
  const opened = [];
  const perms = createPermissions({
    systemPreferences: {
      getMediaAccessStatus: (kind) => (kind === 'screen' ? screen : mic),
      isTrustedAccessibilityClient: () => ax,
      askForMediaAccess: async () => true
    },
    shell: { openExternal: (url) => opened.push(url) },
    platform: 'darwin'
  });
  return { perms, opened };
}

test('screen recording reflects the granted status', () => {
  assert.strictEqual(fake({ screen: 'granted' }).perms.screenRecording(), true);
  assert.strictEqual(fake({ screen: 'denied' }).perms.screenRecording(), false);
});

test('recording is allowed when only accessibility is missing', () => {
  const { perms } = fake({ screen: 'granted', ax: false });
  assert.strictEqual(perms.canRecord(), true);
  assert.strictEqual(perms.canZoom(), false);
});

test('recording is blocked when screen recording is missing', () => {
  assert.strictEqual(fake({ screen: 'denied' }).perms.canRecord(), false);
});

test('zoom requires both screen recording and accessibility', () => {
  assert.strictEqual(fake({ screen: 'denied', ax: true }).perms.canZoom(), false);
  assert.strictEqual(fake({ screen: 'granted', ax: true }).perms.canZoom(), true);
});

test('openPane opens the matching settings URL', () => {
  const { perms, opened } = fake();
  perms.openPane('accessibility');
  assert.deepStrictEqual(opened, [PANES.accessibility]);
});

test('openPane rejects an unknown pane name', () => {
  assert.throws(() => fake().perms.openPane('nope'), /unknown settings pane: nope/);
});

function fakeWindows({ mic = 'granted' } = {}) {
  const opened = [];
  const perms = createPermissions({
    systemPreferences: { getMediaAccessStatus: () => mic },
    shell: { openExternal: (url) => opened.push(url) },
    platform: 'win32'
  });
  return { perms, opened };
}

test('on Windows recording and zoom need no grant', () => {
  const { perms } = fakeWindows();
  assert.strictEqual(perms.canRecord(), true);
  assert.strictEqual(perms.canZoom(), true);
});

test('on Windows the microphone follows the privacy switch', async () => {
  assert.strictEqual(fakeWindows({ mic: 'granted' }).perms.microphone(), true);
  assert.strictEqual(fakeWindows({ mic: 'unknown' }).perms.microphone(), true);
  const denied = fakeWindows({ mic: 'denied' }).perms;
  assert.strictEqual(denied.microphone(), false);
  assert.strictEqual(await denied.requestMicrophone(), false);
});

test('on Windows the microphone pane opens privacy settings', () => {
  const { perms, opened } = fakeWindows();
  perms.openPane('microphone');
  assert.deepStrictEqual(opened, [WINDOWS_PANES.microphone]);
});
