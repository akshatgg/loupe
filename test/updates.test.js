'use strict';
/* global Response -- the fetch API's Response, built into Node */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  RELEASES_API, CHECK_INTERVAL_MS, parseVersion, compareVersions, fetchLatestRelease,
  parseLatestYml, formatLatestYml, downloadVerifiedInstaller, installKind, installerArgs,
  shouldAutoCheck, createUpdater
} = require('../src/main/updates');
const { writeLatestYml } = require('../packaging/latest-yml');
const { DEFAULT_SETTINGS, normalizeSettings } = require('../src/main/settings');

const made = [];
const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-updates-'));
  made.push(dir);
  return dir;
};
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('base64');

// A fake of the fetch API: a map of URL -> body (object = JSON, string or
// Buffer = bytes, number = an HTTP error status). Records every request.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (!(url in routes)) throw new TypeError('fetch failed');
    const body = routes[url];
    if (typeof body === 'number') return new Response('nope', { status: body });
    if (Buffer.isBuffer(body) || typeof body === 'string') return new Response(body);
    return Response.json(body);
  };
  fn.calls = calls;
  return fn;
}

const EXE_URL = 'https://github.com/akshatgg/loupe/releases/download/v0.3.0/Loupe-Setup-x64.exe';
const YML_URL = 'https://github.com/akshatgg/loupe/releases/download/v0.3.0/latest.yml';

function release(version = '0.3.0', extra = {}) {
  return {
    tag_name: `v${version}`,
    name: `Loupe ${version}`,
    body: 'New things',
    html_url: `https://github.com/akshatgg/loupe/releases/tag/v${version}`,
    published_at: '2026-09-15T10:00:00Z',
    assets: [
      { name: 'Loupe-arm64.dmg', browser_download_url: 'https://example/arm.dmg', size: 1 },
      { name: 'Loupe-Setup-x64.exe', browser_download_url: EXE_URL, size: 10 },
      { name: 'latest.yml', browser_download_url: YML_URL, size: 1 }
    ],
    ...extra
  };
}

test('versions compare the way semver says', () => {
  assert.deepStrictEqual(parseVersion('v1.2.3-beta.1'), { major: 1, minor: 2, patch: 3, pre: ['beta', '1'] });
  assert.strictEqual(parseVersion('1.2'), null);
  assert.strictEqual(parseVersion(null), null);
  const ordered = ['0.1.0', '0.1.1', '0.2.0-alpha', '0.2.0-alpha.1', '0.2.0-alpha.beta', '0.2.0-beta',
    '0.2.0-beta.2', '0.2.0-beta.11', '0.2.0-rc.1', '0.2.0', '0.10.0', '1.0.0'];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assert.strictEqual(compareVersions(ordered[i], ordered[j]), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
    }
  }
  assert.strictEqual(compareVersions('v1.0.0', '1.0.0+build.5'), 0);
  assert.throws(() => compareVersions('one', '1.0.0'));
});

test('the latest release is read from the GitHub API', async () => {
  const fetchImpl = fakeFetch({ [RELEASES_API]: release() });
  const r = await fetchLatestRelease(fetchImpl);
  assert.strictEqual(r.version, '0.3.0');
  assert.strictEqual(r.url, 'https://github.com/akshatgg/loupe/releases/tag/v0.3.0');
  assert.strictEqual(r.assets.length, 3);
  assert.strictEqual(fetchImpl.calls[0].opts.headers['User-Agent'], 'Loupe');
});

test('a release page link that isn\'t this repository is not followed', async () => {
  const r = await fetchLatestRelease(fakeFetch({ [RELEASES_API]: release('0.3.0', { html_url: 'https://evil.example/' }) }));
  assert.strictEqual(r.url, 'https://github.com/akshatgg/loupe/releases/latest');
});

test('GitHub errors and odd answers are reported, not crashed on', async () => {
  await assert.rejects(fetchLatestRelease(fakeFetch({ [RELEASES_API]: 403 })), /403/);
  await assert.rejects(fetchLatestRelease(fakeFetch({ [RELEASES_API]: { tag_name: 'nightly' } })), /no version/);
});

test('latest.yml: what the release script writes, the app reads back', () => {
  const text = formatLatestYml({ version: '0.3.0', file: 'Loupe-Setup-x64.exe', sha512: 'abc+/=', size: 42, releaseDate: '2026-09-16T00:00:00.000Z' });
  assert.deepStrictEqual(parseLatestYml(text), {
    version: '0.3.0',
    files: [{ url: 'Loupe-Setup-x64.exe', sha512: 'abc+/=', size: 42 }],
    path: 'Loupe-Setup-x64.exe',
    sha512: 'abc+/=',
    releaseDate: '2026-09-16T00:00:00.000Z'
  });
});

