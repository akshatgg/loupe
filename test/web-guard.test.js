'use strict';
// src/main/web-guard.js with a fake WebContents. The real windows are
// exercised by test/e2e/security.e2e.js.
const test = require('node:test');
const assert = require('node:assert');
const { guardWebContents, installWebGuard, sameDocument } = require('../src/main/web-guard');

function fakeContents(url) {
  const handlers = {};
  return {
    handlers,
    openHandler: null,
    getURL: () => url,
    on(evt, cb) { (handlers[evt] ||= []).push(cb); },
    setWindowOpenHandler(fn) { this.openHandler = fn; },
    emit(evt, ...args) {
      const event = { prevented: false, preventDefault() { this.prevented = true; }, ...(args[1] ?? {}) };
      for (const cb of handlers[evt] ?? []) cb(event, args[0]);
      return event.prevented;
    }
  };
}

const PAGE = 'file:///app/src/renderer/library/index.html';
const quiet = { log: () => {} };

test('a window can not navigate to another page, remote or local', () => {
  const c = fakeContents(PAGE);
  guardWebContents(c, quiet);
  assert.strictEqual(c.emit('will-navigate', 'http://127.0.0.1:5000/lib'), true);
  assert.strictEqual(c.emit('will-navigate', 'file:///tmp/evil.html'), true);
  assert.strictEqual(c.emit('will-navigate', 'file:///app/src/renderer/editor/index.html'), true);
  assert.strictEqual(c.emit('will-redirect', 'https://example.com/'), true);
});

test('moving within the same page (a #hash) is still allowed', () => {
  const c = fakeContents(`${PAGE}#one`);
  guardWebContents(c, quiet);
  assert.strictEqual(c.emit('will-navigate', `${PAGE}#two`), false);
  assert.strictEqual(sameDocument('not a url', PAGE), false);
});

test('frames and webviews are refused, new windows are denied', () => {
  const c = fakeContents(PAGE);
  guardWebContents(c, quiet);
  assert.strictEqual(c.emit('will-frame-navigate', 'https://example.com/', { isMainFrame: false }), true);
  assert.strictEqual(c.emit('will-attach-webview'), true);
  assert.deepStrictEqual(c.openHandler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.deepStrictEqual(c.openHandler({ url: 'file:///etc/hosts' }), { action: 'deny' });
});

test('installWebGuard guards every web contents the app creates', () => {
  let created = null;
  installWebGuard({ app: { on: (evt, cb) => { assert.strictEqual(evt, 'web-contents-created'); created = cb; } } });
  const c = fakeContents(PAGE);
  created({}, c);
  assert.ok(c.openHandler);
  assert.ok(c.handlers['will-navigate']?.length);
});
