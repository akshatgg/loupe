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
  // Windows has no SIGTERM to ask a helper to finish up -- child.kill() there
  // is TerminateProcess, which would leave a half-written recording -- so the
  // Windows helpers stop when their stdin closes instead (see stopHelper).
  const stdin = process.platform === 'win32' ? 'pipe' : 'ignore';
  const child = spawn(binPath, args, { stdio: [stdin, 'pipe', 'pipe'], windowsHide: true });
  // Writing "stop" to a helper that has already exited is not an error
  // anyone needs to hear about.
  child.stdin?.on('error', () => {});

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
  // 'error' on the child, and in that case 'exit' never fires -- there is no
  // process to exit. An EventEmitter with no 'error' listener throws, which
  // would take down the Electron main process, so this listener must always
  // exist, and (for the ENOENT case) it is the only signal the caller will
  // ever get, hence the onExit(null, null) fallback below.
  //
  // But 'error' is not exclusive to that case: ChildProcess also emits it
  // when child.kill() itself fails on an already-running child (e.g.
  // stopHelper() racing a process that is mid-exit, or a permissions
  // problem sending the signal). That happens well after a successful
  // spawn, with the real 'exit' event for the process still to come --
  // treating it as terminal here would fire onExit(null, null) early and
  // then the `notified` guard would suppress the real exit code when 'exit'
  // arrives right behind it. `spawned` distinguishes the two: only an
  // 'error' that arrives before the process ever started is treated as the
  // terminal notification.
  let spawned = false;
  let notified = false;
  child.once('spawn', () => { spawned = true; });
  child.on('error', (err) => {
    if (typeof onError === 'function') {
      onError(err);
    } else {
      console.error(`[${binPath}] ${err.message}`);
    }
    if (!spawned && !notified) {
      notified = true;
      onExit(null, null);
    }
  });
  child.on('exit', (code, signal) => {
    if (notified) return;
    notified = true;
    onExit(code, signal);
  });

  // Tracked on the child itself (rather than a closure-local variable) so
  // stopHelper() -- a separate function that only ever receives the child,
  // not this closure -- can tell "has 'close' already fired" apart from
  // "has 'exit' already fired". Those are not the same question: a process
  // can be reaped (exitCode set) well before its stdio has finished
  // draining to us, and stopHelper() needs the latter, not the former (see
  // its own comment for why).
  child.once('close', () => { child.__loupeClosed = true; });

  return child;
}

// Resolves on 'close', not 'exit'. Node emits 'exit' as soon as the process
// itself has terminated, independent of whether its stdout/stderr pipes have
// finished draining -- 'close' is the event that guarantees the streams have
// ended, i.e. every 'data' chunk (and therefore every NDJSON line a helper
// wrote, including a final {"type":"stopped","duration":...} written right
// before the process exits) has already reached the stream's 'data'
// listener. Resolving on 'exit' let recorder.stop() read `duration` before
// that last line had been parsed off stdout, so a 0 could leak into
// project.capture.duration and collapse the exported camera track down to a
// single sample. This is shared by both helpers (capture/inputtap) and the
// export path (render): all three are read the same way after being
// stopped/killed, so none of them have a reason to prefer the earlier,
// racier event.
//
// The early-return below only short-circuits once `child.__loupeClosed` is
// set (i.e. 'close' has already actually fired) -- not merely once
// exitCode/signalCode are set, which is the exit-only signal and would
// reintroduce exactly the same race for a child that exited on its own
// (without ever being kill()ed) before stop() got around to awaiting it: the
// process would already read as "exited" while its last stdout chunk was
// still in flight. Not sending SIGTERM to a child whose exitCode is already
// set (but hasn't closed yet) avoids a pointless kill() on an already-dead
// process while still correctly waiting out its stdio drain.
function stopHelper(child, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (child.__loupeClosed) {
      resolve(child.exitCode ?? 0);
      return;
    }
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('close', (code) => {
      clearTimeout(kill);
      resolve(code ?? 0);
    });
    if (child.exitCode === null && child.signalCode === null) {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end('stop\n');
      else child.kill('SIGTERM');
    }
  });
}

module.exports = { createLineSplitter, spawnHelper, stopHelper };
