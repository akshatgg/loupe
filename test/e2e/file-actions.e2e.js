'use strict';
/**
 * Real-clipboard check for "Copy" after export (macOS).
 *
 *   node_modules/.bin/electron test/e2e/file-actions.e2e.js
 *
 * Opens a hidden window with the app's real preload, calls
 * window.loupe.copyFile(...) through IPC, then reads the system clipboard
 * back the way other apps do: through AppleScript's «class furl» (what
 * Finder pastes) and Electron's list of native pasteboard types. Also checks
 * the drag icon sources (system file icon, drawn fallback) are non-empty,
 * since macOS refuses a drag with an empty image. Exits non-zero on failure.
 * The clipboard's previous text is put back afterwards.
 */
const { app, BrowserWindow, ipcMain, clipboard, nativeImage } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerFileActionsIpc } = require('../../src/main/ipc/fileActions');

function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

app.whenReady().then(async () => {
  if (process.platform !== 'darwin') {
    console.log('skip: macOS only');
    return app.quit();
  }
  const previousText = await clipboard.readText().catch(() => '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-copy-'));
  const file = path.join(dir, 'Loupe export (1).mp4');
  fs.writeFileSync(file, Buffer.alloc(4096, 7));

  try {
    const actions = registerFileActionsIpc(ipcMain);
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(__dirname, '..', '..', 'src', 'preload', 'preload.js') }
    });
    await win.loadURL('data:text/html,<title>e2e</title>');

    const result = await win.webContents.executeJavaScript(`window.loupe.copyFile(${JSON.stringify(file)})`);
    check('copyFile through preload + IPC', result?.ok === true, JSON.stringify(result));

    const furl = execFileSync('osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)']).toString().trim();
    check('Finder-style file reference on the clipboard', furl === file, furl);

    const types = (await clipboard.read()).flatMap((item) => item.types);
    check('legacy NSFilenamesPboardType is available',
      types.includes('electron application/osclipboard;format="NSFilenamesPboardType"'), types.join(', '));

    const refused = await win.webContents.executeJavaScript('window.loupe.copyFile("/etc/passwd")');
    check('non-export files are refused', refused?.ok === false && refused.code === 'unsupported', JSON.stringify(refused));

    const prepared = await win.webContents.executeJavaScript(`window.loupe.prepareFileDrag(${JSON.stringify(file)})`);
    check('prepareFileDrag', prepared?.ok === true);
    const icon = await app.getFileIcon(file, { size: 'normal' });
    check('system file icon is not empty', !icon.isEmpty(), JSON.stringify(icon.getSize()));

    // The drawn fallback, built the same way fileActions.js builds it.
    const bitmap = Buffer.alloc(32 * 32 * 4, 0xff);
    check('bitmap fallback icon is not empty', !nativeImage.createFromBitmap(bitmap, { width: 32, height: 32 }).isEmpty());
    check('actions exported', typeof actions.startDrag === 'function');

    const link = 'https://loupeapp.vercel.app/v/AAAAAAAAAAAAAAAA';
    await win.webContents.executeJavaScript(`window.loupe.copyText(${JSON.stringify(link)})`);
    check('copyText puts the link on the clipboard', (await clipboard.readText()) === link);
    win.destroy();
  } catch (err) {
    check('no exceptions', false, err.stack);
  } finally {
    await clipboard.writeText(previousText || '').catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    app.quit();
  }
});
