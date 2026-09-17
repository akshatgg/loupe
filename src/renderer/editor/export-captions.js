// The captions part of the export dialog (export-dialog.js), shown only when
// the video has captions:
//
//   Burn captions into the video    starts as the Captions panel's "Show
//                                   captions on the video"
//   Also save subtitles (.srt)      a .srt beside the video, for players and
//                                   sites that show their own captions (not
//                                   for a GIF: nothing plays subtitles with one)
//
//   const cap = createExportCaptions({ store });
//   cap.fields()      -> the section to put in the dialog (null without captions)
//   cap.options()     -> { burnCaptions, subtitles } for loupe.exportVideo, or {}
//   cap.doneNote(result) -> a line for the finished dialog, or null

import { h, toggle } from './ui.js';

export function createExportCaptions({ store }) {
  // Remembered while the editor is open: someone who wants a .srt once
  // usually wants it every time.
  let subtitles = false;
  let burn = null; // null until changed here: follow the panel's switch

  const has = () => store.project.captions.segments.length > 0;
  const gif = () => store.project.export.format === 'gif';

  return {
    fields() {
      if (!has()) return null;
      const burnRow = toggle({
        label: 'Burn captions into the video', hint: 'Everyone sees them, in any player.',
        checked: burn ?? store.project.captions.show,
        onChange: (v) => { burn = v; }
      });
      burnRow.input.id = 'exportBurnCaptions';
      const srtRow = toggle({
        label: 'Also save subtitles (.srt)', hint: 'A file next to the video that players and video sites can show.',
        checked: subtitles,
        onChange: (v) => { subtitles = v; }
      });
      srtRow.input.id = 'exportSubtitles';
      return h('div', { class: 'export-captions' }, burnRow, gif() ? null : srtRow);
    },
    options() {
      if (!has()) return {};
      return { burnCaptions: burn ?? store.project.captions.show, subtitles: subtitles && !gif() };
    },
    doneNote(result) {
      if (result?.subtitlesError) return h('p', { class: 'hint export-subtitles-note', id: 'exportSubtitlesNote' }, result.subtitlesError);
      if (!result?.subtitles) return null;
      const name = String(result.subtitles).split(/[\\/]/).pop();
      return h('p', { class: 'hint export-subtitles-note', id: 'exportSubtitlesNote' }, `Subtitles saved as ${name}`);
    }
  };
}
