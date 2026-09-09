'use strict';

const { spawn } = require('node:child_process');

// stdout arrives in arbitrary chunks: one JSON object can span two chunks and
// one chunk can carry several objects. Buffer until a newline.
// Note: the buffer has no size cap. This is an internal, first-party
// protocol between us and our own compiled helper, so a helper writing an
// unterminated multi-megabyte line is not a threat we defend against here;
// a cap was considered and deliberately left out rather than missed.
function createLineSplitter(onLine) {
  let buffer = '';
  return function push(chunk) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  };
}

function spawnHelper(binPath, args, { onMessage, onMalformed, onExit, onError }) {
  const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const push = createLineSplitter((line) => {
    try {
      onMessage(JSON.parse(line));
    } catch {
      onMalformed(line);
    }
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', push);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => console.error(`[${binPath}] ${d.trimEnd()}`));

  // A failed spawn (e.g. ENOENT for a bad/mis-packaged binary path) emits
  // 'error' on the child. An EventEmitter with no 'error' listener throws,
  // which would take down the Electron main process, so this listener must
  // always exist. Node can emit both 'error' and 'exit' for the same failed
  // spawn, but the caller must be told exactly once, so a single `notified`
  // flag gates both handlers regardless of which fires, or in what order.
  let notified = false;
  child.on('error', (err) => {
    if (typeof onError === 'function') {
      onError(err);
    } else {
      console.error(`[${binPath}] ${err.message}`);
    }
    if (!notified) {
      notified = true;
      onExit(null, null);
    }
  });
  child.on('exit', (code, signal) => {
    if (notified) return;
    notified = true;
    onExit(code, signal);
  });

  return child;
}

function stopHelper(child, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode ?? 0);
      return;
    }
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(kill);
      resolve(code ?? 0);
    });
    child.kill('SIGTERM');
  });
}

module.exports = { createLineSplitter, spawnHelper, stopHelper };
