'use strict';
// An overlay's effects and a clip's finer colour tools, checked in exported
// pixels in the real app. Over a small test video: a green picture is put in
// the middle; "Green screen" (Advanced, in its settings) makes it see-through
// so the video shows where it was, in the export and in the preview; a
// multiply blend darkens what is under it and add brightens it; an oval mask
// leaves the corners of its box showing the video, and a soft edge fades it.
// Then the clip's Colour > Advanced: warmth shifts the colour toward red,
// "Brighten shadows" lifts the dark parts, "Darken corners" does that, the
// curve brightens the middle in one undo step, the histogram counts the
// preview's pixels -- and with everything put back, the export is the
// picture it was before any of it. Screenshots go to
// test/e2e/out/effects-colour/.
//
//   node_modules/.bin/electron test/e2e/effects-colour.e2e.js
// Needs ffmpeg on the PATH.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const electron = require('electron');

const { app, BrowserWindow } = electron;
const VIDEOS = path.join(__dirname, '..', 'fixtures', 'videos');
const OUT = path.join(__dirname, 'out', 'effects-colour');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-efx-')));
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
    await sleep(50);
  }
}

const pageOf = (name) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() &&
  w.webContents.getURL().includes(`/renderer/${name}/`));

// The 720p export is 1280x720. The colour of the 8x8 pixels around (x, y)
// of the frame at `at` seconds.
function pixel(file, [x, y], at = 1) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-vf', `crop=8:8:${x - 4}:${y - 4},scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return { r: raw[0], g: raw[1], b: raw[2] };
}
// The whole frame as 64x36 grey pixels.
function tinyFrame(file, at = 1) {
  return execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-vf', 'scale=64:36:flags=area,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
}
const meanDiff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
const sum = (p) => p.r + p.g + p.b;
const isGreen = (p) => p.g > 180 && p.r < 90 && p.b < 90;
const like = (a, b, eps = 14) => Math.abs(a.r - b.r) <= eps && Math.abs(a.g - b.g) <= eps && Math.abs(a.b - b.b) <= eps;
const show = (p) => `(${p.r}, ${p.g}, ${p.b})`;

// The overlay sits in the middle at half the height: a 360-pixel square,
// x 460..820, y 180..540.
const MIDDLE = [640, 360];
const BOX_CORNER = [476, 196]; // inside the square's corner, outside its oval
const SOFT = [775, 360]; // three quarters of the way from the middle to its right edge
const DARK = [128, 120]; // a dark part of the test video (top left)
const BRIGHT = [1150, 120]; // a bright part (top right)
const CORNER = [1262, 18];

