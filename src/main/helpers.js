'use strict';

const { spawn } = require('node:child_process');

// stdout arrives in arbitrary chunks: one JSON object can span two chunks and
// one chunk can carry several objects. Buffer until a newline.
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

function spawnHelper(binPath, args, { onMessage, onMalformed, onExit }) {
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
  child.on('exit', (code, signal) => onExit(code, signal));

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
