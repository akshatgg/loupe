'use strict';
/**
 * A local stand-in for both halves of share links, for tests:
 *
 *   /api/share/*   the website's functions (web/api/_lib/share.js), backed by
 *                  an in-memory store
 *   /blob/*        the Vercel Blob API as the app talks to it: single PUT and
 *                  multipart create/upload/complete, checking client tokens
 *                  the way the real service does (HMAC signature over the
 *                  payload with the read-write token, pathname, content type,
 *                  size limit, expiry)
 *
 * The client token format follows @vercel/blob 2.8.0's
 * generateClientTokenFromReadWriteToken; share-sdk-compat.test.js checks
 * this fixture against the real SDK when web/node_modules has it.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { createShareApi } = require('../../web/api/_lib/share');

const { Response } = globalThis;

const RW_TOKEN = 'vercel_blob_rw_teststore123_secretsecretsecret';
const STORE_ID = 'teststore123';

function makeClientToken(rwToken, options) {
  const payload = Buffer.from(JSON.stringify(options)).toString('base64');
  const signature = crypto.createHmac('sha256', rwToken).update(payload).digest('hex');
  const storeId = rwToken.split('_')[3];
  return `vercel_blob_client_${storeId}_${Buffer.from(`${signature}.${payload}`).toString('base64')}`;
}

// What the Blob service does with a client token: returns the signed options
// or null when the signature does not match.
function verifyClientToken(rwToken, clientToken) {
  const [, , , storeId, encoded] = clientToken.split('_');
  if (storeId !== rwToken.split('_')[3] || !encoded) return null;
  const [signature, payload] = Buffer.from(encoded, 'base64').toString().split('.');
  const expected = crypto.createHmac('sha256', rwToken).update(payload ?? '').digest('hex');
  if (!signature || signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return JSON.parse(Buffer.from(payload, 'base64').toString());
}

// A fake of the @vercel/blob functions the site uses, over a Map.
function createMemoryBlob({ baseUrl, now = Date.now, handleUpload } = {}) {
  const files = new Map(); // pathname -> {body, contentType, uploadedAt}
  const urlOf = (pathname) => `${baseUrl()}/files/${pathname}`;
  const blob = {
    files,
    async put(pathname, body, opts) {
      if (opts.access !== 'public') throw new Error('access must be public');
      files.set(pathname, { body: Buffer.from(body), contentType: opts.contentType, uploadedAt: new Date(now()) });
      return { url: urlOf(pathname), pathname };
    },
    async list({ prefix = '', limit = 1000, cursor }) {
      const all = [...files.entries()].filter(([p]) => p.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + limit);
      const hasMore = start + limit < all.length;
      return {
        blobs: page.map(([p, f]) => ({
          pathname: p, url: urlOf(p), downloadUrl: `${urlOf(p)}?download=1`,
          size: f.body.length, uploadedAt: f.uploadedAt
        })),
        hasMore,
        cursor: hasMore ? String(start + limit) : undefined
      };
    },
    async del(urls) {
      for (const u of [].concat(urls)) files.delete(u.slice(`${baseUrl()}/files/`.length));
    },
    handleUpload: handleUpload ?? (async ({ token, body, onBeforeGenerateToken }) => {
      const { pathname, clientPayload, multipart } = body.payload;
      const opts = await onBeforeGenerateToken(pathname, clientPayload, multipart);
      const { tokenPayload, ...rest } = opts;
      return {
        type: body.type,
        clientToken: makeClientToken(token, { ...rest, pathname, onUploadCompleted: undefined, tokenPayload })
      };
    })
  };
  return blob;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {object} [opts]
 * @param {object} [opts.env]           env for the site functions
 * @param {Function} [opts.handleUpload] real SDK handleUpload, for compat tests
 * @param {(ctx) => object|undefined} [opts.intercept]  per-request override:
 *        return {status, json} to answer instead, or {hang: true}
 * @param {number} [opts.chunkDelayMs]  slow down reading uploads (for cancel)
 */
