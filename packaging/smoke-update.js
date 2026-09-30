#!/usr/bin/env node
'use strict';

// End-to-end check of Update now with the files a release just built -- the
// release workflow runs it on macOS and on Windows before anything is
// published. The installers and their manifest are served from a local web
// server standing in for GitHub, and go through the same code the app uses
// (src/main/updates.js):
//
//   both      download with progress, checked against the manifest; a
//             tampered copy is refused
//   macOS     the app is copied out of the DMG and verified, swapped in for
//             an older install by the script Loupe runs as it quits, and
//             opened again
//   Windows   Loupe is installed and opened, quits, then the downloaded
//             installer updates it silently and opens it again, as Update
//             now does
//
//   node packaging/smoke-update.js --version 0.2.1 [--dir dist]

const assert = require('node:assert');
const { execFile, execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const {
  updateAsset, downloadVerified, stageMacApp, installerArgs, MAC_SWAP_SCRIPT
} = require('../src/main/updates');

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

async function waitFor(what, fn, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
}

// Serves `dir` by file name; /tampered/<name> serves it with one byte changed.
function serve(dir) {
  const server = http.createServer((req, res) => {
    const tampered = req.url.startsWith('/tampered/');
    const file = path.join(dir, path.basename(decodeURIComponent(req.url)));
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    const bytes = fs.readFileSync(file);
    if (tampered) bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    res.writeHead(200, { 'Content-Length': bytes.length }).end(bytes);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const { version, dir = 'dist' } = args(process.argv.slice(2));
  assert.ok(version, '--version is required');
  const dist = path.resolve(dir);
  const asset = updateAsset(process.platform, process.arch);
  const server = await serve(dist);
  const base = `http://127.0.0.1:${server.address().port}`;
  const release = (fileUrl) => ({
    version,
    assets: [{ name: asset.manifest, url: `${base}/${asset.manifest}` }, { name: asset.file, url: fileUrl }]
  });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-smoke-update-'));

  try {
    const progress = [];
    const file = await downloadVerified({
      release: release(`${base}/${asset.file}`), fetchImpl: fetch, dir: path.join(work, 'download'), asset,
      onProgress: (p) => progress.push(p)
    });
    assert.strictEqual(progress.at(-1), 1, 'progress reaches 100%');
    console.log(`ok    downloaded and verified ${path.basename(file)}`);

    await assert.rejects(downloadVerified({
      release: release(`${base}/tampered/${asset.file}`), fetchImpl: fetch, dir: path.join(work, 'tampered'), asset
    }), /checksum/);
    assert.deepStrictEqual(fs.readdirSync(path.join(work, 'tampered')), []);
    console.log('ok    a tampered download is refused and removed');

    if (process.platform === 'darwin') await macUpdate({ file, version, work });
    else if (process.platform === 'win32') await windowsUpdate({ file, version });
  } finally {
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function macUpdate({ file, version, work }) {
  const staged = await stageMacApp({ dmg: file, dir: path.join(work, 'download'), version, run });
  console.log('ok    the app was copied out of the DMG and verified');

  // An "older Loupe" that is still running, then quits.
  const app = path.join(work, 'Applications', 'Loupe.app');
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'old-version'), '');
  const running = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)']);
  // A bundle id that isn't Loupe's: nothing real has its permissions reset.
  spawn('/bin/sh', ['-c', MAC_SWAP_SCRIPT, 'loupe-update', String(running.pid), staged, app, '1', 'test.invalid.loupe'],
    { detached: true, stdio: 'ignore' }).unref();

  const plist = path.join(app, 'Contents', 'Info.plist');
  await waitFor('the new app to be swapped in', () => fs.existsSync(plist));
  assert.ok(!fs.existsSync(path.join(app, 'Contents', 'old-version')));
  assert.strictEqual((await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist])).stdout.trim(), version);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  console.log(`ok    Loupe ${version} replaced the running app once it quit, and its signature holds`);

  const exe = path.join(app, 'Contents', 'MacOS', 'Loupe');
  await waitFor('Loupe to open again', () => spawnSync('/usr/bin/pgrep', ['-f', exe]).status === 0);
  console.log('ok    Loupe opened again');
  spawnSync('/usr/bin/pkill', ['-f', exe]);
}

async function windowsUpdate({ file, version }) {
  const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'Loupe');
  const exe = path.join(installDir, 'Loupe.exe');
  const isRunning = () => execFileSync('tasklist', ['/FI', 'IMAGENAME eq Loupe.exe', '/NH']).toString().includes('Loupe.exe');
  const quit = () => spawnSync('taskkill', ['/IM', 'Loupe.exe', '/F']);

  // The Loupe being updated: installed, opened, then quit.
  execFileSync(file, ['/S']);
  assert.ok(fs.existsSync(exe), 'Loupe.exe installed');
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  await waitFor('Loupe to open', isRunning);
  quit();
  await waitFor('Loupe to quit', () => !isRunning());

  // What will-quit does after Update now.
  spawn(file, installerArgs({ relaunch: true }), { detached: true, stdio: 'ignore' }).unref();
  await waitFor('Loupe to open again after the update', isRunning, 180000);
  const installed = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.ProductVersion`]).toString().trim();
  assert.ok(installed.startsWith(version), `installed ${installed}, expected ${version}`);
  console.log(`ok    the installer updated Loupe to ${installed} silently and opened it again`);

  quit();
  await waitFor('Loupe to quit', () => !isRunning());
  const uninstaller = path.join(installDir, 'Uninstall Loupe.exe');
  if (fs.existsSync(uninstaller)) execFileSync(uninstaller, ['/S']);
}

main().then(() => console.log('Update now works end to end.'), (err) => {
  console.error(err);
  process.exit(1);
});
