'use strict';
// End-to-end tests of the editor window (docs/EDITOR-V2.md section 10). Run with
//
//   npm run test:e2e:editor                      the suite (editor-cases.js)
//   electron test/e2e/editor.js --real <folder>  open a copy of a real recording
//                                                and save screenshots
//
// The harness (editor-harness.js) opens the real editor page with the app's
// real preload and registers project:load/save and export:start as main.js
// does. Screenshots go to test/e2e/out/editor/ to look at.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { openEditor, waitFor, log, argValue, OUT } = require('./editor-harness');

// ------------------------------------------------------------- real recordings

async function openReal(source) {
  const name = path.basename(source);
  const dir = path.join(OUT, 'real', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // A copy: the recording itself is never touched.
  for (const f of fs.readdirSync(source)) {
    if (/^(raw\.(mov|mp4)|cursor\.bin|project\.json|system\.m4a|keys\.json)$/.test(f)) {
      fs.copyFileSync(path.join(source, f), path.join(dir, f));
    }
  }
  const ed = await openEditor(dir);
  await waitFor(() => ed.js('Object.values(window.__editor.player.videos).every((v) => v.readyState >= 2)'), 'the video');
  await ed.js('window.__editor.player.seek(window.__editor.store.tl.duration * 0.3)');
  log(`# ${name}: ${await ed.shot(`real-${name}`)}`);
  const zooms = await ed.js('window.__editor.store.project.zooms.length');
  if (zooms) {
    await ed.js(`(() => { const z = window.__editor.store.project.zooms[0];
      window.__editor.editor.select({ kind: 'zoom', id: z.id }, { seek: true });
      window.__editor.player.seek(window.__editor.store.tl.toOutput(z.source, Math.min(z.end, z.start + 0.8))); })()`);
    log(`# zoom selected: ${await ed.shot(`real-${name}-zoom`)}`);
  }
  if (ed.errors.length) log(`# console errors: ${ed.errors.join(' | ')}`);
  ed.close();
}

async function main() {
  const real = argValue('--real');
  if (real) {
    await openReal(path.resolve(real));
    return 0;
  }
  const { runSuite } = require('./editor-cases');
  return runSuite();
}

app.whenReady().then(main).then(
  (code) => app.exit(code),
  (err) => { log(`not ok - ${err.stack ?? err}`); app.exit(1); }
);