async function startMockShareServer(opts = {}) {
  let base = '';
  const requests = [];
  const blob = createMemoryBlob({ baseUrl: () => base, handleUpload: opts.handleUpload });
  const env = { BLOB_READ_WRITE_TOKEN: RW_TOKEN, SHARE_SITE_URL: 'https://share.test', ...opts.env };
  const api = createShareApi({
    blob, env,
    fetch: async (url) => {
      const pathname = decodeURIComponent(new URL(url).pathname.slice('/files/'.length));
      const f = blob.files.get(pathname);
      return f ? new Response(f.body, { status: 200 }) : new Response('', { status: 404 });
    }
  });
  const mpu = new Map(); // uploadId -> {pathname, key, parts: Map}
  const aborted = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers };
    requests.push(record);
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const override = opts.intercept?.(record);
      if (override?.hang) return; // never answers
      if (override) return json(override.status, override.json ?? {});

      // The deployed function files themselves (web/api/share/*.js), when given.
      const handlers = opts.apiHandlers ?? {
        status: api.status, upload: api.upload, cleanup: api.cleanup, meta: api.meta
      };
      if (url.pathname === '/api/share/status') return handlers.status(req, res);
      if (url.pathname === '/api/share/upload') return handlers.upload(req, res);
      if (url.pathname === '/api/share/cleanup') return handlers.cleanup(req, res);
      if (url.pathname.startsWith('/api/share/')) {
        req.query = { id: url.pathname.split('/').pop() };
        return handlers.meta(req, res);
      }

      // Server-side SDK calls (put/list/del) authenticate with the read-write token.
      if (url.pathname.startsWith('/blob') && req.headers.authorization === `Bearer ${RW_TOKEN}`) {
        if (req.method === 'PUT' && url.pathname === '/blob/') {
          const pathname = url.searchParams.get('pathname');
          await blob.put(pathname, await readBody(req), {
            access: req.headers['x-vercel-blob-access'], contentType: req.headers['x-content-type']
          });
          const u = `${base}/files/${pathname}`;
          return json(200, { url: u, downloadUrl: `${u}?download=1`, pathname, contentType: req.headers['x-content-type'] });
        }
        if (req.method === 'GET' && url.pathname === '/blob') {
          const page = await blob.list({
            prefix: url.searchParams.get('prefix') ?? '',
            limit: Number(url.searchParams.get('limit') ?? 1000),
            cursor: url.searchParams.get('cursor') ?? undefined
          });
          return json(200, { ...page, blobs: page.blobs.map((b) => ({ ...b, uploadedAt: b.uploadedAt.toISOString() })) });
        }
        if (req.method === 'POST' && url.pathname === '/blob/delete') {
          await blob.del(JSON.parse((await readBody(req)).toString()).urls);
          return json(200, {});
        }
        return json(404, { error: { code: 'not_found', message: 'route' } });
      }

      if (url.pathname.startsWith('/blob')) {
        const claims = verifyClientToken(RW_TOKEN, (req.headers.authorization ?? '').replace(/^Bearer /, ''));
        if (!claims) return json(403, { error: { code: 'forbidden', message: 'bad token' } });
        if (req.headers['x-vercel-blob-store-id'] !== STORE_ID) return json(400, { error: { code: 'bad_request', message: 'store id' } });
        if (req.headers['x-api-version'] !== '12') return json(400, { error: { code: 'bad_request', message: 'api version' } });
        if (claims.validUntil < Date.now()) return json(403, { error: { code: 'client_token_expired', message: 'Token expired' } });
        const pathname = url.searchParams.get('pathname');
        if (pathname !== claims.pathname) {
          return json(400, { error: { code: 'bad_request', message: '"pathname" does not match the token payload' } });
        }
        const contentType = req.headers['x-content-type'];
        if (claims.allowedContentTypes && !claims.allowedContentTypes.includes(contentType)) {
          return json(400, { error: { code: 'content_type_not_allowed', message: `contentType ${contentType} is not allowed` } });
        }
        if (req.headers['x-vercel-blob-access'] !== 'public') return json(400, { error: { code: 'bad_request', message: 'access' } });

        const readUpload = async () => {
          const chunks = [];
          let total = 0;
          for await (const c of req) {
            chunks.push(c);
            total += c.length;
            if (opts.chunkDelayMs) await new Promise((r) => setTimeout(r, opts.chunkDelayMs));
          }
          const body = Buffer.concat(chunks);
          if (req.headers['x-content-length'] !== undefined && Number(req.headers['x-content-length']) !== total) {
            throw Object.assign(new Error('length mismatch'), { status: 400 });
          }
          return body;
        };
        const done = (pathname, body) => {
          if (claims.maximumSizeInBytes !== undefined && body.length > claims.maximumSizeInBytes) {
            return json(400, { error: { code: 'file_too_large', message: `the file length cannot be greater than ${claims.maximumSizeInBytes}` } });
          }
          if (!claims.allowOverwrite && blob.files.has(pathname)) {
            return json(400, { error: { code: 'bad_request', message: 'This blob already exists' } });
          }
          blob.files.set(pathname, { body, contentType, uploadedAt: new Date() });
          const u = `${base}/files/${pathname}`;
          return json(200, { url: u, downloadUrl: `${u}?download=1`, pathname, contentType, contentDisposition: 'inline', etag: '"e"' });
        };

        if (req.method === 'PUT' && url.pathname === '/blob/') {
          req.on('aborted', () => aborted.push(pathname));
          const body = await readUpload();
          return done(pathname, body);
        }
        if (req.method === 'POST' && url.pathname === '/blob/mpu') {
          const action = req.headers['x-mpu-action'];
          if (action === 'create') {
            const uploadId = crypto.randomUUID();
            const key = `k/${pathname}`;
            mpu.set(uploadId, { pathname, key, parts: new Map() });
            return json(200, { key, uploadId });
          }
          const upload = mpu.get(req.headers['x-mpu-upload-id']);
          if (!upload || decodeURIComponent(req.headers['x-mpu-key'] ?? '') !== upload.key) {
            return json(404, { error: { code: 'not_found', message: 'upload' } });
          }
          if (action === 'upload') {
            const partNumber = Number(req.headers['x-mpu-part-number']);
            const body = await readUpload();
            upload.parts.set(partNumber, body);
            return json(200, { etag: `"part-${partNumber}"` });
          }
          if (action === 'complete') {
            const list = JSON.parse((await readBody(req)).toString());
            // The service assembles by part number, whatever order the list is in.
            const bodies = [...list].sort((x, y) => x.partNumber - y.partNumber).map(({ partNumber, etag }) => {
              if (etag !== `"part-${partNumber}"`) throw Object.assign(new Error('etag'), { status: 400 });
              return upload.parts.get(partNumber);
            });
            mpu.delete(req.headers['x-mpu-upload-id']);
            return done(upload.pathname, Buffer.concat(bodies));
          }
        }
        return json(404, { error: { code: 'not_found', message: 'route' } });
      }

      if (url.pathname.startsWith('/files/')) {
        const f = blob.files.get(decodeURIComponent(url.pathname.slice('/files/'.length)));
        if (!f) return json(404, {});
        res.writeHead(200, { 'content-type': f.contentType || 'application/octet-stream' });
        return res.end(f.body);
      }
      json(404, {});
    } catch (err) {
      if (!res.headersSent) json(err.status ?? 500, { error: { code: 'unknown_error', message: err.message } });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, blob, requests, aborted,
    siteUrl: base,
    blobApiUrl: `${base}/blob`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    })
  };
}

module.exports = { startMockShareServer, makeClientToken, verifyClientToken, createMemoryBlob, RW_TOKEN, STORE_ID };
