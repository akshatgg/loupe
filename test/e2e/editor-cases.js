'use strict';
// The editor's end-to-end cases (run by editor.js). Each opens the real
// editor on a fresh copy of a fixture recording saved as a v1 project (as the
// recorder writes it), drives it with the real mouse and keyboard, and checks
// project.json on disk, the preview's pixels and, for export, the video.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  openEditor, openLab, makeFixture, freshRecording, readProject, waitFor, sleep, log, argValue, OUT, FIXTURE, revealed
} = require('./editor-harness');

const MOD = process.platform === 'darwin' ? 'meta' : 'control';
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} is not within ${eps} of ${b}`);

// The colour index (palette a: one colour per second of the recording) the
// preview shows at a point given as a fraction of the drawn content area.
async function previewColour(ed, lab, fx = 0.25, fy = 0.2) {
  await waitFor(() => ed.js(`(() => { const p = window.__editor.player; const at = window.__editor.store.tl.toSource(p.time);
    const v = p.videos[at.source]; return v.readyState >= 2 && !v.seeking && Math.abs(v.currentTime - at.t) < 0.02; })()`), 'the preview frame');
  await sleep(150);
  const rgb = await ed.js(`(() => {
    const c = document.getElementById('preview'); const s = window.__editor.player.state;
    const x = Math.round(s.content.x + ${fx} * s.content.w); const y = Math.round(s.content.y + ${fy} * s.content.h);
    return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3)); })()`);
  let best = -1;
  let dist = Infinity;
  lab.palettes.a.forEach((c, i) => {
    const d = Math.hypot(c[0] - rgb[0], c[1] - rgb[1], c[2] - rgb[2]);
    if (d < dist) { dist = d; best = i; }
  });
  assert.ok(dist < 60, `preview colour ${rgb} is not in the palette`);
  return best;
}

async function seek(ed, t) {
  await ed.js(`window.__editor.player.seek(${t})`);
}

async function trackY(ed, selector) {
  const r = await ed.box(selector);
  return Math.round(r.y + r.h / 2);
}

const CASES = [
  ['opens a v1 recording: title, migrated zoom, live preview', async (ed, dir, lab) => {
    const p = await ed.project();
    assert.strictEqual(p.version, 2);
    assert.match(await ed.js('document.getElementById("title").value'), /^Recording/);
    assert.strictEqual(await ed.js('document.querySelectorAll(".tl-zooms .zoom").length'), 1);
    assert.strictEqual(readProject(dir).version, 1, 'opening alone does not rewrite the file');
    await seek(ed, 2.5);
    assert.strictEqual(await previewColour(ed, lab), 2);
    await seek(ed, 6.2);
    await ed.shot('01-opened');
    // Playing moves the clock and the picture.
    await seek(ed, 0.2);
    await ed.key('Space');
    await sleep(1000);
    // The sound (the preview's mix) plays along, on the same clock.
    const sound = await ed.js(`(() => { const a = window.__editor.player.audio;
      return { paused: !a.playing, drift: a.position - window.__editor.player.time }; })()`);
    assert.strictEqual(sound.paused, false, 'the sound plays');
    assert.ok(Math.abs(sound.drift) < 0.25, `the sound is ${sound.drift.toFixed(3)} s off the picture`);
    await sleep(300);
    await ed.key('Space');
    const t = await ed.js('window.__editor.player.time');
    assert.ok(t > 1.1 && t < 1.9, `played to ${t}`);
    assert.strictEqual(await previewColour(ed, lab), Math.floor(t));
  }],

  ['trim the end by dragging, then undo and redo with the keyboard', async (ed, dir) => {
    const y = await trackY(ed, '.clip');
    const r = await ed.box('.clip .handle.end');
    await ed.drag(Math.round(r.x + r.w / 2), y, await ed.timelineX(6), y);
    await ed.settle();
    near(readProject(dir).clips[0].end, 6, 0.15, 'trimmed end on disk');
    await ed.shot('02-trimmed');
    await ed.key('z', [MOD]);
    await ed.settle();
    near(readProject(dir).clips[0].end, 8, 1e-6, 'undo');
    await ed.key('z', [MOD, 'shift']);
    await ed.settle();
    near(readProject(dir).clips[0].end, 6, 0.15, 'redo');
    // The undo button too.
    await ed.clickOn('#undo');
    await ed.settle();
    near(readProject(dir).clips[0].end, 8, 1e-6, 'undo button');
    // Trim the start with the other edge.
    const s = await ed.box('.clip .handle.start');
    await ed.drag(Math.round(s.x + s.w / 2), y, await ed.timelineX(1), y);
    await ed.settle();
    near(readProject(dir).clips[0].start, 1, 0.15, 'trimmed start');
  }],

  ['split at the playhead, reorder by dragging, delete a clip', async (ed, dir, lab) => {
    await seek(ed, 4);
    await ed.key('s');
    await ed.settle();
    let clips = readProject(dir).clips;
    assert.deepStrictEqual(clips.map((c) => [c.start, c.end]), [[0, 4], [4, 8]]);
    // Drag the second clip before the first.
    const y = await trackY(ed, '.clip');
    await ed.drag(await ed.timelineX(6), y, await ed.timelineX(0.5), y, 16);
    await ed.settle();
    clips = readProject(dir).clips;
    assert.deepStrictEqual(clips.map((c) => [c.start, c.end]), [[4, 8], [0, 4]], 'reordered');
    await seek(ed, 0.5);
    assert.strictEqual(await previewColour(ed, lab), 4, 'the video now starts at recording 4.5 s');
    await seek(ed, 4.5);
    assert.strictEqual(await previewColour(ed, lab), 0);
    await ed.shot('03-reordered');
    // Select the first clip with a click and delete it.
    await ed.click(await ed.timelineX(2), y);
    await ed.key('Backspace');
    await ed.settle();
    clips = readProject(dir).clips;
    assert.deepStrictEqual(clips.map((c) => [c.start, c.end]), [[0, 4]], 'deleted');
    near(await ed.js('window.__editor.store.tl.duration'), 4, 1e-6, 'duration');
    // The last clip can't go.
    await ed.click(await ed.timelineX(2), y);
    await ed.key('Backspace');
    assert.strictEqual(readProject(dir).clips.length, 1);
    assert.match(await ed.js('document.getElementById("toast").textContent'), /at least one clip/);
  }],

  ['add a zoom by dragging, resize it, set its level and a fixed spot', async (ed, dir) => {
    const y = await trackY(ed, '.tl-zooms');
    await ed.drag(await ed.timelineX(1), y, await ed.timelineX(2.5), y);
    await ed.settle();
    let zooms = readProject(dir).zooms;
    assert.strictEqual(zooms.length, 2);
    const added = zooms.find((z) => !z.recorded);
    near(added.start, 1, 0.1, 'zoom start');
    near(added.end, 2.5, 0.1, 'zoom end');
    assert.strictEqual(added.level, 2);
    assert.strictEqual(await ed.js('document.querySelector(".tab[aria-selected=true]").dataset.panel'), 'zoom');
    // Drag its right edge out to 3.5 s.
    const edge = await ed.box('.zoom.selected .handle.end');
    await ed.drag(Math.round(edge.x + edge.w / 2), y, await ed.timelineX(3.5), y);
    await ed.settle();
    zooms = readProject(dir).zooms;
    near(zooms.find((z) => z.id === added.id).end, 3.5, 0.1, 'resized end');
    // Move it by dragging its middle 0.5 s later.
    const body = await ed.box('.zoom.selected');
    const mid = Math.round(body.x + body.w / 2);
    await ed.drag(mid, y, mid + Math.round(0.5 * await ed.js('window.__editor.timeline.pxPerSecond')), y);
    await ed.settle();
    let z = readProject(dir).zooms.find((q) => q.id === added.id);
    near(z.start, 1.5, 0.12, 'moved start');
    near(z.end - z.start, 2.5, 0.05, 'moving keeps the length');
    // Level through the slider, as a person dragging it would.
    await ed.js(`(() => { const s = document.getElementById('zoomLevel'); s.value = '3';
      s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await ed.clickOn('.panel-body[data-panel=zoom] .seg-btn[data-value=fixed]');
    await sleep(100);
    const pick = await ed.box('.spot-picker');
    await ed.click(Math.round(pick.x + pick.w * 0.25), Math.round(pick.y + pick.h * 0.25));
    await ed.settle();
    z = readProject(dir).zooms.find((q) => q.id === added.id);
    assert.strictEqual(z.level, 3);
    assert.strictEqual(z.follow, false);
    near(z.x, FIXTURE.width * 0.25, 8, 'spot x');
    near(z.y, FIXTURE.height * 0.25, 8, 'spot y');
    await seek(ed, 3);
    await sleep(100);
    const zoom = await ed.js('window.__editor.player.state.camera.zoom');
    near(zoom, 3, 0.05, 'the preview is zoomed');
    await ed.shot('04-zoom-fixed');
    // Z at the playhead where there is room adds another; Delete removes the selected one.
    await seek(ed, 6.9);
    await ed.key('z');
    await ed.settle();
    assert.strictEqual(readProject(dir).zooms.length, 3);
    await ed.key('Delete');
    await ed.settle();
    assert.strictEqual(readProject(dir).zooms.length, 2);
    // Double-click opens a zoom's settings.
    await ed.clickOn('#tabs .tab[data-panel=style]');
    const again = await ed.box(`.zoom[data-id="${added.id}"]`);
    await ed.click(Math.round(again.x + again.w / 2), y, { clickCount: 1 });
    await ed.click(Math.round(again.x + again.w / 2), y, { clickCount: 2 });
    assert.strictEqual(await ed.js('document.querySelector(".tab[aria-selected=true]").dataset.panel'), 'zoom');
  }],

  ['speed: drag across the speed track and pick 2x', async (ed, dir) => {
    const y = await trackY(ed, '.tl-speed');
    await ed.drag(await ed.timelineX(1), y, await ed.timelineX(3), y);
    assert.strictEqual(await ed.js('!document.querySelector(".speed-menu").hidden'), true, 'the speed menu opens');
    await ed.shot('05-speed-menu');
    await ed.clickOn('.speed-menu button[data-rate="2"]');
    await ed.settle();
    const speed = readProject(dir).speed;
    assert.strictEqual(speed.length, 1);
    near(speed[0].start, 1, 0.1, 'speed start');
    near(speed[0].end, 3, 0.1, 'speed end');
    assert.strictEqual(speed[0].rate, 2);
    const duration = await ed.js('window.__editor.store.tl.duration');
    assert.ok(duration < 7.2 && duration > 6.9, `2x over 2 s of 8: ${duration}`);
    // Clicking the stretch opens the menu again; Normal takes it away.
    await ed.clickOn('.tl-speed .speed');
    await ed.clickOn('.speed-menu button[data-rate="1"]');
    await ed.settle();
    assert.deepStrictEqual(readProject(dir).speed, []);
  }],

  ['style: background, padding, corners, shape and cursor', async (ed, dir) => {
    await ed.clickOn('.swatch[title="Gradient 2"]');
    for (const [label, value] of [['Padding', '0.1'], ['Rounded corners', '24'], ['Shadow', '0.8']]) {
      await ed.js(`(() => { const s = document.querySelector('input[aria-label="${label}"]'); s.value = '${value}';
        s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    }
    await ed.clickOn('.aspects .seg-btn[data-value="9:16"]');
    await ed.js('document.querySelector(".panel-wrap").scrollTop = 1000');
    await ed.clickOn('.seg-btn[data-value="ring"]');
    await ed.settle();
    const style = readProject(dir).style;
    assert.deepStrictEqual(style.background, { type: 'gradient', value: { angle: 135, stops: ['#8ab4f8', '#1a73e8'] } });
    assert.strictEqual(style.padding, 0.1);
    assert.strictEqual(style.radius, 24);
    assert.strictEqual(style.shadow, 0.8);
    assert.strictEqual(style.aspect, '9:16');
    assert.strictEqual(style.cursor.highlight, 'ring');
    const ratio = await ed.js('document.getElementById("preview").width / document.getElementById("preview").height');
    near(ratio, 9 / 16, 0.01, 'the preview is 9:16');
    // The background shows in the preview's corner.
    const corner = await ed.js('Array.from(document.getElementById("preview").getContext("2d").getImageData(4, 4, 1, 1).data.slice(0, 3))');
    assert.ok(corner[2] > 180 && corner[0] > 90, `gradient corner ${corner}`);
    await seek(ed, 3);
    await ed.shot('06-style-portrait');
    // One undo takes back one change (the highlight), not the whole panel.
    await ed.key('z', [MOD]);
    await ed.settle();
    assert.strictEqual(readProject(dir).style.cursor.highlight, 'none');
    assert.strictEqual(readProject(dir).style.aspect, '9:16');
  }],

  ['rename, cheat sheet', async (ed, dir) => {
    await ed.clickOn('#title');
    await ed.js('document.getElementById("title").select()');
    for (const ch of 'Demo take') await ed.key(ch === ' ' ? 'Space' : ch);
    await ed.key('Return');
    await ed.settle();
    assert.strictEqual(readProject(dir).title, 'Demo take');
    await ed.key('?', ['shift']);
    await sleep(150);
    assert.strictEqual(await ed.js('window.__editor.cheat.open'), true, '? opens the shortcuts');
    await ed.shot('07-shortcuts');
    await ed.key('Escape');
    assert.strictEqual(await ed.js('window.__editor.cheat.open'), false);
  }],

  ['export from the dialog: 720p, progress, Show in Finder; cancel leaves nothing', async (ed, dir, lab) => {
    // An edit to export: cut out 2..4 s.
    await seek(ed, 2);
    await ed.key('s');
    await seek(ed, 4);
    await ed.key('s');
    const y = await trackY(ed, '.clip');
    await ed.click(await ed.timelineX(3), y);
    await ed.key('Backspace');
    near(await ed.js('window.__editor.store.tl.duration'), 6, 1e-6, 'cut');
    await ed.key('e', [MOD]);
    assert.strictEqual(await ed.js('window.__editor.exportDialog.isOpen'), true, 'Cmd+E opens export');
    await ed.clickOn('#exportResolution .seg-btn[data-value="720p"]');
    await ed.clickOn('#exportQuality .seg-btn[data-value="small"]');
    await ed.shot('08-export-settings');
    await ed.clickOn('#exportStart');
    await waitFor(() => ed.js('document.getElementById("exportPercent")?.textContent !== "0%"'), 'export progress');
    await ed.shot('09-export-progress');
    await waitFor(() => ed.js('window.__editor.exportDialog.state !== "running"'), 'the export', 60000);
    assert.strictEqual(await ed.js('window.__editor.exportDialog.state'), 'done', await ed.js('document.getElementById("exportError")?.textContent ?? ""'));
    await ed.shot('10-export-done');
    const file = await ed.js('document.querySelector(".export-dialog").dataset.file');
    assert.strictEqual(file, path.join(dir, `${readProject(dir).title.replace(/:/g, '.')}.mp4`), 'named after the video');
    assert.strictEqual(readProject(dir).export.resolution, '720p');
    assert.strictEqual(readProject(dir).export.quality, 'small');
    const inspection = await lab.call('inspect', pathToFileURL(file).href, {
      samples: [{ t: 3, points: [{ x: 288, y: 144 }] }]
    });
    assert.strictEqual(inspection.width, 1152);
    assert.strictEqual(inspection.height, 720);
    assert.strictEqual(inspection.frames, 360, 'six seconds at 60 fps');
    // Output 3 s is recording 5 s after the cut: colour 5.
    const rgb = inspection.colours[0].colours[0];
    const want = lab.palettes.a[5];
    assert.ok(Math.hypot(rgb[0] - want[0], rgb[1] - want[1], rgb[2] - want[2]) < 60, `export colour ${rgb}, expected ${want}`);
    await ed.clickOn('#exportReveal');
    assert.deepStrictEqual(revealed.slice(-1), [file]);
    fs.rmSync(file);
    await ed.key('Escape');
    await sleep(100);

    await ed.key('e', [MOD]);
    await ed.clickOn('#exportStart');
    await waitFor(() => ed.js('document.getElementById("exportPercent")?.textContent !== "0%"'), 'export progress');
    await ed.clickOn('#exportCancel');
    await waitFor(() => ed.js('window.__editor.exportDialog.state === "settings"'), 'the cancel');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.part') || /\.(mp4|gif|webm)$/.test(f) && f !== 'raw.mp4'), [], 'cancel leaves nothing');
  }]
];

async function errorStates(src) {
  // No video file: the editor opens and says so.
  const missing = freshRecording(src, 'missing-video');
  fs.rmSync(path.join(missing, 'raw.mp4'));
  let ed = await openEditor(missing);
  assert.strictEqual(await ed.js('document.getElementById("stageNotice").hidden'), false);
  assert.match(await ed.js('document.getElementById("stageNotice").textContent'), /video file for this recording is missing/);
  await ed.shot('11-missing-video');
  ed.close();
  // An unreadable project: a plain error instead of the editor.
  const broken = freshRecording(src, 'broken-project');
  fs.writeFileSync(path.join(broken, 'project.json'), '{ not json');
  ed = await openEditor(broken);
  assert.strictEqual(await ed.js('document.getElementById("fatal").hidden'), false);
  assert.match(await ed.js('document.getElementById("fatal").textContent'), /couldn’t be opened.*couldn't be read/s);
  await ed.shot('12-broken-project');
  ed.close();
}

async function runSuite() {
  for (const f of fs.existsSync(OUT) ? fs.readdirSync(OUT) : []) {
    if (/^(\d\d|fail)-.*\.png$/.test(f)) fs.rmSync(path.join(OUT, f));
  }
  const lab = await openLab();
  const src = await makeFixture(lab);
  const only = argValue('--only');
  let n = 0;
  let failed = 0;
  for (const [i, [title, fn]] of CASES.entries()) {
    if (only && !title.includes(only)) continue;
    n++;
    const dir = freshRecording(src, `case-${i + 1}`);
    const ed = await openEditor(dir);
    try {
      await waitFor(() => ed.js('Object.values(window.__editor.player.videos).every((v) => v.readyState >= 2)'), 'the video');
      await fn(ed, dir, lab);
      // The tests' own getImageData calls on the preview draw a performance hint.
      const errors = ed.errors.filter((e) => !/Electron Security Warning|willReadFrequently/.test(e));
      assert.deepStrictEqual(errors, [], 'no errors in the editor console');
      log(`ok ${n} - ${title}`);
    } catch (err) {
      failed++;
      await ed.shot(`fail-${i + 1}`).catch(() => {});
      log(`not ok ${n} - ${title}\n  ${String(err.stack ?? err).split('\n').slice(0, 5).join('\n  ')}`);
    } finally {
      ed.close();
    }
  }
  if (!only) {
    n++;
    try {
      await errorStates(src);
      log(`ok ${n} - missing video and unreadable project show plain messages`);
    } catch (err) {
      failed++;
      log(`not ok ${n} - error states\n  ${String(err.stack ?? err).split('\n').slice(0, 5).join('\n  ')}`);
    }
  }
  log(`# ${n - failed}/${n} passed; screenshots in ${path.relative(path.join(__dirname, '..', '..'), OUT)}/`);
  return failed ? 1 : 0;
}

module.exports = { runSuite };
