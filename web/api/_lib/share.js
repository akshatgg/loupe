'use strict';
/**
 * Share links: the logic behind every /api/share/* function.
 *
 * Kept free of @vercel/blob and of any Vercel runtime detail so the tests can
 * drive it with a fake Blob SDK and plain request/response objects. The thin
 * files next to this directory (status.js, upload.js, [id].js, cleanup.js)
 * only wire the real SDK in (see runtime.js). The leading underscore keeps
 * Vercel from turning this directory into functions of its own.
 *
 * Storage layout in the (public) Blob store, one folder per share:
 *
 *   shares/<id>/meta.json        written by the upload function before it
 *                                hands out the upload token
 *   shares/<id>/<name>.<ext>     the video/GIF, uploaded by the app itself
 *
 * <id> is 96 random bits, so a link cannot be guessed; nothing lists shares.
 *
 * Environment:
 *   BLOB_READ_WRITE_TOKEN   added when a Blob store is connected; sharing is off without it
 *   CRON_SECRET             recommended; when set, cleanup only runs for Vercel Cron
 *   SHARE_SITE_URL          optional; the origin share links point at
 *
 * One-time setup (owner, from web/ linked to the "loupeapp" project):
 *   vercel blob store add loupe-shares      (a *public* store; connect it to the
 *                                            project for all environments, which
 *                                            adds BLOB_READ_WRITE_TOKEN)
 *   vercel env add CRON_SECRET production   (any long random string)
 *   redeploy. /api/share/status then reports enabled and the app shows Share.
 * For a hard upload limit, add a Vercel Firewall rate-limit rule on
 * /api/share/upload; the in-memory limiter below is per instance only.
 */

const nodeCrypto = require('node:crypto');

const MAX_BYTES = 500 * 1024 * 1024;
const TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS = TTL_DAYS * DAY_MS;
// The upload token outlives a slow upload of the biggest allowed file on a
// poor connection, but not by much: a leaked token is only good for its own
// pathname anyway.
const TOKEN_TTL_MS = 60 * 60 * 1000;
const PREFIX = 'shares/';
const DEFAULT_SITE_URL = 'https://loupeapp.vercel.app';
const CONTENT_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'image/gif': 'gif' };
const ID_RE = /^[A-Za-z0-9_-]{16}$/;
// Blob's CDN caches public files. A day keeps the cost down while making sure
// a deleted share stops playing soon after it expires.
const CACHE_SECONDS = 24 * 60 * 60;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function newShareId(randomBytes = nodeCrypto.randomBytes) {
  return randomBytes(12).toString('base64url');
}

function isShareId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// "My demo: v2!" -> "my-demo-v2". Only used as the file name people get when
// they press Download, so anything unusual just falls back to a plain name.
function slugify(title) {
  const slug = String(title ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return slug || 'loupe-recording';
}

// The app describes what it is about to upload in the handshake's
// clientPayload (a string, per the Blob protocol). Everything in it comes
// from the internet, so every field is checked and anything unknown dropped.
function parseClientPayload(raw) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, 'bad_request', 'Missing upload details.');
  }
  const contentType = data.contentType;
  if (!Object.hasOwn(CONTENT_TYPES, contentType)) {
    throw new HttpError(415, 'unsupported_type', 'Only MP4, WebM and GIF files can be shared.');
  }
  const size = data.size;
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new HttpError(400, 'bad_request', 'Missing file size.');
  }
  if (size > MAX_BYTES) {
    throw new HttpError(413, 'too_large', 'This file is bigger than 500 MB.');
  }
  const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 16384 ? v : null);
  const duration = Number.isFinite(data.duration) && data.duration > 0 ? data.duration : null;
  const title = typeof data.title === 'string'
    ? data.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120)
    : '';
  return { contentType, size, title, width: dim(data.width), height: dim(data.height), duration };
}

// Naive fixed-window limiter kept in the function instance's memory. Vercel
// reuses warm instances, so this stops a single client hammering the upload
// endpoint in a loop, but separate instances do not share counts. For a hard
// limit add a Vercel Firewall rate-limit rule on /api/share/upload.
function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();
  return {
    take(key) {
      const t = now();
      let entry = hits.get(key);
      if (!entry || t - entry.start >= windowMs) {
        entry = { start: t, count: 0 };
        hits.set(key, entry);
      }
      entry.count += 1;
      // Forget stale entries now and then so the map cannot grow forever.
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      }
      return entry.count <= limit;
    }
  };
}

