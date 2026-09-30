'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Update checks against GitHub Releases. Free of Electron (everything that
// touches the network, the disk or a process is passed in), so the whole
// flow runs under node --test with a fake fetch.
//
// Both platforms update in place, and nothing runs until its sha512 matches
// the manifest the release workflow publishes next to it
// (packaging/latest-yml.js):
// Windows: the NSIS installer, checked against latest.yml, runs as Loupe quits.
// macOS: the DMG for this Mac, checked against latest-mac.yml. Its app is
// copied out and verified (codesign, version), then swapped in for this one
// by a small script once Loupe has quit (MAC_SWAP_SCRIPT). Where the app
// can't be replaced -- a read-only or translocated copy -- Loupe says a new
// version exists and how to get it instead: the brew command for a Homebrew
// install, the release page otherwise.

const REPO = 'akshatgg/loupe';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const WINDOWS_INSTALLER = 'Loupe-Setup-x64.exe';
const MAC_DMGS = { arm64: 'Loupe-arm64.dmg', x64: 'Loupe-x64.dmg' };
const BUNDLE_ID = 'tech.markai.loupe';
const BREW_COMMAND = 'brew upgrade --cask loupe';
// Loupe checks each time it opens, and again this often while it stays open.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CASKROOMS = ['/opt/homebrew/Caskroom/loupe', '/usr/local/Caskroom/loupe'];
// A request that gets no answer (a captive portal, a network that drops
// packets) would otherwise leave "Checking for updates…" spinning forever,
// with Check now disabled because a check is still running.
const REQUEST_TIMEOUT_MS = 20 * 1000;
// The installer is large, so the download has no overall limit -- only a
// limit on how long it may go without receiving anything.
const DOWNLOAD_STALL_MS = 60 * 1000;

class TimeoutError extends Error {}

