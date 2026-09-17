'use strict';
// IPC wiring for share links (src/main/ipc/share.js) and the exported-file
// check it shares with file actions (src/main/exported-file.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerShareIpc, createShareService, cleanDetails } = require('../src/main/ipc/share');
const { ShareError } = require('../src/main/share-client');
const { checkExportedFile, createExportedFiles } = require('../src/main/exported-file');
const { startMockShareServer } = require('./fixtures/mock-share-server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-share-ipc-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, event, ...args) => handlers.get(channel)(event, ...args)
  };
}

function fakeSender() {
  const { EventEmitter } = require('node:events');
  return Object.assign(new EventEmitter(), {
    sent: [], destroyed: false, isDestroyed() { return this.destroyed; }, send(c, d) { this.sent.push([c, d]); }
  });
}

test('checkExportedFile only lets exported media files through', () => {
  const mp4 = path.join(tmp, 'ok.MP4');
  fs.writeFileSync(mp4, 'x');
  assert.deepStrictEqual(checkExportedFile(mp4), { path: mp4, size: 1, contentType: 'video/mp4', name: 'ok.MP4' });
  fs.writeFileSync(path.join(tmp, 'a.gif'), 'gif');
  assert.strictEqual(checkExportedFile(path.join(tmp, 'a.gif')).contentType, 'image/gif');
  fs.mkdirSync(path.join(tmp, 'dir.mp4'));

  const codes = (p) => { try { checkExportedFile(p); return 'ok'; } catch (e) { return e.code; } };
  assert.strictEqual(codes('relative/ok.mp4'), 'invalid');
  assert.strictEqual(codes(42), 'invalid');
  assert.strictEqual(codes(`${mp4}\0.txt`), 'invalid');
  assert.strictEqual(codes(path.join(tmp, 'notes.txt')), 'unsupported');
  assert.strictEqual(codes('/etc/passwd'), 'unsupported');
  assert.strictEqual(codes(path.join(tmp, 'gone.mp4')), 'missing');
  assert.strictEqual(codes(path.join(tmp, 'dir.mp4')), 'missing');
});

test('share IPC uploads end to end, forwarding progress to the calling window', async () => {
  const server = await startMockShareServer();
  try {
    const ipcMain = fakeIpcMain();
    const { createShareClient } = require('../src/main/share-client');
    registerShareIpc(ipcMain, {
      net: { isOnline: () => true },
      client: createShareClient({ siteUrl: server.siteUrl, blobApiUrl: server.blobApiUrl })
    });
    assert.deepStrictEqual([...ipcMain.handlers.keys()].sort(), ['share:cancel', 'share:status', 'share:upload']);

    const status = await ipcMain.invoke('share:status', {});
    assert.strictEqual(status.enabled, true);

    const file = path.join(tmp, 'export.mp4');
    fs.writeFileSync(file, Buffer.alloc(256 * 1024, 1));
    const sender = fakeSender();
    const result = await ipcMain.invoke('share:upload', { sender }, file, { title: 'Export', width: 'wide' });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(sender.listenerCount('destroyed'), 0, 'no listener left on the window');
    assert.match(result.url, /^https:\/\/share\.test\/v\/[A-Za-z0-9_-]{16}$/);
    assert.ok(sender.sent.length >= 2);
    assert.ok(sender.sent.every(([c]) => c === 'share:progress'));
    assert.strictEqual(sender.sent.at(-1)[1].fraction, 1);

    const bad = await ipcMain.invoke('share:upload', { sender }, '/etc/hosts');
    assert.deepStrictEqual(bad, { ok: false, code: 'unsupported', message: 'Only exported videos and GIFs can be used here.' });
    assert.deepStrictEqual(await ipcMain.invoke('share:cancel', {}), { cancelled: false });
  } finally {
    await server.close();
  }
});

test('share service: offline, busy, cancel and unexpected errors', async () => {
  const file = path.join(tmp, 'svc.mp4');
  fs.writeFileSync(file, 'data');

  let online = false;
  const calls = [];
  let release;
  const client = {
    status: async () => { throw new ShareError('offline'); },
    upload: (f, details, { signal, onProgress }) => {
      calls.push({ f, details });
      onProgress({ loaded: 0, total: f.size, fraction: 0 });
      return new Promise((resolve, reject) => {
        release = () => resolve({ id: 'i', url: 'u', expiresAt: 1, extra: 'dropped' });
        signal.addEventListener('abort', () => reject(new ShareError('cancelled')));
      });
    }
  };
  const service = createShareService({ client, isOnline: () => online });

  assert.deepStrictEqual(await service.status(), { enabled: false, offline: true });
  const offline = await service.upload(file, {}, () => {});
  assert.strictEqual(offline.code, 'offline');
  assert.match(offline.message, /offline/);
  assert.strictEqual(calls.length, 0);

  online = true;
  assert.deepStrictEqual(await service.status(), { enabled: false, offline: true });
  const first = service.upload(file, { title: 't' }, () => {});
  assert.strictEqual(service.busy, true);
  assert.strictEqual((await service.upload(file, {}, () => {})).code, 'busy');
  assert.deepStrictEqual(service.cancel(), { cancelled: true });
  assert.deepStrictEqual(await first, { ok: false, code: 'cancelled', message: 'Upload cancelled.' });
  assert.strictEqual(service.busy, false);

  const second = service.upload(file, {}, () => {});
  release();
  assert.deepStrictEqual(await second, { ok: true, id: 'i', url: 'u', expiresAt: 1 });

  const broken = createShareService({ client: { upload: async () => { throw new Error('bug'); } } });
  const original = console.error;
  console.error = () => {};
  try {
    const res = await broken.upload(file, {}, () => {});
    assert.strictEqual(res.code, 'failed');
    assert.strictEqual(broken.busy, false);
  } finally {
    console.error = original;
  }
});

