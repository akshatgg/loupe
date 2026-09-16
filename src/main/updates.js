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
// macOS: the app is not signed with a Developer ID, so it cannot replace
// itself; we say a new version exists and how to get it -- the brew command
// for a Homebrew install, the release page otherwise.
// Windows: the NSIS installer can update in place. We download it, check its
// sha512 against latest.yml (published next to it by the release workflow,
// packaging/latest-yml.js) and only then offer "Restart to update".

const REPO = 'akshatgg/loupe';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const WINDOWS_INSTALLER = 'Loupe-Setup-x64.exe';
const BREW_COMMAND = 'brew upgrade --cask loupe';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CASKROOMS = ['/opt/homebrew/Caskroom/loupe', '/usr/local/Caskroom/loupe'];

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

async function fetchLatestRelease(fetchImpl) {
  const res = await fetchImpl(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Loupe' }
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
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

function formatLatestYml({ version, file, sha512, size, releaseDate }) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${file}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${file}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    ''
  ].join('\n');
}

async function sha512OfFile(file) {
  const hash = crypto.createHash('sha512');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('base64');
}

// Downloads the Windows installer for `release` into `dir` and returns its
// path -- only if its sha512 matches latest.yml. A mismatch deletes the file
// and throws: a corrupted or tampered installer is never offered.
async function downloadVerifiedInstaller({ release, fetchImpl, dir }) {
  const ymlAsset = release.assets.find((a) => a.name === 'latest.yml');
  const exeAsset = release.assets.find((a) => a.name === WINDOWS_INSTALLER);
  if (!ymlAsset || !exeAsset) throw new Error('This release has no Windows installer to update from');

  const ymlRes = await fetchImpl(ymlAsset.url, { headers: { 'User-Agent': 'Loupe' } });
  if (!ymlRes.ok) throw new Error(`Could not download latest.yml (${ymlRes.status})`);
  const manifest = parseLatestYml(await ymlRes.text());
  if (manifest.version !== release.version) {
    throw new Error(`latest.yml is for ${manifest.version}, not ${release.version}`);
  }
  const entry = manifest.files.find((f) => f.url === WINDOWS_INSTALLER)
    ?? (manifest.path === WINDOWS_INSTALLER ? { sha512: manifest.sha512 } : null);
  if (!entry?.sha512) throw new Error('latest.yml has no checksum for the installer');

  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `Loupe-Setup-${release.version}-x64.exe`);
  // Already downloaded (a previous launch)? Reuse it if it still verifies.
  if (fs.existsSync(target) && await sha512OfFile(target) === entry.sha512) return target;

  const partial = `${target}.partial`;
  const exeRes = await fetchImpl(exeAsset.url, { headers: { 'User-Agent': 'Loupe' } });
  if (!exeRes.ok || !exeRes.body) throw new Error(`Could not download the installer (${exeRes.status})`);
  const hash = crypto.createHash('sha512');
  try {
    const body = Readable.fromWeb(exeRes.body);
    body.on('data', (chunk) => hash.update(chunk));
    await pipeline(body, fs.createWriteStream(partial));
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
  if (hash.digest('base64') !== entry.sha512) {
    fs.rmSync(partial, { force: true });
    throw new Error('The downloaded installer did not match its checksum, so it was discarded');
  }
  fs.renameSync(partial, target);
  return target;
}

// ---- install kinds ----------------------------------------------------------

function installKind(platform, exists = fs.existsSync) {
  if (platform === 'win32') return 'installer';
  if (platform === 'darwin' && CASKROOMS.some((p) => exists(p))) return 'homebrew';
  return 'download';
}

// /S: silent. --updated: tells electron-builder's NSIS script this is an
// update (it closes the running app and keeps user data). --force-run: start
// Loupe again once installed -- "Restart to update". The quit-time install
// leaves that off: the user was quitting.
function installerArgs({ relaunch }) {
  return relaunch ? ['/S', '--updated', '--force-run'] : ['/S', '--updated'];
}

