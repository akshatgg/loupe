'use strict';

const {
  listPresets, savePreset, renamePreset, deletePreset, setDefaultPreset, presetStyle
} = require('../presets');

// Style presets over IPC, for the editor's Style panel (window.loupe.presets
// in preload.js):
//
//   presets:list                     -> { presets: [{id, name, style}], defaultPresetId }
//   presets:save   {name, style}     -> the new preset (a repeated name gets " 2")
//   presets:save   {id, style, name?} -> the updated preset (overwrite its style)
//   presets:rename {id, name}        -> the renamed preset
//   presets:delete id                -> true if it existed (clears the default if it was it)
//   presets:setDefault id | null     -> the new default id (null = none)
//   presets:apply  id                -> a copy of the preset's style, for the
//                                       editor to apply with setStyle(style)
//                                       as one undo step
//
// Styles are cleaned to the known project.style keys and plain JSON
// (settings.js cleanStyle). Every change is stored in settings.json and also
// reaches open windows as 'settings:changed'.
function registerPresetsIpc({ ipcMain, store }) {
  const run = (op) => (_e, arg) => {
    const { patch, result } = op(store.get(), arg);
    store.patch(patch, { trusted: true });
    return result;
  };

  ipcMain.handle('presets:list', () => listPresets(store.get()));
  ipcMain.handle('presets:save', run(savePreset));
  ipcMain.handle('presets:rename', run(renamePreset));
  ipcMain.handle('presets:delete', run(deletePreset));
  ipcMain.handle('presets:setDefault', run(setDefaultPreset));
  ipcMain.handle('presets:apply', (_e, id) => presetStyle(store.get(), id));
}

module.exports = { registerPresetsIpc };
