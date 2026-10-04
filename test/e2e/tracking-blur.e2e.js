'use strict';
// A hidden area that follows what's under it, in the real app: a recording
// is made in which a textured block crosses a plain background at a known
// speed (tracking-lab.js), a hidden area is put over the block where it
// starts, and "Follow what's under it" is pressed in its panel. Checked: the
// stored path against the block's known motion; exported frames (the block
// is pixelated where it now is, and what it uncovered where it started is
// sharp again); Cancel part-way leaves the annotation as it was; one undo
// removes the whole path; dragging the followed box shifts the whole path;
// and a block that vanishes stops the follow there, in words. Screenshots go
// to test/e2e/out/tracking/.
//
//   npm run test:e2e:tracking
// Needs ffmpeg on the PATH.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const electron = require('electron');

const { app, BrowserWindow, ipcMain } = electron;
const OUT = path.join(__dirname, 'out', 'tracking');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOD = process.platform === 'darwin' ? 'meta' : 'control';

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-track-')));
const home = path.join(work, 'home');
const userData = path.join(work, 'userData');
fs.mkdirSync(home);
fs.mkdirSync(userData);
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', userData);
os.homedir = () => home;
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ countdown: false, systemAudio: false, recordCamera: false }));

let nextChoice = null;
electron.dialog.showOpenDialog = async () => {
  const files = nextChoice === null ? [] : [].concat(nextChoice);
  return { canceled: !files.length, filePaths: files };
};

// The recording (tracking-lab.js draws it): the block is still for a second,
// moves for four at 60 px/s across and 20 px/s down, is still again, and is
// gone from 7 s on.
const W = 640;
const H = 400;
const FIXTURE = {
  name: 'moving-block.mp4', width: W, height: H, fps: 30, duration: 10,
  block: { x: 60, y: 80, w: 120, h: 60 }, marker: { x: 70, y: 90, w: 100, h: 40 },
  still: 1, moveFor: 4, velocity: { x: 60, y: 20 }, goneAt: 7
};
const MARGIN = 4; // the hidden area is this much bigger than the block all round
const blockAt = (t) => {
  const m = Math.max(0, Math.min(FIXTURE.moveFor, t - FIXTURE.still));
  return { x: FIXTURE.block.x + FIXTURE.velocity.x * m, y: FIXTURE.block.y + FIXTURE.velocity.y * m };
};
const BOX = {
  x: (FIXTURE.block.x - MARGIN) / W, y: (FIXTURE.block.y - MARGIN) / H,
  w: (FIXTURE.block.w + 2 * MARGIN) / W, h: (FIXTURE.block.h + 2 * MARGIN) / H
};

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

async function waitFor(what, fn, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const pageOf = (name) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() &&
  w.webContents.getURL().includes(`/renderer/${name}/`));
const trackerWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() &&
  w.webContents.getURL().includes('/renderer/exporter/track.html'));

async function makeFixture() {
  ipcMain.handle('lab:save', (_e, name, bytes) => {
    fs.writeFileSync(path.join(work, path.basename(name)), bytes);
  });
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'lab-preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false }
  });
  await win.loadFile(path.join(__dirname, 'tracking-lab.html'));
  await waitFor('the tracking lab', () => win.webContents.executeJavaScript('window.trackingLabReady === true'));
  await win.webContents.executeJavaScript(`window.trackingLab.makeMovingBlock(${JSON.stringify(FIXTURE)})`);
  ipcMain.removeHandler('lab:save');
  // The lab window is closed by the caller once the app has a window of its
  // own: an app whose last window closes quits.
  return { file: path.join(work, FIXTURE.name), close: () => win.destroy() };
}

// One frame of an exported video at `at` seconds, as grey pixels.
function greyFrame(file, at, width, height) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
  assert.strictEqual(raw.length, width * height, 'a whole frame');
  return raw;
}

// How much fine detail a part of a frame has: the average difference between
// neighbouring pixels along each row. The block's texture changes every few
// pixels; pixelated, it is flat squares.
function detail(frame, width, r) {
  let sum = 0;
  let n = 0;
  for (let y = Math.ceil(r.y); y < Math.floor(r.y + r.h); y++) {
    for (let x = Math.ceil(r.x); x < Math.floor(r.x + r.w) - 1; x++) {
      sum += Math.abs(frame[y * width + x + 1] - frame[y * width + x]);
      n++;
    }
  }
  return n ? sum / n : 0;
}

