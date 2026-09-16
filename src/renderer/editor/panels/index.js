// The sidebar's panels, in tab order. Each panel is one module whose default
// export is
//
//   { id, title, icon, mount(container, editor) -> { update(what) } }
//
// `editor` is { store, player, core, platform, select, showPanel, toast }
// (see editor.js); update() runs after every change to the project or the
// selection. A feature adds its panel by replacing its placeholder module
// (audio.js, captions.js, annotations.js) -- this list stays as it is.

import style from './style.js';
import zoom from './zoom.js';
import audio from './audio.js';
import captions from './captions.js';
import annotations from './annotations.js';

export const PANELS = [style, zoom, audio, captions, annotations];

export function panelById(id) {
  return PANELS.find((p) => p.id === id) ?? null;
}
