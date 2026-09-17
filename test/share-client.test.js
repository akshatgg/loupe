'use strict';
// The app's share uploader (src/main/share-client.js) against a local server
// that implements the website's handshake and the Blob API protocol
// (test/fixtures/mock-share-server.js), over real HTTP with real fetch.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createShareClient, ShareError, isNetworkError } = require('../src/main/share-client');
const { checkExportedFile } = require('../src/main/exported-file');
const { startMockShareServer, verifyClientToken, RW_TOKEN, STORE_ID } = require('./fixtures/mock-share-server');

const { AbortController, ReadableStream, fetch } = globalThis;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-share-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeFile(name, size) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, crypto.randomBytes(size));
  return checkExportedFile(p);
}

async function withServer(opts, fn) {
  const server = await startMockShareServer(opts);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

const clientFor = (server, extra = {}) => createShareClient({
  siteUrl: server.siteUrl, blobApiUrl: server.blobApiUrl, retryDelayMs: 5, ...extra
});

test('status reads the website and treats anything else as disabled', async () => {
  await withServer({}, async (server) => {
    assert.deepStrictEqual(await clientFor(server).status(),
      { enabled: true, maxBytes: 500 * 1024 * 1024, expiresInDays: 7 });
  });
  await withServer({ env: { BLOB_READ_WRITE_TOKEN: '' } }, async (server) => {
    assert.strictEqual((await clientFor(server).status()).enabled, false);
  });
  await withServer({ intercept: (r) => (r.path === '/api/share/status' ? { status: 500 } : undefined) }, async (server) => {
    assert.strictEqual((await clientFor(server).status()).enabled, false);
  });
});

test('status and upload report offline when nothing is listening', async () => {
  const server = await startMockShareServer();
  const client = clientFor(server);
  await server.close();
  await assert.rejects(client.status(), (err) => err instanceof ShareError && err.code === 'offline');
  const file = makeFile('offline.mp4', 1000);
  await assert.rejects(client.upload(file), (err) => err.code === 'offline' && /offline/.test(err.message));
});

test('a small file goes up in one PUT with the SDK headers and lands intact', async () => {
  await withServer({}, async (server) => {
    const file = makeFile('small clip.mp4', 300 * 1024 + 17);
    const progress = [];
    const result = await clientFor(server).upload(file, { title: 'Small clip', width: 1920, height: 1080, duration: 3.2 },
      { onProgress: (p) => progress.push(p) });

    assert.match(result.id, /^[A-Za-z0-9_-]{16}$/);
    assert.strictEqual(result.url, `https://share.test/v/${result.id}`);
    assert.ok(result.expiresAt > Date.now());

    const stored = server.blob.files.get(`shares/${result.id}/small-clip.mp4`);
    assert.ok(stored, 'uploaded under the server-chosen pathname');
    assert.ok(stored.body.equals(fs.readFileSync(file.path)), 'bytes intact');
    assert.strictEqual(stored.contentType, 'video/mp4');
    assert.strictEqual(result.blobUrl, `${server.base}/files/shares/${result.id}/small-clip.mp4`);

    const handshake = server.requests.find((r) => r.path === '/api/share/upload');
    assert.strictEqual(handshake.method, 'POST');
    const put = server.requests.find((r) => r.path === '/blob/');
    assert.strictEqual(put.method, 'PUT');
    assert.strictEqual(put.query.pathname, `shares/${result.id}/small-clip.mp4`);
    assert.strictEqual(put.headers['x-api-version'], '12');
    assert.strictEqual(put.headers['x-vercel-blob-store-id'], STORE_ID);
    assert.strictEqual(put.headers['x-vercel-blob-access'], 'public');
    assert.strictEqual(put.headers['x-content-type'], 'video/mp4');
    assert.strictEqual(put.headers['x-content-length'], String(file.size));
    assert.strictEqual(put.headers['x-api-blob-request-attempt'], '0');
    assert.match(put.headers['x-api-blob-request-id'], new RegExp(`^${STORE_ID}:\\d+:[0-9a-f]+$`));
    assert.ok(verifyClientToken(RW_TOKEN, put.headers.authorization.replace('Bearer ', '')));

    // The viewer metadata now reports it ready, with what the app sent.
    const meta = await (await fetch(`${server.base}/api/share/${result.id}`)).json();
    assert.strictEqual(meta.ready, true);
    assert.strictEqual(meta.title, 'Small clip');
    assert.strictEqual(meta.width, 1920);
    assert.strictEqual(meta.duration, 3.2);
    assert.strictEqual(meta.size, file.size);

    assert.ok(progress.length >= 2);
    assert.deepStrictEqual(progress[0], { loaded: 0, total: file.size, fraction: 0 });
    assert.deepStrictEqual(progress.at(-1), { loaded: file.size, total: file.size, fraction: 1 });
    for (let i = 1; i < progress.length; i++) {
      assert.ok(progress[i].loaded >= progress[i - 1].loaded, 'progress never goes backwards on success');
    }
  });
});

test('a large file goes up in parts, in order, and progress covers every byte', async () => {
  // Every progress update is kept (no throttle), so the check doesn't depend
  // on how fast the machine uploads over loopback.
  await withServer({ chunkDelayMs: 3 }, async (server) => {
    const file = makeFile('big.webm', 5 * 1024 * 1024 + 123);
    const progress = [];
    const client = clientFor(server, { partSize: 1024 * 1024, multipartOver: 2 * 1024 * 1024, progressIntervalMs: 0 });
    const result = await client.upload(file, {}, { onProgress: (p) => progress.push(p) });

    const stored = server.blob.files.get(`shares/${result.id}/loupe-recording.webm`);
    assert.ok(stored && stored.body.equals(fs.readFileSync(file.path)), 'reassembled bytes intact');
    const mpu = server.requests.filter((r) => r.path === '/blob/mpu');
    assert.deepStrictEqual(mpu.map((r) => r.headers['x-mpu-action']).filter((a, i, all) => all.indexOf(a) === i),
      ['create', 'upload', 'complete']);
    const parts = mpu.filter((r) => r.headers['x-mpu-action'] === 'upload');
    assert.deepStrictEqual(parts.map((r) => Number(r.headers['x-mpu-part-number'])).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
    assert.strictEqual(parts.find((r) => r.headers['x-mpu-part-number'] === '6').headers['x-content-length'], '123');
    assert.strictEqual(progress.at(-1).fraction, 1);
    assert.ok(progress.some((p) => p.fraction > 0 && p.fraction < 1), 'reports progress along the way');
  });
});

test('a part that fails once with a server error is retried', async () => {
  let failed = false;
  const intercept = (r) => {
    if (!failed && r.headers['x-mpu-part-number'] === '2') {
      failed = true;
      return { status: 502, json: { error: { code: 'service_unavailable' } } };
    }
    return undefined;
  };
  await withServer({ intercept }, async (server) => {
    const file = makeFile('retry.mp4', 3 * 1024 * 1024);
    const client = clientFor(server, { partSize: 1024 * 1024, multipartOver: 1024 * 1024 });
    const result = await client.upload(file);
    assert.ok(server.blob.files.get(`shares/${result.id}/loupe-recording.mp4`).body.equals(fs.readFileSync(file.path)));
    const attempts = server.requests.filter((r) => r.headers['x-mpu-part-number'] === '2')
      .map((r) => r.headers['x-api-blob-request-attempt']);
    assert.deepStrictEqual(attempts, ['0', '1']);
  });
});

test('cancel stops an upload in flight', async () => {
  await withServer({ chunkDelayMs: 20 }, async (server) => {
    const file = makeFile('cancel.mp4', 4 * 1024 * 1024);
    const controller = new AbortController();
    const started = Date.now();
    const pending = clientFor(server).upload(file, {}, {
      signal: controller.signal,
      onProgress: (p) => { if (p.loaded > 0) controller.abort(); }
    });
    await assert.rejects(pending, (err) => err.code === 'cancelled' && err.message === 'Upload cancelled.');
    assert.ok(Date.now() - started < 5000, 'returns promptly');
    assert.strictEqual([...server.blob.files.keys()].filter((k) => !k.endsWith('meta.json')).length, 0, 'nothing stored');
  });

  // Already cancelled before it starts: no request at all.
  await withServer({}, async (server) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(clientFor(server).upload(makeFile('pre.mp4', 10), {}, { signal: controller.signal }),
      (err) => err.code === 'cancelled');
    assert.strictEqual(server.requests.length, 0);
  });
});

test('a request that stops making progress is dropped and retried', async () => {
  // The first PUT is never answered (a connection that silently died).
  let hung = false;
  const intercept = (r) => {
    if (!hung && r.path === '/blob/') {
      hung = true;
      return { hang: true };
    }
    return undefined;
  };
  await withServer({ intercept }, async (server) => {
    const file = makeFile('stall.mp4', 3 * 1024 * 1024);
    const started = Date.now();
    const result = await clientFor(server, { stallTimeoutMs: 300 }).upload(file);
    assert.ok(Date.now() - started < 5000, 'recovers promptly');
    assert.ok(server.blob.files.get(`shares/${result.id}/loupe-recording.mp4`).body.equals(fs.readFileSync(file.path)));
    assert.deepStrictEqual(server.requests.filter((r) => r.path === '/blob/').map((r) => r.headers['x-api-blob-request-attempt']),
      ['0', '1']);
  });

  // Never answered at all: gives up with a friendly error instead of hanging.
  await withServer({ intercept: (r) => (r.path.startsWith('/blob') ? { hang: true } : undefined) }, async (server) => {
    await assert.rejects(clientFor(server, { stallTimeoutMs: 200 }).upload(makeFile('dead.mp4', 1024 * 1024)),
      (err) => err instanceof ShareError && err.code === 'offline');
  });
});

test('a slow upload that keeps moving is not mistaken for a stall', async () => {
  // fetch pulls the body slowly, the way it does over a slow connection.
  const slowFetch = (url, init) => {
    if (!(init.body instanceof ReadableStream)) return fetch(url, init);
    const reader = init.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 40));
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      }
    });
    return fetch(url, { ...init, body });
  };
  await withServer({}, async (server) => {
    const file = makeFile('slow.mp4', 1024 * 1024);
    const started = Date.now();
    const result = await clientFor(server, { stallTimeoutMs: 200, fetch: slowFetch }).upload(file);
    assert.ok(Date.now() - started > 400, `took ${Date.now() - started} ms, well over the stall timeout`);
    assert.ok(server.blob.files.get(`shares/${result.id}/loupe-recording.mp4`).body.equals(fs.readFileSync(file.path)));
    assert.ok(server.requests.filter((r) => r.path === '/blob/').every((r) => r.headers['x-api-blob-request-attempt'] === '0'));
  });
});

