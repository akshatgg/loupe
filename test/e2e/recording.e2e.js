'use strict';
// A real recording on this Mac through recorder.js and the built helpers
// (npm run build:native first), checking the recording additions end to end:
//
//   - computer sound: a system sound is played partway in; system.m4a must be
//     silent before it and loud where it starts, at the right source time
//   - keystrokes: ⌘F13 and F14 are pressed through the HID event stream
//     (test/e2e/postkey.swift: F13-F20 only, which do nothing anywhere) and
//     must land in keys.json with the right labels and times (letters are
//     never pressed here: they would type into whatever has focus)
//   - pauses: a pause/resume in the middle lands in sources.main.pauses and
//     is left out of the clips
//
// Needs Screen Recording and Accessibility for the shell running it.
//   node test/e2e/recording.e2e.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createRecorder } = require('../../src/main/recorder');
const { spawnHelper, stopHelper } = require('../../src/main/helpers');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin');
const SOUND = '/System/Library/Sounds/Glass.aiff';
const COMMAND = 0x100000;
const F13 = 105;
const F14 = 107;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now() / 1000;

// 16-bit mono PCM of an audio file, through macOS's own converter.
function decodeMono(file) {
  const wav = path.join(os.tmpdir(), `loupe-e2e-${process.pid}.wav`);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', file, wav]);
  const buf = fs.readFileSync(wav);
  fs.rmSync(wav, { force: true });
  let at = 12;
  while (at < buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'data') {
      const pcm = buf.subarray(at + 8, at + 8 + size);
      return new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.length & ~1)));
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

function rmsWindows(samples, rate, windowSec) {
  const n = Math.round(rate * windowSec);
  const out = [];
  for (let i = 0; i + n <= samples.length; i += n) {
    let sum = 0;
    for (let j = i; j < i + n; j++) sum += (samples[j] / 32768) ** 2;
    out.push(Math.sqrt(sum / n));
  }
  return out;
}

async function main() {
  for (const name of ['capture', 'inputtap']) {
    if (!fs.existsSync(path.join(BIN, name))) throw new Error(`bin/${name} missing: npm run build:native`);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-rec-'));
  const postkey = path.join(work, 'postkey');
  execFileSync('swiftc', ['-O', path.join(__dirname, 'postkey.swift'), '-o', postkey]);
  const press = (code, flags = 0) => execFileSync(postkey, [String(code), String(flags)]);

  const display = JSON.parse(execFileSync(path.join(BIN, 'sources'), { maxBuffer: 64 * 1024 * 1024 }))
    .find((s) => s.kind === 'display');
  const dir = path.join(work, 'recording');
  fs.mkdirSync(dir);

  const errors = [];
  const rec = createRecorder({
    binDir: BIN, spawnHelper, stopHelper, now,
    onError: (e) => errors.push(e)
  });
  await rec.start({
    source: display.id, dir, mic: false, width: display.width, height: display.height,
    x: display.x, y: display.y, title: display.title, excludeWindowIds: [],
    zoomEnabled: true, keys: true, systemAudio: true
  });

  // Wait for the first frame (the recorder's source clock).
  const deadline = Date.now() + 10000;
  while (rec.toSourceTime(now()) === null) {
    if (Date.now() > deadline) throw new Error('capture never started');
    await sleep(20);
  }
  await sleep(1500);

  const soundAt = rec.toSourceTime(now());
  const player = spawn('afplay', [SOUND]);
  await sleep(1000);

  // A press happens somewhere while postkey runs (starting a process takes
  // a moment, more the first time), so each is bracketed.
  const pressedBetween = (code, flags) => {
    const before = rec.toSourceTime(now());
    press(code, flags);
    return [before, rec.toSourceTime(now())];
  };
  const cmdF13At = pressedBetween(F13, COMMAND);
  await sleep(400);
  const f14At = pressedBetween(F14, 0);
  await sleep(400);

  assert.ok(rec.pause(), 'pause');
  const pausedAt = rec.toSourceTime(now());
  await sleep(800);
  assert.ok(rec.resume(), 'resume');
  const resumedAt = rec.toSourceTime(now());
  await sleep(1000);

  const result = await rec.stop();
  player.kill();
  assert.ok(result, 'stop returned a result');
  assert.deepStrictEqual(errors, [], 'no helper errors');
  const main = result.project.sources.main;
  const project = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  console.log('sources.main:', JSON.stringify({ ...main, clicks: main.clicks.length }));
  console.log('clips:', JSON.stringify(project.clips));

  // ---- computer sound ----
  assert.strictEqual(main.systemAudio, 'system.m4a');
  const samples = decodeMono(path.join(dir, 'system.m4a'));
  const WINDOW = 0.01;
  const rms = rmsWindows(samples, 48000, WINDOW);
  const fileSeconds = samples.length / 48000;
  const loudFrom = rms.findIndex((v) => v > 0.02) * WINDOW;
  const quietBefore = Math.max(...rms.slice(0, Math.floor((soundAt - 0.1) / WINDOW)));
  const loudPeak = Math.max(...rms);
  console.log(`system.m4a: ${fileSeconds.toFixed(2)} s (video ${main.duration.toFixed(2)} s), ` +
    `sound started at ${soundAt.toFixed(3)} s, heard from ${loudFrom.toFixed(3)} s ` +
    `(+${((loudFrom - soundAt) * 1000).toFixed(0)} ms), peak RMS ${loudPeak.toFixed(3)}, ` +
    `before it ${quietBefore.toFixed(4)}`);
  assert.ok(loudFrom >= 0, 'the sound is in the file');
  assert.ok(quietBefore < 0.005, 'silent before the sound');
  // afplay takes a moment to open the file and the audio device.
  assert.ok(loudFrom >= soundAt - 0.03 && loudFrom <= soundAt + 0.35,
    `heard ${loudFrom} for a sound started at ${soundAt}`);
  assert.ok(Math.abs(fileSeconds - main.duration) < 0.5, 'as long as the video');

  // ---- keystrokes ----
  const keys = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8'));
  const span = ([a, b]) => `${a.toFixed(3)}-${b.toFixed(3)}`;
  console.log('keys.json:', JSON.stringify(keys), `pressed during ${span(cmdF13At)} and ${span(f14At)}`);
  assert.deepStrictEqual(keys.map((k) => k.label), ['⌘F13', 'F14']);
  const within = (t, [a, b]) => t >= a - 0.005 && t <= b + 0.005;
  assert.ok(within(keys[0].t, cmdF13At), '⌘F13 time');
  assert.ok(within(keys[1].t, f14At), 'F14 time');

  // ---- pauses ----
  assert.strictEqual(main.pauses.length, 1);
  assert.ok(Math.abs(main.pauses[0].start - pausedAt) < 0.02, 'pause start');
  assert.ok(Math.abs(main.pauses[0].end - resumedAt) < 0.02, 'pause end');
  assert.strictEqual(project.clips.length, 2);
  assert.strictEqual(project.clips[0].end, main.pauses[0].start);
  assert.strictEqual(project.clips[1].start, main.pauses[0].end);

  fs.rmSync(work, { recursive: true, force: true });
  console.log('recording e2e: all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