test('progress is not sent to a window that has closed', async () => {
  const ipcMain = fakeIpcMain();
  const file = path.join(tmp, 'closed.mp4');
  fs.writeFileSync(file, 'data');
  registerShareIpc(ipcMain, {
    net: { isOnline: () => true },
    client: {
      status: async () => ({ enabled: true }),
      upload: async (f, d, { onProgress }) => { onProgress({ loaded: 1, total: 4, fraction: 0.25 }); return { id: 'a', url: 'b', expiresAt: 0 }; }
    }
  });
  const sender = fakeSender();
  sender.destroyed = true;
  const res = await ipcMain.invoke('share:upload', { sender }, file);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(sender.sent.length, 0);
});

test('cleanDetails keeps only sensible values', () => {
  assert.deepStrictEqual(cleanDetails({ title: 'x'.repeat(200), width: 1920, height: 0, duration: -1 }),
    { title: 'x'.repeat(120), width: 1920, height: undefined, duration: undefined });
  assert.deepStrictEqual(cleanDetails('nope'), { title: '', width: undefined, height: undefined, duration: undefined });
});

test('closing the window that started an upload cancels it', async () => {
  const ipcMain = fakeIpcMain();
  const file = path.join(tmp, 'closing.mp4');
  fs.writeFileSync(file, 'data');
  let started;
  const uploading = new Promise((resolve) => { started = resolve; });
  const service = registerShareIpc(ipcMain, {
    net: { isOnline: () => true },
    client: {
      status: async () => ({ enabled: true }),
      upload: (f, d, { signal }) => new Promise((resolve, reject) => {
        started();
        signal.addEventListener('abort', () => reject(new ShareError('cancelled')));
      })
    }
  });
  const sender = fakeSender();
  const pending = ipcMain.invoke('share:upload', { sender }, file);
  await uploading;
  assert.strictEqual(service.busy, true);
  sender.destroyed = true;
  sender.emit('destroyed');
  assert.strictEqual((await pending).code, 'cancelled');
  assert.strictEqual(service.busy, false);
  assert.strictEqual(sender.listenerCount('destroyed'), 0, 'listener removed');
});

test('in the app only files Loupe exported can be shared, copied or dragged', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'rec-'));
  const made = path.join(dir, 'export-1920x1080.mp4');
  const earlier = path.join(dir, 'export-1280x720.mp4');
  const other = path.join(dir, 'someone-elses.mp4');
  // A "voiceover" dressed up as WebM, the kind of file a page can make main write.
  const disguised = path.join(dir, 'Voiceover.webm');
  for (const f of [made, earlier, other, disguised]) fs.writeFileSync(f, 'video');
  const link = path.join(dir, 'link.mp4');
  fs.symlinkSync(other, link);

  const files = createExportedFiles({ recent: () => [earlier] });
  files.remember(made);
  const codes = (p) => { try { files.check(p); return 'ok'; } catch (e) { return e.code; } };
  assert.strictEqual(codes(made), 'ok');
  assert.strictEqual(codes(earlier), 'ok', 'an earlier export of the open recording');
  assert.strictEqual(codes(other), 'unsupported');
  assert.strictEqual(codes(disguised), 'unsupported');
  assert.strictEqual(codes(link), 'unsupported', 'never through a link');
  assert.strictEqual(codes('/etc/passwd'), 'unsupported');
  // A link where a made export used to be doesn't count either.
  fs.rmSync(made);
  fs.symlinkSync(other, made);
  assert.strictEqual(codes(made), 'unsupported');

  // Wired into share and file actions.
  const ipcMain = fakeIpcMain();
  let uploaded = 0;
  registerShareIpc(ipcMain, {
    net: { isOnline: () => true },
    client: { status: async () => ({ enabled: true }), upload: async () => { uploaded++; return { id: 'a', url: 'b', expiresAt: 0 }; } },
    checkFile: files.check
  });
  const res = await ipcMain.invoke('share:upload', { sender: fakeSender() }, other);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'unsupported');
  assert.strictEqual((await ipcMain.invoke('share:upload', { sender: fakeSender() }, earlier)).ok, true);
  assert.strictEqual(uploaded, 1);

  const { registerFileActionsIpc } = require('../src/main/ipc/fileActions');
  const fileIpc = fakeIpcMain();
  const shown = [];
  registerFileActionsIpc(fileIpc, {
    clipboard: { write: async () => {}, writeText: async () => {} }, ClipboardItem: class {},
    shell: { showItemInFolder: (p) => shown.push(p) }, app: {}, nativeImage: {}
  }, { checkFile: files.check });
  assert.strictEqual((await fileIpc.invoke('file:copy', {}, other)).code, 'unsupported');
  assert.strictEqual((await fileIpc.invoke('file:reveal', {}, other)).code, 'unsupported');
  assert.strictEqual((await fileIpc.invoke('file:startDrag', { sender: { startDrag: () => assert.fail('dragged') } }, other)).code, 'unsupported');
  assert.deepStrictEqual(await fileIpc.invoke('file:reveal', {}, earlier), { ok: true });
  assert.deepStrictEqual(shown, [earlier]);
});