test('latest.yml as electron-builder itself writes it also parses', () => {
  const text = [
    'version: 1.4.2',
    'files:',
    '  - url: Loupe-Setup-x64.exe',
    '    sha512: Zm9v',
    '    size: 91234567',
    "path: Loupe-Setup-x64.exe",
    'sha512: Zm9v',
    "releaseDate: '2026-01-02T03:04:05.678Z'",
    ''
  ].join('\r\n');
  const m = parseLatestYml(text);
  assert.strictEqual(m.version, '1.4.2');
  assert.deepStrictEqual(m.files, [{ url: 'Loupe-Setup-x64.exe', sha512: 'Zm9v', size: 91234567 }]);
});

test('packaging/latest-yml.js hashes the real installer file', async () => {
  const dir = tmpDir();
  const installer = path.join(dir, 'Loupe-Setup-x64.exe');
  const bytes = crypto.randomBytes(200000);
  fs.writeFileSync(installer, bytes);
  const out = await writeLatestYml({ version: '0.3.0', installer, now: new Date('2026-09-16T00:00:00Z') });
  assert.strictEqual(out, path.join(dir, 'latest.yml'));
  const m = parseLatestYml(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(m.files[0].sha512, sha512(bytes));
  assert.strictEqual(m.files[0].size, bytes.length);
  await assert.rejects(writeLatestYml({ version: 'v-next', installer }), /Not a version/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the Windows installer is kept only when its sha512 matches latest.yml', async () => {
  const dir = tmpDir();
  const exe = crypto.randomBytes(300000);
  const good = formatLatestYml({ version: '0.3.0', file: 'Loupe-Setup-x64.exe', sha512: sha512(exe), size: exe.length, releaseDate: 'x' });
  const rel = await fetchLatestRelease(fakeFetch({ [RELEASES_API]: release() }));

  const file = await downloadVerifiedInstaller({ release: rel, fetchImpl: fakeFetch({ [YML_URL]: good, [EXE_URL]: exe }), dir });
  assert.strictEqual(file, path.join(dir, 'Loupe-Setup-0.3.0-x64.exe'));
  assert.ok(fs.readFileSync(file).equals(exe));

  // Already there and still valid: not downloaded again.
  const again = fakeFetch({ [YML_URL]: good, [EXE_URL]: exe });
  await downloadVerifiedInstaller({ release: rel, fetchImpl: again, dir });
  assert.deepStrictEqual(again.calls.map((c) => c.url), [YML_URL]);

  // A tampered download is thrown away.
  fs.rmSync(file);
  const tampered = Buffer.from(exe);
  tampered[1000] ^= 0xff;
  await assert.rejects(
    downloadVerifiedInstaller({ release: rel, fetchImpl: fakeFetch({ [YML_URL]: good, [EXE_URL]: tampered }), dir }),
    /did not match its checksum/);
  assert.deepStrictEqual(fs.readdirSync(dir), []);

  // A manifest for a different version is refused before downloading.
  const other = good.replace('version: 0.3.0', 'version: 0.2.9');
  const f = fakeFetch({ [YML_URL]: other, [EXE_URL]: exe });
  await assert.rejects(downloadVerifiedInstaller({ release: rel, fetchImpl: f, dir }), /not 0.3.0/);
  assert.ok(!f.calls.some((c) => c.url === EXE_URL));

  // No manifest in the release at all.
  const bare = { ...rel, assets: rel.assets.filter((a) => a.name !== 'latest.yml') };
  await assert.rejects(downloadVerifiedInstaller({ release: bare, fetchImpl: fakeFetch({}), dir }), /no Windows installer/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('install kind: installer on Windows, brew when a Caskroom exists, download otherwise', () => {
  assert.strictEqual(installKind('win32', () => true), 'installer');
  assert.strictEqual(installKind('darwin', (p) => p === '/opt/homebrew/Caskroom/loupe'), 'homebrew');
  assert.strictEqual(installKind('darwin', (p) => p === '/usr/local/Caskroom/loupe'), 'homebrew');
  assert.strictEqual(installKind('darwin', () => false), 'download');
  assert.deepStrictEqual(installerArgs({ relaunch: true }), ['/S', '--updated', '--force-run']);
  assert.deepStrictEqual(installerArgs({ relaunch: false }), ['/S', '--updated']);
});

test('automatic checks: only with the setting on, and at most once a day', () => {
  const now = 1_800_000_000_000;
  assert.strictEqual(shouldAutoCheck({ checkForUpdates: true, lastUpdateCheck: 0 }, now), true);
  assert.strictEqual(shouldAutoCheck({ checkForUpdates: false, lastUpdateCheck: 0 }, now), false);
  assert.strictEqual(shouldAutoCheck({ checkForUpdates: true, lastUpdateCheck: now - 60_000 }, now), false);
  assert.strictEqual(shouldAutoCheck({ checkForUpdates: true, lastUpdateCheck: now - CHECK_INTERVAL_MS }, now), true);
});

function harness({ platform = 'darwin', exists = () => false, routes, settings = {}, version = '0.2.0' }) {
  let s = normalizeSettings({ ...DEFAULT_SETTINGS, ...settings });
  const states = [];
  const spawned = [];
  const fetchImpl = fakeFetch(routes);
  const updater = createUpdater({
    currentVersion: version, platform, fetchImpl, downloadDir: tmpDir(),
    getSettings: () => s,
    patchSettings: (p) => { s = normalizeSettings({ ...s, ...p }); },
    now: () => 1_800_000_000_000, exists,
    spawn: (file, args, opts) => { spawned.push({ file, args, opts }); return { unref() {} }; },
    onChange: (st) => states.push(st.status)
  });
  return { updater, states, spawned, fetchImpl, settings: () => s };
}

test('macOS, installed with Homebrew: a newer release is "available" with the brew command', async () => {
  const h = harness({ exists: (p) => p.endsWith('Caskroom/loupe'), routes: { [RELEASES_API]: release() } });
  const st = await h.updater.check();
  assert.strictEqual(st.status, 'available');
  assert.strictEqual(st.kind, 'homebrew');
  assert.strictEqual(st.latest.version, '0.3.0');
  assert.ok(!('assets' in st.latest));
  assert.strictEqual(h.updater.brewCommand, 'brew upgrade --cask loupe');
  assert.deepStrictEqual(h.states, ['checking', 'available']);
  assert.strictEqual(h.settings().lastUpdateCheck, 1_800_000_000_000);
  // macOS never runs an installer.
  assert.strictEqual(h.updater.install({ relaunch: true }), false);
  assert.strictEqual(h.spawned.length, 0);
});

test('up to date, and a failed check, are both plain states', async () => {
  const current = harness({ routes: { [RELEASES_API]: release('0.2.0') } });
  assert.strictEqual((await current.updater.check()).status, 'current');
  assert.strictEqual(current.updater.shouldNotify(), false);

  const offline = harness({ routes: {} });
  const st = await offline.updater.check();
  assert.strictEqual(st.status, 'error');
  assert.match(st.error, /internet connection/);
  // A failed check doesn't count as the day's check.
  assert.strictEqual(offline.settings().lastUpdateCheck, 0);
});

test('the user hears about each new version once', async () => {
  const h = harness({ routes: { [RELEASES_API]: release() } });
  await h.updater.check();
  assert.strictEqual(h.updater.shouldNotify(), true);
  h.updater.markNotified();
  assert.strictEqual(h.settings().lastNotifiedVersion, '0.3.0');
  assert.strictEqual(h.updater.shouldNotify(), false);
});

test('autoCheck respects the setting and the daily limit; concurrent checks share one request', async () => {
  const off = harness({ routes: { [RELEASES_API]: release() }, settings: { checkForUpdates: false } });
  assert.strictEqual(await off.updater.autoCheck(), null);
  assert.strictEqual(off.fetchImpl.calls.length, 0);

  const recent = harness({ routes: { [RELEASES_API]: release() }, settings: { lastUpdateCheck: 1_800_000_000_000 - 1000 } });
  assert.strictEqual(await recent.updater.autoCheck(), null);

  const h = harness({ routes: { [RELEASES_API]: release() } });
  const [a, b] = await Promise.all([h.updater.check(), h.updater.check()]);
  assert.strictEqual(a, b);
  assert.strictEqual(h.fetchImpl.calls.length, 1);
});

test('Windows: downloads, verifies, and "Restart to update" runs the installer silently', async () => {
  const exe = crypto.randomBytes(50000);
  const yml = formatLatestYml({ version: '0.3.0', file: 'Loupe-Setup-x64.exe', sha512: sha512(exe), size: exe.length, releaseDate: 'x' });
  const h = harness({ platform: 'win32', routes: { [RELEASES_API]: release(), [YML_URL]: yml, [EXE_URL]: exe } });
  const st = await h.updater.check();
  assert.deepStrictEqual(h.states, ['checking', 'downloading', 'ready']);
  assert.strictEqual(st.kind, 'installer');
  assert.strictEqual(h.updater.install({ relaunch: true }), true);
  assert.strictEqual(h.spawned.length, 1);
  assert.match(h.spawned[0].file, /Loupe-Setup-0\.3\.0-x64\.exe$/);
  assert.deepStrictEqual(h.spawned[0].args, ['/S', '--updated', '--force-run']);
  assert.strictEqual(h.spawned[0].opts.detached, true);
  // The quit-time install doesn't run it a second time.
  assert.strictEqual(h.updater.install({ relaunch: false }), false);
  assert.strictEqual(h.spawned.length, 1);
});

test('Windows: a checksum mismatch ends in an error and nothing to install', async () => {
  const exe = crypto.randomBytes(50000);
  const yml = formatLatestYml({ version: '0.3.0', file: 'Loupe-Setup-x64.exe', sha512: sha512(Buffer.from('other')), size: 5, releaseDate: 'x' });
  const h = harness({ platform: 'win32', routes: { [RELEASES_API]: release(), [YML_URL]: yml, [EXE_URL]: exe } });
  const st = await h.updater.check();
  assert.strictEqual(st.status, 'error');
  assert.match(st.error, /checksum/);
  assert.strictEqual(h.updater.install({ relaunch: false }), false);
  assert.strictEqual(h.spawned.length, 0);
});
