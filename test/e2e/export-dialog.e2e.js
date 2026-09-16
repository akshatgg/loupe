'use strict';
// The editor's export dialog end to end (docs/EDITOR-V2.md section 6):
//
//   electron test/e2e/export-dialog.e2e.js       (npm run test:e2e:export runs it too)
//
// Opens the real editor on a fixture recording with project, export, file
// action and share IPC registered as main.js does (share against the local
// mock of the website and Blob API). Clicks through: Settings export defaults
// on a fresh project, a GIF export, dragging the file out, Copy (read back
// from the macOS clipboard as Finder would), Share link with progress and Copy
// link, Recent exports, and an MP4 fitted to a custom size limit. Screenshots
// go to test/e2e/out/editor/export-*.png.

const { app, ipcMain, clipboard, ClipboardItem, nativeImage, net } = require('electron');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startMockShareServer } = require('../fixtures/mock-share-server');
const { openEditor, openLab, makeFixture, freshRecording, readProject, waitFor, sleep, log } = require('./editor-harness');
const { createFileActions } = require('../../src/main/ipc/fileActions');
const { parseGif } = require('./media-parse.mjs');

const MOD = process.platform === 'darwin' ? 'meta' : 'control';

async function main() {
  const server = await startMockShareServer({ chunkDelayMs: 1 });
  process.env.LOUPE_SHARE_URL = server.siteUrl;
  process.env.LOUPE_BLOB_API_URL = server.blobApiUrl;
  require('../../src/main/ipc/share').registerShareIpc(ipcMain, { net });

  // File actions as registerFileActionsIpc wires them, with drags and
  // reveals recorded instead of handed to the OS.
  const dragged = [];
  const shown = [];
  const actions = createFileActions({ clipboard, ClipboardItem, app, nativeImage, shell: { showItemInFolder: (f) => shown.push(f) } });
  ipcMain.handle('file:copy', (_e, f) => actions.copyFile(f));
  ipcMain.handle('file:prepareDrag', (_e, f) => actions.prepareDrag(f));
  ipcMain.handle('file:startDrag', (_e, f) => { dragged.push(f); return { ok: true }; });
  ipcMain.handle('file:reveal', (_e, f) => actions.reveal(f));
  ipcMain.handle('clipboard:writeText', (_e, t) => actions.copyText(t));
  ipcMain.handle('settings:get', () => ({ exportDefaults: { format: 'gif', resolution: '720p', quality: 'high' } }));

  const lab = await openLab();
  const src = await makeFixture(lab);
  const dir = freshRecording(src, 'export-dialog');
  const ed = await openEditor(dir);
  const previousText = await clipboard.readText().catch(() => '');
  let failed = 0;
  const step = async (title, fn) => {
    try {
      await fn();
      log(`ok - ${title}`);
    } catch (err) {
      failed++;
      await ed.shot('export-fail').catch(() => {});
      log(`not ok - ${title}\n  ${String(err.stack ?? err).split('\n').slice(0, 5).join('\n  ')}`);
    }
  };
  const text = (sel) => ed.js(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);

  try {
    await waitFor(() => ed.js('Object.values(window.__editor.player.videos).every((v) => v.readyState >= 2)'), 'the video');

    await step('a fresh project opens with the Settings export defaults', async () => {
      await ed.key('e', [MOD]);
      await waitFor(() => ed.js('document.querySelector("#exportFormat .seg-btn[data-value=gif]")?.getAttribute("aria-pressed") === "true"'), 'the GIF default');
      assert.match(await text('#exportSummary'), /960 × 600·8 seconds·up to about/);
      assert.strictEqual(await ed.js('!!document.getElementById("exportGifWidth")'), true);
      await ed.shot('export-1-gif-settings');
    });

    let gifFile;
    await step('export a GIF, drag it out, copy it', async () => {
      await ed.clickOn('#exportGifWidth .seg-btn[data-value="480"]');
      assert.match(await text('#exportSummary'), /480 × 300/);
      await ed.clickOn('#exportStart');
      await waitFor(() => ed.js('window.__editor.exportDialog.state === "done"'), 'the GIF', 60000);
      gifFile = await ed.js('document.querySelector(".export-dialog").dataset.file');
      assert.strictEqual(gifFile, path.join(dir, 'export-480x300.gif'));
      const gif = parseGif(fs.readFileSync(gifFile));
      assert.strictEqual(gif.width, 480);
      assert.strictEqual(gif.frames.reduce((n, f) => n + f.delayCs, 0), 800);
      assert.strictEqual(readProject(dir).export.gifWidth, 480);
      assert.match(await text('#exportFile'), /export-480x300\.gif/);
      await waitFor(() => ed.js('!document.getElementById("exportShare").hidden'), 'the Share button');
      await ed.shot('export-2-gif-done');

      await ed.js('document.getElementById("exportDrag").dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }))');
      await waitFor(() => dragged.length === 1, 'the drag');
      assert.strictEqual(dragged[0], gifFile);

      await ed.clickOn('#exportCopy');
      await waitFor(async () => /Copied/.test(await text('#exportCopy')), 'Copied');
      if (process.platform === 'darwin') {
        const furl = execFileSync('osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)']).toString().trim();
        assert.strictEqual(furl, gifFile, 'Finder pastes the GIF');
      }
    });

    await step('Share link: progress, then a link to copy', async () => {
      await ed.clickOn('#exportShare');
      await waitFor(() => ed.js('!!document.getElementById("shareLink")'), 'the link', 30000);
      const url = await ed.js('document.getElementById("shareLink").value');
      assert.match(url, /\/v\/[A-Za-z0-9_-]+$/);
      assert.match(await text('#exportStatus'), /stops working after 7 days/);
      await ed.shot('export-3-shared');
      await ed.clickOn('#shareCopy');
      await waitFor(async () => (await clipboard.readText()) === url, 'the link on the clipboard');
      const uploaded = server.requests.filter((r) => r.path.startsWith('/blob'));
      assert.ok(uploaded.length > 0, 'the file went to the Blob API');
    });

    await step('Recent exports lists the GIF; an MP4 fitted to a custom limit', async () => {
      await ed.clickOn('#exportDone');
      await ed.key('e', [MOD]);
      await waitFor(() => ed.js('!!document.getElementById("exportRecent")'), 'recent exports');
      assert.match(await text('#exportRecent'), /export-480x300\.gif/);
      await ed.clickOn('#exportRecent .icon-btn[aria-label^="Show"]');
      assert.deepStrictEqual(shown.slice(-1), [gifFile]);

      await ed.clickOn('#exportFormat .seg-btn[data-value="mp4"]');
      await ed.clickOn('#exportResolution .seg-btn[data-value="720p"]');
      await ed.clickOn('#exportLimit');
      await waitFor(() => ed.js('!!document.getElementById("exportLimitChoice")'), 'the limit choices');
      assert.strictEqual((await ed.project()).export.sizeLimit, 25, "turning the limit on picks 25 MB");
      await ed.clickOn('#exportLimitChoice .seg-btn[data-value="custom"]');
      await ed.js('(() => { const i = document.getElementById("exportLimitCustom"); i.value = "0.5"; i.dispatchEvent(new Event("change")); })()');
      await sleep(100);
      // Below the smallest limit: put back.
      assert.strictEqual((await ed.project()).export.sizeLimit, 25);
      await ed.js('(() => { const i = document.getElementById("exportLimitCustom"); i.value = "3"; i.dispatchEvent(new Event("change")); })()');
      await waitFor(async () => (await ed.project()).export.sizeLimit === 3, 'the custom limit');
      assert.match(await text('#exportSummary'), /under 3 MB/);
      await ed.shot('export-4-size-limit');
      await ed.clickOn('#exportStart');
      await waitFor(() => ed.js('window.__editor.exportDialog.state === "done"'), 'the MP4', 60000);
      const file = await ed.js('document.querySelector(".export-dialog").dataset.file');
      assert.ok(file.endsWith('.mp4'));
      assert.ok(fs.statSync(file).size <= 3e6);
      await ed.settle();
      assert.strictEqual(readProject(dir).export.sizeLimit, 3);
      await ed.clickOn('#exportDone');
      await ed.key('e', [MOD]);
      await waitFor(async () => /export-1152x720\.mp4[\s\S]*export-480x300\.gif/.test(await text('#exportRecent') ?? ''), 'both in recent');
      await ed.shot('export-5-recent');
      await ed.key('Escape');
    });

    await step('a long GIF shows a warning', async () => {
      // Eight seconds slowed to a quarter speed is 32 seconds.
      await ed.js('window.__editor.store.apply((p) => ({ ...p, speed: [{ source: "main", start: 0, end: 8, rate: 0.25 }] }))');
      await ed.key('e', [MOD]);
      await ed.clickOn('#exportFormat .seg-btn[data-value="gif"]');
      await waitFor(() => ed.js('!!document.getElementById("exportWarning")'), 'the warning');
      assert.match(await text('#exportWarning'), /MP4/);
      await ed.shot('export-6-long-gif');
      await ed.key('Escape');
    });

    const errors = ed.errors.filter((e) => !/Electron Security Warning|willReadFrequently/.test(e));
    await step('no errors in the editor console', async () => assert.deepStrictEqual(errors, []));
  } finally {
    await clipboard.writeText(previousText || '').catch(() => {});
    ed.close();
    await server.close?.();
  }
  log(failed ? `# ${failed} failed` : '# all passed; screenshots in test/e2e/out/editor/export-*.png');
  return failed ? 1 : 0;
}

app.whenReady().then(main).then(
  (code) => app.exit(code),
  (err) => { log(`not ok - ${err.stack ?? err}`); app.exit(1); }
);
