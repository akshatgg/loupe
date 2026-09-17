'use strict';
/**
 * Share links, app side: uploads an exported file to the Loupe website's
 * Vercel Blob store and returns https://loupeapp.vercel.app/v/<id>.
 *
 * The app keeps zero runtime npm dependencies, so this speaks the
 * @vercel/blob client-upload protocol (v2.8.0, API version 12) directly with
 * fetch instead of bundling the SDK:
 *
 *  1. Handshake. POST <site>/api/share/upload
 *       {type: "blob.generate-client-token",
 *        payload: {pathname, clientPayload, multipart}}
 *     clientPayload is a JSON string {title, contentType, size, width,
 *     height, duration}. The site (web/api/_lib/share.js) picks the share id
 *     and pathname itself and answers {clientToken, id, pathname, url,
 *     expiresAt}. clientToken is "vercel_blob_client_<storeId>_<signed>".
 *
 *  2. Upload, straight to Blob (the file never passes through the site):
 *     small files: PUT <blobApi>/?pathname=<pathname>
 *     large files: POST <blobApi>/mpu?pathname=<pathname> three ways,
 *       x-mpu-action: create -> {key, uploadId}
 *       x-mpu-action: upload (x-mpu-key, x-mpu-upload-id, x-mpu-part-number)
 *                   -> {etag}, one per 8 MiB part
 *       x-mpu-action: complete, JSON body [{partNumber, etag}]
 *     Every request carries the same headers the SDK sends: authorization
 *     (Bearer clientToken), x-api-version, x-vercel-blob-store-id,
 *     x-api-blob-request-id, x-api-blob-request-attempt,
 *     x-vercel-blob-access: public, x-content-type, and x-content-length
 *     for streamed bodies.
 *
 * Bodies are streamed in 64 KiB chunks and counted as fetch pulls them,
 * which is how the SDK reports upload progress under Node as well.
 */
const fs = require('node:fs');
const nodeCrypto = require('node:crypto');
const { ReadableStream } = require('node:stream/web');
const { URLSearchParams } = require('node:url');

const { AbortController, AbortSignal, DOMException } = globalThis;

const DEFAULT_SITE_URL = 'https://loupeapp.vercel.app';
const DEFAULT_BLOB_API_URL = 'https://vercel.com/api/blob';
const BLOB_API_VERSION = '12';
const MAX_BYTES = 500 * 1024 * 1024;
const SHAREABLE_TYPES = new Set(['video/mp4', 'video/webm', 'image/gif']);
const PART_SIZE = 8 * 1024 * 1024;
const MULTIPART_OVER = 32 * 1024 * 1024;
const PART_CONCURRENCY = 3;
const CHUNK_SIZE = 64 * 1024;
const ATTEMPTS = 3;
const STATUS_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
// A Blob request that makes no progress for this long is dropped and retried.
// Without it a connection that silently dies (Wi-Fi switch, laptop sleep)
// leaves the upload hanging with its progress bar frozen forever: fetch has
// no timeout of its own, and a stalled socket reports no error for many
// minutes. "Progress" is the body being pulled, then the response arriving.
const STALL_TIMEOUT_MS = 60_000;

const MESSAGES = {
  offline: 'You’re offline. Connect to the internet and try again.',
  disabled: 'Sharing isn’t available right now. Please try again later.',
  too_large: 'This file is too big to share. Links can be up to 500 MB, so try exporting a smaller size.',
  unsupported: 'Only MP4, WebM and GIF files can be shared.',
  rate_limited: 'You’ve shared a lot in a short time. Please try again in a while.',
  cancelled: 'Upload cancelled.',
  busy: 'Another upload is still going. Wait for it to finish or cancel it first.',
  failed: 'The upload didn’t finish. Please try again.'
};

class ShareError extends Error {
  constructor(code, message = MESSAGES[code] ?? MESSAGES.failed, options) {
    super(message, options);
    this.code = code;
  }
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH',
  'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'
]);

function isNetworkError(err) {
  if (!err) return false;
  if (err.name === 'TimeoutError') return true;
  if (NETWORK_CODES.has(err.code) || NETWORK_CODES.has(err.cause?.code)) return true;
  // undici reports every connection-level failure as TypeError("fetch failed").
  return err.name === 'TypeError' && /fetch failed|terminated|network/i.test(err.message);
}

