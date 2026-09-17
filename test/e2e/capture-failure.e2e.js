'use strict';
// When the screen can't be captured (a locked screen, a display that went
// away): the real main.js with stand-in helpers that fail the way the real
// ones do. The picker says what to do in plain words instead of the helper's
// output, and a capture that dies before its first frame brings the picker
// back with a plain, non-blocking message -- no raw error box, no editor on
// an empty recording, no empty folder left in the recordings folder.
//
//   node_modules/.bin/electron test/e2e/capture-failure.e2e.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');

const { app, BrowserWindow, dialog } = electron;
const OUT = path.join(__dirname, 'out', 'capture-failure');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-capfail-')));
const home = path.join(work, 'home');
const userData = path.join(work, 'userData');
const bin = path.join(work, 'bin');
for (const d of [home, userData, bin, OUT]) fs.mkdirSync(d, { recursive: true });
app.setPath('userData', userData);
os.homedir = () => home;
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ countdown: false, recordCamera: false, systemAudio: false }));

// sources fails (as on a locked screen) until the test unlocks it.
const flag = path.join(work, 'unlocked');
const display = JSON.stringify([{ id: 'display:1', kind: 'display', title: 'Display 1', x: 0, y: 0, width: 800, height: 600 }]);
fs.writeFileSync(path.join(bin, 'sources'), `#!/bin/sh
if [ ! -f '${flag}' ]; then echo 'Assertion failed: (did_initialize), function CGS_REQUIRE_INIT' >&2; exit 134; fi
echo '${display}'
`);
fs.writeFileSync(path.join(bin, 'capture'), `#!/bin/sh
echo '{"type":"error","message":"display not found: display:1"}'
exit 1
`);
fs.writeFileSync(path.join(bin, 'inputtap'), `#!/bin/sh
trap 'exit 0' TERM
while true; do sleep 1; done
`);
for (const name of ['sources', 'capture', 'inputtap']) fs.chmodSync(path.join(bin, name), 0o755);
process.env.LOUPE_BIN_DIR = bin;

const errorBoxes = [];
const messages = [];
dialog.showErrorBox = (title, content) => { errorBoxes.push({ title, content }); };
dialog.showMessageBox = async (...args) => {
  messages.push(args.find((a) => a && typeof a.message === 'string'));
  return { response: 0 };
};

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}
async function waitFor(what, fn, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
const pageOf = (name) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() &&
  w.webContents.getURL().includes(`/renderer/${name}/`));
const js = (win, code) => win.webContents.executeJavaScript(code);
async function shot(win, name) {
  await sleep(300);
  fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}

async function run() {
  require('../../src/main/main');
  const picker = await waitFor('the picker', () => pageOf('picker'));
  await waitFor('the picker to load', () => !picker.webContents.isLoading());

  await check('the picker explains a failed source list in plain words', async () => {
    const text = await waitFor('the message', () => js(picker, `(() => { const li = document.querySelector('#list li.none');
      return li && !li.textContent.startsWith('Loading') ? li.textContent : null; })()`));
    assert.ok(/couldn't see your screens/.test(text), text);
    assert.ok(!/CGS_|remote method|bin\/sources|Assertion/.test(text), `no technical words: ${text}`);
    await shot(picker, '01-sources-failed');
  });

  await check('Refresh lists the display again', async () => {
    fs.writeFileSync(flag, '');
    await js(picker, `document.getElementById('refresh').click()`);
    await waitFor('the display', () => js(picker, `document.querySelectorAll('#list li[role=option]').length === 1`));
  });

  await check('a capture that fails before its first frame goes back to the picker with a plain message', async () => {
    await js(picker, `document.querySelector('#list li[role=option]').click()`);
    await waitFor('Continue to be enabled', () => js(picker, `!document.getElementById('record').disabled`));
    await js(picker, `document.getElementById('record').click()`);
    const bar = await waitFor('the bar', () => pageOf('bar'));
    await waitFor('the bar to load', () => !bar.webContents.isLoading());
    await waitFor('the Start button', () => js(bar, `!document.getElementById('armed').hidden`));
    js(bar, 'window.loupe.startRecording().catch(() => null)').catch(() => {});
    await waitFor('the message', () => messages.length > 0);
    await waitFor('the bar to close', () => !pageOf('bar'));
    assert.deepStrictEqual(errorBoxes, [], 'no blocking error box');
    assert.strictEqual(messages[0].message, "Loupe couldn't start recording the screen");
    assert.ok(!/display not found/.test(messages[0].detail), messages[0].detail);
    await sleep(500);
    assert.ok(!pageOf('editor'), 'no editor on an empty recording');
    assert.ok(pageOf('picker')?.isVisible(), 'the picker is back');
    const root = path.join(home, 'Movies', 'Loupe');
    const left = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => !n.startsWith('.')) : [];
    assert.deepStrictEqual(left, [], 'no empty recording left behind');
  });
}

app.whenReady().then(async () => {
  try {
    await run();
    console.log(`\n${passed} passed`);
    app.exit(0);
  } catch (err) {
    console.error('not ok -', err);
    app.exit(1);
  }
});
