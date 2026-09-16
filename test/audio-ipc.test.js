'use strict';
// The main-process side of voiceover and music: files written into the open
// project's folder, with every renderer-supplied value validated.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  registerVoiceoverIpc, validateVoiceoverPayload, containerExtension
} = require('../src/main/ipc/voiceover');
const { registerMusicIpc, validateMusicPath, safeStem } = require('../src/main/ipc/music');
const { resolveProjectFile } = require('../src/main/ipc/project-files');

const WEBM = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81];
const OGG = [0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0];
const MP4 = [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20];

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `loupe-${name}-`));
}

function harness({ projectDir, openResult } = {}) {
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const dialogCalls = [];
  const dialog = { showOpenDialog: async (win, opts) => { dialogCalls.push(opts); return openResult; } };
  const BrowserWindow = { fromWebContents: () => null };
  const getProjectDir = () => projectDir;
  registerVoiceoverIpc({ ipcMain, getProjectDir });
  registerMusicIpc({ ipcMain, dialog, BrowserWindow, getProjectDir });
  // ipcRenderer.invoke always returns a promise, even for a handler that throws.
  const invoke = async (ch, ...args) => handlers[ch]({ sender: {} }, ...args);
  return { handlers, invoke, dialogCalls };
}

test('container is detected from the bytes', () => {
  assert.strictEqual(containerExtension(Uint8Array.from(WEBM)), '.webm');
  assert.strictEqual(containerExtension(Uint8Array.from(OGG)), '.ogg');
  assert.strictEqual(containerExtension(Uint8Array.from(MP4)), '.m4a');
  assert.strictEqual(containerExtension(Uint8Array.from([0x3c, 0x68, 0x74, 0x6d, 0x6c])), null);
  assert.strictEqual(containerExtension(new Uint8Array(2)), null);
});

test('voiceover payload validation', () => {
  assert.throws(() => validateVoiceoverPayload(null), /Invalid/);
  assert.throws(() => validateVoiceoverPayload({ data: 'abc' }), /Invalid/);
  assert.throws(() => validateVoiceoverPayload({ data: [0x1a, 0x45, 0xdf, 0xa3] }), /Invalid/);
  assert.throws(() => validateVoiceoverPayload({ data: new Uint8Array(0) }), /empty/);
  assert.throws(() => validateVoiceoverPayload({ data: Uint8Array.from([1, 2, 3, 4, 5]) }), /Unsupported/);
  assert.strictEqual(validateVoiceoverPayload({ data: Uint8Array.from(WEBM).buffer }).ext, '.webm');
});

test('voiceover:save writes numbered takes into <project>/voiceover', async () => {
  const dir = tmpDir('vo');
  const { invoke } = harness({ projectDir: dir });
  const a = await invoke('voiceover:save', { data: Uint8Array.from(WEBM), mimeType: 'audio/png' });
  const b = await invoke('voiceover:save', { data: Uint8Array.from(WEBM).buffer });
  const c = await invoke('voiceover:save', { data: Uint8Array.from(OGG) });
  assert.deepStrictEqual([a.file, b.file, c.file],
    ['voiceover/Voiceover.webm', 'voiceover/Voiceover 2.webm', 'voiceover/Voiceover.ogg']);
  assert.deepStrictEqual([...fs.readFileSync(path.join(dir, a.file))], WEBM);
  assert.strictEqual(a.bytes, WEBM.length);
  await assert.rejects(invoke('voiceover:save', { data: new Uint8Array([60, 33, 45, 45]) }));
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'voiceover')).sort(),
    ['Voiceover 2.webm', 'Voiceover.ogg', 'Voiceover.webm']);
});

test('voiceover:delete removes a take and refuses anything else', async () => {
  const dir = tmpDir('vodel');
  fs.writeFileSync(path.join(dir, 'project.json'), '{}');
  const { invoke } = harness({ projectDir: dir });
  const { file } = await invoke('voiceover:save', { data: Uint8Array.from(WEBM) });
  for (const bad of ['../project.json', 'voiceover/../project.json', '/etc/hosts', 'voiceover\\..\\project.json',
    'project.json', 'voiceover/', 'voiceover/a/b.webm', 'music/x.webm', 'voiceover/..', 42, null]) {
    await assert.rejects(invoke('voiceover:delete', { file: bad }), /Invalid/, String(bad));
  }
  fs.writeFileSync(path.join(dir, 'voiceover', 'notes.txt'), 'x');
  await assert.rejects(invoke('voiceover:delete', { file: 'voiceover/notes.txt' }), /Invalid/);
  assert.ok(fs.existsSync(path.join(dir, 'project.json')));
  assert.deepStrictEqual(await invoke('voiceover:delete', { file }), { deleted: true });
  assert.ok(!fs.existsSync(path.join(dir, file)));
});

test('no open project: every handler refuses', async () => {
  const { invoke } = harness({ projectDir: null });
  await assert.rejects(invoke('voiceover:save', { data: Uint8Array.from(WEBM) }), /No project/);
  await assert.rejects(invoke('voiceover:delete', { file: 'voiceover/Voiceover.webm' }), /No project/);
  await assert.rejects(invoke('music:choose'), /No project/);
  await assert.rejects(invoke('music:import', '/tmp/x.mp3'), /No project/);
});

test('resolveProjectFile stays inside the folder', () => {
  const dir = tmpDir('resolve');
  assert.strictEqual(resolveProjectFile(dir, 'music', 'music/a b.mp3'), path.join(dir, 'music', 'a b.mp3'));
  assert.throws(() => resolveProjectFile(dir, 'music', 'music/../../x'));
  assert.throws(() => resolveProjectFile(dir, 'music', 'music/a\0.mp3'));
});