// fetch with a deadline for the response headers. Aborts the request and
// also races it, so a fetch that ignores the signal can't hang the check.
async function fetchWithTimeout(fetchImpl, url, opts = {}, ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError('The request timed out'));
    }, ms);
  });
  try {
    return await Promise.race([fetchImpl(url, { ...opts, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- versions ---------------------------------------------------------------

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(v) {
  const m = typeof v === 'string' ? VERSION_RE.exec(v.trim()) : null;
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

// Semver precedence: numbers first; a pre-release sorts before its release;
// pre-release identifiers compare numerically when both are numbers.
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) throw new Error(`Not a version: ${JSON.stringify(va ? b : a)}`);
  for (const k of ['major', 'minor', 'patch']) {
    if (va[k] !== vb[k]) return va[k] < vb[k] ? -1 : 1;
  }
  if (!va.pre.length && !vb.pre.length) return 0;
  if (!va.pre.length) return 1;
  if (!vb.pre.length) return -1;
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return +x < +y ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// ---- GitHub -----------------------------------------------------------------

async function fetchLatestRelease(fetchImpl, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const res = await fetchWithTimeout(fetchImpl, RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Loupe' }
  }, timeoutMs);
  if (!res.ok) {
    const err = new Error(`GitHub answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  const version = String(body?.tag_name ?? '').replace(/^v/, '');
  if (!parseVersion(version)) throw new Error('The latest release has no version number');
  const assets = Array.isArray(body.assets) ? body.assets : [];
  return {
    version,
    name: typeof body.name === 'string' ? body.name : `Loupe ${version}`,
    notes: typeof body.body === 'string' ? body.body.slice(0, 20000) : '',
    // Only ever a github.com page for this repository: it is opened in the
    // user's browser, so a surprising value is replaced, not followed.
    url: typeof body.html_url === 'string' && body.html_url.startsWith(`https://github.com/${REPO}/`)
      ? body.html_url : RELEASES_PAGE,
    publishedAt: typeof body.published_at === 'string' ? body.published_at : null,
    assets: assets
      .filter((a) => typeof a?.name === 'string' && typeof a?.browser_download_url === 'string')
      .map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))
  };
}

// ---- latest.yml -------------------------------------------------------------

// electron-builder's update manifest. Only the flat shape it writes is read:
//   version: 1.2.3
//   files:
//     - url: Loupe-Setup-x64.exe
//       sha512: <base64>
//       size: 123
//   path: Loupe-Setup-x64.exe
//   sha512: <base64>
//   releaseDate: '2026-09-16T00:00:00.000Z'
function parseLatestYml(text) {
  const unquote = (s) => {
    const t = s.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
    return t;
  };
  const out = { files: [] };
  let inFiles = false;
  let file = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const item = /^\s*-\s+(\w+):\s*(.*)$/.exec(raw);
    const nested = /^\s+(\w+):\s*(.*)$/.exec(raw);
    const top = /^(\w+):\s*(.*)$/.exec(raw);
    if (top) {
      inFiles = top[1] === 'files' && top[2].trim() === '';
      if (!inFiles) out[top[1]] = unquote(top[2]);
    } else if (inFiles && item) {
      file = { [item[1]]: unquote(item[2]) };
      out.files.push(file);
    } else if (inFiles && nested && file) {
      file[nested[1]] = unquote(nested[2]);
    }
  }
  for (const f of out.files) if (f.size !== undefined) f.size = Number(f.size);
  return out;
}

// One file (Windows' installer), or `files` for several (the two Mac DMGs);
// path/sha512 name the first, as electron-builder's own manifests do.
function formatLatestYml({ version, file, sha512, size, files, releaseDate }) {
  const list = files ?? [{ file, sha512, size }];
  return [
    `version: ${version}`,
    'files:',
    ...list.flatMap((f) => [`  - url: ${f.file}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`]),
    `path: ${list[0].file}`,
    `sha512: ${list[0].sha512}`,
    `releaseDate: '${releaseDate}'`,
    ''
  ].join('\n');
}

async function sha512OfFile(file) {
  const hash = crypto.createHash('sha512');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('base64');
}

// What this platform downloads to update itself, and the manifest that
// carries its checksum.
function updateAsset(platform, arch) {
  if (platform === 'win32') return { manifest: 'latest.yml', file: WINDOWS_INSTALLER };
  return { manifest: 'latest-mac.yml', file: MAC_DMGS[arch] ?? MAC_DMGS.arm64 };
}

// The versioned name a download is kept under: Loupe-Setup-x64.exe for 0.3.0
// is Loupe-Setup-0.3.0-x64.exe.
const versionedName = (file, version) => file.replace(/-([^-]+)$/, `-${version}-$1`);

// Downloads `asset` of `release` into `dir` and returns its path -- only if
// its sha512 matches the release's manifest. A mismatch deletes the file and
// throws: a corrupted or tampered download is never offered. onProgress gets
// the fraction received so far.
async function downloadVerified({
  release, fetchImpl, dir, asset, timeoutMs = REQUEST_TIMEOUT_MS, stallMs = DOWNLOAD_STALL_MS,
  onProgress = () => {}
}) {
  const ymlAsset = release.assets.find((a) => a.name === asset.manifest);
  const fileAsset = release.assets.find((a) => a.name === asset.file);
  if (!ymlAsset || !fileAsset) throw new Error(`This release has no ${asset.file} to update from`);

  const ymlRes = await fetchWithTimeout(fetchImpl, ymlAsset.url, { headers: { 'User-Agent': 'Loupe' } }, timeoutMs);
  if (!ymlRes.ok) throw new Error(`Could not download ${asset.manifest} (${ymlRes.status})`);
  const manifest = parseLatestYml(await ymlRes.text());
  if (manifest.version !== release.version) {
    throw new Error(`${asset.manifest} is for ${manifest.version}, not ${release.version}`);
  }
  const entry = manifest.files.find((f) => f.url === asset.file)
    ?? (manifest.path === asset.file ? { sha512: manifest.sha512 } : null);
  if (!entry?.sha512) throw new Error(`${asset.manifest} has no checksum for ${asset.file}`);

  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, versionedName(asset.file, release.version));
  // Already downloaded (a previous launch)? Reuse it if it still verifies.
  if (fs.existsSync(target) && await sha512OfFile(target) === entry.sha512) return removeOthers(dir, target, asset.file);

  const partial = `${target}.partial`;
  const res = await fetchWithTimeout(fetchImpl, fileAsset.url, { headers: { 'User-Agent': 'Loupe' } }, timeoutMs);
  if (!res.ok || !res.body) throw new Error(`Could not download the update (${res.status})`);
  const total = Number(res.headers?.get?.('content-length')) || entry.size || fileAsset.size || 0;
  const hash = crypto.createHash('sha512');
  let received = 0;
  let stall = null;
  try {
    const body = Readable.fromWeb(res.body);
    const watch = () => {
      clearTimeout(stall);
      stall = setTimeout(() => body.destroy(new TimeoutError('The download stopped')), stallMs);
    };
    watch();
    body.on('data', (chunk) => {
      watch();
      hash.update(chunk);
      received += chunk.length;
      if (total > 0) onProgress(Math.min(1, received / total));
    });
    await pipeline(body, fs.createWriteStream(partial));
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  } finally {
    clearTimeout(stall);
  }
  if (hash.digest('base64') !== entry.sha512) {
    fs.rmSync(partial, { force: true });
    throw new Error('The downloaded update did not match its checksum, so it was discarded');
  }
  fs.renameSync(partial, target);
  return removeOthers(dir, target, asset.file);
}

// The Windows installer for `release` (downloadVerified above).
function downloadVerifiedInstaller(opts) {
  return downloadVerified({ ...opts, asset: updateAsset('win32') });
}

// Downloads of older versions (each one about 100 MB) would otherwise pile
// up in the temp folder, one per update, since nothing else removes them.
// Only files this code names are touched, whatever folder it was given.
function removeOthers(dir, keep, file) {
  const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const [, stem, tail] = /^(.*)-([^-]+)$/.exec(file);
  const old = new RegExp(`^${escape(stem)}-[^/\\\\]+-${escape(tail)}(\\.partial)?$`);
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (full !== keep && old.test(name)) fs.rmSync(full, { force: true });
  }
  return keep;
}

