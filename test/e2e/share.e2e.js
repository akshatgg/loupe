'use strict';
/**
 * Share links inside real Electron, against the local mock of the website and
 * the Blob API (test/fixtures/mock-share-server.js):
 *
 *   node_modules/.bin/electron test/e2e/share.e2e.js [file.mp4]
 *
 * Drives window.loupe.shareStatus / shareUpload / onShareProgress /
 * shareCancel through the app's real preload and IPC registration, using
 * Electron's own fetch and net.isOnline, and checks the uploaded bytes and
 * the viewer metadata. Pass a real export to upload it; otherwise a generated
 * 40 MB file is used (big enough for the multipart path).
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startMockShareServer } = require('../fixtures/mock-share-server');

function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

app.whenReady().then(async () => {
  // A slow reader stands in for a real connection, so progress and cancel
  // have time to happen.
  const server = await startMockShareServer({ chunkDelayMs: 2 });
  process.env.LOUPE_SHARE_URL = server.siteUrl;
  process.env.LOUPE_BLOB_API_URL = server.blobApiUrl;
  const { registerShareIpc } = require('../../src/main/ipc/share');
  registerShareIpc(ipcMain);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-share-'));
  const given = process.argv.slice(2).find((a) => /\.(mp4|webm|gif)$/i.test(a));
  // Cancel needs an upload that takes a while, whatever file was given.
  const bigFile = path.join(dir, 'generated.mp4');
  fs.writeFileSync(bigFile, crypto.randomBytes(40 * 1024 * 1024));
  const file = given ? path.resolve(given) : bigFile;

  try {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(__dirname, '..', '..', 'src', 'preload', 'preload.js') }
    });
    await win.loadURL('data:text/html,<title>e2e</title>');
    const js = (code) => win.webContents.executeJavaScript(code);

    const status = await js('window.loupe.shareStatus()');
    check('shareStatus enabled', status.enabled === true, JSON.stringify(status));

    const started = Date.now();
    const result = await js(`(async () => {
      const events = [];
      const off = window.loupe.onShareProgress((p) => events.push(p));
      const res = await window.loupe.shareUpload(${JSON.stringify(file)}, { title: 'E2E upload', width: 1920, height: 1080 });
      off();
      return { res, events };
    })()`);
    const { res, events } = result;
    check('shareUpload ok', res.ok === true, JSON.stringify(res));
    check('link shape', /^https:\/\/share\.test\/v\/[A-Za-z0-9_-]{16}$/.test(res.url ?? ''), res.url);
    check('progress events arrived', events.length >= 2, `${events.length} events in ${Date.now() - started} ms`);
    check('progress ends at 1', events.at(-1)?.fraction === 1);
    check('progress is monotonic', events.every((e, i) => i === 0 || e.loaded >= events[i - 1].loaded));

    const stored = [...server.blob.files.entries()].find(([k]) => k.startsWith(`shares/${res.id}/`) && !k.endsWith('meta.json'));
    check('uploaded bytes intact', Boolean(stored) && stored[1].body.equals(fs.readFileSync(file)), stored?.[0]);
    const multipart = server.requests.some((r) => r.headers['x-mpu-action'] === 'complete');
    check('large file used multipart', fs.statSync(file).size <= 32 * 1024 * 1024 || multipart);

    const meta = await (await fetch(`${server.base}/api/share/${res.id}`)).json();
    check('viewer metadata ready', meta.ready === true && meta.title === 'E2E upload', JSON.stringify(meta).slice(0, 200));

    // Cancel mid-way: start, cancel on the first progress event.
    const cancelled = await js(`(async () => {
      let off;
      const cancelledOnce = new Promise((resolve) => {
        off = window.loupe.onShareProgress((p) => { if (p.loaded > 0) resolve(window.loupe.shareCancel()); });
      });
      const pending = window.loupe.shareUpload(${JSON.stringify(bigFile)}, {});
      const busy = await window.loupe.shareUpload(${JSON.stringify(bigFile)}, {});
      const cancel = await cancelledOnce;
      const res = await pending;
      off();
      return { res, busy, cancel };
    })()`);
    check('second upload while busy is refused', cancelled.busy.code === 'busy', JSON.stringify(cancelled.busy));
    check('cancel acknowledged', cancelled.cancel.cancelled === true);
    check('cancelled upload reports cancelled', cancelled.res.code === 'cancelled', JSON.stringify(cancelled.res));

    // Closing the window mid-upload cancels the upload, so the next Share works.
    const doomed = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(__dirname, '..', '..', 'src', 'preload', 'preload.js') }
    });
    await doomed.loadURL('data:text/html,<title>closing</title>');
    const mediaCount = () => [...server.blob.files.keys()].filter((k) => !k.endsWith('meta.json')).length;
    const storedBefore = mediaCount();
    doomed.webContents.executeJavaScript(`(() => {
      const off = window.loupe.onShareProgress((p) => {
        if (p.loaded > 0) { off(); document.title = 'progressed'; }
      });
      window.loupe.shareUpload(${JSON.stringify(bigFile)}, {});
    })()`);
    while (doomed.webContents.getTitle() !== 'progressed') await new Promise((r) => setTimeout(r, 20));
    doomed.destroy();
    const closedAt = Date.now();
    let after;
    do {
      await new Promise((r) => setTimeout(r, 50));
      after = await js(`window.loupe.shareUpload(${JSON.stringify(path.join(dir, 'missing.mp4'))}, {})`);
    } while (after.code === 'busy' && Date.now() - closedAt < 5000);
    check('closing the window cancels its upload', after.code === 'missing' && mediaCount() === storedBefore,
      `${JSON.stringify(after)} after ${Date.now() - closedAt} ms`);

    const bad = await js('window.loupe.shareUpload("/etc/hosts")');
    check('non-export refused', bad.ok === false && bad.code === 'unsupported');

    await server.close();
    const offline = await js(`window.loupe.shareUpload(${JSON.stringify(file)}, {})`);
    check('server gone -> friendly offline error', offline.code === 'offline', JSON.stringify(offline));
    const offStatus = await js('window.loupe.shareStatus()');
    check('status when unreachable', offStatus.enabled === false, JSON.stringify(offStatus));
    win.destroy();
  } catch (err) {
    check('no exceptions', false, err.stack);
  } finally {
    await server.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    app.quit();
  }
});
