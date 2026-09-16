'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const {
  createLogger, readLogTail, redact, reportProblemUrl, startDiagnostics, MAX_URL_LENGTH
} = require('../src/main/diagnostics');
const { collectLicenses, LINKS } = require('../src/main/ipc/about');

const made = [];
const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-logs-'));
  made.push(dir);
  return dir;
};
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test('the log appends timestamped lines and rotates, keeping two old files', () => {
  const dir = path.join(tmpDir(), 'logs'); // created on first write
  const log = createLogger({ dir, maxBytes: 200, now: () => new Date('2026-09-16T10:00:00Z') });
  for (let i = 0; i < 30; i++) log.error(`line ${i}`, { n: i });
  const files = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(files, ['loupe.1.log', 'loupe.2.log', 'loupe.log']);
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size < 400, `${f} stayed small`);
  const tail = readLogTail(dir, 3);
  assert.strictEqual(tail.length, 3);
  assert.match(tail[2], /^2026-09-16T10:00:00.000Z \[error\] line 29 \{ n: 29 \}$/);
  // Oldest first across the rotated files.
  const all = readLogTail(dir, 1000).map((l) => Number(/line (\d+)/.exec(l)[1]));
  assert.deepStrictEqual(all, [...all].sort((a, b) => a - b));
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test('a log that can\'t be written doesn\'t throw', () => {
  const file = path.join(tmpDir(), 'not-a-dir');
  fs.writeFileSync(file, 'x');
  const log = createLogger({ dir: file });
  assert.doesNotThrow(() => log.error('nope'));
  assert.deepStrictEqual(readLogTail(path.join(file, 'missing')), []);
});

test('Report a problem: a prefilled GitHub issue with version, OS, arch and the log, home folder hidden', () => {
  const url = new URL(reportProblemUrl({
    version: '0.2.0', platform: 'darwin', osVersion: '15.6', arch: 'arm64', homedir: '/Users/alex',
    logLines: ['2026 [error] could not open /Users/alex/Movies/Loupe/1/raw.mov']
  }));
  assert.strictEqual(url.origin + url.pathname, 'https://github.com/akshatgg/loupe/issues/new');
  const body = url.searchParams.get('body');
  assert.match(body, /Loupe 0\.2\.0 · macOS 15\.6 · arm64/);
  assert.match(body, /could not open ~\/Movies\/Loupe\/1\/raw\.mov/);
  assert.ok(!body.includes('/Users/alex'));
  assert.strictEqual(redact('C:\\Users\\alex\\x', 'C:\\Users\\alex'), '~\\x');
  // As util.inspect and JSON write it, as a file URL, and with a lower-case drive.
  assert.strictEqual(redact("{ path: 'C:\\\\Users\\\\alex\\\\raw.mp4' }", 'C:\\Users\\alex'), "{ path: '~\\\\raw.mp4' }");
  assert.strictEqual(redact('file:///C:/Users/alex/x.mp4', 'C:\\Users\\alex'), 'file:///~/x.mp4');
  assert.strictEqual(redact('c:\\Users\\alex\\x', 'C:\\Users\\alex'), '~\\x');
});

test('Report a problem: a long log is trimmed from the oldest end so the URL stays usable', () => {
  const logLines = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(60)}`);
  const url = reportProblemUrl({ version: '1.0.0', platform: 'win32', osVersion: '10.0.26100', arch: 'x64', logLines });
  assert.ok(url.length <= MAX_URL_LENGTH);
  const body = new URL(url).searchParams.get('body');
  assert.match(body, /Windows 10\.0\.26100/);
  assert.match(body, /line 499 /);
  assert.ok(!body.includes('line 0 '));
  // One absurdly long line: dropped, but the report still opens.
  const huge = reportProblemUrl({ version: '1', platform: 'linux', osVersion: '6', arch: 'x64', logLines: ['y'.repeat(20000)] });
  assert.ok(huge.length <= MAX_URL_LENGTH);
});

function fakeElectron() {
  const handlers = {};
  return {
    handlers,
    started: [],
    app: { on: (evt, cb) => { handlers[evt] = cb; }, getVersion: () => '0.2.0' },
    crashReporter: { start(opts) { this.opts = opts; } }
  };
}

test('startDiagnostics: local-only crash reporter, and every kind of failure is logged', async (t) => {
  const dir = tmpDir();
  const electron = fakeElectron();
  const boxes = [];
  const before = {
    error: console.error, warn: console.warn,
    exc: process.listeners('uncaughtException'), rej: process.listeners('unhandledRejection')
  };
  t.after(() => {
    console.error = before.error;
    console.warn = before.warn;
    for (const l of process.listeners('uncaughtException')) if (!before.exc.includes(l)) process.off('uncaughtException', l);
    for (const l of process.listeners('unhandledRejection')) if (!before.rej.includes(l)) process.off('unhandledRejection', l);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const printed = [];
  console.error = (...a) => printed.push(a.join(' '));
  startDiagnostics({ electron, logDir: dir, enabled: true, showErrorBox: (title, text) => boxes.push({ title, text }) });
  assert.deepStrictEqual(electron.crashReporter.opts, { uploadToServer: false, compress: true });

  console.error('Loupe: something recoverable');
  assert.deepStrictEqual(printed, ['Loupe: something recoverable'], 'still printed to the console');

  const exc = process.listeners('uncaughtException').find((l) => !before.exc.includes(l));
  exc(new Error('kaboom'));
  assert.strictEqual(boxes.length, 1, 'the user still sees an error');
  exc(new Error('kaboom again'));
  assert.strictEqual(boxes.length, 1, 'a repeat right away is logged, not shown again');
  assert.match(fs.readFileSync(path.join(dir, 'loupe.log'), 'utf8'), /kaboom again/);
  const rej = process.listeners('unhandledRejection').find((l) => !before.rej.includes(l));
  rej(new Error('lost promise'));
  electron.handlers['render-process-gone']({}, { getURL: () => 'file:///app/src/renderer/editor/index.html' }, { reason: 'crashed', exitCode: 5 });
  electron.handlers['child-process-gone']({}, { type: 'GPU', reason: 'oom' });

  const log = readLogTail(dir, 100).join('\n');
  assert.match(log, /\[info\] Loupe 0\.2\.0 started/);
  assert.match(log, /\[error\] Loupe: something recoverable/);
  assert.match(log, /uncaught exception: Error: kaboom/);
  assert.match(log, /unhandled rejection: Error: lost promise/);
  assert.match(log, /window process gone \(editor\).*crashed/s);
  assert.match(log, /child process gone:.*GPU/s);
});

test('startDiagnostics with crash reports turned off writes nothing and hooks nothing', () => {
  const dir = path.join(tmpDir(), 'logs');
  const electron = fakeElectron();
  const exc = process.listenerCount('uncaughtException');
  const log = startDiagnostics({ electron, logDir: dir, enabled: false });
  log.error('ignored');
  assert.strictEqual(electron.crashReporter.opts, undefined);
  assert.strictEqual(process.listenerCount('uncaughtException'), exc);
  assert.strictEqual(fs.existsSync(dir), false);
});

test('licences: Loupe, each vendored library, then Electron', () => {
  const root = tmpDir();
  const vendor = path.join(root, 'vendor');
  fs.mkdirSync(path.join(vendor, 'mp4box'), { recursive: true });
  fs.writeFileSync(path.join(vendor, 'mp4box', 'LICENSE'), 'BSD-3 mp4box');
  fs.mkdirSync(path.join(vendor, 'nolicense'), { recursive: true });
  const electronDir = path.join(root, 'electron');
  fs.mkdirSync(electronDir);
  fs.writeFileSync(path.join(electronDir, 'LICENSE'), 'MIT electron');
  fs.writeFileSync(path.join(electronDir, 'LICENSES.chromium.html'), '<html>');
  const list = collectLicenses({ vendorDir: vendor, electronDir });
  assert.deepStrictEqual(list.map((l) => l.name), ['Loupe', 'mp4box', 'Electron']);
  assert.match(list[0].text, /MIT License/);
  assert.strictEqual(list[2].chromiumCredits, true);
  // With nothing on disk it still lists Loupe and Electron.
  assert.deepStrictEqual(collectLicenses({ vendorDir: path.join(root, 'x'), electronDir: path.join(root, 'y') }).map((l) => l.name), ['Loupe', 'Electron']);
  assert.ok(Object.values(LINKS).every((u) => u.startsWith('https://')));
  fs.rmSync(root, { recursive: true, force: true });
});
