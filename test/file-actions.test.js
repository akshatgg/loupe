'use strict';
// File actions IPC (src/main/ipc/fileActions.js) with fake Electron modules.
// The real macOS clipboard is exercised by test/e2e/file-actions.e2e.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerFileActionsIpc, createFileActions, rawFormat } = require('../src/main/ipc/fileActions');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-file-actions-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const video = path.join(tmp, 'my export.mp4');
fs.writeFileSync(video, 'video');

class FakeClipboardItem {
  constructor(items) { this.items = items; }
}

function fakes(overrides = {}) {
  const log = { writes: [], texts: [], shown: [], drags: [], exec: [], bitmaps: [] };
  const deps = {
    ClipboardItem: FakeClipboardItem,
    clipboard: {
      write: async (items) => { log.writes.push(items.map((i) => i.items)); },
      writeText: async (t) => { log.texts.push(t); }
    },
    shell: { showItemInFolder: (p) => log.shown.push(p) },
    app: { getFileIcon: async () => ({ isEmpty: () => false, name: 'file-icon' }) },
    nativeImage: { createFromBitmap: (buf, size) => { log.bitmaps.push([buf, size]); return { name: 'fallback' }; } },
    execFile: (cmd, args, opts, cb) => { log.exec.push({ cmd, args, opts }); cb(null); },
    ...overrides
  };
  return { deps, log };
}

test('macOS: the file goes on the clipboard as a public.file-url', async () => {
  const { deps, log } = fakes({ platform: 'darwin' });
  const actions = createFileActions(deps);
  assert.deepStrictEqual(await actions.copyFile(video), { ok: true });
  const url = `file://${tmp.split(path.sep).map(encodeURIComponent).join('/')}/my%20export.mp4`;
  assert.deepStrictEqual(log.writes, [[{ 'electron application/osclipboard;format="public.file-url"': url }]]);
});

test('Windows: PowerShell gets the path through the environment, with a FileNameW fallback', async () => {
  const { deps, log } = fakes({ platform: 'win32' });
  const actions = createFileActions(deps);
  assert.deepStrictEqual(await actions.copyFile(video), { ok: true });
  assert.strictEqual(log.exec.length, 1);
  const { cmd, args, opts } = log.exec[0];
  assert.strictEqual(cmd, 'powershell.exe');
  assert.strictEqual(args.at(-1), 'Set-Clipboard -LiteralPath $env:LOUPE_CLIPBOARD_FILE');
  assert.ok(!args.some((a) => a.includes(video)), 'path never appears in the command line');
  assert.strictEqual(opts.env.LOUPE_CLIPBOARD_FILE, video);
  assert.strictEqual(opts.windowsHide, true);
  assert.strictEqual(log.writes.length, 0);

  const failing = fakes({ platform: 'win32', execFile: (c, a, o, cb) => cb(new Error('no powershell')) });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepStrictEqual(await createFileActions(failing.deps).copyFile(video), { ok: true });
  } finally {
    console.warn = warn;
  }
  const [[item]] = failing.log.writes;
  const blob = item[rawFormat('FileNameW')];
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.strictEqual(bytes.toString('utf16le'), `${video}\0`);
});

test('invalid paths are refused before touching the clipboard, shell or drag', async () => {
  const { deps, log } = fakes({ platform: 'darwin' });
  const actions = createFileActions(deps);
  const sender = { startDrag: (item) => log.drags.push(item) };
  for (const p of ['/etc/passwd', 'relative.mp4', path.join(tmp, 'missing.mp4'), null]) {
    assert.strictEqual((await actions.copyFile(p)).ok, false);
    assert.strictEqual(actions.reveal(p).ok, false);
    assert.strictEqual(actions.startDrag(sender, p).ok, false);
    assert.strictEqual((await actions.prepareDrag(p)).ok, false);
  }
  assert.deepStrictEqual(log, { writes: [], texts: [], shown: [], drags: [], exec: [], bitmaps: [] });
});

test('a clipboard failure is reported, not thrown', async () => {
  const { deps } = fakes({ platform: 'darwin', clipboard: { write: async () => { throw new Error('denied'); } } });
  const error = console.error;
  console.error = () => {};
  try {
    const res = await createFileActions(deps).copyFile(video);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'failed');
  } finally {
    console.error = error;
  }
});

test('drag uses the prepared file icon, or a drawn fallback', async () => {
  const { deps, log } = fakes({ platform: 'darwin' });
  const actions = createFileActions(deps);
  const sender = { startDrag: (item) => log.drags.push(item) };

  assert.deepStrictEqual(actions.startDrag(sender, video), { ok: true });
  assert.strictEqual(log.drags[0].file, video);
  assert.strictEqual(log.drags[0].icon.name, 'fallback');
  const [bitmap, size] = log.bitmaps[0];
  assert.deepStrictEqual(size, { width: 32, height: 32 });
  assert.strictEqual(bitmap[3], 0, 'rounded corner is transparent');
  const centre = (16 * 32 + 16) * 4;
  assert.deepStrictEqual([...bitmap.subarray(centre, centre + 4)], [0xf8, 0xb4, 0x8a, 0xff]);

  assert.deepStrictEqual(await actions.prepareDrag(video), { ok: true });
  actions.startDrag(sender, video);
  assert.strictEqual(log.drags[1].icon.name, 'file-icon');
  actions.startDrag(sender, video);
  assert.strictEqual(log.bitmaps.length, 1, 'fallback drawn once');
});

test('reveal and copyText', async () => {
  const { deps, log } = fakes({ platform: 'darwin' });
  const actions = createFileActions(deps);
  assert.deepStrictEqual(actions.reveal(video), { ok: true });
  assert.deepStrictEqual(log.shown, [video]);
  assert.deepStrictEqual(await actions.copyText('https://loupeapp.vercel.app/v/abc'), { ok: true });
  assert.deepStrictEqual(log.texts, ['https://loupeapp.vercel.app/v/abc']);
  assert.strictEqual((await actions.copyText('')).ok, false);
  assert.strictEqual((await actions.copyText({})).ok, false);
  assert.strictEqual((await actions.copyText('x'.repeat(9000))).ok, false);
});

test('registration wires every channel', async () => {
  const handles = new Map();
  const ipcMain = { handle: (c, f) => handles.set(c, f) };
  const { deps, log } = fakes({ platform: 'darwin' });
  registerFileActionsIpc(ipcMain, deps);
  assert.deepStrictEqual([...handles.keys()].sort(),
    ['clipboard:writeText', 'file:copy', 'file:prepareDrag', 'file:reveal', 'file:startDrag']);

  assert.deepStrictEqual(await handles.get('file:copy')({}, video), { ok: true });
  const sender = { startDrag: (item) => log.drags.push(item) };
  assert.deepStrictEqual(handles.get('file:startDrag')({ sender }, video), { ok: true });
  assert.strictEqual(log.drags.length, 1);
  // A throwing drag does not take the main process down.
  const error = console.error;
  console.error = () => {};
  try {
    const res = handles.get('file:startDrag')({ sender: { startDrag: () => { throw new Error('no gesture'); } } }, video);
    assert.strictEqual(res.ok, false);
  } finally {
    console.error = error;
  }
});
