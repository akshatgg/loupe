// The editor's keyboard shortcuts: which key does what, and the list the "?"
// cheat sheet shows. Pure so it can be tested without a window
// (test/editor-shortcuts.test.mjs).
//
// macOS uses ⌘ where Windows uses Ctrl; redo is ⇧⌘Z on a Mac and Ctrl+Y
// (or Ctrl+Shift+Z) on Windows.

// commandFor(keyboard event fields, platform) -> command name or null.
export function commandFor(e, platform) {
  const mac = platform === 'darwin';
  const mod = mac ? e.metaKey : e.ctrlKey;
  // The other platform's modifier is never a shortcut here (Ctrl+click
  // habits on a Mac, the Windows key on Windows).
  const otherMod = mac ? e.ctrlKey : e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (otherMod || e.altKey) return null;

  if (mod) {
    if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (key === 'y' && !mac) return 'redo';
    if (key === 'e') return 'export';
    if (key === '=' || key === '+') return 'timelineZoomIn';
    if (key === '-' || key === '_') return 'timelineZoomOut';
    if (key === '0') return 'timelineFit';
    return null;
  }

  switch (key) {
    case ' ': return 'playPause';
    case 'ArrowLeft': return e.shiftKey ? 'back1s' : 'backFrame';
    case 'ArrowRight': return e.shiftKey ? 'forward1s' : 'forwardFrame';
    case 'Home': return 'toStart';
    case 'End': return 'toEnd';
    case 's': return e.shiftKey ? null : 'split';
    case 'z': return e.shiftKey ? null : 'addZoom';
    case 'Delete':
    case 'Backspace': return 'delete';
    case '?': return 'cheatSheet';
    case '/': return e.shiftKey ? 'cheatSheet' : null;
    case 'Escape': return 'escape';
    default: return null;
  }
}

// [{ keys: [...labels], what }] for the cheat sheet, in the platform's words.
export function cheatSheet(platform) {
  const mac = platform === 'darwin';
  const mod = mac ? '⌘' : 'Ctrl';
  const plus = (...k) => (mac ? k.join('') : k.join('+'));
  return [
    { group: 'Playback', items: [
      { keys: ['Space'], what: 'Play or pause' },
      { keys: ['←', '→'], what: 'Step one frame' },
      { keys: [plus(mac ? '⇧' : 'Shift', '←'), plus(mac ? '⇧' : 'Shift', '→')], what: 'Jump one second' },
      { keys: ['Home', 'End'], what: 'Go to the start or end' }
    ] },
    { group: 'Editing', items: [
      { keys: ['S'], what: 'Split the clip at the playhead' },
      { keys: ['Z'], what: 'Add a zoom at the playhead' },
      { keys: [mac ? '⌫' : 'Delete'], what: 'Delete what’s selected' },
      { keys: [plus(mod, 'Z')], what: 'Undo' },
      { keys: [mac ? '⇧⌘Z' : 'Ctrl+Y'], what: 'Redo' }
    ] },
    { group: 'Timeline', items: [
      { keys: [plus(mod, '='), plus(mod, '−')], what: 'Zoom the timeline in or out' },
      { keys: [plus(mod, '0')], what: 'Fit the whole video' }
    ] },
    { group: 'Other', items: [
      { keys: [plus(mod, 'E')], what: 'Export' },
      { keys: ['?'], what: 'Show these shortcuts' }
    ] }
  ];
}
