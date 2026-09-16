'use strict';
/* global Response -- the fetch API's Response, built into Electron's Node */
// End-to-end check of the app shell in the real app: the Library and Settings
// windows, the menus, presets, updates and Report a problem.
//
//   node_modules/.bin/electron test/e2e/shell.e2e.js
//
// It starts Loupe's own main.js with a throwaway home folder and userData, and
// a recordings folder holding COPIES of recordings from ~/Movies/Loupe (or
// LOUPE_E2E_RECORDINGS; made-up ones when there are none). Nothing leaves the
// computer: the GitHub update check gets a fake answer, and opening links,
// revealing files and moving to the Trash are recorded instead of done.
// Screenshots of every window state go to test/e2e/out/ (LOUPE_E2E_OUT) --
// look at them. Exits non-zero if any check fails.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { URL } = require('node:url');
const electron = require('electron');
const { app, BrowserWindow, Menu, shell, dialog } = electron;

const OUT = process.env.LOUPE_E2E_OUT ?? path.join(__dirname, 'out');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-shell-e2e-'));
const HOME = path.join(TMP, 'home');
const USER_DATA = path.join(TMP, 'userData');
const RECORDINGS = path.join(HOME, 'Movies', 'Loupe');
const EMPTY_FOLDER = path.join(TMP, 'Empty folder');
const SOURCE = process.env.LOUPE_E2E_RECORDINGS ?? path.join(os.homedir(), 'Movies', 'Loupe');

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(RECORDINGS, { recursive: true });
fs.mkdirSync(EMPTY_FOLDER, { recursive: true });
fs.mkdirSync(USER_DATA, { recursive: true });

// ---- fixtures ---------------------------------------------------------------

function copyRecordings() {
  let picked = [];
  try {
    picked = fs.readdirSync(SOURCE)
      .filter((n) => fs.existsSync(path.join(SOURCE, n, 'project.json')))
      .filter((n) => {
        const size = fs.readdirSync(path.join(SOURCE, n))
          .reduce((s, f) => s + fs.statSync(path.join(SOURCE, n, f)).size, 0);
        return size < 12 * 1024 * 1024;
      })
      .slice(-7);
  } catch { /* no recordings on this machine */ }
  for (const name of picked) {
    // Copies only, and never thumb.jpg: the test makes its own.
    fs.cpSync(path.join(SOURCE, name), path.join(RECORDINGS, name), {
      recursive: true, filter: (src) => path.basename(src) !== 'thumb.jpg'
    });
  }
  if (picked.length === 0) {
    for (let i = 0; i < 4; i++) {
      const dir = path.join(RECORDINGS, String(1789000000000 + i * 3600e3));
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
        version: 1, source: { width: 1470, height: 956 }, capture: { file: 'raw.mov', duration: 20 + i * 7 }
      }));
    }
  }
  // One with a name already, as the new editor will write it.
  const named = path.join(RECORDINGS, fs.readdirSync(RECORDINGS).sort()[0]);
  const project = JSON.parse(fs.readFileSync(path.join(named, 'project.json'), 'utf8'));
  project.title = 'Onboarding walkthrough';
  fs.writeFileSync(path.join(named, 'project.json'), JSON.stringify(project, null, 2));
  return fs.readdirSync(RECORDINGS).length;
}

const recordingCount = copyRecordings();

fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify({
  zoomTriggers: ['option', 'mouse-side'],
  recordingsFolder: RECORDINGS,
  presets: [
    { id: 'p_launch', name: 'Launch video', style: { background: { type: 'gradient', value: ['#1e3a8a', '#9333ea'] }, padding: 0.08, radius: 14 } },
    { id: 'p_docs', name: 'Docs screenshots', style: { background: { type: 'color', value: '#f1f3f4' }, padding: 0.04 } },
    { id: 'p_plain', name: 'Plain', style: { background: { type: 'none' } } }
  ],
  defaultPresetId: 'p_launch',
  // The launch check runs, but this version was already announced, so no
  // dialog interrupts the test.
  lastNotifiedVersion: '99.0.0'
}, null, 2));

// ---- stand-ins for everything that would leave the test ---------------------