async function run() {
  // src/core is ES modules: loaded once the app is up, as main does.
  const { positionAt } = require('../../src/core/track.js');
  const fixture = await makeFixture();
  require('../../src/main/main');
  const picker = await waitFor('the picker', () => pageOf('picker'));
  await waitFor('the picker to load', () => !picker.webContents.isLoading());
  fixture.close();
  nextChoice = fixture.file;
  await picker.webContents.executeJavaScript('document.getElementById("importVideo").click()');
  const editor = await waitFor('the editor', () => pageOf('editor'), 30000);
  await waitFor('the editor to load', () => editor.webContents.executeJavaScript('document.body.dataset.ready === "true"'), 30000);
  editor.webContents.setBackgroundThrottling(false);
  const js = (code) => editor.webContents.executeJavaScript(code);
  const shot = async (name) => {
    await sleep(250);
    fs.writeFileSync(path.join(OUT, `${name}.png`), (await editor.webContents.capturePage()).toPNG());
  };
  const key = async (keyCode, modifiers = []) => {
    await js('document.activeElement?.blur()');
    editor.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1) editor.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
    editor.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(120);
  };
  const exportVideo = async () => {
    await js('window.__editor.saver.flush()');
    return js('window.loupe.exportVideo({ resolution: "720p" })');
  };
  const annotation = (id) => js(`window.__editor.store.project.annotations.find((a) => a.id === ${JSON.stringify(id)}) ?? null`);
  const visible = (id) => js(`(() => { const el = document.getElementById(${JSON.stringify(id)}); return Boolean(el) && el.getClientRects().length > 0; })()`);
  const projectOnDisk = async () => {
    await js('window.__editor.saver.flush()');
    // Main writes a moment after the editor sends.
    await sleep(700);
    const file = fs.readdirSync(home, { recursive: true }).map((f) => path.join(home, f)).find((f) => path.basename(f) === 'project.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  await js('document.querySelector(".first-run .btn")?.click()');

  // A hidden area added with the toolbar's Blur button at 1 s, then put over
  // the block (4 px bigger all round) for the four seconds it moves.
  await js('window.__editor.player.seek(1)');
  await js('document.getElementById("blurBtn").click()');
  const added = await waitFor('the hidden area', () => js('window.__editor.store.project.annotations.at(-1) ?? null'));
  assert.strictEqual(added.type, 'blur');
  const id = added.id;
  const place = (patch) => js(`(() => { const E = window.__editor; E.store.apply((p) => E.editor.core.updateAnnotation(p, ${JSON.stringify(id)}, ${JSON.stringify(patch)})); })()`);
  await place({ ...BOX, start: 1, end: 5, size: 2.5 });
  const placed = await annotation(id);

  // Where the recording's picture is in an exported frame, from the preview's
  // own layout (the same compositor draws both).
  const layout = await js('(() => { const s = window.__editor.player.state; return { content: s.content, size: s.size }; })()');
  let out = null; // the export's size
  const inExport = (r) => {
    const k = out.width / layout.size.width;
    const sx = (layout.content.w / W) * k;
    const sy = (layout.content.h / H) * k;
    return { x: layout.content.x * k + r.x * sx, y: layout.content.y * k + r.y * sy, w: r.w * sx, h: r.h * sy };
  };
  // The inside of the block at recording time t, and of the marker.
  const inset = (r, by) => ({ x: r.x + by, y: r.y + by, w: r.w - 2 * by, h: r.h - 2 * by });
  const blockRect = (t) => inset({ ...blockAt(t), w: FIXTURE.block.w, h: FIXTURE.block.h }, 8);
  const markerRect = inset(FIXTURE.marker, 6);
  const look = (file, t) => {
    const frame = greyFrame(file, t + 0.5 / FIXTURE.fps, out.width, out.height);
    return {
      block: detail(frame, out.width, inExport(blockRect(t))),
      marker: detail(frame, out.width, inExport(markerRect))
    };
  };

  let sharp = null; // how much detail the block has when nothing hides it
  await check('a hidden area that doesn’t follow stays where it was put: the block leaves it, and what it uncovers is hidden instead', async () => {
    assert.strictEqual(await js('document.getElementById("sidebar").dataset.panel'), 'annotations');
    assert.ok(await visible('blurFollow'), 'the Follow button shows for a hidden area');
    assert.strictEqual(await js('document.getElementById("blurFollow").textContent'), 'Follow what’s under it');
    assert.ok(!(await visible('blurUnfollow')) && !(await visible('blurFollowProgress')), 'nothing to stop yet');
    const result = await exportVideo();
    out = { width: result.width, height: result.height };
    const early = look(result.file, 1.1);
    const late = look(result.file, 4.5);
    console.log(`    detail (not followed): block at 1.1 s ${early.block.toFixed(1)}; at 4.5 s block ${late.block.toFixed(1)}, where it started ${late.marker.toFixed(1)}`);
    sharp = late.block;
    assert.ok(sharp > 12, `the block's texture survives the export (${sharp.toFixed(1)})`);
    assert.ok(early.block < sharp / 3, 'hidden while it is under the box');
    assert.ok(late.marker < sharp / 3, 'the box still hides where the block was');
    await shot('01-not-followed');
  });

  await check('Cancel part-way through leaves the annotation exactly as it was', async () => {
    // Over the whole recording, so there is plenty left to cancel.
    await place({ start: 0, end: 10 });
    const before = await annotation(id);
    const projectBefore = await js('JSON.stringify(window.__editor.store.project)');
    // Press Cancel as soon as the tracking page reports its first frames.
    let progressed = 0;
    const onWindow = (_e, win) => {
      win.webContents.ipc.on('tracker:progress', () => {
        if (progressed++ === 0) js('document.getElementById("blurFollowCancel").click()');
      });
    };
    app.on('browser-window-created', onWindow);
    await js('document.getElementById("blurFollow").click()');
    await waitFor('the progress row', () => visible('blurFollowProgress'), 5000);
    assert.ok(await visible('blurFollowCancel') && !(await visible('blurFollow')), 'progress with Cancel in place of the button');
    await shot('02-following');
    await waitFor('the follow to stop', async () => (await visible('blurFollow')) && !(await visible('blurFollowProgress')), 15000);
    app.removeListener('browser-window-created', onWindow);
    assert.ok(progressed > 0, 'it had started');
    assert.deepStrictEqual(await annotation(id), before);
    assert.strictEqual(await js('JSON.stringify(window.__editor.store.project)'), projectBefore, 'the project is untouched');
    assert.ok(!('path' in (await projectOnDisk()).annotations.find((a) => a.id === id)), 'and so is the file');
    await waitFor('the tracking window to close', () => trackerWindows().length === 0, 5000);
    await place({ start: 1, end: 5 });
    assert.deepStrictEqual(await annotation(id), placed);
  });

  let followed = null;
  await check('Follow what’s under it stores a path that matches the block’s motion', async () => {
    await js('document.getElementById("blurFollow").click()');
    followed = await waitFor('the path', async () => { const a = await annotation(id); return a?.path ? a : null; }, 30000);
    await waitFor('the button back', () => visible('blurFollow'), 5000);
    assert.strictEqual(followed.follow, true);
    console.log(`    ${followed.path.length} keyframes: ${followed.path.map((p) => `${p.t.toFixed(2)}s (${(p.x * W).toFixed(1)}, ${(p.y * H).toFixed(1)})`).join('  ')}`);
    assert.ok(followed.path.length >= 2 && followed.path.length <= 40, `thinned to a few keyframes (${followed.path.length})`);
    assert.deepStrictEqual([followed.x, followed.y, followed.w, followed.h], [placed.x, placed.y, placed.w, placed.h], 'the box itself is as it was');
    // The path, played back as the layer does, against the known motion.
    let worst = 0;
    for (let t = 1; t <= 4.95; t += 0.25) {
      const p = positionAt(followed.path, t);
      const want = blockAt(t);
      const dx = p.x * W - (want.x - MARGIN);
      const dy = p.y * H - (want.y - MARGIN);
      worst = Math.max(worst, Math.abs(dx), Math.abs(dy));
      assert.ok(Math.abs(dx) <= 2 && Math.abs(dy) <= 2, `at ${t} s the box is ${dx.toFixed(2)}, ${dy.toFixed(2)} px from the block`);
    }
    console.log(`    furthest from the block's known position: ${worst.toFixed(2)} px`);
    assert.ok(await visible('blurUnfollow'), 'Stop following is offered');
    assert.strictEqual(await js('document.getElementById("blurFollow").textContent'), 'Follow again');
    assert.ok(!(await visible('blurFollowProgress')));
    assert.deepStrictEqual((await projectOnDisk()).annotations.find((a) => a.id === id).path, followed.path, 'saved in project.json');
    await js('window.__editor.player.seek(3)');
    await shot('03-followed');
  });

  await check('the export hides the block wherever it is, and no longer hides where it started', async () => {
    const result = await exportVideo();
    for (const t of [1.5, 3, 4.5]) {
      const seen = look(result.file, t);
      console.log(`    detail (followed) at ${t} s: block ${seen.block.toFixed(1)}, where it started ${seen.marker.toFixed(1)} (unhidden block ${sharp.toFixed(1)})`);
      assert.ok(seen.block < sharp / 3, `the block is pixelated at ${t} s`);
      // By 3 s the box has left the marker behind.
      if (t >= 3) assert.ok(seen.marker > sharp / 2, `where the block started is sharp again at ${t} s`);
    }
  });

  await check('the preview shows the box where the path puts it', async () => {
    // Where the selection frame's corner is, in pixels of the recording.
    const frame = () => js(`(() => { const s = window.__editor.player.state; const c = document.getElementById('preview');
      const g = document.querySelector('.anno-frame').getBoundingClientRect(); const r = c.getBoundingClientRect();
      const k = c.width / r.width;
      return { x: (((g.left - r.left) * k - s.content.x) / s.content.w) * ${W}, y: (((g.top - r.top) * k - s.content.y) / s.content.h) * ${H} }; })()`);
    for (const t of [2, 4]) {
      await js(`window.__editor.player.seek(${t})`);
      const want = blockAt(t);
      let f = null;
      // The preview settles on the frame a moment after a seek.
      await waitFor(`the selection frame on the block at ${t} s`, async () => {
        f = await frame();
        return Math.abs(f.x - (want.x - MARGIN)) < 4 && Math.abs(f.y - (want.y - MARGIN)) < 4;
      }, 5000).catch(() => assert.fail(`the selection frame at ${t} s is at ${f?.x.toFixed(1)}, ${f?.y.toFixed(1)}, not ${want.x - MARGIN}, ${want.y - MARGIN}`));
      console.log(`    at ${t} s the selection frame is at ${f.x.toFixed(1)}, ${f.y.toFixed(1)} (the block's box: ${want.x - MARGIN}, ${want.y - MARGIN})`);
    }
  });

  await check('one undo removes the whole path; redo brings it back', async () => {
    await key('z', [MOD]);
    const undone = await annotation(id);
    assert.deepStrictEqual(undone, placed, 'back to the box as placed: no path, no follow');
    assert.ok(!(await visible('blurUnfollow')), 'nothing to stop');
    assert.strictEqual(await js('document.getElementById("blurFollow").textContent'), 'Follow what’s under it');
    await key('z', [MOD, 'shift']);
    assert.deepStrictEqual(await annotation(id), followed);
  });

  await check('dragging the followed box on the preview shifts the whole path by as much, as one undo step', async () => {
    await js('window.__editor.player.seek(3)');
    await sleep(300);
    const r = await js('(() => { const g = document.querySelector(".anno-frame").getBoundingClientRect(); return { x: g.x + g.width / 2, y: g.y + g.height / 2 }; })()');
    const from = { x: Math.round(r.x), y: Math.round(r.y) };
    const to = { x: from.x + 44, y: from.y + 26 };
    editor.focus();
    editor.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
    editor.webContents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 10; i++) {
      editor.webContents.sendInputEvent({
        type: 'mouseMove', x: Math.round(from.x + ((to.x - from.x) * i) / 10), y: Math.round(from.y + ((to.y - from.y) * i) / 10), modifiers: ['leftButtonDown']
      });
      await sleep(20);
    }
    editor.webContents.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    await sleep(200);
    const moved = await annotation(id);
    const dx = moved.x - followed.x;
    const dy = moved.y - followed.y;
    console.log(`    dragged by ${(dx * W).toFixed(1)}, ${(dy * H).toFixed(1)} px of the recording`);
    assert.ok(dx > 0.01 && dy > 0.01, 'the box moved right and down');
    assert.strictEqual(moved.path.length, followed.path.length);
    moved.path.forEach((p, i) => {
      assert.strictEqual(p.t, followed.path[i].t);
      assert.ok(Math.abs(p.x - followed.path[i].x - dx) < 1e-9 && Math.abs(p.y - followed.path[i].y - dy) < 1e-9, `point ${i} moved by the same amount`);
    });
    assert.deepStrictEqual([moved.w, moved.h], [followed.w, followed.h]);
    await shot('04-dragged');
    await key('z', [MOD]);
    assert.deepStrictEqual(await annotation(id), followed, 'one undo puts the whole path back');
  });

  await check('Stop following removes the path; the box stays where it starts', async () => {
    await js('document.getElementById("blurUnfollow").click()');
    assert.deepStrictEqual(await annotation(id), placed);
    assert.ok(!(await visible('blurUnfollow')));
    await key('z', [MOD]);
    assert.deepStrictEqual(await annotation(id), followed, 'and that undoes too');
  });

  await check('when what’s under the box vanishes, the path stops there and the panel says where', async () => {
    // A second hidden area over the block where it has come to rest, from
    // 5.5 s to 9 s; the block is gone from 7 s.
    await js('window.__editor.player.seek(5.5)');
    await js('document.getElementById("blurBtn").click()');
    const second = await waitFor('the second hidden area', () => js(`(() => { const a = window.__editor.store.project.annotations.at(-1); return a.id !== ${JSON.stringify(id)} ? a : null; })()`));
    const rest = blockAt(6);
    const box2 = { x: (rest.x - MARGIN) / W, y: (rest.y - MARGIN) / H, w: BOX.w, h: BOX.h, start: 5.5, end: 9 };
    await js(`(() => { const E = window.__editor; E.store.apply((p) => E.editor.core.updateAnnotation(p, ${JSON.stringify(second.id)}, ${JSON.stringify(box2)})); })()`);
    await js('document.getElementById("blurFollow").click()');
    const lost = await waitFor('the path', async () => { const a = await annotation(second.id); return a?.path ? a : null; }, 30000);
    await waitFor('the note', () => visible('blurFollowNote'), 5000);
    const note = await js('document.getElementById("blurFollowNote").textContent');
    console.log(`    ${note}`);
    assert.match(note, /^Lost what was under the box at 0:0[67]\.\d\. The blur stays put from there\./);
    const last = lost.path.at(-1);
    assert.ok(last.t > 6.5 && last.t < 7.05, `the path ends just before it vanished (${last.t.toFixed(2)} s)`);
    assert.ok(Math.abs(last.x - box2.x) * W <= 1 && Math.abs(last.y - box2.y) * H <= 1, 'still on the block until then');
    await shot('05-lost');
    // The first hidden area was not touched by any of this.
    assert.deepStrictEqual(await annotation(id), followed);
  });

  await check('a box over a plain area has nothing to follow, and says so without changing anything', async () => {
    await js('window.__editor.player.seek(8)');
    await js('document.getElementById("blurBtn").click()');
    const third = await waitFor('the third hidden area', () => js('(() => { const a = window.__editor.store.project.annotations; return a.length === 3 ? a.at(-1) : null; })()'));
    await js(`(() => { const E = window.__editor; E.store.apply((p) => E.editor.core.updateAnnotation(p, ${JSON.stringify(third.id)}, { x: 0.7, y: 0.05, w: 0.2, h: 0.1 })); })()`);
    const blank = await annotation(third.id);
    await js('document.getElementById("blurFollow").click()');
    const toast = await waitFor('the message', () => js('(() => { const t = document.getElementById("toast"); return t.classList.contains("show") && /nothing under the box/.test(t.textContent) ? t.textContent : null; })()'), 15000);
    console.log(`    ${toast}`);
    await waitFor('the button back', () => visible('blurFollow'), 5000);
    assert.deepStrictEqual(await annotation(third.id), blank);
  });

  await check('how fast it follows', async () => {
    // The first hidden area again, over the whole recording: 7 s of frames
    // before the block goes (then half a second more before giving up).
    await place({ start: 0, end: 10 });
    await js('window.__editor.saver.flush()');
    const r = await js(`window.loupe.followBlur(${JSON.stringify(id)})`);
    console.log(`    ${r.frames} frames of ${W}x${H} in ${r.seconds.toFixed(2)} s: ${(r.frames / r.seconds).toFixed(0)} frames a second (lost at ${r.lostAt?.toFixed(2)} s)`);
    assert.ok(r.frames > 200 && r.lostAt > 6.9 && r.lostAt < 7.1);
    assert.ok(r.frames / r.seconds > 30, 'faster than the video plays');
  });

  assert.strictEqual(trackerWindows().length, 0, 'no tracking window is left open');
  console.log(`\n${passed} passed. Screenshots: ${OUT}`);
  // The editor closed (its last save written) before its folder goes.
  await js('window.__editor.saver.flush()');
  editor.close();
  await waitFor('the editor to close', () => editor.isDestroyed(), 5000).catch(() => {});
  await sleep(300);
  fs.rmSync(work, { recursive: true, force: true });
}

app.whenReady().then(run).then(() => app.exit(0), (err) => {
  console.error(err);
  app.exit(1);
});