function shouldAutoCheck(settings, now) {
  return settings.checkForUpdates === true
    && !(settings.lastUpdateCheck > 0 && now - settings.lastUpdateCheck < CHECK_INTERVAL_MS);
}

// ---- the updater ------------------------------------------------------------

// State (what the Settings window's Updates section shows):
//   status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error'
//   kind:   'homebrew' | 'download' | 'installer'
//   latest: { version, name, notes, url, publishedAt } | null
//   error:  string | null     checkedAt: ms | null
// On macOS 'available' is final; on Windows it moves on to 'downloading' and
// then 'ready' (installer verified) or 'error'.
function createUpdater({
  currentVersion, platform = process.platform, fetchImpl, downloadDir,
  getSettings, patchSettings, now = Date.now, exists = fs.existsSync,
  spawn, onChange = () => {}
}) {
  const kind = installKind(platform, exists);
  let state = { status: 'idle', kind, currentVersion, latest: null, error: null, checkedAt: null };
  let installerPath = null;
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
      release = await fetchLatestRelease(fetchImpl);
    } catch (err) {
      set({ status: 'error', error: friendlyError(err), checkedAt: now(), latest: null });
      return state;
    }
    patchSettings({ lastUpdateCheck: now() });
    const { assets, ...latest } = release;
    if (compareVersions(release.version, currentVersion) <= 0) {
      set({ status: 'current', latest, checkedAt: now() });
      return state;
    }
    if (kind !== 'installer') {
      set({ status: 'available', latest, checkedAt: now() });
      return state;
    }
    set({ status: 'downloading', latest, checkedAt: now() });
    try {
      installerPath = await downloadVerifiedInstaller({ release: { ...release, assets }, fetchImpl, dir: downloadDir });
      set({ status: 'ready' });
    } catch (err) {
      installerPath = null;
      set({ status: 'error', error: friendlyError(err) });
    }
    return state;
  }

  // One check at a time; a second caller shares the running one.
  function check() {
    if (!running) running = run().finally(() => { running = null; });
    return running;
  }

  // Launch-time check: only if the setting allows it and the last one was
  // over a day ago. Resolves to the state, or null when it didn't check.
  async function autoCheck() {
    if (!shouldAutoCheck(getSettings(), now())) return null;
    return check();
  }

  // Whether this version is news to the user -- the automatic check tells
  // them once per version, not on every launch.
  function shouldNotify() {
    const s = getSettings();
    return Boolean(state.latest) && (state.status === 'available' || state.status === 'ready')
      && s.lastNotifiedVersion !== state.latest.version;
  }

  function markNotified() {
    if (state.latest) patchSettings({ lastNotifiedVersion: state.latest.version });
  }

  // Windows only: start the verified installer detached. The caller quits the
  // app right after, which is what lets the installer replace it.
  function install({ relaunch }) {
    if (kind !== 'installer' || state.status !== 'ready' || !installerPath || installed) return false;
    const child = spawn(installerPath, installerArgs({ relaunch }), { detached: true, stdio: 'ignore' });
    child.unref?.();
    installed = true;
    return true;
  }

  return {
    check, autoCheck, shouldNotify, markNotified, install,
    state: () => state,
    brewCommand: BREW_COMMAND
  };
}

function friendlyError(err) {
  const msg = String(err?.message ?? err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(msg)) {
    return 'Could not reach GitHub. Check your internet connection and try again.';
  }
  return msg;
}

module.exports = {
  RELEASES_API, RELEASES_PAGE, WINDOWS_INSTALLER, BREW_COMMAND, CHECK_INTERVAL_MS, CASKROOMS,
  parseVersion, compareVersions, fetchLatestRelease, parseLatestYml, formatLatestYml,
  sha512OfFile, downloadVerifiedInstaller, installKind, installerArgs, shouldAutoCheck,
  createUpdater
};
