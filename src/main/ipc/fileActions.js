'use strict';
/**
 * IPC for what the export dialog offers once a file exists: copy the file to
 * the clipboard, drag it out of the window, show it in Finder/Explorer, and
 * copy text (a share link). Registered once from main.js with
 * registerFileActionsIpc(ipcMain).
 *
 * Renderer API (preload.js, window.loupe):
 *
 *   copyFile(filePath) -> Promise<{ok: true} | {ok: false, code, message}>
 *     Puts the file itself on the clipboard, so pasting into Finder,
 *     Explorer, Slack, Mail or Messages pastes the video.
 *
 *   prepareFileDrag(filePath) -> Promise<{ok}>
 *     Optional: loads the file's system icon ahead of time so the drag
 *     image is the real file icon. Call it when the export finishes.
 *
 *   startFileDrag(filePath)   (fire and forget)
 *     Call from the draggable element's `dragstart` handler, after
 *     event.preventDefault(). The OS then carries the file wherever it is
 *     dropped.
 *
 *   revealFile(filePath) -> Promise<{ok}>
 *   copyText(text) -> Promise<{ok}>
 *
 * How files reach the clipboard (Electron 44 has no file clipboard API and
 * its clipboard is the async ClipboardItem one):
 *   macOS    a raw `public.file-url` item. AppKit derives the legacy
 *            NSFilenamesPboardType and NSURL forms from it, which is what
 *            Finder and other apps read (verified by reading it back through
 *            NSPasteboard, test/e2e/file-actions.e2e.js).
 *   Windows  Windows PowerShell's `Set-Clipboard -LiteralPath`, which writes
 *            a CF_HDROP file drop list like Explorer's own Copy. The path
 *            travels in an environment variable, never in the command text,
 *            so no file name can be interpreted as a command. If PowerShell
 *            is unavailable, a raw "FileNameW" item (UTF-16 path) is written,
 *            which Explorer also accepts for a single file.
 */
const { execFile: nodeExecFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { Blob } = require('node:buffer');
const { checkExportedFile, FileCheckError } = require('../exported-file');

const rawFormat = (format) => `electron application/osclipboard;format="${format}"`;
const MAX_TEXT = 8192;

function createFileActions({
  clipboard, ClipboardItem, shell, app, nativeImage,
  platform = process.platform, execFile = nodeExecFile, checkFile = checkExportedFile
}) {
  const icons = new Map();

  function check(filePath) {
    try {
      return { file: checkFile(filePath) };
    } catch (err) {
      if (err instanceof FileCheckError) return { error: { ok: false, code: err.code, message: err.message } };
      throw err;
    }
  }

  function powershellCopy(filePath) {
    return new Promise((resolve, reject) => {
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          'Set-Clipboard -LiteralPath $env:LOUPE_CLIPBOARD_FILE'],
        { env: { ...process.env, LOUPE_CLIPBOARD_FILE: filePath }, windowsHide: true, timeout: 15_000 },
        (err) => (err ? reject(err) : resolve()));
    });
  }

  async function copyFile(filePath) {
    const { file, error } = check(filePath);
    if (error) return error;
    try {
      if (platform === 'darwin') {
        await clipboard.write([new ClipboardItem({ [rawFormat('public.file-url')]: pathToFileURL(file.path).href })]);
      } else if (platform === 'win32') {
        try {
          await powershellCopy(file.path);
        } catch (err) {
          console.warn('Loupe: PowerShell clipboard copy failed, using FileNameW:', err.message);
          const utf16 = Buffer.from(`${file.path}\0`, 'utf16le');
          await clipboard.write([new ClipboardItem({ [rawFormat('FileNameW')]: new Blob([utf16]) })]);
        }
      } else {
        // Linux file managers read a uri-list.
        await clipboard.write([new ClipboardItem({ 'text/uri-list': `${pathToFileURL(file.path).href}\r\n` })]);
      }
      return { ok: true };
    } catch (err) {
      console.error('Loupe: copying the file to the clipboard failed:', err);
      return { ok: false, code: 'failed', message: 'The file couldn’t be copied. Please try again.' };
    }
  }

  async function prepareDrag(filePath) {
    const { file, error } = check(filePath);
    if (error) return error;
    try {
      const icon = await app.getFileIcon(file.path, { size: 'normal' });
      if (!icon.isEmpty()) icons.set(file.path, icon);
    } catch {
      // The fallback icon still works.
    }
    return { ok: true };
  }

  // A plain rounded square in Loupe blue, drawn once: macOS refuses a drag
  // without an image, and this avoids shipping an image file just for it.
  let fallback = null;
  function fallbackIcon() {
    if (fallback) return fallback;
    const size = 32;
    const r = 7;
    const bitmap = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = Math.max(r - x, 0, x - (size - 1 - r));
        const dy = Math.max(r - y, 0, y - (size - 1 - r));
        if (dx * dx + dy * dy > r * r) continue;
        const i = (y * size + x) * 4;
        // BGRA, #8ab4f8
        bitmap[i] = 0xf8; bitmap[i + 1] = 0xb4; bitmap[i + 2] = 0x8a; bitmap[i + 3] = 0xff;
      }
    }
    fallback = nativeImage.createFromBitmap(bitmap, { width: size, height: size });
    return fallback;
  }

  // startDrag has to run while the renderer's drag gesture is live, so this
  // is synchronous: the icon comes from prepareDrag's cache or the fallback.
  function startDrag(sender, filePath) {
    const { file, error } = check(filePath);
    if (error) return error;
    sender.startDrag({ file: file.path, icon: icons.get(file.path) ?? fallbackIcon() });
    return { ok: true };
  }

  function reveal(filePath) {
    const { file, error } = check(filePath);
    if (error) return error;
    shell.showItemInFolder(file.path);
    return { ok: true };
  }

  async function copyText(text) {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT) {
      return { ok: false, code: 'invalid', message: 'Nothing to copy.' };
    }
    await clipboard.writeText(text);
    return { ok: true };
  }

  return { copyFile, prepareDrag, startDrag, reveal, copyText };
}

function registerFileActionsIpc(ipcMain, deps) {
  const actions = createFileActions(deps ?? (() => {
    const { clipboard, ClipboardItem, shell, app, nativeImage } = require('electron');
    return { clipboard, ClipboardItem, shell, app, nativeImage };
  })());

  ipcMain.handle('file:copy', (_e, filePath) => actions.copyFile(filePath));
  ipcMain.handle('file:prepareDrag', (_e, filePath) => actions.prepareDrag(filePath));
  // The renderer fires this from dragstart without waiting for the answer;
  // startDrag uses the sender that started the gesture.
  ipcMain.handle('file:startDrag', (event, filePath) => {
    try {
      return actions.startDrag(event.sender, filePath);
    } catch (err) {
      console.error('Loupe: starting a file drag failed:', err);
      return { ok: false, code: 'failed', message: 'The file couldn’t be dragged.' };
    }
  });
  ipcMain.handle('file:reveal', (_e, filePath) => actions.reveal(filePath));
  ipcMain.handle('clipboard:writeText', (_e, text) => actions.copyText(text));

  return actions;
}

module.exports = { registerFileActionsIpc, createFileActions, rawFormat };