async function run() {
  require('../../src/main/main');
  const picker = await waitFor('the picker', () => pageOf('picker'));
  await waitFor('the picker to load', () => !picker.webContents.isLoading());
  nextChoice = path.join(VIDEOS, 'video6.mp4');
  await picker.webContents.executeJavaScript('document.getElementById("importVideo").click()');
  const editor = await waitFor('the editor', () => pageOf('editor'), 30000);
  await waitFor('the editor to load', () => editor.webContents.executeJavaScript('document.body.dataset.ready === "true"'), 30000);
  editor.webContents.setBackgroundThrottling(false);
  const js = (code) => editor.webContents.executeJavaScript(code);
  const shot = async (name) => {
    await sleep(300);
    fs.writeFileSync(path.join(OUT, `${name}.png`), (await editor.webContents.capturePage()).toPNG());
  };
  const exportFile = async () => {
    await js('window.__editor.saver.flush()');
    return (await js('window.loupe.exportVideo({ resolution: "720p" })')).file;
  };
  const slide = (id, v) => js(`(() => { const i = document.getElementById('${id}'); i.value = '${v}';
    i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const choose = (id, v) => js(`(() => { const s = document.getElementById('${id}'); s.value = '${v}';
    s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const overlay = () => js('window.__editor.store.project.overlays[0]');
  const clip = () => js('window.__editor.store.project.clips[0]');
  const previewAt = ([x, y]) => js(`(() => { const c = document.getElementById('preview');
    const d = c.getContext('2d').getImageData(Math.round(c.width * ${x / 1280}), Math.round(c.height * ${y / 720}), 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] }; })()`);
  const visible = (id) => js(`(() => { const e = document.getElementById('${id}'); return Boolean(e) && e.checkVisibility(); })()`);
  await js('document.querySelector(".first-run .btn")?.click()');
  await js('window.__editor.player.seek(1)');

  // The untouched video through the same export: what the edits are compared with.
  const reference = await exportFile();
  const refFrame = tinyFrame(reference);
  const ref = Object.fromEntries(Object.entries({ MIDDLE, BOX_CORNER, SOFT, DARK, BRIGHT, CORNER }).map(([k, at]) => [k, pixel(reference, at)]));
  console.log(`    the video: middle ${show(ref.MIDDLE)}, dark part ${show(ref.DARK)}, bright part ${show(ref.BRIGHT)}, corner ${show(ref.CORNER)}`);
  assert.ok(!isGreen(ref.MIDDLE) && sum(ref.DARK) < sum(ref.BRIGHT) - 150, 'the test video has a dark and a bright part, and no green middle');

  await check('a green picture over the video, as it always was: solid green in its square', async () => {
    await js('window.__editor.player.seek(0)');
    nextChoice = path.join(VIDEOS, 'green.png');
    await js('document.getElementById("addOverlayBtn").click()');
    await waitFor('the overlay', async () => (await js('window.__editor.store.project.overlays.length')) === 1);
    await slide('overlayX', 0);
    await slide('overlayY', 0);
    await slide('overlayScale', 0.5);
    const o = await overlay();
    assert.deepStrictEqual([o.blend, o.mask, o.key.on], ['normal', { shape: 'none', feather: 0 }, false], 'no effects until asked for');
    const file = await exportFile();
    assert.ok(isGreen(pixel(file, MIDDLE)) && isGreen(pixel(file, BOX_CORNER)) && isGreen(pixel(file, SOFT)), 'green all over its square');
    assert.ok(like(pixel(file, DARK), ref.DARK), 'the video around it');
  });

  await check('Advanced is folded until opened, and remembers that it was', async () => {
    assert.strictEqual(await js('document.getElementById("overlayAdvanced").open'), false);
    assert.strictEqual(await visible('overlayBlend'), false, 'its controls are out of the way');
    await js('document.querySelector("#overlayAdvanced summary").click()');
    await waitFor('it to be remembered', () => js('localStorage.getItem("loupe.advanced.overlay") === "open"'));
    for (const id of ['overlayBlend', 'overlayMask', 'overlayKeyOn']) assert.strictEqual(await js(`Boolean(document.getElementById('${id}'))`), true, id);
    assert.strictEqual(await visible('overlayBlend'), true);
    assert.strictEqual(await visible('overlayKeyColor'), false, 'the green screen’s settings wait for it to be on');
    assert.strictEqual(await visible('overlayMaskFeather'), false, 'and the edge’s for a shape');
    assert.strictEqual(await js('JSON.stringify(window.__editor.store.project).includes("advanced")'), false, 'not in the project');
  });

  await check('Green screen: the video shows where the green was, in the export and the preview; off, it is green again', async () => {
    await js('document.getElementById("overlayKeyOn").click()');
    assert.strictEqual((await overlay()).key.on, true);
    for (const id of ['overlayKeyColor', 'overlayKeyTolerance', 'overlayKeySoftness']) assert.strictEqual(await visible(id), true, id);
    assert.strictEqual(await js('document.getElementById("overlayKeyColor").value'), '#00ff00', 'pure green to begin with');
    let file = await exportFile();
    let px = pixel(file, MIDDLE);
    console.log(`    under the picture with the green screen on: ${show(px)} (the video there: ${show(ref.MIDDLE)})`);
    assert.ok(!isGreen(px) && like(px, ref.MIDDLE), 'the video, not green');
    assert.ok(like(pixel(file, BOX_CORNER), ref.BOX_CORNER), 'all over its square');
    await js('window.__editor.player.seek(1)');
    await waitFor('the preview to show the video there', async () => !isGreen(await previewAt(MIDDLE)), 8000);
    await shot('01-green-screen');
    // Another colour to remove: the green stays.
    await js(`(() => { const i = document.getElementById('overlayKeyColor'); i.value = '#0000ff';
      i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    assert.strictEqual((await overlay()).key.color, '#0000ff');
    assert.ok(isGreen(pixel(await exportFile(), MIDDLE)), 'removing blue leaves the green');
    await js('window.__editor.store.undo()');
    assert.strictEqual((await overlay()).key.color, '#00ff00', 'one undo step');
    await slide('overlayKeyTolerance', 0.3);
    await slide('overlayKeySoftness', 0.1);
    const o = await overlay();
    assert.deepStrictEqual([o.key.tolerance, o.key.softness], [0.3, 0.1]);
    assert.ok(like(pixel(await exportFile(), MIDDLE), ref.MIDDLE), 'still removed with less tolerance');
    await js('document.getElementById("overlayKeyOn").click()');
    assert.strictEqual((await overlay()).key.on, false);
    file = await exportFile();
    px = pixel(file, MIDDLE);
    console.log(`    with it off: ${show(px)}`);
    assert.ok(isGreen(px), 'green again');
    await waitFor('the preview to be green there again', async () => isGreen(await previewAt(MIDDLE)), 8000);
  });

  await check('a multiply blend darkens what is under the picture; add brightens it', async () => {
    await choose('overlayBlend', 'multiply');
    assert.strictEqual((await overlay()).blend, 'multiply');
    let px = pixel(await exportFile(), MIDDLE);
    console.log(`    multiply: ${show(px)}`);
    assert.ok(sum(px) < sum(ref.MIDDLE) - 60 && px.r < ref.MIDDLE.r - 40 && px.b < ref.MIDDLE.b - 40, 'darker: the red and blue of the video gone');
    assert.ok(Math.abs(px.g - ref.MIDDLE.g) < 20, 'its green kept');
    await choose('overlayBlend', 'add');
    px = pixel(await exportFile(), MIDDLE);
    console.log(`    add: ${show(px)}`);
    assert.ok(px.g > 235 && like({ ...px, g: 0 }, { ...ref.MIDDLE, g: 0 }, 20), 'brighter: green added to the video');
    await shot('02-blend');
    await choose('overlayBlend', 'normal');
  });

  await check('an oval mask leaves the corners of its box showing the video; a soft edge fades it', async () => {
    await choose('overlayMask', 'ellipse');
    assert.deepStrictEqual((await overlay()).mask, { shape: 'ellipse', feather: 0 });
    assert.strictEqual(await visible('overlayMaskFeather'), true);
    let file = await exportFile();
    const corner = pixel(file, BOX_CORNER);
    console.log(`    the box’s corner: ${show(corner)} (the video there: ${show(ref.BOX_CORNER)})`);
    assert.ok(!isGreen(corner) && like(corner, ref.BOX_CORNER), 'the video in the corner');
    assert.ok(isGreen(pixel(file, MIDDLE)) && isGreen(pixel(file, SOFT)), 'green inside the oval');
    await slide('overlayMaskFeather', 0.5);
    file = await exportFile();
    const soft = pixel(file, SOFT);
    console.log(`    in the soft edge: ${show(soft)} (the video there: ${show(ref.SOFT)})`);
    assert.ok(isGreen(pixel(file, MIDDLE)), 'still solid in the middle');
    // Three quarters of the way out, with half of the way soft: half of each.
    const half = { r: ref.SOFT.r / 2, g: (ref.SOFT.g + 255) / 2, b: ref.SOFT.b / 2 };
    assert.ok(!isGreen(soft) && like(soft, half, 30), 'half green, half video in the edge');
    await waitFor('the preview to show the video in the corner', async () => !isGreen(await previewAt(BOX_CORNER)), 8000);
    await shot('03-mask');
    // A rectangle with a soft edge fades toward its sides.
    await choose('overlayMask', 'rectangle');
    file = await exportFile();
    assert.ok(isGreen(pixel(file, MIDDLE)), 'solid in the middle');
    const edge = pixel(file, [476, 360]);
    assert.ok(!isGreen(edge), `faded near its left side: ${show(edge)}`);
    await js('window.__editor.store.apply((p) => window.__editor.editor.core.removeOverlay(p, p.overlays[0].id))');
  });

  // ---- the clip's finer colour tools
  const clipId = (await clip()).id;
  await js(`window.__editor.editor.select({ kind: 'clip', id: '${clipId}' })`);

  await check('Colour > Advanced holds the finer tools, folded until opened', async () => {
    assert.strictEqual(await js('document.getElementById("clipColourAdvanced").open'), false);
    await js('document.querySelector("#clipColourAdvanced summary").click()');
    await waitFor('it to be remembered', () => js('localStorage.getItem("loupe.advanced.clipColour") === "open"'));
    for (const id of ['clipTemperature', 'clipTint', 'clipHighlights', 'clipShadows', 'clipVignette', 'clipSharpen', 'clipCurve', 'clipHistogram']) {
      assert.strictEqual(await visible(id), true, id);
    }
  });

  await check('Warmth shifts the colour toward red, in the export and the preview; one undo step per drag', async () => {
    await slide('clipTemperature', 0.6);
    assert.strictEqual((await clip()).color.temperature, 0.6);
    // The video's white part (its colours are all full or none: white shows it best).
    const px = pixel(await exportFile(), BRIGHT);
    console.log(`    white warmed: ${show(px)} (was ${show(ref.BRIGHT)})`);
    assert.ok(px.r - px.b > ref.BRIGHT.r - ref.BRIGHT.b + 30 && px.r >= px.g && px.g > px.b, 'toward red, away from blue');
    await js('window.__editor.player.seek(1)');
    await waitFor('the preview warmed', async () => { const p = await previewAt(BRIGHT); return p.r > p.b + 25; }, 8000);
    await slide('clipTemperature', -0.6);
    const cold = pixel(await exportFile(), BRIGHT);
    assert.ok(cold.b > cold.r + 20, `colder the other way: ${show(cold)}`);
    await slide('clipTint', 0.6);
    const pink = pixel(await exportFile(), BRIGHT);
    assert.ok(pink.g < cold.g - 12, `tint takes green out: ${show(pink)}`);
    await js('window.__editor.store.undo()');
    assert.strictEqual((await clip()).color.tint, undefined, 'the tint was one step');
    await js('window.__editor.store.undo()');
    assert.strictEqual((await clip()).color.temperature, 0.6, 'and each drag of warmth another');
    await js('document.getElementById("clipResetColour").click()');
    assert.strictEqual((await clip()).color, undefined);
  });

  await check('Brighten shadows lifts the dark parts far more than the bright ones; highlights the other way', async () => {
    await slide('clipShadows', 1);
    let file = await exportFile();
    const dark = sum(pixel(file, DARK)) - sum(ref.DARK);
    const bright = sum(pixel(file, BRIGHT)) - sum(ref.BRIGHT);
    console.log(`    shadows up: the dark part +${dark}, the bright part +${bright}`);
    assert.ok(dark > 100 && bright < dark / 4, 'the dark part much more');
    await slide('clipShadows', 0);
    await slide('clipHighlights', -1);
    file = await exportFile();
    const dark2 = sum(pixel(file, DARK)) - sum(ref.DARK);
    const bright2 = sum(pixel(file, BRIGHT)) - sum(ref.BRIGHT);
    console.log(`    highlights down: the dark part ${dark2}, the bright part ${bright2}`);
    assert.ok(bright2 < -100 && Math.abs(dark2) < Math.abs(bright2) / 4, 'the bright part much more');
    await js('document.getElementById("clipResetColour").click()');
  });

  await check('Darken corners darkens the corners more than the middle', async () => {
    await slide('clipVignette', 1);
    const file = await exportFile();
    const corner = pixel(file, CORNER);
    const middle = pixel(file, MIDDLE);
    console.log(`    corner ${show(corner)} (was ${show(ref.CORNER)}), middle ${show(middle)} (was ${show(ref.MIDDLE)})`);
    assert.ok(sum(corner) < sum(ref.CORNER) * 0.5, 'the corner much darker');
    assert.ok(like(middle, ref.MIDDLE, 8), 'the middle as it was');
    await js('window.__editor.player.seek(1)');
    await waitFor('the preview’s corner darkened', async () => sum(await previewAt(CORNER)) < sum(ref.CORNER) * 0.6, 8000);
    await shot('04-corners');
    await js('document.getElementById("clipResetColour").click()');
    assert.strictEqual((await clip()).color, undefined, 'Reset colour clears it');
  });

  await check('the curve: click adds a point, dragging it up brightens, in one undo step; double-click removes it', async () => {
    const at = await js(`(() => { const r = document.getElementById('clipCurve').getBoundingClientRect();
      document.getElementById('clipCurve').scrollIntoView({ block: 'center' });
      const q = document.getElementById('clipCurve').getBoundingClientRect();
      return { x: q.left + q.width / 2, y: q.top + q.height / 2, h: q.height, was: r.top }; })()`);
    const fire = (type, x, y) => js(`document.getElementById('clipCurve').dispatchEvent(new PointerEvent('${type}', { bubbles: true, button: 0, pointerId: 7, clientX: ${x}, clientY: ${y} }))`);
    // The test video has no mid-tones: its white pulled down to a grey first
    // (highlights come before the curve).
    await slide('clipHighlights', -1);
    const grey = pixel(await exportFile(), BRIGHT);
    await fire('pointerdown', at.x, at.y);
    let curve = (await clip()).color.curve;
    assert.strictEqual(curve.length, 3, 'a point added');
    assert.ok(Math.abs(curve[1].x - 0.5) < 0.02 && Math.abs(curve[1].y - 0.5) < 0.02, `in the middle: ${JSON.stringify(curve[1])}`);
    for (let k = 1; k <= 5; k++) await fire('pointermove', at.x, at.y - (k * at.h) / 20);
    await fire('pointerup', at.x, at.y - at.h / 4);
    curve = (await clip()).color.curve;
    console.log(`    the curve: ${JSON.stringify(curve)}`);
    assert.ok(curve[1].y > 0.7 && Math.abs(curve[1].x - 0.5) < 0.02, 'dragged up');
    const file = await exportFile();
    const px = pixel(file, BRIGHT);
    console.log(`    a grey through it: ${show(px)} (was ${show(grey)})`);
    assert.ok(grey.r > 120 && grey.r < 190 && sum(px) > sum(grey) + 90, 'the grey brighter');
    assert.ok(like(pixel(file, DARK), ref.DARK, 6), 'black stays black');
    await shot('05-curve');
    await js('window.__editor.store.undo()');
    assert.strictEqual((await clip()).color.curve, undefined, 'adding and dragging it was one undo step');
    await js('window.__editor.store.redo()');
    assert.strictEqual((await clip()).color.curve.length, 3);
    await js(`document.getElementById('clipCurve').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: ${at.x}, clientY: ${at.y - at.h / 4 + 2} }))`);
    assert.strictEqual((await clip()).color.curve.length, 2, 'double-click removed it');
    await js('document.getElementById("clipCurveReset").click()');
    assert.strictEqual((await clip()).color.curve, null);
    await js('document.getElementById("clipResetColour").click()');
  });

  await check('the histogram counts the preview’s pixels by brightness', async () => {
    await js('window.__editor.player.seek(1)');
    const bins = await waitFor('the histogram', () => js(`(() => { const b = document.getElementById('clipHistogram').bins; return b ? Array.from(b) : null; })()`));
    assert.strictEqual(bins.length, 64);
    assert.strictEqual(bins.reduce((s, n) => s + n, 0), 160 * 90, 'every sampled pixel counted');
    assert.ok(bins.filter((n) => n > 0).length >= 4, `spread over several brightnesses: ${bins.join(' ')}`);
    const drawn = await js(`(() => { const c = document.getElementById('clipHistogram'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; })()`);
    assert.ok(drawn > 50, 'bars drawn');
    // It follows the picture: everything dark, the bars move left.
    await slide('clipBrightness', -1);
    await waitFor('the histogram to follow', () => js(`(() => { const b = document.getElementById('clipHistogram').bins; return b[0] === 160 * 90; })()`), 8000);
    await slide('clipBrightness', 0);
  });

  await check('Sharpen makes edges crisper and leaves flat parts alone', async () => {
    await slide('clipSharpen', 1);
    const file = await exportFile();
    const diff = meanDiff(tinyFrame(file), refFrame);
    const flat = pixel(file, BRIGHT);
    console.log(`    the picture changed by ${diff.toFixed(2)} on average; a flat part ${show(flat)} (was ${show(ref.BRIGHT)})`);
    assert.ok(like(flat, ref.BRIGHT, 8) && like(pixel(file, DARK), ref.DARK, 8), 'flat parts unchanged');
    const full = (f) => execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', f, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
    const a = full(file);
    const b = full(reference);
    let changed = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 12) changed++;
    console.log(`    ${changed} of ${a.length} pixels differ clearly (the edges)`);
    assert.ok(changed > 500 && changed < a.length / 2, 'only around edges');
  });

  await check('with everything put back, the export is the picture it was before', async () => {
    await js('document.getElementById("clipResetColour").click()');
    const project = await js('window.__editor.store.project');
    assert.strictEqual(project.clips[0].color, undefined);
    assert.strictEqual(project.overlays.length, 0);
    assert.strictEqual(project.version, 2);
    const file = await exportFile();
    const diff = meanDiff(tinyFrame(file), refFrame);
    console.log(`    differs from the first export by ${diff.toFixed(3)} per pixel`);
    assert.ok(diff < 0.5, 'the same pixels');
    for (const [name, at] of Object.entries({ MIDDLE, DARK, BRIGHT, CORNER })) assert.ok(like(pixel(file, at), ref[name], 3), name);
  });

  console.log(`\n${passed} passed. Screenshots: ${OUT}`);
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
