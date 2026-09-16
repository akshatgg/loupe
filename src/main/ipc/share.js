'use strict';
/**
 * IPC for share links (docs/EDITOR-V2.md section 9). Registered once from
 * main.js with registerShareIpc(ipcMain).
 *
 * Renderer API (preload.js, window.loupe):
 *
 *   shareStatus() -> Promise<{enabled, maxBytes, expiresInDays, offline?}>
 *     Show the Share button only when enabled. Cheap; call it when the
 *     export dialog opens.
 *
 *   shareUpload(filePath, {title?, width?, height?, duration?})
 *     -> Promise<{ok: true, id, url, expiresAt}
 *              | {ok: false, code, message}>
 *     Uploads an exported MP4/WebM/GIF. Never rejects for expected failures:
 *     `message` is written for people and can be shown as-is. Codes:
 *     offline, disabled, too_large, unsupported, rate_limited, cancelled,
 *     busy, failed, invalid, missing.
 *
 *   onShareProgress(cb) -> unsubscribe
 *     cb({loaded, total, fraction}) while an upload runs, at most ~10/s;
 *     fraction reaches 1 only once the upload is confirmed.
 *
 *   shareCancel() -> Promise<{cancelled: boolean}>
 *     The pending shareUpload then resolves with code "cancelled".
 *
 * Copy the returned url with window.loupe.copyText(url) (ipc/fileActions.js).
 *
 * LOUPE_SHARE_URL and LOUPE_BLOB_API_URL point the app at another deployment
 * or a local mock (tests); normal builds use loupeapp.vercel.app.
 */
const { createShareClient, ShareError, MESSAGES } = require('../share-client');
const { checkExportedFile, FileCheckError } = require('../exported-file');

// Only one upload at a time: the export dialog shows a single progress bar,
// and a second press of Share while one runs is almost certainly a mistake.
function createShareService({ client, checkFile = checkExportedFile, isOnline = () => true }) {
  let active = null;

  async function status() {
    if (!isOnline()) return { enabled: false, offline: true };
    try {
      return await client.status();
    } catch (err) {
      return { enabled: false, offline: err.code === 'offline' };
    }
  }

  async function upload(filePath, details, onProgress) {
    if (active) return failure('busy');
    let file;
    try {
      file = checkFile(filePath);
    } catch (err) {
      if (err instanceof FileCheckError) return { ok: false, code: err.code, message: err.message };
      throw err;
    }
    if (!isOnline()) return failure('offline');
    const controller = new globalThis.AbortController();
    active = controller;
    try {
      const result = await client.upload(file, cleanDetails(details), { signal: controller.signal, onProgress });
      return { ok: true, id: result.id, url: result.url, expiresAt: result.expiresAt };
    } catch (err) {
      if (err instanceof ShareError) return { ok: false, code: err.code, message: err.message };
      console.error('Loupe: share upload failed:', err);
      return failure('failed');
    } finally {
      active = null;
    }
  }

  function cancel() {
    if (!active) return { cancelled: false };
    active.abort();
    return { cancelled: true };
  }

  return { status, upload, cancel, get busy() { return Boolean(active); } };
}

function failure(code) {
  return { ok: false, code, message: MESSAGES[code] };
}

// Details only decorate the viewer page, so anything odd is dropped rather
// than failing the upload.
function cleanDetails(details) {
  const d = details && typeof details === 'object' ? details : {};
  const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 16384 ? v : undefined);
  return {
    title: typeof d.title === 'string' ? d.title.slice(0, 120) : '',
    width: dim(d.width),
    height: dim(d.height),
    duration: Number.isFinite(d.duration) && d.duration > 0 ? d.duration : undefined
  };
}

function registerShareIpc(ipcMain, {
  net = require('electron').net,
  client = createShareClient({
    siteUrl: process.env.LOUPE_SHARE_URL,
    blobApiUrl: process.env.LOUPE_BLOB_API_URL
  })
} = {}) {
  const service = createShareService({ client, isOnline: () => net.isOnline() });

  ipcMain.handle('share:status', () => service.status());

  ipcMain.handle('share:upload', (event, filePath, details) => {
    const sender = event.sender;
    return service.upload(filePath, details, (progress) => {
      if (!sender.isDestroyed()) sender.send('share:progress', progress);
    });
  });

  ipcMain.handle('share:cancel', () => service.cancel());

  return service;
}

module.exports = { registerShareIpc, createShareService, cleanDetails };