// ---- install kinds ----------------------------------------------------------

// The app bundle this Loupe runs from (…/Loupe.app/Contents/MacOS/Loupe),
// when it can be replaced: Loupe must be able to move it and write next to
// it. A copy run from its DMG, or translocated by Gatekeeper, is read-only.
function replaceableBundle(execPath, { access = fs.accessSync } = {}) {
  const bundle = path.resolve(execPath, '..', '..', '..');
  if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/')) return null;
  try {
    access(path.dirname(bundle), fs.constants.W_OK);
    access(bundle, fs.constants.W_OK);
  } catch {
    return null;
  }
  return bundle;
}

// installer: Windows, the NSIS installer. bundle: macOS, the app replaced in
// place. homebrew / download: macOS where the app can't be replaced -- the
// brew command, or the release page.
function installKind(platform, { exists = fs.existsSync, bundle = null } = {}) {
  if (platform === 'win32') return 'installer';
  if (platform === 'darwin' && bundle) return 'bundle';
  if (platform === 'darwin' && CASKROOMS.some((p) => exists(p))) return 'homebrew';
  return 'download';
}

const installsItself = (kind) => kind === 'installer' || kind === 'bundle';

// /S: silent. --updated: tells electron-builder's NSIS script this is an
// update (it closes the running app and keeps user data). --force-run: start
// Loupe again once installed -- "Update now". The quit-time install leaves
// that off: the user was quitting.
function installerArgs({ relaunch }) {
  return relaunch ? ['/S', '--updated', '--force-run'] : ['/S', '--updated'];
}

// macOS: copies the app out of the verified DMG into `dir` and checks it
// before anything is replaced -- its signature seals every file, and it must
// be the version the release says. `run(file, args)` runs a command and
// resolves to { stdout }. Resolves to the staged app's path.
async function stageMacApp({ dmg, dir, version, run }) {
  const staged = path.join(dir, 'Loupe.app');
  fs.rmSync(staged, { recursive: true, force: true });
  const mount = fs.mkdtempSync(path.join(dir, 'mount-'));
  await run('/usr/bin/hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount]);
  try {
    await run('/usr/bin/ditto', [path.join(mount, 'Loupe.app'), staged]);
  } finally {
    await run('/usr/bin/hdiutil', ['detach', mount, '-force']).catch(() => {});
    try { fs.rmdirSync(mount); } catch { /* still mounted: the OS removes it */ }
  }
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
    const { stdout } = await run('/usr/bin/plutil', [
      '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(staged, 'Contents', 'Info.plist')
    ]);
    const found = String(stdout).trim();
    if (found !== version) throw new Error(`The downloaded app is version ${found}, not ${version}`);
  } catch (err) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw err;
  }
  return staged;
}