const record = { external: [], openPath: [], reveal: [], trash: [], dialogs: [], fetches: [] };
shell.openExternal = async (url) => { record.external.push(url); };
shell.openPath = async (p) => { record.openPath.push(p); return ''; };
shell.showItemInFolder = (p) => { record.reveal.push(p); };
shell.trashItem = async (p) => { record.trash.push(p); fs.rmSync(p, { recursive: true, force: true }); };
dialog.showMessageBox = async (...args) => {
  const opts = args.find((a) => a && typeof a === 'object' && 'message' in a);
  record.dialogs.push(opts.message);
  return { response: 0 };
};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [EMPTY_FOLDER] });

const RELEASE = {
  // Newer than any version this can run as: started this way, the app reports
  // Electron's own version, not package.json's.
  tag_name: 'v99.0.0', name: 'Loupe 99.0.0', body: 'Notes',
  html_url: 'https://github.com/akshatgg/loupe/releases/tag/v99.0.0',
  published_at: '2026-09-15T10:00:00Z', assets: []
};
electron.net.fetch = async (url) => {
  record.fetches.push(url);
  await new Promise((r) => setTimeout(r, 300)); // long enough to see "Checking…"
  return Response.json(RELEASE);
};

process.env.HOME = HOME;
app.setPath('userData', USER_DATA);

