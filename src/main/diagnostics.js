'use strict';

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { URL, URLSearchParams } = require('node:url');

// Crash reports and error logs, kept on this computer only. Nothing here
// sends anything anywhere: Help > Report a problem opens a GitHub issue form
// in the browser with the details filled in, and the user reads (and can
// edit) all of it before choosing to submit.
//
// Logs live in userData/logs/loupe.log and rotate at 1 MB, keeping two older
// files (loupe.1.log, loupe.2.log), so they never grow without bound.
// Electron's own minidumps go to its crashDumps folder (app.getPath
// ('crashDumps')), which "Show logs" doesn't cover -- they're only useful to
// a developer who asks for them.

const LOG_NAME = 'loupe.log';
const MAX_BYTES = 1024 * 1024;
const KEEP_FILES = 2;
const ISSUES_URL = 'https://github.com/akshatgg/loupe/issues/new';
// Browsers and GitHub start refusing very long URLs; this leaves headroom.
const MAX_URL_LENGTH = 7000;

function createLogger({ dir, maxBytes = MAX_BYTES, keep = KEEP_FILES, now = () => new Date() }) {
  const file = path.join(dir, LOG_NAME);

  function rotate() {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < maxBytes) return;
    for (let i = keep; i >= 1; i--) {
      const from = i === 1 ? file : path.join(dir, `loupe.${i - 1}.log`);
      const to = path.join(dir, `loupe.${i}.log`);
      try { fs.renameSync(from, to); } catch { /* that generation doesn't exist yet */ }
    }
  }

  // Synchronous on purpose: the line that matters most is the one written
  // just before the process dies.
  function write(level, ...parts) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      rotate();
      const text = parts.map((p) => (typeof p === 'string' ? p : util.inspect(p, { depth: 4 }))).join(' ');
      fs.appendFileSync(file, `${now().toISOString()} [${level}] ${text}\n`);
    } catch {
      // Logging must never be the thing that breaks the app.
    }
  }

  return {
    dir, file,
    info: (...p) => write('info', ...p),
    warn: (...p) => write('warn', ...p),
    error: (...p) => write('error', ...p)
  };
}

// The last `count` lines across the current and rotated logs, oldest first.
function readLogTail(dir, count = 40) {
  const files = [];
  for (let i = KEEP_FILES; i >= 1; i--) files.push(path.join(dir, `loupe.${i}.log`));
  files.push(path.join(dir, LOG_NAME));
  let lines = [];
  for (const f of files) {
    try {
      lines = lines.concat(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean));
    } catch { /* missing generation */ }
  }
  return lines.slice(-count);
}

// Home folder paths often carry the user's name; the report doesn't need it.
// A Windows path can also appear with its backslashes doubled (a string
// inside a logged object, or JSON) or turned into forward slashes (a file://
// URL), and a drive letter in either case.
function redact(text, homedir) {
  if (!homedir) return text;
  const forms = new Set([homedir]);
  if (homedir.includes('\\')) {
    forms.add(homedir.replaceAll('\\', '\\\\'));
    forms.add(homedir.replaceAll('\\', '/'));
  }
  let out = text;
  // Longest first, so the doubled form isn't half-replaced by the plain one.
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, /^[A-Za-z]:/.test(form) ? 'gi' : 'g'), '~');
  }
  return out;
}

// A GitHub "new issue" URL with the environment and recent log lines filled
// in. The log tail is trimmed from the oldest end until the URL fits.
function reportProblemUrl({ version, platform, osVersion, arch, logLines = [], homedir }) {
  const osName = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[platform] ?? platform;
  let lines = logLines.map((l) => redact(l, homedir));
  const build = (tail) => {
    const body = [
      '**What happened?**',
      '',
      '',
      '**What did you expect?**',
      '',
      '',
      '**Steps to make it happen again**',
      '1. ',
      '',
      '---',
      `Loupe ${version} · ${osName} ${osVersion} · ${arch}`,
      '',
      tail.length
        ? ['<details><summary>Recent log (please check there is nothing private in it)</summary>', '', '```', ...tail, '```', '</details>'].join('\n')
        : '_No log lines._'
    ].join('\n');
    const params = new URLSearchParams({ title: '', body, labels: 'bug' });
    return `${ISSUES_URL}?${params}`;
  };
  let url = build(lines);
  while (url.length > MAX_URL_LENGTH && lines.length) {
    lines = lines.slice(1);
    url = build(lines);
  }
  // A single enormous line can still be too long: cut it down.
  if (url.length > MAX_URL_LENGTH) url = build([]);
  return url;
}

// Wires crash reporting and error logging into the running app. `electron`
// is the Electron module (injected so tests can pass a fake). Call before the
// app is ready -- crashReporter wants to start as early as possible.
// `enabled` is the saveCrashReports setting; turning it off stops the log and
// crash dumps from being written (it takes effect the next time Loupe opens,
// since the crash reporter can't be stopped once started).
function startDiagnostics({ electron, logDir, enabled, showErrorBox, now = Date.now }) {
  const { app, crashReporter } = electron;
  const logger = createLogger({ dir: logDir });
  if (!enabled) {
    // Same API, writing nothing.
    const off = () => {};
    return { ...logger, info: off, warn: off, error: off };
  }

  try {
    crashReporter.start({ uploadToServer: false, compress: true });
  } catch (err) {
    logger.warn('crash reporter did not start:', err);
  }

  // Keep what already goes to the console, and copy errors and warnings into
  // the log -- main.js reports its recoverable failures with console.error.
  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      logger[level](...args);
      original(...args);
    };
  }

  // A fault that repeats (a timer that throws every frame) would otherwise
  // stack up error boxes faster than they can be closed; each one is still
  // logged.
  let lastBox = -Infinity;
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception:', err);
    if (now() - lastBox < 30 * 1000) return;
    lastBox = now();
    // Adding this listener replaces Electron's own error dialog, so show one:
    // the user should still hear that something went wrong.
    try {
      showErrorBox?.('Loupe ran into a problem', `${err?.stack ?? err}\n\nYou can report it from Help > Report a problem.`);
    } catch { /* nothing more we can do */ }
  });
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection:', reason));

  app.on('render-process-gone', (_e, webContents, details) => {
    let page = '';
    // Every window is some renderer/<name>/index.html; the folder names it.
    try { page = path.basename(path.dirname(new URL(webContents.getURL()).pathname)); } catch { /* no URL */ }
    logger.error(`window process gone (${page || 'unknown page'}):`, details);
  });
  app.on('child-process-gone', (_e, details) => logger.error('child process gone:', details));

  logger.info(`Loupe ${app.getVersion()} started`);
  return logger;
}

module.exports = {
  LOG_NAME, MAX_BYTES, ISSUES_URL, MAX_URL_LENGTH,
  createLogger, readLogTail, redact, reportProblemUrl, startDiagnostics
};