// macOS: run detached as Loupe quits -- `sh -c MAC_SWAP_SCRIPT loupe-update
// <pid> <staged app> <installed app> <relaunch 1|0> <bundle id>`. Waits for
// Loupe to exit (a minute at most, then gives up and changes nothing),
// moves the old app aside, moves the new one in, and puts the old one back
// if that fails. Loupe opens again either way when asked to.
// An ad-hoc signed app is a different app to macOS after every update, so
// its privacy switches (Screen Recording, Accessibility, …) would still show
// on in System Settings while no longer applying to it. Those stale entries
// are cleared, so the new copy asks again instead of failing silently. A
// Developer ID signed app keeps its permissions and is left alone.
const MAC_SWAP_SCRIPT = [
  'pid=$1; new=$2; app=$3; relaunch=$4; id=$5',
  'old="$(dirname "$app")/.Loupe-old.app"',
  'i=0',
  'while kill -0 "$pid" 2>/dev/null; do',
  '  i=$((i+1)); [ "$i" -gt 300 ] && exit 1',
  '  sleep 0.2',
  'done',
  'rm -rf "$old"',
  'swapped=0',
  'if mv "$app" "$old"; then',
  '  if mv "$new" "$app"; then rm -rf "$old"; swapped=1; else rm -rf "$app"; mv "$old" "$app"; fi',
  'fi',
  'if [ "$swapped" = 1 ] && /usr/bin/codesign -dv "$app" 2>&1 | grep -q "Signature=adhoc"; then',
  '  /usr/bin/tccutil reset All "$id" >/dev/null 2>&1',
  'fi',
  '[ "$relaunch" = 1 ] && /usr/bin/open "$app"',
  'exit 0'
].join('\n');

// Checks run when the setting allows. (Launch always checks then; while
// Loupe stays open, once every CHECK_INTERVAL_MS.)
function shouldAutoCheck(settings) {
  return settings.checkForUpdates === true;
}

// ---- the updater ------------------------------------------------------------