// A stream over `buffer` that reports every chunk fetch takes from it.
function countingStream(buffer, onBytes) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= buffer.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + CHUNK_SIZE, buffer.length);
      controller.enqueue(buffer.subarray(offset, end));
      onBytes(end - offset);
      offset = end;
    }
  });
}

function blobErrorCode(status, apiCode) {
  switch (apiCode) {
    case 'file_too_large': return 'too_large';
    case 'content_type_not_allowed': return 'unsupported';
    case 'store_suspended':
    case 'store_not_found':
    case 'forbidden': return 'disabled';
    case 'rate_limited': return 'rate_limited';
    default: return status === 429 ? 'rate_limited' : 'failed';
  }
}

function handshakeErrorCode(status) {
  if (status === 503 || status === 404) return 'disabled';
  if (status === 413) return 'too_large';
  if (status === 415) return 'unsupported';
  if (status === 429) return 'rate_limited';
  return 'failed';
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {object} [opts]
 * @param {string} [opts.siteUrl]      origin of the website with /api/share
 * @param {string} [opts.blobApiUrl]   Vercel Blob API base
 * @param {Function} [opts.fetch]
 * @param {object} [opts.fsImpl]       node:fs (promises.open is used)
 * @param {number} [opts.partSize]     multipart part size (tests use small parts)
 * @param {number} [opts.multipartOver] files larger than this use multipart
 * @param {number} [opts.retryDelayMs]
 * @param {number} [opts.stallTimeoutMs] drop a Blob request idle this long
 */
function createShareClient(opts = {}) {
  const siteUrl = (opts.siteUrl || DEFAULT_SITE_URL).replace(/\/+$/, '');
  const blobApiUrl = (opts.blobApiUrl || DEFAULT_BLOB_API_URL).replace(/\/+$/, '');
  const fetchImpl = opts.fetch || globalThis.fetch;
  const fsImpl = opts.fsImpl || fs;
  const partSize = opts.partSize || PART_SIZE;
  const multipartOver = opts.multipartOver ?? MULTIPART_OVER;
  const retryDelayMs = opts.retryDelayMs ?? 500;
  const stallTimeoutMs = opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;
  // Progress is sent at most this often, so a fast link doesn't flood the UI.
  const progressIntervalMs = opts.progressIntervalMs ?? 100;

  // Runs `fn`, turning whatever went wrong into a ShareError the UI can show.
  async function guard(signal, fn) {
    try {
      return await fn();
    } catch (err) {
      if (signal?.aborted) throw new ShareError('cancelled', undefined, { cause: err });
      if (err instanceof ShareError) throw err;
      if (isNetworkError(err)) throw new ShareError('offline', undefined, { cause: err });
      throw new ShareError('failed', undefined, { cause: err });
    }
  }

  async function status({ signal } = {}) {
    const timeout = AbortSignal.timeout(STATUS_TIMEOUT_MS);
    const res = await guard(signal, () => fetchImpl(`${siteUrl}/api/share/status`, {
      headers: { accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    }));
    if (!res.ok) return { enabled: false };
    const body = await guard(signal, () => res.json());
    return {
      enabled: body?.enabled === true,
      maxBytes: Number.isSafeInteger(body?.maxBytes) ? Math.min(body.maxBytes, MAX_BYTES) : MAX_BYTES,
      expiresInDays: Number.isInteger(body?.expiresInDays) ? body.expiresInDays : 7
    };
  }

  async function handshake(file, details, multipart, signal) {
    const clientPayload = JSON.stringify({
      title: details.title ?? '', contentType: file.contentType, size: file.size,
      width: details.width, height: details.height, duration: details.duration
    });
    const res = await fetchImpl(`${siteUrl}/api/share/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        type: 'blob.generate-client-token',
        payload: { pathname: file.name, clientPayload, multipart }
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS)])
    });
    if (!res.ok) throw new ShareError(handshakeErrorCode(res.status));
    const body = await res.json();
    const ok = typeof body?.clientToken === 'string' && body.clientToken.startsWith('vercel_blob_client_') &&
      typeof body.pathname === 'string' && body.pathname.length > 0 &&
      typeof body.url === 'string' && typeof body.id === 'string';
    if (!ok) throw new ShareError('failed', undefined, { cause: new Error('bad handshake response') });
    return body;
  }

  /**
   * @param {{path, size, contentType, name}} file  from checkExportedFile()
   * @param {object} [details]  {title, width, height, duration}, shown on the viewer page
   * @param {object} [options]  {signal, onProgress({loaded, total, fraction})}
   * @returns {Promise<{id, url, expiresAt, blobUrl}>}
   */
  async function upload(file, details = {}, { signal, onProgress } = {}) {
    if (!SHAREABLE_TYPES.has(file.contentType)) throw new ShareError('unsupported');
    if (file.size > MAX_BYTES) throw new ShareError('too_large');
    if (file.size <= 0) throw new ShareError('failed');
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) throw new ShareError('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      return await guard(signal, async () => {
        const multipart = file.size > multipartOver;
        const token = await handshake(file, details, multipart, controller.signal);
        const progress = createProgress(file.size, onProgress, progressIntervalMs);
        progress.emit(true);
        const put = createBlobRequester(token, file, controller.signal);
        const result = multipart
          ? await uploadMultipart(put, file, token.pathname, progress, controller)
          : await uploadSingle(put, file, token.pathname, progress);
        progress.done();
        return { id: token.id, url: token.url, expiresAt: token.expiresAt, blobUrl: result.url };
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // One Blob API request with the SDK's headers, retried on network errors
  // and server errors (not on 4xx: those will not get better).
  function createBlobRequester(token, file, signal) {
    const storeId = token.clientToken.split('_')[3] || '';
    const requestId = `${storeId}:${Date.now()}:${nodeCrypto.randomBytes(6).toString('hex')}`;
    return async function blobRequest(route, { method, headers = {}, body, onBytes, json }) {
      const query = new URLSearchParams({ pathname: token.pathname });
      let lastErr;
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(retryDelayMs * attempt, signal);
        let sent = 0;
        const attemptController = new AbortController();
        const stop = () => attemptController.abort(signal.reason);
        signal.addEventListener('abort', stop, { once: true });
        let timer;
        let settled = false;
        const touch = (ms = stallTimeoutMs) => {
          // fetch can still pull a chunk after it gave up on the request.
          if (settled) return;
          clearTimeout(timer);
          timer = setTimeout(() => attemptController.abort(
            new DOMException('The upload stopped making progress.', 'TimeoutError')), ms);
        };
        touch();
        const init = {
          method,
          signal: attemptController.signal,
          headers: {
            authorization: `Bearer ${token.clientToken}`,
            'x-api-version': BLOB_API_VERSION,
            'x-vercel-blob-store-id': storeId,
            'x-api-blob-request-id': requestId,
            'x-api-blob-request-attempt': String(attempt),
            'x-vercel-blob-access': 'public',
            'x-content-type': file.contentType,
            ...headers
          }
        };
        if (body) {
          init.body = countingStream(body, (n) => {
            sent += n;
            // Once the last chunk is handed over, the OS may still be sending
            // a few MB of it on a slow link before the service can answer.
            touch(sent >= body.length ? stallTimeoutMs * 5 : stallTimeoutMs);
            onBytes?.(sent);
          });
          init.duplex = 'half';
          init.headers['x-content-length'] = String(body.length);
        } else if (json !== undefined) {
          init.body = JSON.stringify(json);
          init.headers['content-type'] = 'application/json';
        }
        let res;
        let resBody;
        try {
          res = await fetchImpl(`${blobApiUrl}${route}?${query}`, init);
          touch();
          resBody = res.ok ? await res.json() : await res.json().catch(() => undefined);
        } catch (err) {
          if (signal.aborted || !isNetworkError(err)) throw err;
          lastErr = err;
          onBytes?.(0);
          continue;
        } finally {
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', stop);
        }
        if (res.ok) return resBody;
        const apiCode = resBody?.error?.code;
        if (res.status >= 500) {
          lastErr = new Error(`Blob API ${res.status} ${apiCode ?? ''}`);
          onBytes?.(0);
          continue;
        }
        throw new ShareError(blobErrorCode(res.status, apiCode), undefined,
          { cause: new Error(`Blob API ${res.status} ${apiCode ?? ''}`) });
      }
      throw lastErr;
    };
  }

  async function readRange(filePath, start, length) {
    const handle = await fsImpl.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
        if (bytesRead === 0) throw new Error('The file changed while it was being uploaded.');
        read += bytesRead;
      }
      return buffer;
    } finally {
      await handle.close();
    }
  }

  async function uploadSingle(blobRequest, file, pathname, progress) {
    const body = await readRange(file.path, 0, file.size);
    const result = await blobRequest('/', {
      method: 'PUT', body, onBytes: (n) => progress.set('single', n)
    });
    checkResult(result, pathname);
    return result;
  }

  async function uploadMultipart(blobRequest, file, pathname, progress, controller) {
    const created = await blobRequest('/mpu', { method: 'POST', headers: { 'x-mpu-action': 'create' } });
    if (typeof created?.key !== 'string' || typeof created?.uploadId !== 'string') {
      throw new Error('multipart create returned no upload id');
    }
    const count = Math.ceil(file.size / partSize);
    const parts = [];
    let next = 1;
    const worker = async () => {
      while (next <= count && !controller.signal.aborted) {
        const partNumber = next++;
        const start = (partNumber - 1) * partSize;
        const body = await readRange(file.path, start, Math.min(partSize, file.size - start));
        const result = await blobRequest('/mpu', {
          method: 'POST',
          headers: {
            'x-mpu-action': 'upload',
            'x-mpu-key': encodeURIComponent(created.key),
            'x-mpu-upload-id': created.uploadId,
            'x-mpu-part-number': String(partNumber)
          },
          body,
          onBytes: (n) => progress.set(partNumber, n)
        });
        if (typeof result?.etag !== 'string') throw new Error(`part ${partNumber} returned no etag`);
        parts.push({ partNumber, etag: result.etag });
      }
    };
    let failure = null;
    const workers = Array.from({ length: Math.min(PART_CONCURRENCY, count) }, () =>
      worker().catch((err) => {
        // One failed part dooms the upload: stop the others sending, and
        // report this error rather than the aborts it causes in them.
        if (!failure) failure = err;
        controller.abort(err);
      }));
    await Promise.all(workers);
    if (failure) throw failure;
    parts.sort((a, b) => a.partNumber - b.partNumber);
    const result = await blobRequest('/mpu', {
      method: 'POST',
      headers: {
        'x-mpu-action': 'complete',
        'x-mpu-key': encodeURIComponent(created.key),
        'x-mpu-upload-id': created.uploadId
      },
      json: parts
    });
    checkResult(result, pathname);
    return result;
  }

  return { status, upload };
}

function checkResult(result, pathname) {
  if (typeof result?.url !== 'string' || (result.pathname && result.pathname !== pathname)) {
    throw new Error('Blob API returned an unexpected result');
  }
}

// Sums bytes sent across parts (a retried part starts again from zero) and
// reports at most ten times a second.
function createProgress(total, onProgress, intervalMs = 100, now = Date.now) {
  const sent = new Map();
  let last = 0;
  const loaded = () => {
    let sum = 0;
    for (const v of sent.values()) sum += v;
    return Math.min(sum, total);
  };
  const emit = (force) => {
    if (!onProgress) return;
    const t = now();
    if (!force && t - last < intervalMs) return;
    last = t;
    const l = loaded();
    // 100% is only reported once Blob has confirmed the file.
    onProgress({ loaded: l, total, fraction: Math.min(0.999, l / total) });
  };
  return {
    set(key, bytes) { sent.set(key, bytes); emit(false); },
    emit,
    done() { onProgress?.({ loaded: total, total, fraction: 1 }); }
  };
}

module.exports = {
  createShareClient, ShareError, isNetworkError, MESSAGES, MAX_BYTES,
  DEFAULT_SITE_URL, DEFAULT_BLOB_API_URL, BLOB_API_VERSION
};