test('music:import copies a supported file into <project>/music with a unique, safe name', async () => {
  const project = tmpDir('music');
  const outside = tmpDir('songs');
  const song = path.join(outside, 'My Song: Remix?.MP3');
  fs.writeFileSync(song, Buffer.from('ID3 fake mp3 bytes'));
  const { invoke } = harness({ projectDir: project });
  const first = await invoke('music:import', song);
  const second = await invoke('music:import', song);
  assert.deepStrictEqual(first, { file: 'music/My Song Remix.mp3', name: 'My Song: Remix?.MP3' });
  assert.strictEqual(second.file, 'music/My Song Remix 2.mp3');
  assert.strictEqual(fs.readFileSync(path.join(project, first.file), 'utf8'), 'ID3 fake mp3 bytes');
  assert.ok(fs.existsSync(song), 'the original is left where it was');
});

test('music:import rejects bad paths, types, folders and empty files', async () => {
  const project = tmpDir('music-bad');
  const outside = tmpDir('songs-bad');
  const exe = path.join(outside, 'song.exe');
  fs.writeFileSync(exe, 'x');
  const empty = path.join(outside, 'empty.wav');
  fs.writeFileSync(empty, '');
  const folder = path.join(outside, 'folder.mp3');
  fs.mkdirSync(folder);
  const { invoke } = harness({ projectDir: project });
  await assert.rejects(invoke('music:import', exe), /isn’t supported/);
  await assert.rejects(invoke('music:import', empty), /empty/);
  await assert.rejects(invoke('music:import', folder), /Choose a music file/);
  await assert.rejects(invoke('music:import', path.join(outside, 'missing.mp3')), /can’t be found/);
  await assert.rejects(invoke('music:import', 'relative/song.mp3'), /Choose a music file/);
  await assert.rejects(invoke('music:import', { path: exe }), /Choose a music file/);
  assert.ok(!fs.existsSync(path.join(project, 'music')) || fs.readdirSync(path.join(project, 'music')).length === 0);
  assert.throws(() => validateMusicPath(42));
});

test('music:choose opens a filtered dialog, imports the pick, and returns null on cancel', async () => {
  const project = tmpDir('choose');
  const song = path.join(tmpDir('choose-src'), 'theme.m4a');
  fs.writeFileSync(song, 'm4a');
  const picked = harness({ projectDir: project, openResult: { canceled: false, filePaths: [song] } });
  const res = await picked.invoke('music:choose');
  assert.deepStrictEqual(res, { file: 'music/theme.m4a', name: 'theme.m4a' });
  const exts = picked.dialogCalls[0].filters[0].extensions;
  assert.ok(exts.includes('mp3') && exts.includes('m4a') && !exts.includes('exe'));
  const cancelled = harness({ projectDir: project, openResult: { canceled: true, filePaths: [] } });
  assert.strictEqual(await cancelled.invoke('music:choose'), null);
});

test('safeStem keeps readable names and never produces a hidden or empty file', () => {
  assert.strictEqual(safeStem('/a/..hidden.mp3'), 'hidden');
  assert.strictEqual(safeStem('/a/???.mp3'), 'Music');
  assert.strictEqual(safeStem('/a/Café del Mar.flac'), 'Café del Mar');
});

test('safeStem: names Windows would refuse are adjusted', () => {
  assert.strictEqual(safeStem('/a/CON.mp3'), 'CON music');
  assert.strictEqual(safeStem('/a/lpt1.wav'), 'lpt1 music');
  assert.strictEqual(safeStem('/a/Song. .mp3'), 'Song');
  assert.strictEqual(safeStem('/a/. . ..mp3'), 'Music');
  assert.strictEqual(safeStem('/a/Console.mp3'), 'Console');
});

test('music:import that fails to copy leaves nothing behind and says so plainly', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const project = tmpDir('music-copyfail');
  const outside = tmpDir('songs-copyfail');
  const song = path.join(outside, 'locked.mp3');
  fs.writeFileSync(song, 'ID3 bytes');
  fs.chmodSync(song, 0o000);
  try {
    const { invoke } = harness({ projectDir: project });
    await assert.rejects(invoke('music:import', song), /couldn’t be copied/);
    assert.deepStrictEqual(fs.readdirSync(path.join(project, 'music')), []);
  } finally {
    fs.chmodSync(song, 0o644);
  }
});

test('resolveProjectFile under Windows path rules: no drive-relative or stream names', () => {
  // Load a fresh copy of the module with node:path swapped for path.win32, so
  // the checks run exactly as they would on Windows.
  const Module = require('node:module');
  const id = require.resolve('../src/main/ipc/project-files');
  const cached = require.cache[id];
  delete require.cache[id];
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'node:path' ? path.win32 : load.call(this, request, ...rest);
  };
  let win;
  try {
    win = require('../src/main/ipc/project-files');
  } finally {
    Module._load = load;
    require.cache[id] = cached;
  }
  const dir = 'C:\\Users\\me\\Videos\\Loupe\\1789';
  assert.strictEqual(win.resolveProjectFile(dir, 'voiceover', 'voiceover/Voiceover 2.webm'),
    'C:\\Users\\me\\Videos\\Loupe\\1789\\voiceover\\Voiceover 2.webm');
  for (const bad of ['voiceover/C:take.webm', 'voiceover/a:b.webm', 'voiceover\\x.webm',
    'C:\\x.webm', 'voiceover/..', '\\\\server\\share\\x.webm', 'music/x.webm']) {
    assert.throws(() => win.resolveProjectFile(dir, 'voiceover', bad), /Invalid file path/, bad);
  }
});