// ---- helpers ----------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`ok    ${name}`);
  } catch (err) {
    results.push([false, name]);
    console.log(`FAIL  ${name}\n      ${String(err.stack ?? err).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

async function waitFor(what, fn, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const windowTitled = (title) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle() === title);
const js = (win, code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
const clickMenu = (id) => {
  const item = Menu.getApplicationMenu().getMenuItemById(id);
  assert.ok(item, `menu item ${id}`);
  item.click();
};
const readSettings = () => JSON.parse(fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf8'));

async function shot(win, name) {
  await sleep(250);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
}

// ---- the run ----------------------------------------------------------------

async function run() {
  await app.whenReady();
  await waitFor('the picker', () => windowTitled('Loupe'));
  const picker = windowTitled('Loupe');
  await waitFor('the picker to load', () => !picker.webContents.isLoading());

  await check('menus: the app menu has the shell commands', () => {
    for (const id of ['about', 'settings', 'check-for-updates', 'new-recording', 'open-recordings',
      'website', 'keyboard-shortcuts', 'report-problem', 'show-logs']) {
      assert.ok(Menu.getApplicationMenu().getMenuItemById(id), id);
    }
    const labels = Menu.getApplicationMenu().items.map((i) => i.label);
    assert.deepStrictEqual(labels.slice(1), ['File', 'Edit', 'View', 'Window', 'Help']);
  });

  // -- Library ----------------------------------------------------------------
  let library;
  await check('the picker\'s Recordings button opens the Library', async () => {
    await waitFor('the Recordings button', () => js(picker, 'return Boolean(document.getElementById("recordings"))'));
    await js(picker, 'document.getElementById("recordings").click()');
    library = await waitFor('the Library window', () => windowTitled('Recordings'));
    await waitFor('recordings listed', () => js(library, 'return document.querySelectorAll(".card").length'));
    assert.strictEqual(await js(library, 'return document.querySelectorAll(".card").length'), recordingCount);
    assert.match(await js(library, 'return document.getElementById("summary").textContent'),
      new RegExp(`^${recordingCount} recordings in\u200E~`));
  });

  await check('File > Open Recordings brings the same Library window forward', async () => {
    clickMenu('open-recordings');
    await sleep(200);
    assert.strictEqual(BrowserWindow.getAllWindows().filter((w) => w.getTitle() === 'Recordings').length, 1);
  });

  await check('thumbnails are generated and cached as thumb.jpg', async () => {
    const withVideo = fs.readdirSync(RECORDINGS).filter((n) => fs.existsSync(path.join(RECORDINGS, n, 'raw.mov')));
    if (withVideo.length === 0) return;
    await waitFor('thumbnails', () => js(library,
      `return document.querySelectorAll('.thumb img.loaded').length >= ${withVideo.length}`), 20000);
    for (const n of withVideo) assert.ok(fs.existsSync(path.join(RECORDINGS, n, 'thumb.jpg')), n);
  });
  await shot(library, '01-library');

  await check('search narrows the list and says when nothing matches', async () => {
    await js(library, `
      const s = document.getElementById('search');
      s.value = 'onboarding'; s.dispatchEvent(new Event('input'));`);
    assert.strictEqual(await js(library, 'return document.querySelectorAll(".card").length'), 1);
    await shot(library, '02-library-search');
    await js(library, `
      const s = document.getElementById('search');
      s.value = 'zzzz nothing'; s.dispatchEvent(new Event('input'));`);
    assert.strictEqual(await js(library, 'return document.getElementById("noMatch").hidden'), false);
    await shot(library, '03-library-no-match');
    await js(library, 'document.getElementById("clearSearch").click()');
    assert.strictEqual(await js(library, 'return document.querySelectorAll(".card").length'), recordingCount);
  });

  await check('sort by name', async () => {
    await js(library, `const s = document.getElementById('sort'); s.value = 'name'; s.dispatchEvent(new Event('change'));`);
    const titles = await js(library, 'return [...document.querySelectorAll(".card .title")].map((t) => t.textContent)');
    assert.deepStrictEqual(titles, [...titles].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })));
    await js(library, `const s = document.getElementById('sort'); s.value = 'newest'; s.dispatchEvent(new Event('change'));`);
  });

  const firstId = await js(library, 'return document.querySelector(".card").dataset.id');

  await check('the "…" menu opens with every action', async () => {
    await js(library, 'document.querySelector(".card .more").click()');
    const items = await js(library, 'return [...document.querySelectorAll("#menu button")].map((b) => b.textContent)');
    assert.deepStrictEqual(items, ['Open', 'Rename', 'Duplicate', 'Show in Finder', 'Move to Trash']);
    await shot(library, '04-library-menu');
  });

  await check('rename writes the title to project.json', async () => {
    await js(library, 'document.querySelector("#menu [data-action=rename]").click()');
    await waitFor('the name field', () => js(library, 'return Boolean(document.querySelector(".card .title input"))'));
    await js(library, `
      const input = document.querySelector('.card .title input');
      input.value = 'Product tour';
      input.dispatchEvent(new Event('input'));`);
    await shot(library, '05-library-rename');
    await js(library, `document.querySelector('.card .title input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await waitFor('the new name', () => js(library, `return document.querySelector('.card[data-id="${firstId}"] .title').textContent === 'Product tour'`));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(RECORDINGS, firstId, 'project.json'), 'utf8')).title, 'Product tour');
  });

  await check('duplicate makes a copy next to it', async () => {
    const before = fs.readdirSync(RECORDINGS).length;
    await js(library, `document.querySelector('.card[data-id="${firstId}"] .more').click()`);
    await js(library, 'document.querySelector("#menu [data-action=duplicate]").click()');
    await waitFor('the copy', () => fs.readdirSync(RECORDINGS).length === before + 1);
    await waitFor('the copy listed', () => js(library, `return document.querySelectorAll('.card').length === ${before + 1}`));
    const titles = await js(library, 'return [...document.querySelectorAll(".card .title")].map((t) => t.textContent)');
    assert.ok(titles.includes('Product tour copy'), titles.join(', '));
    await shot(library, '06-library-duplicated');
  });

  await check('Show in Finder reveals the recording\'s folder', async () => {
    await js(library, `document.querySelector('.card[data-id="${firstId}"] .more').click()`);
    await js(library, 'document.querySelector("#menu [data-action=reveal]").click()');
    await waitFor('reveal', () => record.reveal.length === 1);
    assert.strictEqual(record.reveal[0], fs.realpathSync(path.join(RECORDINGS, firstId)));
  });

  await check('Move to Trash asks, then removes it from the list', async () => {
    const copyId = await js(library, `return [...document.querySelectorAll('.card')].find((c) => c.querySelector('.title').textContent === 'Product tour copy').dataset.id`);
    await js(library, `document.querySelector('.card[data-id="${copyId}"] .more').click()`);
    await js(library, 'document.querySelector("#menu [data-action=trash]").click()');
    await waitFor('trash', () => record.trash.length === 1);
    assert.ok(record.dialogs.some((m) => /^Move "Product tour copy" to the Trash\?$/.test(m)), record.dialogs.join(' | '));
    await waitFor('the list to update', () => js(library, `return !document.querySelector('.card[data-id="${copyId}"]')`));
  });

  await check('double-click opens the recording in the editor', async () => {
    await js(library, `document.querySelector('.card[data-id="${firstId}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    const editor = await waitFor('the editor', () => windowTitled('Loupe — Edit'));
    editor.close();
  });

  await check('a recording open in the editor can\'t be moved to the Trash', async () => {
    await js(library, `document.querySelector('.card[data-id="${firstId}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    const editor = await waitFor('the editor', () => windowTitled('Loupe — Edit'));
    const trashed = record.trash.length;
    const asked = record.dialogs.length;
    await js(library, `document.querySelector('.card[data-id="${firstId}"] .more').click()`);
    await js(library, 'document.querySelector("#menu [data-action=trash]").click()');
    await waitFor('the message', () => js(library, 'return /open in the editor/.test(document.getElementById("toast").textContent)'));
    assert.strictEqual(record.trash.length, trashed);
    assert.strictEqual(record.dialogs.length, asked, 'no confirmation is shown');
    assert.ok(fs.existsSync(path.join(RECORDINGS, firstId)));
    await shot(library, '08-library-trash-open-in-editor');
    editor.close();
    await waitFor('the editor to close', () => !windowTitled('Loupe — Edit'));
  });

  await check('Duplicate pressed twice quickly makes one copy', async () => {
    const before = fs.readdirSync(RECORDINGS).filter((n) => !n.startsWith('.')).length;
    await js(library, `
      const card = document.querySelector('.card[data-id="${firstId}"]');
      card.focus();
      for (let i = 0; i < 2; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true, ctrlKey: true, bubbles: true }));`);
    await waitFor('the copy listed', () => js(library, `return document.querySelectorAll('.card').length === ${before + 1}`));
    await sleep(500);
    assert.strictEqual(fs.readdirSync(RECORDINGS).filter((n) => !n.startsWith('.')).length, before + 1);
    // Tidy up so the checks below see the same list as before.
    const copyId = await js(library, `return [...document.querySelectorAll('.card')].find((c) => c.querySelector('.title').textContent === 'Product tour copy').dataset.id`);
    fs.rmSync(path.join(RECORDINGS, copyId), { recursive: true, force: true });
    await js(library, 'window.dispatchEvent(new Event("focus"))');
    await waitFor('the list', () => js(library, `return document.querySelectorAll('.card').length === ${before}`));
  });

  await check('New recording shows the picker', async () => {
    picker.hide();
    await js(library, 'document.getElementById("newRecording").click()');
    await waitFor('the picker', () => picker.isVisible());
  });

  // -- Settings -----------------------------------------------------------------
  let settingsWin;
  await check('Settings… opens the Settings window at General', async () => {
    clickMenu('settings');
    settingsWin = await waitFor('the Settings window', () => windowTitled('Settings'));
    await waitFor('settings to load', () => js(settingsWin, 'return document.getElementById("folderPath").textContent.length > 0'));
    assert.strictEqual(await js(settingsWin, 'return document.getElementById("folderPath").textContent'), RECORDINGS);
    assert.strictEqual(await js(settingsWin, 'return document.getElementById("resetFolder").disabled'), false);
  });
  await shot(settingsWin, '10-settings-general');

  await check('switches save immediately', async () => {
    await js(settingsWin, `const c = document.querySelector('[data-setting=countdown]'); c.click();`);
    await waitFor('countdown off', () => readSettings().countdown === false);
    await js(settingsWin, `document.querySelector('[data-setting=countdown]').click();`);
    await waitFor('countdown on', () => readSettings().countdown === true);
    assert.strictEqual(readSettings().openAtLogin, false);
  });

  await check('Change… picks a new recordings folder and the Library follows it', async () => {
    await js(settingsWin, 'document.getElementById("changeFolder").click()');
    await waitFor('the new folder', () => readSettings().recordingsFolder === EMPTY_FOLDER);
    await waitFor('the empty Library', () => js(library, 'return !document.getElementById("empty").hidden'));
    await shot(library, '07-library-empty');
    await shot(settingsWin, '11-settings-general-changed');
  });

  await check('Reset puts the recordings folder back to the usual place', async () => {
    await js(settingsWin, 'document.getElementById("resetFolder").click()');
    await waitFor('reset', () => readSettings().recordingsFolder === null);
    await waitFor('the default path shown', () => js(settingsWin, `return document.getElementById('folderPath').textContent === ${JSON.stringify(RECORDINGS)}`));
  });

  await check('choosing a folder that can\'t be used is refused with a plain message', async () => {
    const blocker = path.join(TMP, 'a file');
    fs.writeFileSync(blocker, 'x');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(blocker, 'Loupe')] });
    await js(settingsWin, 'document.getElementById("changeFolder").click()');
    await waitFor('the message', () => js(settingsWin, 'return /can\'t save recordings in .*Choose another folder/.test(document.getElementById("toast").textContent)'));
    assert.strictEqual(readSettings().recordingsFolder, null);
    assert.doesNotMatch(await js(settingsWin, 'return document.getElementById("toast").textContent'), /invoking remote method/);
  });

  await check('a recordings folder that can\'t be reached is explained in the Library', async () => {
    // A folder on a "drive" that is then unplugged: it worked when chosen,
    // and a file now stands where its parent was, so it can't be made again.
    const drive = path.join(TMP, 'Drive');
    const unreachable = path.join(drive, 'Loupe');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [unreachable] });
    await js(settingsWin, 'document.getElementById("changeFolder").click()');
    await waitFor('saved', () => readSettings().recordingsFolder === unreachable);
    fs.rmSync(drive, { recursive: true, force: true });
    fs.writeFileSync(drive, 'x');
    await js(library, 'window.dispatchEvent(new Event("focus"))');
    await waitFor('the message', () => js(library, 'return !document.getElementById("failed").hidden'));
    assert.match(await js(library, 'return document.getElementById("failedText").textContent'), /can't use the recordings folder .*connect it/);
    assert.strictEqual(await js(library, 'return document.querySelectorAll(".card").length'), 0);
    await shot(library, '09-library-folder-unreachable');
    await js(library, 'document.getElementById("failedSettings").click()');
    await js(settingsWin, 'document.getElementById("resetFolder").click()');
    await waitFor('reset', () => readSettings().recordingsFolder === null);
    await waitFor('the Library back', () => js(library, 'return document.getElementById("failed").hidden && document.querySelectorAll(".card").length > 0'));
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [EMPTY_FOLDER] });
  });

  await check('Recording: zoom shortcuts use the same capture fields as the picker', async () => {
    await js(settingsWin, 'location.hash = "recording"');
    await waitFor('section', () => js(settingsWin, 'return !document.getElementById("recording").hidden'));
    assert.match(await js(settingsWin, 'return document.getElementById("zoomHelp").textContent'), /^Hold ⌥ or a mouse side button/);
    await js(settingsWin, `document.querySelector('.capture[data-slot="1"]').click()`);
    assert.strictEqual(await js(settingsWin, `return document.querySelector('.capture[data-slot="1"]').textContent`), 'Press a key or mouse button…');
    await shot(settingsWin, '12-settings-recording-capturing');
    await js(settingsWin, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))`);
    await waitFor('saved', () => readSettings().zoomTriggers[1] === 'shift');
    // The picker, open at the same time, shows the change too.
    await waitFor('the picker updated', () => js(picker, `return document.querySelectorAll('.capture')[1].textContent === '⇧ Shift'`));
  });

  await check('Recording: devices, computer sound, keystrokes and presets', async () => {
    await waitFor('microphones listed', () => js(settingsWin, 'return document.getElementById("microphone").options.length > 0'));
    await js(settingsWin, `document.querySelector('[data-setting=systemAudio]').click()`);
    await waitFor('system audio on', () => readSettings().systemAudio === true);
    const presetNames = await js(settingsWin, 'return [...document.querySelectorAll("#presetList .pname")].map((n) => n.textContent)');
    assert.deepStrictEqual(presetNames, ['Launch video', 'Docs screenshots', 'Plain']);
    assert.strictEqual(await js(settingsWin, 'return document.getElementById("defaultPreset").value'), 'p_launch');
    await js(settingsWin, `const s = document.getElementById('defaultPreset'); s.value = 'p_docs'; s.dispatchEvent(new Event('change'));`);
    await waitFor('default preset', () => readSettings().defaultPresetId === 'p_docs');
    await js(settingsWin, 'document.querySelectorAll("#presetList .btn")[0].click()'); // Rename
    await js(settingsWin, `const i = document.querySelector('#presetList input'); i.value = 'Launch video (dark)';
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));`);
    await waitFor('renamed', () => readSettings().presets[0].name === 'Launch video (dark)');
    await js(settingsWin, 'document.querySelectorAll("#presetList .btn.danger")[2].click()'); // Delete "Plain"
    await waitFor('deleted', () => readSettings().presets.length === 2);
    await sleep(300);
    await shot(settingsWin, '13-settings-recording');
    await js(settingsWin, 'document.querySelector("main").scrollTop = 1000');
    await shot(settingsWin, '14-settings-recording-looks');
  });

  await check('Export defaults', async () => {
    await js(settingsWin, 'location.hash = "export"');
    await waitFor('section', () => js(settingsWin, 'return !document.getElementById("export").hidden'));
    await js(settingsWin, `document.querySelector('input[name=format][value=gif]').click()`);
    await waitFor('gif', () => readSettings().exportDefaults.format === 'gif');
    await js(settingsWin, `const s = document.getElementById('resolution'); s.value = '4k'; s.dispatchEvent(new Event('change'));`);
    await waitFor('4k', () => readSettings().exportDefaults.resolution === '4k');
    assert.deepStrictEqual(readSettings().exportDefaults, { format: 'gif', resolution: '4k', quality: 'balanced' });
    assert.match(await js(settingsWin, 'return document.getElementById("formatHelp").textContent'), /looping/);
    await js(settingsWin, `document.querySelector('input[name=format][value=mp4]').click()`);
    await waitFor('mp4', () => readSettings().exportDefaults.format === 'mp4');
    await shot(settingsWin, '15-settings-export');
  });

  await check('Check for Updates… opens Updates and shows the new version', async () => {
    clickMenu('check-for-updates');
    await waitFor('section', () => js(settingsWin, 'return !document.getElementById("updates").hidden'));
    await waitFor('checking', () => js(settingsWin, 'return /Checking/.test(document.getElementById("updateText").textContent)'), 3000);
    await shot(settingsWin, '16-settings-updates-checking');
    await waitFor('available', () => js(settingsWin, 'return document.getElementById("updateTitle").textContent === "Loupe 99.0.0 is available"'));
    assert.ok(record.fetches.every((u) => u === 'https://api.github.com/repos/akshatgg/loupe/releases/latest'));
    assert.strictEqual(await js(settingsWin, 'return document.getElementById("updateDot").hidden'), false);
    await shot(settingsWin, '17-settings-updates-available');
    await js(settingsWin, 'document.getElementById("downloadUpdate").click()');
    await waitFor('release page', () => record.external.includes(RELEASE.html_url));
  });

  await check('Privacy: Report a problem opens a prefilled GitHub issue; Show logs opens the log folder', async () => {
    await js(settingsWin, 'location.hash = "privacy"');
    await waitFor('section', () => js(settingsWin, 'return !document.getElementById("privacy").hidden'));
    await shot(settingsWin, '18-settings-privacy');
    await js(settingsWin, 'document.getElementById("reportProblem").click()');
    const url = await waitFor('issue URL', () => record.external.find((u) => u.startsWith('https://github.com/akshatgg/loupe/issues/new')));
    const body = new URL(url).searchParams.get('body');
    assert.match(body, new RegExp(`Loupe ${app.getVersion().replace(/\./g, '\\.')} · macOS`));
    assert.match(body, /started/, 'recent log lines are included');
    await js(settingsWin, 'document.getElementById("showLogs").click()');
    await waitFor('logs', () => record.openPath.includes(path.join(USER_DATA, 'logs')));
    assert.ok(fs.existsSync(path.join(USER_DATA, 'logs', 'loupe.log')));
  });

  await check('About shows the version and licences', async () => {
    clickMenu('about');
    await waitFor('section', () => js(settingsWin, 'return !document.getElementById("about").hidden'));
    await waitFor('licences', () => js(settingsWin, 'return document.querySelectorAll("#licenses details").length >= 2'));
    assert.strictEqual(await js(settingsWin, 'return document.getElementById("aboutVersion").textContent'), `Version ${app.getVersion()}`);
    await shot(settingsWin, '19-settings-about');
    await js(settingsWin, 'document.querySelector("#licenses details").open = true; document.querySelector("main").scrollTop = 400');
    await shot(settingsWin, '20-settings-about-license');
  });

  await check('Help menu: website, keyboard shortcuts', async () => {
    clickMenu('website');
    await waitFor('website', () => record.external.includes('https://loupeapp.vercel.app'));
    settingsWin.focus();
    clickMenu('keyboard-shortcuts');
    await waitFor('shortcuts dialog', () => record.dialogs.includes('Keyboard shortcuts'));
  });

  await check('the settings file stayed valid and complete', () => {
    const s = readSettings();
    for (const key of ['zoomTriggers', 'countdown', 'openAtLogin', 'microphone', 'camera', 'systemAudio',
      'showKeystrokes', 'exportDefaults', 'checkForUpdates', 'saveCrashReports', 'presets', 'defaultPresetId']) {
      assert.ok(key in s, key);
    }
    assert.ok(s.lastUpdateCheck > 0);
  });

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed. Screenshots: ${OUT}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  app.exit(1);
});

require('../../src/main/main.js');
