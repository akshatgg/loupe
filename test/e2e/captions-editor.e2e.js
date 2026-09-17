'use strict';
// End-to-end test of captions in the editor, in real Electron on macOS:
//
//   electron test/e2e/captions-editor.e2e.js     (part of npm run test:e2e:captions)
//
// A recording is made from speech (`say`, then ffmpeg puts it under a plain
// video as the mic track), opened in the real editor with the app's preload,
// and driven with the real mouse and keyboard: the first-time download
// explanation, its progress and Cancel (the download itself is simulated so
// the test can see it; the real model is then used from LOUPE_E2E_CACHE),
// generating captions, fixing one caption's words, dragging a caption's edge
// on the timeline, join + undo, the look settings, and exporting with the
// captions burned in plus a .srt. The export is decoded to check for a
// caption box in the picture while a caption is on screen (and none when it
// isn't), and the .srt for the edited words at the right time.
//
// Screenshots go to test/e2e/out/editor/captions-*.png to look at.

const { app, ipcMain, dialog, BrowserWindow, nativeImage } = require('electron');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const CACHE = process.env.LOUPE_E2E_CACHE || path.join(os.tmpdir(), 'loupe-e2e-cache');
app.setPath('userData', path.join(CACHE, 'userData'));

const { registerCaptionsIpc } = require('../../src/main/ipc/captions');
const { createSpeechModels, MODELS } = require('../../src/main/speech-models');
const { openEditor, openLab, readProject, waitFor, sleep, log, OUT } = require('./editor-harness');
const v1 = require('../../src/main/project');

const MOD = process.platform === 'darwin' ? 'meta' : 'control';
const LEAD_SILENCE = 2;
const SPEECH = `[[slnc ${LEAD_SILENCE * 1000}]] Welcome to the Loupe demo. [[slnc 1200]] ` +
  'Today I will show you how to record your screen and share the video with your team. [[slnc 1500]]';
const EDITED = 'Hello from the captions test';
const BACKGROUND = [64, 96, 128];

// ------------------------------------------------------------- speech models

// The real models, except that while `pretendFresh` is on the model looks not
// yet downloaded and "downloads" slowly, so the first-time view, its progress
// and Cancel can be checked without fetching hundreds of MB again.
function testModels() {
  const real = createSpeechModels({ root: () => path.join(app.getPath('userData'), 'speech-models') });
  const state = { pretendFresh: false, stop: null };
  const models = {
    async list() {
      const list = await real.list();
      return state.pretendFresh ? list.map((m) => ({ ...m, downloaded: false })) : list;
    },
    ensure(key, onProgress) {
      if (!state.pretendFresh) return real.ensure(key, onProgress);
      const total = MODELS[key].files.reduce((n, f) => n + f.size, 0);
      return new Promise((resolve, reject) => {
        let i = 0;
        const timer = setInterval(() => {
          i++;
          onProgress({ key, received: (total * i) / 400, total, file: 'onnx/encoder_model.onnx' });
          if (i >= 400) { clearInterval(timer); resolve(real.ensure(key, onProgress)); }
        }, 50);
        state.stop = () => { clearInterval(timer); reject(new Error('The download was cancelled.')); };
      });
    },
    cancel(key) {
      if (state.stop) { state.stop(); state.stop = null; return true; }
      return real.cancel(key);
    },
    remove: (key) => real.remove(key),
    info: (key) => real.info(key)
  };
  return { models, state };
}

// ------------------------------------------------------------- the recording

