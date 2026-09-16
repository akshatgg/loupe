'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createLibrary, registerLibraryIpc, projectDuration, displayPath, THUMB } = require('../src/main/ipc/library');
const { createProject, saveProject } = require('../src/main/project');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-library-'));
  const root = path.join(base, 'Loupe');
  fs.mkdirSync(root);
  return { base, root };
}

function v1(root, id, { duration = 12.5, video = true, title } = {}) {
  const dir = path.join(root, id);
  const project = createProject({ kind: 'display', id: 'display:1', width: 1470, height: 956 },
    { file: 'raw.mov', fps: 60, duration, hasMicTrack: false });
  if (title) project.title = title;
  saveProject(dir, project);
  if (video) fs.writeFileSync(path.join(dir, 'raw.mov'), 'not really a movie');
  return dir;
}

function v2(root, id, extra = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'raw.mp4'), 'video');
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    version: 2, title: 'Onboarding demo', createdAt: 1789000000000,
    sources: { main: { dir: '.', video: 'raw.mp4', width: 1920, height: 1080, duration: 30 } },
    clips: [{ id: 'c1', source: 'main', start: 0, end: 10 }, { id: 'c2', source: 'main', start: 15, end: 20.5 }],
    ...extra
  }));
  return dir;
}

test('lists every project folder, newest first, with title, date, length and size', () => {
  const { base, root } = setup();
  v1(root, '1788954728479');
  v1(root, '1788981448379', { title: 'Checkout flow' });
  v2(root, 'my-demo');
  fs.mkdirSync(path.join(root, 'not-a-recording'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
  const broken = path.join(root, '1788000000000');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'project.json'), '{broken');

  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  let list;
  try {
    list = createLibrary({ root: () => root, locale: 'en-GB' }).list();
  } finally {
    console.warn = warn;
  }
  assert.deepStrictEqual(list.map((r) => r.id), ['my-demo', '1788981448379', '1788954728479']);
  assert.strictEqual(warnings.length, 1, 'the unreadable project is skipped, with a note in the log');

  const [modern, custom, dated] = list;
  assert.strictEqual(custom.title, 'Checkout flow');
  assert.strictEqual(custom.customTitle, true);
  assert.strictEqual(dated.customTitle, false);
  assert.match(dated.title, /^Recording \d{1,2} Sept? 2026, \d\d:\d\d$/);
  assert.strictEqual(dated.createdAt, 1788954728479);
  // The locale may be a function (app.getLocale can only be asked once the
  // app is ready); a 12-hour locale formats the same title its own way.
  const us = createLibrary({ root: () => root, locale: () => 'en-US' }).list().find((r) => r.id === dated.id);
  assert.match(us.title, /^Recording Sep \d{1,2}, 2026, \d\d:\d\d [AP]M$/);
  assert.strictEqual(dated.duration, 12.5);
  assert.strictEqual(dated.width, 1470);
  assert.strictEqual(dated.hasVideo, true);
  assert.strictEqual(dated.thumbnail, null);
  assert.strictEqual(modern.title, 'Onboarding demo');
  assert.strictEqual(modern.duration, 15.5);
  assert.strictEqual(modern.width, 1920);
  fs.rmSync(base, { recursive: true, force: true });
});

test('v2 length falls back to the source duration when there are no clips', () => {
  assert.strictEqual(projectDuration({ version: 2, clips: [], sources: { main: { duration: 8 } } }), 8);
  assert.strictEqual(projectDuration({ version: 1, capture: { duration: -1 } }), null);
});

test('the folder is shown with ~ for the home folder on macOS, in full on Windows', () => {
  assert.strictEqual(displayPath('/Users/alex/Movies/Loupe', '/Users/alex', 'darwin'), '~/Movies/Loupe');
  assert.strictEqual(displayPath('/Users/alexandra/Loupe', '/Users/alex', 'darwin'), '/Users/alexandra/Loupe');
  assert.strictEqual(displayPath('/Volumes/Work/Loupe', '/Users/alex', 'darwin'), '/Volumes/Work/Loupe');
  assert.strictEqual(displayPath('C:\\Users\\alex\\Videos\\Loupe', 'C:\\Users\\alex', 'win32'), 'C:\\Users\\alex\\Videos\\Loupe');
});

