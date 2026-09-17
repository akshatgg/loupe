'use strict';
// The website's share functions (web/api/_lib/share.js), driven directly
// with a fake Blob SDK and fake request/response objects -- the same objects
// Vercel's Node runtime passes to web/api/share/*.js.
const test = require('node:test');
const assert = require('node:assert');
const {
  createShareApi, createRateLimiter, parseClientPayload, slugify, newShareId, isShareId,
  clientIp, MAX_BYTES, TTL_MS
} = require('../web/api/_lib/share');
const { createMemoryBlob, verifyClientToken, RW_TOKEN } = require('./fixtures/mock-share-server');

const { Response } = globalThis;
const T0 = Date.UTC(2026, 8, 16, 12, 0, 0);

function fakeRes() {
  const res = {
    statusCode: 0, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(text) { this.body = text === undefined ? undefined : JSON.parse(text); }
  };
  return res;
}

function fakeReq({ method = 'GET', url = '/', body, headers = {}, query } = {}) {
  return { method, url, body, headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', ...headers }, query };
}

function setup({ env = {}, now = () => T0, limiter } = {}) {
  const blob = createMemoryBlob({ baseUrl: () => 'https://store.test', now });
  const calls = { put: [], handleUpload: [], del: [] };
  const wrapped = {
    put: (...a) => { calls.put.push(a); return blob.put(...a); },
    list: (...a) => blob.list(...a),
    del: (...a) => { calls.del.push(a); return blob.del(...a); },
    handleUpload: (...a) => { calls.handleUpload.push(a); return blob.handleUpload(...a); }
  };
  const api = createShareApi({
    blob: wrapped,
    env: { BLOB_READ_WRITE_TOKEN: RW_TOKEN, ...env },
    now,
    randomBytes: (n) => Buffer.alloc(n, 7),
    fetch: async (url) => {
      const f = blob.files.get(url.slice('https://store.test/files/'.length));
      return f ? new Response(f.body) : new Response('', { status: 404 });
    },
    limiter
  });
  return { api, blob, calls };
}

const tokenRequest = (payload, extra = {}) => ({
  type: 'blob.generate-client-token',
  payload: { pathname: 'anything.mp4', clientPayload: JSON.stringify(payload), multipart: false, ...extra }
});

async function call(handler, req) {
  const res = fakeRes();
  await handler(req, res);
  return res;
}

test('status reports enabled only when the Blob token is set', async () => {
  const on = await call(setup().api.status, fakeReq());
  assert.strictEqual(on.statusCode, 200);
  assert.deepStrictEqual(on.body, {
    enabled: true, maxBytes: MAX_BYTES, expiresInDays: 7,
    contentTypes: ['video/mp4', 'video/webm', 'image/gif']
  });
  assert.strictEqual(on.headers['cache-control'], 'no-store');

  const off = await call(setup({ env: { BLOB_READ_WRITE_TOKEN: '' } }).api.status, fakeReq());
  assert.strictEqual(off.body.enabled, false);

  // The status function is deployed without the SDK at all.
  const bare = createShareApi({ blob: null, env: {} });
  assert.strictEqual((await call(bare.status, fakeReq())).body.enabled, false);
  assert.strictEqual((await call(bare.status, fakeReq({ method: 'POST' }))).statusCode, 405);
});

test('upload issues a token for a server-chosen pathname and writes meta.json first', async () => {
  const { api, blob, calls } = setup();
  const res = await call(api.upload, fakeReq({
    method: 'POST',
    body: tokenRequest({ title: 'My demo: v2!', contentType: 'video/mp4', size: 1234, width: 1920, height: 1080, duration: 12.5 },
      { pathname: '../../evil.mp4' })
  }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  const id = newShareId(() => Buffer.alloc(12, 7));
  assert.strictEqual(res.body.id, id);
  assert.strictEqual(res.body.pathname, `shares/${id}/my-demo-v2.mp4`);
  assert.strictEqual(res.body.url, `https://loupeapp.vercel.app/v/${id}`);
  assert.strictEqual(res.body.expiresAt, T0 + TTL_MS);
  assert.strictEqual(res.body.type, 'blob.generate-client-token');

  // The client's own pathname is ignored; the token is bound to ours.
  const claims = verifyClientToken(RW_TOKEN, res.body.clientToken);
  assert.ok(claims, 'token signed with the read-write token');
  assert.strictEqual(claims.pathname, res.body.pathname);
  assert.deepStrictEqual(claims.allowedContentTypes, ['video/mp4']);
  assert.strictEqual(claims.maximumSizeInBytes, 1234);
  assert.strictEqual(claims.addRandomSuffix, false);
  assert.strictEqual(claims.allowOverwrite, false);
  assert.strictEqual(claims.validUntil, T0 + 6 * 60 * 60 * 1000);

  // meta.json exists before the token is handed out.
  assert.strictEqual(calls.put.length, 1);
  assert.strictEqual(calls.put[0][0], `shares/${id}/meta.json`);
  assert.strictEqual(calls.put[0][2].access, 'public');
  assert.strictEqual(calls.put[0][2].token, RW_TOKEN);
  const meta = JSON.parse(blob.files.get(`shares/${id}/meta.json`).body);
  assert.deepStrictEqual(meta, {
    version: 1, id, pathname: `shares/${id}/my-demo-v2.mp4`, createdAt: T0, expiresAt: T0 + TTL_MS,
    title: 'My demo: v2!', contentType: 'video/mp4', size: 1234, width: 1920, height: 1080, duration: 12.5
  });
});

test('upload reads a raw JSON body when the runtime did not parse it', async () => {
  const { api } = setup();
  const payload = JSON.stringify(tokenRequest({ contentType: 'image/gif', size: 10 }));
  const req = fakeReq({ method: 'POST' });
  req.body = undefined;
  req[Symbol.asyncIterator] = async function* () { yield Buffer.from(payload); };
  const res = await call(api.upload, req);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(res.body.pathname, /^shares\/[A-Za-z0-9_-]{16}\/loupe-recording\.gif$/);
});

test('upload refuses what it should', async () => {
  const cases = [
    [{ contentType: 'video/quicktime', size: 10 }, 415, 'unsupported_type'],
    [{ contentType: 'text/html', size: 10 }, 415, 'unsupported_type'],
    [{ contentType: 'video/mp4', size: MAX_BYTES + 1 }, 413, 'too_large'],
    [{ contentType: 'video/mp4', size: 0 }, 400, 'bad_request'],
    [{ contentType: 'video/mp4', size: 1.5 }, 400, 'bad_request']
  ];
  for (const [payload, status, code] of cases) {
    const { api, calls } = setup();
    const res = await call(api.upload, fakeReq({ method: 'POST', body: tokenRequest(payload) }));
    assert.strictEqual(res.statusCode, status, JSON.stringify(payload));
    assert.strictEqual(res.body.error, code);
    assert.strictEqual(calls.put.length + calls.handleUpload.length, 0, 'nothing written');
  }

  const { api } = setup();
  const exactlyMax = await call(api.upload, fakeReq({ method: 'POST', body: tokenRequest({ contentType: 'video/webm', size: MAX_BYTES }) }));
  assert.strictEqual(exactlyMax.statusCode, 200);

  const completed = await call(api.upload, fakeReq({ method: 'POST', body: { type: 'blob.upload-completed', payload: {} } }));
  assert.strictEqual(completed.statusCode, 400);
  const notJson = await call(api.upload, fakeReq({ method: 'POST', body: '{nope' }));
  assert.strictEqual(notJson.statusCode, 400);
  const get = await call(api.upload, fakeReq({ method: 'GET' }));
  assert.strictEqual(get.statusCode, 405);

  const disabled = setup({ env: { BLOB_READ_WRITE_TOKEN: '' } });
  const off = await call(disabled.api.upload, fakeReq({ method: 'POST', body: tokenRequest({ contentType: 'video/mp4', size: 1 }) }));
  assert.strictEqual(off.statusCode, 503);
  assert.strictEqual(off.body.error, 'disabled');
});

test('upload is rate limited per client address', async () => {
  let t = T0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  const { api } = setup({ limiter });
  const body = tokenRequest({ contentType: 'video/mp4', size: 1 });
  const send = (ip) => call(api.upload, fakeReq({ method: 'POST', body, headers: { 'x-forwarded-for': ip } }));
  assert.strictEqual((await send('198.51.100.1')).statusCode, 200);
  assert.strictEqual((await send('198.51.100.1')).statusCode, 200);
  const limited = await send('198.51.100.1');
  assert.strictEqual(limited.statusCode, 429);
  assert.strictEqual(limited.body.error, 'rate_limited');
  assert.strictEqual((await send('198.51.100.2')).statusCode, 200, 'other clients unaffected');
  t += 1000;
  assert.strictEqual((await send('198.51.100.1')).statusCode, 200, 'window resets');
});

test('meta returns what the viewer needs, and handles missing, unfinished and expired shares', async () => {
  let t = T0;
  const { api, blob } = setup({ now: () => t, env: { SHARE_SITE_URL: 'https://example.test/' } });
  const up = await call(api.upload, fakeReq({
    method: 'POST', body: tokenRequest({ title: 'Clip', contentType: 'video/mp4', size: 3, width: 1280, height: 720 })
  }));
  assert.strictEqual(up.body.url, `https://example.test/v/${up.body.id}`);
  const { id, pathname } = up.body;

  const pending = await call(api.meta, fakeReq({ query: { id } }));
  assert.strictEqual(pending.statusCode, 200);
  assert.strictEqual(pending.body.ready, false);
  assert.strictEqual(pending.body.url, null);
  assert.strictEqual(pending.headers['cache-control'], 'no-store');

  blob.files.set(pathname, { body: Buffer.from('abc'), contentType: 'video/mp4', uploadedAt: new Date(t) });
  t += 2 * 24 * 60 * 60 * 1000 + 1000;
  const ready = await call(api.meta, fakeReq({ query: { id } }));
  assert.strictEqual(ready.statusCode, 200);
  assert.deepStrictEqual(ready.body, {
    id, title: 'Clip', contentType: 'video/mp4', size: 3, width: 1280, height: 720, duration: null,
    createdAt: T0, expiresAt: T0 + TTL_MS, expiresInDays: 5, ready: true,
    url: `https://store.test/files/${pathname}`,
    downloadUrl: `https://store.test/files/${pathname}?download=1`
  });
  assert.match(ready.headers['cache-control'], /s-maxage=60/);
  assert.strictEqual(ready.headers['x-robots-tag'], 'noindex');

  // The id can also come from the URL (no query helper).
  const byUrl = await call(api.meta, fakeReq({ url: `/api/share/${id}` }));
  assert.strictEqual(byUrl.body.id, id);

  t = T0 + TTL_MS;
  const expired = await call(api.meta, fakeReq({ query: { id } }));
  assert.strictEqual(expired.statusCode, 410);
  assert.strictEqual(expired.body.error, 'expired');

  const unknown = await call(api.meta, fakeReq({ query: { id: 'AAAAAAAAAAAAAAAA' } }));
  assert.strictEqual(unknown.statusCode, 404);
  for (const bad of ['short', '../../../etc/pas', 'AAAAAAAAAAAAAAA/', '']) {
    const res = await call(api.meta, fakeReq({ query: { id: bad } }));
    assert.strictEqual(res.statusCode, 404, bad);
  }
});

test('cleanup deletes everything older than 7 days, page by page, and checks the cron secret', async () => {
  const t = T0;
  const { api, blob, calls } = setup({ now: () => t, env: { CRON_SECRET: 's3cret' } });
  const put = (p, ageMs) => blob.files.set(p, { body: Buffer.from('x'), uploadedAt: new Date(T0 - ageMs) });
  for (let i = 0; i < 1203; i++) put(`shares/old${String(i).padStart(5, '0')}/v.mp4`, TTL_MS + 1);
  put('shares/fresh/meta.json', TTL_MS - 60_000);
  put('shares/fresh/v.mp4', 1000);
  put('shares/edge/v.mp4', TTL_MS);
  put('elsewhere/keep.txt', 30 * TTL_MS);

  const denied = await call(api.cleanup, fakeReq({ headers: { authorization: 'Bearer wrong' } }));
  assert.strictEqual(denied.statusCode, 401);
  assert.strictEqual(calls.del.length, 0);

  const res = await call(api.cleanup, fakeReq({ headers: { authorization: 'Bearer s3cret' } }));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.deleted, 1204);
  assert.ok(calls.del.every(([urls]) => urls.length <= 100), 'deletes in batches');
  assert.deepStrictEqual([...blob.files.keys()].sort(), ['elsewhere/keep.txt', 'shares/fresh/meta.json', 'shares/fresh/v.mp4']);
});

test('cleanup runs without a cron secret configured', async () => {
  const { api, blob } = setup();
  blob.files.set('shares/a/v.mp4', { body: Buffer.from('x'), uploadedAt: new Date(T0 - TTL_MS - 1) });
  const res = await call(api.cleanup, fakeReq());
  assert.strictEqual(res.body.deleted, 1);
});

test('unexpected SDK failures become a plain 500 without details', async () => {
  const api = createShareApi({
    blob: { list: async () => { throw new Error('store exploded: token=abc'); } },
    env: { BLOB_READ_WRITE_TOKEN: RW_TOKEN }
  });
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a);
  try {
    const res = await call(api.meta, fakeReq({ query: { id: 'AAAAAAAAAAAAAAAA' } }));
    assert.strictEqual(res.statusCode, 500);
    assert.doesNotMatch(JSON.stringify(res.body), /token=abc/);
  } finally {
    console.error = original;
  }
  assert.strictEqual(errors.length, 1);
});

test('helpers', () => {
  assert.strictEqual(slugify('  Hello, World!  '), 'hello-world');
  assert.strictEqual(slugify('Café résumé'), 'cafe-resume');
  assert.strictEqual(slugify('日本語'), 'loupe-recording');
  assert.strictEqual(slugify('a'.repeat(100)).length, 60);
  assert.ok(isShareId(newShareId()));
  assert.notStrictEqual(newShareId(), newShareId());
  assert.strictEqual(isShareId('AAAAAAAAAAAAAAA'), false);
  assert.strictEqual(clientIp({ headers: { 'x-real-ip': '192.0.2.1' } }), '192.0.2.1');
  assert.strictEqual(clientIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
  // A client can't pick its own address by sending x-forwarded-for.
  assert.strictEqual(clientIp({ headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7', 'x-real-ip': '198.51.100.7' } }), '198.51.100.7');
  assert.strictEqual(clientIp({ headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' } }), '198.51.100.7');

  const p = parseClientPayload(JSON.stringify({
    title: 'a\u0000b\nc', contentType: 'image/gif', size: 5, width: -1, height: 99999, duration: 'x', extra: 1
  }));
  assert.deepStrictEqual(p, { contentType: 'image/gif', size: 5, title: 'a b c', width: null, height: null, duration: null });
  assert.throws(() => parseClientPayload(null), /Missing upload details/);
  assert.throws(() => parseClientPayload('[1]'), /Missing upload details/);
});

test('guessing links is limited and cached; an open cleanup runs at most every ten minutes', async () => {
  let t = T0;
  const { api } = setup({ now: () => t });
  let last;
  for (let i = 0; i < 121; i++) last = await call(api.meta, fakeReq({ query: { id: 'AAAAAAAAAAAAAAAA' }, headers: { 'x-real-ip': '192.0.2.5' } }));
  assert.strictEqual(last.statusCode, 429);
  const other = await call(api.meta, fakeReq({ query: { id: 'AAAAAAAAAAAAAAAA' }, headers: { 'x-real-ip': '192.0.2.6' } }));
  assert.strictEqual(other.statusCode, 404);
  assert.match(other.headers['cache-control'] ?? other.headers['Cache-Control'], /s-maxage=300/);
  assert.strictEqual((await call(api.cleanup, fakeReq())).statusCode, 200);
  assert.strictEqual((await call(api.cleanup, fakeReq())).statusCode, 429);
  t += 11 * 60 * 1000;
  assert.strictEqual((await call(api.cleanup, fakeReq())).statusCode, 200);
});
