'use strict';
// Checks the app's hand-written Blob client (src/main/share-client.js) and the
// mock Blob API against the real @vercel/blob SDK the website deploys with:
//
//  - the website's upload function, running the SDK's real handleUpload,
//    issues a token the app can upload with;
//  - the SDK's own client `put` sends the same protocol headers as the app,
//    for a single PUT and for multipart.
//
// Needs the website's dependencies (cd web && npm ci). Skipped without them,
// so `npm test` stays dependency-free.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const sdkDir = path.join(__dirname, '..', 'web', 'node_modules', '@vercel', 'blob');
const haveSdk = fs.existsSync(sdkDir);
const skip = haveSdk ? false : 'web/node_modules/@vercel/blob is not installed (cd web && npm ci)';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-share-sdk-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Headers that are part of the Blob protocol rather than HTTP plumbing.
const protocolHeaders = (headers) => Object.keys(headers)
  .filter((h) => h === 'authorization' || h.startsWith('x-'))
  .sort();

test('the app uploads with a token from the real SDK handleUpload', { skip }, async () => {
  const { handleUpload } = require(path.join(sdkDir, 'dist', 'client.cjs'));
  const { startMockShareServer } = require('./fixtures/mock-share-server');
  const { createShareClient } = require('../src/main/share-client');
  const { checkExportedFile } = require('../src/main/exported-file');

  const server = await startMockShareServer({ handleUpload });
  try {
    const p = path.join(tmp, 'real-token.mp4');
    fs.writeFileSync(p, crypto.randomBytes(200 * 1024));
    const client = createShareClient({ siteUrl: server.siteUrl, blobApiUrl: server.blobApiUrl });
    const result = await client.upload(checkExportedFile(p), { title: 'Real token' });
    const stored = server.blob.files.get(`shares/${result.id}/real-token.mp4`);
    assert.ok(stored && stored.body.equals(fs.readFileSync(p)));
  } finally {
    await server.close();
  }
});

test('the SDK client and the app send the same protocol headers', { skip }, async () => {
  const { handleUpload, put } = require(path.join(sdkDir, 'dist', 'client.cjs'));
  const { startMockShareServer } = require('./fixtures/mock-share-server');
  const { createShareClient } = require('../src/main/share-client');
  const { checkExportedFile } = require('../src/main/exported-file');

  const server = await startMockShareServer({ handleUpload });
  const previousApiUrl = process.env.VERCEL_BLOB_API_URL;
  process.env.VERCEL_BLOB_API_URL = server.blobApiUrl;
  try {
    for (const multipart of [false, true]) {
      const size = multipart ? 9 * 1024 * 1024 : 100 * 1024;
      const p = path.join(tmp, `compare-${multipart}.mp4`);
      fs.writeFileSync(p, crypto.randomBytes(size));
      const file = checkExportedFile(p);

      // The app.
      const client = createShareClient({
        siteUrl: server.siteUrl, blobApiUrl: server.blobApiUrl,
        multipartOver: multipart ? 1 : Infinity
      });
      server.requests.length = 0;
      await client.upload(file, {}, { onProgress: () => {} });
      const ours = server.requests.filter((r) => r.path.startsWith('/blob'));

      // The SDK, with a token from the same handshake.
      server.requests.length = 0;
      const handshake = await (await fetch(`${server.siteUrl}/api/share/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'blob.generate-client-token',
          payload: { pathname: 'x.mp4', clientPayload: JSON.stringify({ contentType: 'video/mp4', size }), multipart }
        })
      })).json();
      const sdkResult = await put(handshake.pathname, fs.readFileSync(p), {
        access: 'public', token: handshake.clientToken, contentType: 'video/mp4', multipart,
        onUploadProgress: () => {}
      });
      assert.strictEqual(sdkResult.pathname, handshake.pathname);
      assert.ok(server.blob.files.get(handshake.pathname).body.equals(fs.readFileSync(p)), 'SDK upload stored');
      const theirs = server.requests.filter((r) => r.path.startsWith('/blob'));

      const byStep = (reqs) => {
        const out = {};
        for (const r of reqs) {
          const step = `${r.method} ${r.path} ${r.headers['x-mpu-action'] ?? ''}`.trim();
          out[step] ??= protocolHeaders(r.headers);
        }
        return out;
      };
      // Same requests, each with exactly the same protocol headers.
      assert.deepStrictEqual(byStep(ours), byStep(theirs));
      for (const r of theirs) assert.strictEqual(r.headers['x-api-version'], '12');
    }
  } finally {
    if (previousApiUrl === undefined) delete process.env.VERCEL_BLOB_API_URL;
    else process.env.VERCEL_BLOB_API_URL = previousApiUrl;
    await server.close();
  }
});

test('the deployed function files work end to end with the real SDK', { skip }, async () => {
  const { startMockShareServer, RW_TOKEN } = require('./fixtures/mock-share-server');
  const { createShareClient } = require('../src/main/share-client');
  const { checkExportedFile } = require('../src/main/exported-file');
  const fn = (name) => require(path.join(__dirname, '..', 'web', 'api', 'share', name));
  const apiHandlers = { status: fn('status.js'), upload: fn('upload.js'), meta: fn('[id].js'), cleanup: fn('cleanup.js') };

  const saved = { ...process.env };
  const server = await startMockShareServer({ apiHandlers });
  Object.assign(process.env, {
    BLOB_READ_WRITE_TOKEN: RW_TOKEN, VERCEL_BLOB_API_URL: server.blobApiUrl,
    SHARE_SITE_URL: 'https://loupe.example', CRON_SECRET: 'cron-test'
  });
  try {
    const client = createShareClient({ siteUrl: server.siteUrl, blobApiUrl: server.blobApiUrl });
    assert.strictEqual((await client.status()).enabled, true);

    const p = path.join(tmp, 'deployed.gif');
    fs.writeFileSync(p, crypto.randomBytes(50 * 1024));
    const result = await client.upload(checkExportedFile(p), { title: 'Deployed', width: 640, height: 360 });
    assert.strictEqual(result.url, `https://loupe.example/v/${result.id}`);

    const metaRes = await fetch(`${server.base}/api/share/${result.id}`);
    assert.strictEqual(metaRes.status, 200);
    const meta = await metaRes.json();
    assert.strictEqual(meta.ready, true);
    assert.strictEqual(meta.contentType, 'image/gif');
    assert.strictEqual(meta.title, 'Deployed');
    const media = await fetch(meta.url);
    assert.ok(Buffer.from(await media.arrayBuffer()).equals(fs.readFileSync(p)), 'viewer URL serves the upload');

    // Age everything past 7 days, then run the cron.
    for (const f of server.blob.files.values()) f.uploadedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const denied = await fetch(`${server.base}/api/share/cleanup`);
    assert.strictEqual(denied.status, 401);
    const cleanup = await fetch(`${server.base}/api/share/cleanup`, { headers: { authorization: 'Bearer cron-test' } });
    assert.deepStrictEqual(await cleanup.json(), { deleted: 2, scanned: 2 });
    assert.strictEqual(server.blob.files.size, 0);
    assert.strictEqual((await fetch(`${server.base}/api/share/${result.id}`)).status, 404);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    await server.close();
  }
});