function clientIp(req) {
  const header = (name) => {
    const v = req.headers?.[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const forwarded = header('x-forwarded-for');
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return header('x-real-ip') || req.socket?.remoteAddress || 'unknown';
}

function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

function sendError(res, err) {
  if (err instanceof HttpError) {
    return sendJson(res, err.status, { error: err.code, message: err.message },
      { 'Cache-Control': 'no-store' });
  }
  console.error('share: unexpected error', err);
  return sendJson(res, 500, { error: 'server_error', message: 'Something went wrong. Please try again.' },
    { 'Cache-Control': 'no-store' });
}

async function readJsonBody(req) {
  // Vercel's Node runtime parses JSON bodies onto req.body already; a plain
  // Node request (tests, other hosts) has to be read here.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return parseJson(String(req.body));
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'bad_request', 'Request too large.');
    chunks.push(chunk);
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_request', 'Request body must be JSON.');
  }
}

function requestId(req) {
  if (typeof req.query?.id === 'string') return req.query.id;
  try {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('id') ?? decodeURIComponent(url.pathname.split('/').pop());
  } catch {
    return '';
  }
}

function siteUrlOf(env) {
  const url = env.SHARE_SITE_URL || DEFAULT_SITE_URL;
  return url.replace(/\/+$/, '');
}

/**
 * @param {object} deps
 * @param {{handleUpload, put, list, del}} deps.blob  the @vercel/blob functions used
 * @param {object} [deps.env]        process.env by default
 * @param {() => number} [deps.now]  ms clock
 * @param {Function} [deps.randomBytes]
 * @param {Function} [deps.fetch]    used to read meta.json back
 * @param {object} [deps.limiter]    { take(key) -> boolean }
 */