function makeRecording() {
  const dir = path.join(OUT, 'cases', 'captions');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-captions-editor-'));
  const aiff = path.join(work, 'speech.aiff');
  const m4a = path.join(work, 'speech.m4a');
  execFileSync('/usr/bin/say', ['-v', 'Samantha', '-o', aiff, SPEECH]);
  execFileSync('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac@48000', aiff, m4a]);
  const duration = Number(/estimated duration: ([\d.]+)/.exec(execFileSync('/usr/bin/afinfo', [m4a]).toString())[1]);
  const hex = BACKGROUND.map((c) => c.toString(16).padStart(2, '0')).join('');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=640x400:r=30:d=${duration}`,
    '-i', m4a, '-map', '0:v', '-map', '1:a', '-c:v', 'h264_videotoolbox', '-b:v', '2M', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart', path.join(dir, 'raw.mov')]);
  fs.rmSync(work, { recursive: true, force: true });
  const project = v1.createProject({ kind: 'display', id: 'display:1', title: 'Display', width: 640, height: 400 },
    { file: 'raw.mov', fps: 30, duration, hasMicTrack: true });
  v1.saveProject(dir, project);
  return { dir, duration };
}

// ------------------------------------------------------------- picture checks

// Counts pixels in the lower part of a PNG (where bottom captions go) that
// are much darker or much lighter than the plain background.
function captionPixels(file) {
  const img = nativeImage.createFromPath(file);
  const { width, height } = img.getSize();
  const bgra = img.toBitmap();
  let dark = 0;
  let light = 0;
  let total = 0;
  for (let y = Math.round(height * 0.62); y < Math.round(height * 0.97); y += 2) {
    for (let x = Math.round(width * 0.1); x < Math.round(width * 0.9); x += 2) {
      const i = (y * width + x) * 4;
      const lum = 0.299 * bgra[i + 2] + 0.587 * bgra[i + 1] + 0.114 * bgra[i];
      if (lum < 45) dark++;
      if (lum > 200) light++;
      total++;
    }
  }
  return { dark: dark / total, light: light / total };
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    log(`ok - ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    log(`not ok - ${name}\n  ${String(err.stack ?? err).split('\n').slice(0, 4).join('\n  ')}`);
    throw err;
  }
}