test('only folders directly inside the recordings folder can be touched', () => {
  const { base, root } = setup();
  v1(root, '1');
  const outside = v1(base, 'outside');
  fs.symlinkSync(outside, path.join(root, 'link-out'));
  const lib = createLibrary({ root: () => root });
  assert.strictEqual(lib.resolve('1'), fs.realpathSync(path.join(root, '1')));
  for (const id of ['..', '.', '../outside', 'link-out', '1/../1', '', 'missing', null, 42, 'a\0b', `..${path.sep}outside`]) {
    assert.throws(() => lib.resolve(id), /could not be found/, String(id));
  }
  assert.throws(() => lib.rename('../outside', 'x'), /could not be found/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('rename writes the title into project.json, and an empty name brings back the date', () => {
  const { base, root } = setup();
  const dir = v1(root, '1788954728479');
  const lib = createLibrary({ root: () => root, locale: 'en-GB' });
  const renamed = lib.rename('1788954728479', '  Sign-up\nwalkthrough  ');
  assert.strictEqual(renamed.title, 'Sign-up walkthrough');
  const project = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  assert.strictEqual(project.title, 'Sign-up walkthrough');
  assert.strictEqual(project.version, 1, 'the rest of the project is untouched');
  assert.strictEqual(project.capture.duration, 12.5);

  const cleared = lib.rename('1788954728479', '   ');
  assert.strictEqual(cleared.customTitle, false);
  assert.ok(!('title' in JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'))));
  assert.throws(() => lib.rename('1788954728479', 'x'.repeat(121)), /up to 120/);
  assert.throws(() => lib.rename('1788954728479', 5), /text/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('duplicate copies the folder (not its exports) under a new name next to the original', async () => {
  const { base, root } = setup();
  const dir = v1(root, '1788954728479', { title: 'Demo' });
  fs.writeFileSync(path.join(dir, 'cursor.bin'), Buffer.alloc(32));
  fs.writeFileSync(path.join(dir, 'export-1920x1080.mp4'), 'big');
  fs.mkdirSync(path.join(dir, 'voice'));
  fs.writeFileSync(path.join(dir, 'voice', 'take1.m4a'), 'audio');
  const t = 1790000000000;
  fs.mkdirSync(path.join(root, String(t))); // that name is taken: the next one is used
  const lib = createLibrary({ root: () => root, now: () => t });

  const copy = await lib.duplicate('1788954728479');
  assert.strictEqual(copy.id, String(t + 1));
  assert.strictEqual(copy.title, 'Demo copy');
  assert.strictEqual(copy.createdAt, 1788954728479);
  const copied = path.join(root, copy.id);
  assert.deepStrictEqual(fs.readdirSync(copied).sort(), ['cursor.bin', 'project.json', 'raw.mov', 'voice']);
  assert.ok(fs.existsSync(path.join(copied, 'voice', 'take1.m4a')));
  // The original is unchanged.
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).title, 'Demo');
  assert.ok(fs.existsSync(path.join(dir, 'export-1920x1080.mp4')));
  fs.rmSync(base, { recursive: true, force: true });
});

test('thumbnails are made once, cached as thumb.jpg, and skipped without a video', async () => {
  const { base, root } = setup();
  v1(root, 'a');
  v1(root, 'b', { video: false });
  const made = [];
  const lib = createLibrary({
    root: () => root,
    createThumbnail: async (video) => { made.push(video); return Buffer.from([0xff, 0xd8, 0xff]); }
  });
  const url = await lib.thumbnail('a');
  assert.match(url, /thumb\.jpg\?v=\d+$/);
  assert.strictEqual(fileURLToPath(url.replace(/\?.*$/, '')), fs.realpathSync(path.join(root, 'a', THUMB)));
  await lib.thumbnail('a');
  assert.strictEqual(made.length, 1, 'made only once');
  assert.strictEqual(lib.list().find((r) => r.id === 'a').thumbnail, url);
  assert.strictEqual(await lib.thumbnail('b'), null);
  await assert.rejects(lib.thumbnail('../a'), /could not be found/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('IPC: open, reveal and trash go through the checked path; trash asks first', async () => {
  const { base, root } = setup();
  const dir = fs.realpathSync(v1(root, 'rec'));
  const handlers = {};
  const calls = [];
  let answer = 1;
  const electron = {
    shell: {
      showItemInFolder: (p) => calls.push(['reveal', p]),
      openPath: async (p) => calls.push(['openPath', p]),
      trashItem: async (p) => calls.push(['trash', p])
    },
    dialog: { showMessageBox: async (_w, opts) => { calls.push(['ask', opts.message]); return { response: answer }; } },
    BrowserWindow: { fromWebContents: () => null }
  };
  const library = createLibrary({ root: () => root, locale: 'en-GB' });
  registerLibraryIpc({
    ipcMain: { handle: (c, fn) => { handlers[c] = fn; } }, electron, library,
    openEditor: (d) => calls.push(['edit', d]), showPicker: () => calls.push(['picker'])
  });

  await handlers['library:open']({}, 'rec');
  await handlers['library:reveal']({}, 'rec');
  await handlers['library:newRecording']({});
  assert.deepStrictEqual(calls.splice(0), [['edit', dir], ['reveal', dir], ['picker']]);

  assert.deepStrictEqual(await handlers['library:trash']({ sender: {} }, 'rec'), { trashed: false });
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0][1], /^Move "Recording .*" to the (Trash|Recycle Bin)\?$/);
  answer = 0;
  calls.length = 0;
  assert.deepStrictEqual(await handlers['library:trash']({ sender: {} }, 'rec'), { trashed: true });
  assert.deepStrictEqual(calls[1], ['trash', dir]);

  await assert.rejects(async () => handlers['library:trash']({ sender: {} }, '..'), /could not be found/);
  await assert.rejects(async () => handlers['library:open']({}, '../x'), /could not be found/);
  const listed = await handlers['library:list']();
  assert.strictEqual(listed.root, root);
  fs.rmSync(base, { recursive: true, force: true });
});