function createShareApi(deps) {
  const {
    blob, env = process.env, now = Date.now, randomBytes = nodeCrypto.randomBytes,
    fetch: fetchImpl = globalThis.fetch,
    limiter = createRateLimiter({ limit: 20, windowMs: 60 * 60 * 1000, now })
  } = deps;
  const token = () => env.BLOB_READ_WRITE_TOKEN || '';
  const requireEnabled = () => {
    if (!token()) throw new HttpError(503, 'disabled', 'Sharing is not available right now.');
  };
  const onlyMethod = (req, method) => {
    if (req.method !== method) throw new HttpError(405, 'method_not_allowed', `Use ${method}.`);
  };

  // GET /api/share/status -- the app hides its Share button unless enabled.
  async function status(req, res) {
    try {
      onlyMethod(req, 'GET');
      sendJson(res, 200, {
        enabled: Boolean(token()),
        maxBytes: MAX_BYTES,
        expiresInDays: TTL_DAYS,
        contentTypes: Object.keys(CONTENT_TYPES)
      }, { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendError(res, err);
    }
  }

  // POST /api/share/upload -- the Blob client-upload handshake
  // ({type: "blob.generate-client-token", payload: {pathname, clientPayload,
  // multipart}}). Unlike the stock handler, the pathname the client asked for
  // is ignored: the server picks the share id and the pathname, and returns
  // them next to clientToken ({type, clientToken, id, pathname, url,
  // expiresAt}), because a client token only works for the pathname it was
  // issued for.
  async function upload(req, res) {
    try {
      onlyMethod(req, 'POST');
      requireEnabled();
      if (!limiter.take(clientIp(req))) {
        throw new HttpError(429, 'rate_limited', 'Too many shares in a short time. Please try again later.');
      }
      const body = await readJsonBody(req);
      if (body?.type !== 'blob.generate-client-token') {
        // Upload-completed callbacks are not used: the viewer checks the
        // store directly, so there is nothing to record when one finishes.
        throw new HttpError(400, 'bad_request', 'Unsupported request.');
      }
      const details = parseClientPayload(body.payload?.clientPayload);
      const id = newShareId(randomBytes);
      const createdAt = now();
      const expiresAt = createdAt + TTL_MS;
      const pathname = `${PREFIX}${id}/${slugify(details.title)}.${CONTENT_TYPES[details.contentType]}`;
      const meta = {
        version: 1, id, pathname, createdAt, expiresAt,
        title: details.title, contentType: details.contentType, size: details.size,
        width: details.width, height: details.height, duration: details.duration
      };
      await blob.put(`${PREFIX}${id}/meta.json`, JSON.stringify(meta), {
        access: 'public', contentType: 'application/json', addRandomSuffix: false,
        cacheControlMaxAge: CACHE_SECONDS, token: token()
      });
      const result = await blob.handleUpload({
        token: token(),
        request: req,
        body: {
          type: body.type,
          payload: { pathname, clientPayload: body.payload.clientPayload, multipart: Boolean(body.payload.multipart) }
        },
        onBeforeGenerateToken: async () => ({
          allowedContentTypes: [details.contentType],
          // Exactly the size announced (never above 500 MB), so meta.json
          // cannot be made to describe a different file.
          maximumSizeInBytes: details.size,
          addRandomSuffix: false,
          allowOverwrite: false,
          cacheControlMaxAge: CACHE_SECONDS,
          validUntil: createdAt + TOKEN_TTL_MS,
          tokenPayload: id
        })
      });
      sendJson(res, 200, {
        ...result, id, pathname, url: `${siteUrlOf(env)}/v/${id}`, expiresAt
      }, { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendError(res, err);
    }
  }

  // GET /api/share/<id> -- what the viewer page needs to play a share.
  async function meta(req, res) {
    try {
      onlyMethod(req, 'GET');
      const id = requestId(req);
      if (!isShareId(id)) throw new HttpError(404, 'not_found', 'This link does not exist.');
      requireEnabled();
      const { blobs } = await blob.list({ prefix: `${PREFIX}${id}/`, limit: 10, token: token() });
      const metaBlob = blobs.find((b) => b.pathname === `${PREFIX}${id}/meta.json`);
      if (!metaBlob) throw new HttpError(404, 'not_found', 'This link does not exist.');
      const response = await fetchImpl(metaBlob.url);
      if (!response.ok) throw new Error(`meta.json fetch failed: ${response.status}`);
      const info = await response.json();
      const t = now();
      if (!(t < info.expiresAt)) {
        throw new HttpError(410, 'expired', 'This link has expired.');
      }
      const media = blobs.find((b) => b.pathname === info.pathname);
      const payload = {
        id,
        title: info.title || '',
        contentType: info.contentType,
        size: info.size,
        width: info.width ?? null,
        height: info.height ?? null,
        duration: info.duration ?? null,
        createdAt: info.createdAt,
        expiresAt: info.expiresAt,
        expiresInDays: Math.max(1, Math.ceil((info.expiresAt - t) / DAY_MS)),
        ready: Boolean(media),
        url: media ? media.url : null,
        downloadUrl: media ? (media.downloadUrl || `${media.url}?download=1`) : null
      };
      // Short edge cache: a share that is still uploading appears within a
      // few seconds, and expiry is at most a minute late.
      sendJson(res, 200, payload, {
        'Cache-Control': media ? 'public, max-age=0, s-maxage=60' : 'no-store',
        'X-Robots-Tag': 'noindex'
      });
    } catch (err) {
      sendError(res, err);
    }
  }

  // GET /api/share/cleanup -- Vercel Cron, daily. Deletes everything under
  // shares/ uploaded more than 7 days ago (meta.json and media alike, so an
  // upload that never finished is cleared too).
  async function cleanup(req, res) {
    try {
      onlyMethod(req, 'GET');
      if (env.CRON_SECRET && req.headers?.authorization !== `Bearer ${env.CRON_SECRET}`) {
        throw new HttpError(401, 'unauthorized', 'Unauthorized.');
      }
      requireEnabled();
      const cutoff = now() - TTL_MS;
      // List everything first, then delete: deleting while paging could
      // shift what a cursor points at and skip blobs.
      let cursor;
      let scanned = 0;
      const old = [];
      do {
        const page = await blob.list({ prefix: PREFIX, limit: 1000, cursor, token: token() });
        scanned += page.blobs.length;
        for (const b of page.blobs) {
          if (new Date(b.uploadedAt).getTime() <= cutoff) old.push(b.url);
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      let deleted = 0;
      for (let i = 0; i < old.length; i += 100) {
        const batch = old.slice(i, i + 100);
        await blob.del(batch, { token: token() });
        deleted += batch.length;
      }
      sendJson(res, 200, { deleted, scanned }, { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendError(res, err);
    }
  }

  return { status, upload, meta, cleanup };
}

module.exports = {
  createShareApi, createRateLimiter, parseClientPayload, slugify, newShareId, isShareId,
  clientIp, HttpError, MAX_BYTES, TTL_DAYS, TTL_MS, CONTENT_TYPES, PREFIX
};