// State (what the Settings window's Updates section and the Update now
// buttons show):
//   status:   'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error'
//   kind:     'installer' | 'bundle' | 'homebrew' | 'download'
//   latest:   { version, name, notes, url, publishedAt } | null
//   progress: 0..1 while downloading, else null
//   pending:  the user asked to update; it installs as soon as it is ready
//   error:    string | null     checkedAt: ms | null
// Where Loupe installs itself (installer, bundle) a newer release moves on
// through 'downloading' to 'ready' (verified, ready to install) or 'error';
// otherwise 'available' is final.
function createUpdater({
  currentVersion, platform = process.platform, arch = process.arch, fetchImpl, downloadDir,
  getSettings, patchSettings, now = Date.now, exists = fs.existsSync, bundle = null,
  pid = process.pid, spawn, runCommand, onChange = () => {}, timeoutMs = REQUEST_TIMEOUT_MS
}) {
  const kind = installKind(platform, { exists, bundle });
  let state = {
    status: 'idle', kind, currentVersion, latest: null, progress: null, pending: false, error: null, checkedAt: null
  };
  let readyPath = null;
  let readyVersion = null;
  let running = null;
  let installed = false;

  const set = (changes) => {
    state = { ...state, ...changes };
    onChange(state);
  };

  async function run() {
    set({ status: 'checking', error: null });
    let release;
    try {
      release = await fetchLatestRelease(fetchImpl, { timeoutMs });
    } catch (err) {
      // An update already downloaded stays ready: only the check failed.
      if (readyPath) set({ status: 'ready', checkedAt: now() });
      else set({ status: 'error', error: friendlyError(err), checkedAt: now(), latest: null });
      return state;
    }
    patchSettings({ lastUpdateCheck: now() });
    const { assets, ...latest } = release;
    if (compareVersions(release.version, currentVersion) <= 0) {
      set({ status: 'current', latest, checkedAt: now() });
      return state;
    }
    if (!installsItself(kind)) {
      set({ status: 'available', latest, checkedAt: now() });
      return state;
    }
    if (readyPath && readyVersion === release.version) {
      set({ status: 'ready', latest, checkedAt: now() });
      return state;
    }
    readyPath = null;
    set({ status: 'downloading', latest, progress: 0, checkedAt: now() });
    try {
      const file = await downloadVerified({
        release: { ...release, assets }, fetchImpl, dir: downloadDir, timeoutMs,
        asset: updateAsset(platform, arch),
        onProgress: (fraction) => {
          const p = Math.floor(fraction * 100) / 100;
          if (p !== state.progress) set({ progress: p });
        }
      });
      readyPath = kind === 'bundle'
        ? await stageMacApp({ dmg: file, dir: downloadDir, version: release.version, run: runCommand })
        : file;
      readyVersion = release.version;
      set({ status: 'ready', progress: null });
    } catch (err) {
      readyPath = null;
      set({ status: 'error', progress: null, pending: false, error: friendlyError(err) });
    }
    return state;
  }

  // One check at a time; a second caller shares the running one.
  function check() {
    if (!running) running = run().finally(() => { running = null; });
    return running;
  }

  // Checks if the setting allows. Resolves to the state, or null when it
  // didn't check.
  async function autoCheck() {
    if (!shouldAutoCheck(getSettings())) return null;
    return check();
  }

  // "Update now" before the download has finished: remembered, so it
  // installs the moment it is ready. After a failed download it tries again.
  function requestInstall() {
    if (!installsItself(kind) || !state.latest) return false;
    set({ pending: true });
    if (state.status === 'error') check();
    return true;
  }

  // Starts the verified update detached. The caller quits the app right
  // after, which is what lets it replace Loupe.
  function install({ relaunch }) {
    if (!installsItself(kind) || state.status !== 'ready' || !readyPath || installed) return false;
    const child = kind === 'installer'
      ? spawn(readyPath, installerArgs({ relaunch }), { detached: true, stdio: 'ignore' })
      : spawn('/bin/sh', ['-c', MAC_SWAP_SCRIPT, 'loupe-update', String(pid), readyPath, bundle, relaunch ? '1' : '0', BUNDLE_ID],
        { detached: true, stdio: 'ignore' });
    child.unref?.();
    installed = true;
    return true;
  }

  return {
    check, autoCheck, requestInstall, install,
    state: () => state,
    installsItself: () => installsItself(kind),
    brewCommand: BREW_COMMAND
  };
}

// What the Settings window shows. Raw network and HTTP errors mean nothing
// to most people, so the common ones get a plain sentence.
function friendlyError(err) {
  const msg = String(err?.message ?? err);
  if (err instanceof TimeoutError || err?.name === 'AbortError') {
    return 'GitHub took too long to answer. Check your internet connection and try again.';
  }
  if (err?.status === 403 || err?.status === 429) {
    return 'GitHub is getting too many requests right now. Try again in an hour.';
  }
  if (err?.status === 404) return 'No released version of Loupe was found.';
  if (err?.status >= 500) return 'GitHub isn’t answering right now. Try again later.';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET|ERR_NAME|network/i.test(msg)) {
    return 'Could not reach GitHub. Check your internet connection and try again.';
  }
  return msg;
}

module.exports = {
  RELEASES_API, RELEASES_PAGE, WINDOWS_INSTALLER, MAC_DMGS, BUNDLE_ID, BREW_COMMAND, CHECK_INTERVAL_MS, CASKROOMS,
  MAC_SWAP_SCRIPT, parseVersion, compareVersions, fetchLatestRelease, parseLatestYml, formatLatestYml,
  sha512OfFile, updateAsset, downloadVerified, downloadVerifiedInstaller, stageMacApp, replaceableBundle,
  installKind, installerArgs, shouldAutoCheck, createUpdater, fetchWithTimeout, friendlyError, REQUEST_TIMEOUT_MS
};
