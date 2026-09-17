'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { MODELS, createSpeechModels, validateModelKey } = require('../src/main/speech-models');
const { validateSubtitlePayload, registerCaptionsIpc } = require('../src/main/ipc/captions');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const gitBlob = (b) => crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-models-'));
}

// A tiny model: one small file (git blob id) and one "large" file (sha256).
function fixture() {
  const small = Buffer.from('{"model_type":"whisper"}');
  const large = crypto.randomBytes(200 * 1024);
  const catalog = {
    tiny: {
      label: 'Tiny', description: 'test', id: 'org/tiny', revision: 'abc123', dtype: { encoder_model: 'fp32' },
      files: [
        { path: 'config.json', size: small.length, git: gitBlob(small) },
        { path: 'onnx/encoder_model.onnx', size: large.length, sha256: sha256(large) }
      ]
    }
  };
  return { small, large, catalog, bodies: { 'config.json': small, 'onnx/encoder_model.onnx': large } };
}

// fetch() stand-in serving `bodies`, streaming in 16 KB pieces, honouring Range.
function fakeFetch(bodies, { log = [], corrupt = false, failAfter = null, ignoreRange = false, delayMs = 0 } = {}) {
  return async (url, { headers = {}, signal } = {}) => {
    log.push({ url, range: headers.Range });
    const m = /\/org\/tiny\/resolve\/abc123\/(.+)$/.exec(url);
    if (!m) return { ok: false, status: 404, body: null };
    let body = Buffer.from(bodies[m[1]]);
    if (corrupt) body[body.length - 1] ^= 0xff;
    let status = 200;
    const range = headers.Range && /bytes=(\d+)-/.exec(headers.Range);
    if (range && !ignoreRange) { body = body.subarray(Number(range[1])); status = 206; }
    let sent = 0;
    return {
      ok: true,
      status,
      body: {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < body.length; i += 16 * 1024) {
            if (signal?.aborted) throw new Error('aborted');
            if (failAfter !== null && sent >= failAfter) throw new Error('connection reset');
            const piece = body.subarray(i, i + 16 * 1024);
            sent += piece.length;
            yield piece;
            await new Promise((r) => (delayMs ? setTimeout(r, delayMs) : setImmediate(r)));
          }
        },
        cancel: async () => {}
      }
    };
  };
}

test('the model catalogue pins every file to a revision, size and hash', () => {
  for (const [key, m] of Object.entries(MODELS)) {
    assert.strictEqual(validateModelKey(key), key);
    assert.match(m.revision, /^[0-9a-f]{40}$/);
    assert.ok(m.label && m.description);
    for (const f of m.files) {
      assert.ok(Number.isInteger(f.size) && f.size > 0, f.path);
      assert.ok(/^[0-9a-f]{64}$/.test(f.sha256 ?? '') || /^[0-9a-f]{40}$/.test(f.git ?? ''), f.path);
      assert.ok(!f.path.includes('..') && !path.isAbsolute(f.path));
    }
    // What transformers.js loads for the chosen dtypes must be in the list.
    for (const [part, dtype] of Object.entries(m.dtype)) {
      const suffix = dtype === 'fp32' ? '' : `_${dtype}`;
      assert.ok(m.files.some((f) => f.path === `onnx/${part}${suffix}.onnx`), `${key}: ${part} ${dtype}`);
    }
  }
  for (const bad of ['', 'toString', '__proto__', null, 42, '../x']) assert.throws(() => validateModelKey(bad));
});