test('failures become friendly codes', async () => {
  const cases = [
    [{ env: { BLOB_READ_WRITE_TOKEN: '' } }, 'disabled'],
    [{ intercept: (r) => (r.path === '/api/share/upload' ? { status: 429 } : undefined) }, 'rate_limited'],
    [{ intercept: (r) => (r.path === '/api/share/upload' ? { status: 500 } : undefined) }, 'failed'],
    [{ intercept: (r) => (r.path === '/api/share/upload' ? { status: 200, json: { nope: true } } : undefined) }, 'failed'],
    [{ intercept: (r) => (r.path === '/blob/' ? { status: 400, json: { error: { code: 'file_too_large' } } } : undefined) }, 'too_large'],
    [{ intercept: (r) => (r.path === '/blob/' ? { status: 403, json: { error: { code: 'store_suspended' } } } : undefined) }, 'disabled'],
    [{ intercept: (r) => (r.path === '/blob/' ? { status: 503, json: {} } : undefined) }, 'failed']
  ];
  for (const [opts, code] of cases) {
    await withServer(opts, async (server) => {
      await assert.rejects(clientFor(server).upload(makeFile('f.mp4', 2048)),
        (err) => err instanceof ShareError && err.code === code && err.message.length > 0, code);
    });
  }

  // Checked before any request.
  await withServer({}, async (server) => {
    const client = clientFor(server);
    await assert.rejects(client.upload({ path: '/x.mov', size: 10, contentType: 'video/quicktime', name: 'x.mov' }),
      (err) => err.code === 'unsupported');
    await assert.rejects(client.upload({ path: '/x.mp4', size: 500 * 1024 * 1024 + 1, contentType: 'video/mp4', name: 'x.mp4' }),
      (err) => err.code === 'too_large');
    assert.strictEqual(server.requests.length, 0);
  });
});

test('isNetworkError', () => {
  assert.ok(isNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })));
  assert.ok(isNetworkError({ name: 'TimeoutError' }));
  assert.ok(!isNetworkError(new Error('boom')));
  assert.ok(!isNetworkError(null));
});
