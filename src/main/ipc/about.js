'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLogTail, reportProblemUrl } = require('../diagnostics');

const WEBSITE = 'https://loupeapp.vercel.app';
const GITHUB = 'https://github.com/akshatgg/loupe';

// The only pages app:openLink will open, so a renderer can't send the
// browser anywhere else.
const LINKS = {
  website: WEBSITE,
  github: GITHUB,
  releases: `${GITHUB}/releases`,
  issues: `${GITHUB}/issues`
};

const LOUPE_LICENSE = `MIT License

Copyright (c) 2026 akshatgg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

// Loupe's own licence, then every vendored browser library's (src/vendor/
// <name>/LICENSE*), then Electron's -- read from disk so the list can't drift
// from what actually ships.
function collectLicenses({ vendorDir, electronDir }) {
  const out = [{ name: 'Loupe', text: LOUPE_LICENSE }];
  let vendors = [];
  try {
    vendors = fs.readdirSync(vendorDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch { /* no vendored code yet */ }
  for (const d of vendors.sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(vendorDir, d.name);
    const file = fs.readdirSync(dir).find((f) => /^(LICEN[CS]E|COPYING)/i.test(f));
    if (file) out.push({ name: d.name, text: fs.readFileSync(path.join(dir, file), 'utf8') });
  }
  const electronLicense = [path.join(electronDir, 'LICENSE'), path.join(electronDir, 'LICENSE.electron.txt')]
    .find((f) => fs.existsSync(f));
  out.push({
    name: 'Electron',
    text: electronLicense ? fs.readFileSync(electronLicense, 'utf8')
      : 'Copyright (c) Electron contributors\nCopyright (c) 2013-2020 GitHub Inc.\n\nMIT License.',
    // Chromium's credits are a large HTML page of their own; opened, not inlined.
    chromiumCredits: fs.existsSync(path.join(electronDir, 'LICENSES.chromium.html'))
  });
  return out;
}

// About, links, licences, Report a problem and Show logs -- for the Settings
// window's About and Privacy sections and the Help menu.
function registerAboutIpc({ ipcMain, electron, logDir }) {
  const { app, shell } = electron;

  // Where Electron keeps LICENSE and LICENSES.chromium.html: next to the
  // executable on Windows, in Contents/Resources on macOS (packaged), next to
  // Electron.app in development.
  const electronDir = () => {
    if (process.platform === 'darwin') {
      return app.isPackaged ? process.resourcesPath : path.resolve(path.dirname(process.execPath), '..', '..', '..');
    }
    return path.dirname(process.execPath);
  };

  function reportProblem() {
    const url = reportProblemUrl({
      version: app.getVersion(),
      platform: process.platform,
      osVersion: process.getSystemVersion?.() ?? os.release(),
      arch: process.arch,
      logLines: readLogTail(logDir(), 40),
      homedir: os.homedir()
    });
    return shell.openExternal(url);
  }

  function showLogs() {
    fs.mkdirSync(logDir(), { recursive: true });
    return shell.openPath(logDir());
  }

  ipcMain.handle('app:about', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    osVersion: process.getSystemVersion?.() ?? os.release(),
    website: WEBSITE,
    github: GITHUB,
    logDir: logDir()
  }));
  ipcMain.handle('app:openLink', (_e, name) => {
    if (!Object.hasOwn(LINKS, name)) throw new Error(`Unknown link: ${JSON.stringify(name)}`);
    return shell.openExternal(LINKS[name]);
  });
  ipcMain.handle('app:licenses', () => collectLicenses({
    vendorDir: path.join(__dirname, '..', '..', 'vendor'),
    electronDir: electronDir()
  }));
  ipcMain.handle('app:openChromiumCredits', () =>
    shell.openPath(path.join(electronDir(), 'LICENSES.chromium.html')));
  ipcMain.handle('app:reportProblem', reportProblem);
  ipcMain.handle('app:showLogs', showLogs);

  return { reportProblem, showLogs, openWebsite: () => shell.openExternal(WEBSITE) };
}

module.exports = { registerAboutIpc, collectLicenses, LINKS, WEBSITE, GITHUB };