test('downloads a model once, with progress, into the folder the worker reads', async () => {
  const root = tmp();
  try {
    const { catalog, bodies, large } = fixture();
    const log = [];
    const models = createSpeechModels({ root: () => root, fetchImpl: fakeFetch(bodies, { log }), catalog });
    assert.deepStrictEqual(models.list().map((m) => [m.key, m.downloaded, m.downloading]), [['tiny', false, false]]);

    const progress = [];
    const p = models.ensure('tiny', (e) => progress.push(e));
    assert.strictEqual(models.info('tiny').downloading, true);
    // A second caller joins the same download.
    const again = models.ensure('tiny');
    const info = await p;
    assert.deepStrictEqual(await again, info);

    assert.deepStrictEqual(info, { key: 'tiny', id: 'org/tiny', dtype: { encoder_model: 'fp32' }, baseUrl: `${pathToFileURL(root).href}/` });
    assert.ok(fs.readFileSync(path.join(root, 'org', 'tiny', 'onnx', 'encoder_model.onnx')).equals(large));
    assert.strictEqual(log.length, 2);
    const last = progress[progress.length - 1];
    assert.strictEqual(last.received, last.total);
    assert.strictEqual(last.total, large.length + bodies['config.json'].length);
    assert.strictEqual(models.info('tiny').downloaded, true);

    // Already there: no network at all.
    await models.ensure('tiny');
    assert.strictEqual(log.length, 2);

    // A deleted file is noticed and fetched again.
    fs.rmSync(path.join(root, 'org', 'tiny', 'config.json'));
    assert.strictEqual(models.isDownloaded('tiny'), false);
    await models.ensure('tiny');
    assert.strictEqual(log.length, 3);

    const removed = await models.remove('tiny');
    assert.strictEqual(removed.downloaded, false);
    assert.strictEqual(fs.existsSync(path.join(root, 'org', 'tiny')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a file that does not match its hash is thrown away', async () => {
  const root = tmp();
  try {
    const { catalog, bodies } = fixture();
    const models = createSpeechModels({ root, fetchImpl: fakeFetch(bodies, { corrupt: true }), catalog });
    await assert.rejects(models.ensure('tiny'), (err) => err.code === 'corrupt' && /not what was expected/.test(err.message));
    assert.strictEqual(models.isDownloaded('tiny'), false);
    assert.strictEqual(fs.existsSync(path.join(root, 'org', 'tiny', 'config.json.part')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an interrupted download picks up where it stopped', async () => {
  const root = tmp();
  try {
    const { catalog, bodies, large } = fixture();
    const broken = createSpeechModels({ root, fetchImpl: fakeFetch(bodies, { failAfter: 64 * 1024 }), catalog });
    await assert.rejects(broken.ensure('tiny'), (err) => err.code === 'network' && /internet connection/.test(err.message));
    const part = path.join(root, 'org', 'tiny', 'onnx', 'encoder_model.onnx.part');
    const kept = fs.statSync(part).size;
    assert.ok(kept > 0 && kept < large.length);

    const log = [];
    const models = createSpeechModels({ root, fetchImpl: fakeFetch(bodies, { log }), catalog });
    await models.ensure('tiny');
    assert.deepStrictEqual(log.map((l) => l.range), [`bytes=${kept}-`]);
    assert.ok(fs.readFileSync(path.join(root, 'org', 'tiny', 'onnx', 'encoder_model.onnx')).equals(large));

    // A server that ignores Range still ends with the right file.
    fs.rmSync(path.join(root, 'org'), { recursive: true });
    await assert.rejects(createSpeechModels({ root, fetchImpl: fakeFetch(bodies, { failAfter: 64 * 1024 }), catalog }).ensure('tiny'));
    await createSpeechModels({ root, fetchImpl: fakeFetch(bodies, { ignoreRange: true }), catalog }).ensure('tiny');
    assert.ok(fs.readFileSync(path.join(root, 'org', 'tiny', 'onnx', 'encoder_model.onnx')).equals(large));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a download can be cancelled', async () => {
  const root = tmp();
  try {
    const { catalog, bodies } = fixture();
    const models = createSpeechModels({ root, fetchImpl: fakeFetch(bodies, { delayMs: 10 }), catalog });
    const p = models.ensure('tiny');
    await new Promise((r) => setTimeout(r, 40));
    const cancelled = models.cancel('tiny');
    await assert.rejects(p, (err) => err.code === 'cancelled');
    assert.strictEqual(cancelled, true);
    assert.strictEqual(models.cancel('tiny'), false, 'nothing running any more');
    assert.strictEqual(models.info('tiny').downloading, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saving subtitles only takes a format, the text and a plain file name', () => {
  assert.deepStrictEqual(validateSubtitlePayload({ format: 'srt', text: '1\n', name: 'My demo.srt' }),
    { format: 'srt', text: '1\n', name: 'My demo' });
  assert.strictEqual(validateSubtitlePayload({ format: 'vtt', text: '', name: '../../etc/passwd' }).name, 'passwd');
  assert.strictEqual(validateSubtitlePayload({ format: 'vtt', text: '', name: 'a:b*c?' }).name, 'abc');
  assert.strictEqual(validateSubtitlePayload({ format: 'vtt', text: '' }).name, 'Captions');
  assert.throws(() => validateSubtitlePayload({ format: 'exe', text: '' }));
  assert.throws(() => validateSubtitlePayload({ format: 'srt', text: 5 }));
  assert.throws(() => validateSubtitlePayload(null));
});

test('the IPC handlers validate model keys and write the file the user picked', async () => {
  const root = tmp();
  try {
    const handlers = {};
    const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
    const target = path.join(root, 'out.vtt');
    let dialogOpts = null;
    const dialog = { showSaveDialog: async (opts) => { dialogOpts = opts; return { canceled: false, filePath: target }; } };
    const { catalog, bodies } = fixture();
    const models = createSpeechModels({ root, fetchImpl: fakeFetch(bodies), catalog });
    registerCaptionsIpc({
      ipcMain, dialog, models,
      app: { getPath: () => root },
      BrowserWindow: { fromWebContents: () => null },
      getDefaultDir: () => '/recordings/one'
    });
    assert.deepStrictEqual(Object.keys(handlers).sort(), [
      'captions:model-cancel', 'captions:model-ensure', 'captions:model-remove', 'captions:models', 'captions:save-subtitles'
    ]);
    const sent = [];
    const sender = { isDestroyed: () => false, send: (ch, d) => sent.push([ch, d]) };
    assert.throws(() => handlers['captions:model-ensure']({ sender }, 'nope'));
    await handlers['captions:model-ensure']({ sender }, 'tiny');
    assert.ok(sent.length > 0 && sent.every(([ch]) => ch === 'captions:model-progress'));

    const res = await handlers['captions:save-subtitles']({ sender }, { format: 'vtt', text: 'WEBVTT\n', name: 'Demo' });
    assert.deepStrictEqual(res, { saved: true, path: target });
    assert.strictEqual(dialogOpts.defaultPath, path.join('/recordings/one', 'Demo.vtt'));
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'WEBVTT\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
