// The right side's panels (inspector.js shows one at a time). Each is one
// module whose default export is
//
//   { id, title, icon, mount(container, editor) -> { update(what) } }
//
// `editor` is { store, player, core, platform, select, showPanel, toast }
// (see editor.js); update() runs after every change to the project or the
// selection.
//
// VIDEO_TABS are the video's own settings, on tabs when nothing is selected.
// The rest show for a selected thing: a zoom, a clip or overlay, a text or
// shape, or several things at once.

import style from './style.js';
import cursor from './cursor.js';
import clip from './clip.js';
import zoom from './zoom.js';
import audio from './audio.js';
import captions from './captions.js';
import annotations from './annotations.js';
import webcam from './webcam.js';
import multi from './multi.js';

export const VIDEO_TABS = [style, cursor, webcam, captions, audio];
export const PANELS = [...VIDEO_TABS, clip, zoom, annotations, multi];

export function panelById(id) {
  return PANELS.find((p) => p.id === id) ?? null;
}