async function main() {
  const { models, state } = testModels();
  registerCaptionsIpc({ ipcMain, app, dialog, BrowserWindow, models });
  const lab = await openLab();
  const { dir, duration } = makeRecording();
  log(`# recording: ${dir} (${duration.toFixed(1)} s)`);
  const ed = await openEditor(dir);
  const segments = () => ed.js('window.__editor.store.project.captions.segments');

  try {
    await step('the Captions panel explains the one-time download before starting', async () => {
      state.pretendFresh = true;
      await ed.clickOn('#tabs [data-panel="captions"]');
      await waitFor(() => ed.js('!document.getElementById("captionsDownloadNote").hidden'), 'the download note');
      const note = await ed.js('document.getElementById("captionsDownloadNote").textContent');
      assert.match(note, /first time.*\(\d+ MB\).*only happens once/i);
      assert.strictEqual(await ed.js('document.getElementById("captionsGenerate").disabled'), false);
      await ed.shot('captions-01-start');
    });

    await step('the download shows its progress and can be cancelled', async () => {
      await ed.js(`(() => { const s = document.getElementById('captionsLanguage'); s.value = 'en'; s.dispatchEvent(new Event('change')); })()`);
      await ed.clickOn('#captionsGenerate');
      await waitFor(() => ed.js('/of \\d+ MB/.test(document.getElementById("captionsStage").textContent)'), 'download progress');
      await sleep(600);
      assert.match(await ed.js('document.getElementById("captionsStage").textContent'), /Downloading the speech model/);
      await ed.shot('captions-02-downloading');
      // From here the model is what is really on disk.
      state.pretendFresh = false;
      await ed.clickOn('#captionsCancel');
      await waitFor(() => ed.js('!document.getElementById("captionsGenerate").closest(".cap-start").hidden'), 'the start view again');
      assert.strictEqual((await segments()).length, 0);
      assert.strictEqual(await ed.js('document.getElementById("captionsError").closest(".cap-error").hidden'), true, 'a cancel is not an error');
    });

    let first;
    await step('Generate captions writes captions from the speech', async () => {
      // The panel asks again which models are on disk once a job ends.
      await waitFor(() => ed.js('document.getElementById("captionsDownloadNote").hidden'), 'the real model state', 20000);
      await ed.clickOn('#captionsGenerate');
      await waitFor(() => ed.js('!document.querySelector(".cap-work").hidden'), 'the progress view');
      await ed.shot('captions-03-writing');
      await waitFor(async () => (await segments()).length > 0 || ed.js('!document.querySelector(".cap-error").hidden'), 'captions', 180000);
      assert.strictEqual(await ed.js('document.querySelector(".cap-error").hidden'), true, await ed.js('document.getElementById("captionsError").textContent'));
      const segs = await segments();
      const text = segs.map((s) => s.text).join(' ').toLowerCase();
      log(`# transcript: ${segs.map((s) => `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`).join(' | ')}`);
      for (const w of ['welcome', 'record', 'screen', 'team']) assert.ok(text.includes(w), `"${w}" in ${text}`);
      assert.ok(segs[0].start > LEAD_SILENCE - 0.7, `first caption starts with the speech (${segs[0].start})`);
      const p = await ed.project();
      assert.strictEqual(p.captions.show, true, 'captions are shown once written');
      assert.strictEqual(p.captions.language, 'en');
      assert.strictEqual(await ed.js('document.querySelectorAll("#captionsList .cap-row").length'), segs.length);
      assert.strictEqual(await ed.js('document.querySelectorAll(".tl-captions .caption").length'), segs.length);
      first = segs[0];
      await ed.js(`window.__editor.player.seek(${first.start + 0.3})`);
      await ed.shot('captions-04-transcript');
    });

    await step('clicking a caption\'s time jumps there', async () => {
      await ed.js('window.__editor.player.seek(0)');
      const second = (await segments())[1] ?? first;
      await ed.clickOn(`#captionsList .cap-row[data-id="${second.id}"] .cap-time`);
      const t = await ed.js('window.__editor.player.time');
      assert.ok(Math.abs(t - second.start) < 0.05, `playhead ${t}, caption at ${second.start}`);
    });

    await step('fixing a caption\'s words in the transcript', async () => {
      await ed.clickOn(`#captionsList .cap-row[data-id="${first.id}"] .cap-text`);
      // Select the words (the test window has no Edit menu for ⌘A), then type over them.
      await ed.js('document.activeElement.select()');
      ed.win.webContents.insertText(EDITED);
      await sleep(100);
      await ed.key('Return');
      const seg = (await segments()).find((s) => s.id === first.id);
      assert.strictEqual(seg.text, EDITED);
      await ed.settle();
      assert.strictEqual(readProject(dir).captions.segments.find((s) => s.id === first.id).text, EDITED, 'saved to project.json');
      first = seg;
    });

    await step('dragging a caption\'s end on the timeline changes when it hides', async () => {
      const segs = await segments();
      const next = segs.find((s) => s.start >= first.end);
      const handle = await ed.box(`.tl-captions .caption[data-id="${first.id}"] .handle.end`);
      const y = Math.round(handle.y + handle.h / 2);
      const x0 = Math.round(handle.x + handle.w / 2);
      const pps = await ed.js('window.__editor.timeline.pxPerSecond');
      // Pull it 0.6 s earlier: a real change, and never into the next caption.
      await ed.drag(x0, y, Math.round(x0 - 0.6 * pps), y);
      const moved = (await segments()).find((s) => s.id === first.id);
      assert.ok(Math.abs(moved.end - (first.end - 0.6)) < 0.12, `end ${moved.end}, was ${first.end}`);
      assert.strictEqual(moved.start, first.start);
      assert.strictEqual(await ed.js('window.__editor.store.selection?.id'), first.id, 'the dragged caption is selected');
      // Past the next caption it stops there.
      if (next) {
        const h2 = await ed.box(`.tl-captions .caption[data-id="${first.id}"] .handle.end`);
        await ed.drag(Math.round(h2.x + h2.w / 2), y, Math.round(h2.x + (next.end - first.end + 1) * pps), y);
        const capped = (await segments()).find((s) => s.id === first.id);
        assert.ok(capped.end <= next.start + 1e-6, `end ${capped.end} stops at the next caption (${next.start})`);
      }
      await ed.shot('captions-05-timeline-drag');
      first = (await segments()).find((s) => s.id === first.id);
    });

    await step('joining two captions, and undo', async () => {
      const before = await segments();
      if (before.length < 2) return;
      await ed.clickOn(`#captionsList .cap-row[data-id="${first.id}"] .cap-time`);
      await ed.clickOn(`#captionsList .cap-row[data-id="${first.id}"] [aria-label="Join with the next caption"]`);
      assert.strictEqual((await segments()).length, before.length - 1);
      await ed.js('document.activeElement?.blur()');
      await ed.key('Z', [MOD]);
      assert.deepStrictEqual((await segments()).map((s) => s.text), before.map((s) => s.text));
    });

    await step('the look: size, position and background box', async () => {
      await ed.clickOn('#captionsPosition .seg-btn[data-value="top"]');
      assert.strictEqual((await ed.project()).captions.style.position, 'top');
      await ed.js(`window.__editor.player.seek(${first.start + 0.3})`);
      await ed.shot('captions-06-top');
      await ed.clickOn('#captionsPosition .seg-btn[data-value="bottom"]');
      await ed.clickOn('#captionsBox');
      assert.strictEqual((await ed.project()).captions.style.box, false);
      await ed.shot('captions-07-no-box');
      await ed.key('Z', [MOD]);
      assert.strictEqual((await ed.project()).captions.style.box, true);
      assert.strictEqual((await ed.project()).captions.style.position, 'bottom');
    });

    let exported;
    await step('export with captions burned in and a .srt beside it', async () => {
      await ed.clickOn('#exportBtn');
      await waitFor(() => ed.js('window.__editor.exportDialog.isOpen'), 'the export dialog');
      assert.strictEqual(await ed.js('document.getElementById("exportBurnCaptions").checked'), true, 'burn follows "Show captions"');
      assert.strictEqual(await ed.js('document.getElementById("exportSubtitles").checked'), false);
      // A GIF can burn captions in, but has no use for a .srt.
      await ed.clickOn('#exportFormat .seg-btn[data-value="gif"]');
      assert.strictEqual(await ed.js('!!document.getElementById("exportBurnCaptions")'), true);
      assert.strictEqual(await ed.js('!!document.getElementById("exportSubtitles")'), false, 'no .srt choice for a GIF');
      await ed.clickOn('#exportFormat .seg-btn[data-value="mp4"]');
      await ed.clickOn('#exportResolution .seg-btn[data-value="720p"]');
      await ed.clickOn('label:has(#exportSubtitles)');
      assert.strictEqual(await ed.js('document.getElementById("exportSubtitles").checked'), true);
      await ed.shot('captions-08-export-settings');
      await ed.clickOn('#exportStart');
      await waitFor(() => ed.js('window.__editor.exportDialog.state !== "running"'), 'the export', 120000);
      assert.strictEqual(await ed.js('window.__editor.exportDialog.state'), 'done', await ed.js('document.getElementById("exportError")?.textContent ?? ""'));
      exported = await ed.js('document.querySelector(".export-dialog").dataset.file');
      assert.match(await ed.js('document.getElementById("exportSubtitlesNote").textContent'), /Subtitles saved as .+\.srt$/);
      await ed.shot('captions-09-export-done');
      await ed.clickOn('.export-dialog .btn.primary');
    });

    await step('the .srt has the edited words at the caption\'s time', async () => {
      const srt = fs.readFileSync(exported.replace(/\.mp4$/, '.srt'), 'utf8');
      const cues = srt.trim().split(/\n\n/).map((block) => {
        const [n, times, ...lines] = block.split('\n');
        const [a, b] = times.split(' --> ').map((s) => {
          const [hh, mm, rest] = s.split(':');
          return Number(hh) * 3600 + Number(mm) * 60 + Number(rest.replace(',', '.'));
        });
        return { n: Number(n), start: a, end: b, text: lines.join(' ') };
      });
      const segs = await segments();
      assert.strictEqual(cues.length, segs.length);
      assert.deepStrictEqual(cues.map((c) => c.n), cues.map((_, i) => i + 1));
      const cue = cues.find((c) => c.text === EDITED);
      assert.ok(cue, `edited caption in:\n${srt}`);
      assert.ok(Math.abs(cue.start - first.start) < 0.01 && Math.abs(cue.end - first.end) < 0.01,
        `cue ${cue.start}-${cue.end}, caption ${first.start}-${first.end}`);
    });

    await step('the exported picture has the caption while it is on screen, and not before', async () => {
      const mid = (first.start + first.end) / 2;
      const url = pathToFileURL(exported).href;
      const info = await lab.call('inspect', url, {
        snapshots: [{ t: mid, name: 'captions-burned.png' }, { t: 0.5, name: 'captions-before.png' }]
      });
      assert.strictEqual(info.height, 720);
      const burned = captionPixels(path.join(OUT, 'captions-burned.png'));
      const before = captionPixels(path.join(OUT, 'captions-before.png'));
      log(`# caption area: burned ${JSON.stringify(burned)}, before ${JSON.stringify(before)}`);
      assert.ok(burned.dark > 0.05, 'a dark caption box');
      assert.ok(burned.light > 0.005, 'light words on it');
      assert.ok(before.dark < 0.001 && before.light < 0.001, 'nothing there before the speech');
    });
  } finally {
    if (ed.errors.length) log(`# console errors: ${ed.errors.join(' | ')}`);
    ed.close();
    lab.win.destroy();
  }
  const failed = results.filter((r) => !r.ok).length;
  log(`\n${results.length - failed}/${results.length} passed`);
  return failed ? 1 : 0;
}

app.whenReady().then(main).then(
  (code) => app.exit(code),
  (err) => { log(`not ok - ${err.stack ?? err}`); app.exit(1); }
);
