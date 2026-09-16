#!/usr/bin/env node
'use strict';

// End-to-end check of the Windows helper (bin-win/loupe-native.exe) on a real
// Windows desktop -- the release workflow runs it before building the
// installer. It lists sources, starts and stops the input hooks, records the
// screen (whole and cropped) for a few seconds, then exports that recording
// with a zoom, a click, a cursor and a sped-up stretch, through the same
// spawnHelper/stopHelper the app uses.
//
//   node packaging/smoke-win.js [path\to\loupe-native.exe]

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnHelper, stopHelper } = require('../src/main/helpers');
const { createProject, saveProject, writeCursorTrack, writeCameraTrack } = require('../src/main/project');
const { solveCamera } = require('../src/main/camera');
const { retimePlan } = require('../src/main/speed');

const EXE = path.resolve(process.argv[2] ?? path.join(__dirname, '..', 'bin-win', 'loupe-native.exe'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(tool, args, { until, timeoutMs = 30000 } = {}) {
  const messages = [];
  let exited = null;
  let resolveUntil;
  const reached = new Promise((r) => { resolveUntil = r; });
  const child = spawnHelper(EXE, [tool, ...args], {
    onMessage: (m) => {
      messages.push(m);
      console.log(`  ${tool} <- ${JSON.stringify(m).slice(0, 160)}`);
      if (until && until(m)) resolveUntil(m);
    },
    onMalformed: (l) => console.log(`  ${tool} malformed: ${l}`),
    onExit: (code) => { exited = code; resolveUntil(null); },
    onError: (e) => console.log(`  ${tool} spawn error: ${e.message}`)
  });
  const waitFor = () => Promise.race([
    reached,
    sleep(timeoutMs).then(() => { throw new Error(`${tool}: timed out`); })
  ]);
  return { child, messages, waitFor, exitCode: () => exited };
}

function errorsIn(messages) {
  return messages.filter((m) => m.type === 'error').map((m) => m.message);
}

async function record(dir, display, crop) {
  const args = ['--source', display.id, '--out', path.join(dir, 'raw.mp4'), '--mic', '0'];
  if (crop) args.push('--crop-x', String(crop.x), '--crop-y', String(crop.y), '--crop-w', String(crop.width), '--crop-h', String(crop.height));
  const cap = run('capture', args, { until: (m) => m.type === 'started' || m.type === 'error' });
  const first = await cap.waitFor();
  assert.ok(first && first.type === 'started', `capture did not start: ${JSON.stringify(errorsIn(cap.messages))}`);
  await sleep(3000);
  const code = await stopHelper(cap.child, 15000);
  assert.deepStrictEqual(errorsIn(cap.messages), [], 'capture reported errors');
  assert.strictEqual(code, 0, 'capture exit code');
  const stopped = cap.messages.find((m) => m.type === 'stopped');
  assert.ok(stopped && stopped.duration > 2.5, `stopped with duration ${stopped?.duration}`);
  const size = fs.statSync(path.join(dir, 'raw.mp4')).size;
  assert.ok(size > 1000, `raw.mp4 is ${size} bytes`);
  console.log(`  recorded ${stopped.duration.toFixed(2)}s, ${size} bytes`);
  return stopped.duration;
}

async function main() {
  assert.ok(fs.existsSync(EXE), `${EXE} not found`);

  console.log('sources');
  const sources = JSON.parse(execFileSync(EXE, ['sources', '--exclude-pid', String(process.pid)], { encoding: 'utf8' }));
  const displays = sources.filter((s) => s.kind === 'display');
  console.log(`  ${displays.length} display(s), ${sources.length - displays.length} window(s)`);
  assert.ok(displays.length >= 1, 'at least one display');
  for (const s of sources) assert.match(s.id, /^(display|window):\d+$/);
  const display = displays[0];

  console.log('inputtap');
  const tap = run('inputtap', ['--zoom-triggers', 'option,mouse-side'], { until: (m) => m.type === 'ready' || m.type === 'error' });
  const ready = await tap.waitFor();
  assert.ok(ready && ready.type === 'ready', `inputtap not ready: ${JSON.stringify(errorsIn(tap.messages))}`);
  assert.strictEqual(await stopHelper(tap.child, 5000), 0, 'inputtap exit code');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-smoke-'));

  console.log('capture: a cropped area');
  const cropDir = path.join(root, 'crop');
  fs.mkdirSync(cropDir);
  await record(cropDir, display, {
    x: display.x + 100, y: display.y + 80, width: Math.min(640, display.width - 100), height: Math.min(360, display.height - 80)
  });

  console.log('capture: the whole display');
  const dir = path.join(root, 'full');
  fs.mkdirSync(dir);
  const duration = await record(dir, display, null);

  console.log('render');
  const { width, height } = display;
  const project = createProject(
    { kind: 'display', id: display.id, title: display.title, width, height },
    { file: 'raw.mp4', fps: 60, duration, hasMicTrack: false }
  );
  project.zoomKeyframes = [{ t: 0.5, zoom: 2.5, cx: width / 2, cy: height / 2 }];
  project.clicks = [{ t: 1, x: width / 2, y: height / 2, button: 'left' }];
  project.speedSegments = [{ srcStart: 1.5, srcEnd: 2.5, rate: 2 }];
  saveProject(dir, project);
  const cursor = [];
  for (let t = 0; t < duration; t += 1 / 120) cursor.push({ t, x: width / 2 + 100 * Math.sin(t), y: height / 2, shape: 'arrow' });
  writeCursorTrack(dir, cursor);
  writeCameraTrack(dir, solveCamera({ keyframes: project.zoomKeyframes, cursorTrack: cursor, duration, width, height }));
  const plan = retimePlan(project.speedSegments, duration, 200);
  fs.writeFileSync(path.join(dir, 'retime.json'), JSON.stringify({ ...plan, preservePitch: true }));

  const out = path.join(dir, 'export.mp4');
  const render = run('render', ['--project', dir, '--out', out, '--width', '1920', '--height', '1080'],
    { until: (m) => m.type === 'done' || m.type === 'error', timeoutMs: 240000 });
  const done = await render.waitFor();
  assert.ok(done && done.type === 'done', `render failed: ${JSON.stringify(errorsIn(render.messages))}`);
  assert.strictEqual(done.frames, plan.frames.length, 'one exported frame per planned frame');
  const size = fs.statSync(out).size;
  assert.ok(size > 10000, `export is ${size} bytes`);
  await stopHelper(render.child, 10000);
  console.log(`  exported ${done.frames} frames, ${size} bytes`);

  if (process.env.LOUPE_SMOKE_KEEP) console.log(`kept ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
  console.log('smoke test passed');
}

main().catch((err) => {
  console.error(`smoke test FAILED: ${err.stack || err.message}`);
  process.exit(1);
});
