// Fills the static buttons in index.html with their icons and labels, so the
// page reads right before the project has loaded.

import { icon } from './ui.js';

const fill = (id, name, label, size = 18) => {
  const el = document.getElementById(id);
  el.replaceChildren(icon(name, { size }));
  if (label) el.append(label);
};

fill('undo', 'undo');
fill('redo', 'redo');
fill('shortcutsBtn', 'keyboard', null, 20);
fill('play', 'play', null, 20);
fill('splitBtn', 'split', 'Split');
fill('zoomBtn', 'zoomAdd', 'Zoom');
fill('deleteBtn', 'trash', 'Delete');
fill('addRecBtn', 'plus', 'Add recording');
fill('tlOut', 'minus', null, 16);
fill('tlFit', 'fit', null, 16);
fill('tlIn', 'plus', null, 16);
document.getElementById('tlOut').title = 'Zoom the timeline out';
document.getElementById('tlFit').title = 'Fit the whole video';
document.getElementById('tlIn').title = 'Zoom the timeline in';
