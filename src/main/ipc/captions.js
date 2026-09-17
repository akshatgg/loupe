'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSpeechModels } = require('../speech-models');

// IPC for captions (window.loupe.captions in the preload):
//
//   captions:models           -> [{ key, label, description, bytes, downloaded, downloading }]
//   captions:model-ensure key -> { key, id, dtype, baseUrl }  (downloads first if needed,
//                                 pushing captions:model-progress { key, received, total, file })
//   captions:model-cancel key -> boolean (was a download running)
//   captions:model-remove key -> model info after deleting its files
//   captions:save-subtitles { format: "srt"|"vtt", text, name } -> { saved, path? }
//
// Transcription itself runs in the renderer (src/renderer/captions/); main
// only owns the disk: model files and the subtitle file the user saves.

const MAX_SUBTITLE_CHARS = 20 * 1024 * 1024;

// The project's captions as a .srt beside an exported video ("demo.mp4" ->
// "demo.srt"), timed to that video: cuts, reordering and speed changes are
// already applied. Written from the project main loaded, never from text the
// page sends. Returns the file's path, or null when there are no captions.
async function writeSubtitlesBeside(videoFile, project) {
  const { buildTimeline } = require('../../core/timeline.js');
  const { captionsToOutput, toSRT } = require('../../core/captions/index.js');
  const cues = captionsToOutput(project.captions?.segments ?? [], buildTimeline(project));
  if (!cues.length) return null;
  const file = path.join(path.dirname(videoFile), `${path.basename(videoFile, path.extname(videoFile))}.srt`);
  // Temporary name first, so a half-written file never replaces an older one.
  const part = `${file}.part`;
  await fs.promises.writeFile(part, toSRT(cues), 'utf8');
  await fs.promises.rename(part, file);
  return file;
}

function validateSubtitlePayload(raw) {
  const { format, text, name } = raw ?? {};
  if (format !== 'srt' && format !== 'vtt') throw new Error(`Unknown subtitle format: ${JSON.stringify(format)}`);
  if (typeof text !== 'string' || text.length > MAX_SUBTITLE_CHARS) throw new Error('Invalid subtitle text');
  // Only a file NAME is taken from the renderer, never a directory: the user
  // picks where it goes in the save dialog.
  let base = typeof name === 'string' ? path.basename(name).replace(/\.(srt|vtt)$/i, '') : '';
  base = base.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 120);
  return { format, text, name: base || 'Captions' };
}

function registerCaptionsIpc({ ipcMain, app, dialog, BrowserWindow, getDefaultDir = () => null, models }) {
  const speech = models ?? createSpeechModels({ root: () => path.join(app.getPath('userData'), 'speech-models') });

  ipcMain.handle('captions:models', () => speech.list());

  ipcMain.handle('captions:model-ensure', (event, key) => {
    const sender = event.sender;
    return speech.ensure(key, (progress) => {
      if (!sender.isDestroyed()) sender.send('captions:model-progress', progress);
    });
  });

  ipcMain.handle('captions:model-cancel', (_e, key) => speech.cancel(key));
  ipcMain.handle('captions:model-remove', (_e, key) => speech.remove(key));

  ipcMain.handle('captions:save-subtitles', async (event, raw) => {
    const { format, text, name } = validateSubtitlePayload(raw);
    const win = BrowserWindow.fromWebContents(event.sender);
    const dir = getDefaultDir() || app.getPath('documents');
    const opts = {
      title: 'Save captions',
      defaultPath: path.join(dir, `${name}.${format}`),
      filters: [format === 'srt'
        ? { name: 'SubRip subtitles', extensions: ['srt'] }
        : { name: 'WebVTT subtitles', extensions: ['vtt'] }]
    };
    const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (result.canceled || !result.filePath) return { saved: false };
    await fs.promises.writeFile(result.filePath, text, 'utf8');
    return { saved: true, path: result.filePath };
  });

  return speech;
}

module.exports = { registerCaptionsIpc, validateSubtitlePayload, writeSubtitlesBeside };
