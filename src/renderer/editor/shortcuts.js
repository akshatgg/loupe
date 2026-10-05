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
  // ⌥X clears the In and Out marks. (On a Mac ⌥X types "≈": the key is read.)
  if (e.altKey && !mod && !otherMod && !e.shiftKey && (e.code === 'KeyX' || key === 'x')) return 'clearMarks';
  if (otherMod || e.altKey) return null;

  if (mod) {
    if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (key === 'y' && !mac) return 'redo';
    if (key === 'e') return 'export';
    if (key === 'a') return e.shiftKey ? null : 'selectAll';
    if (!e.shiftKey && key === 'c') return 'copy';
    if (!e.shiftKey && key === 'x') return 'cutSelection';
    if (!e.shiftKey && key === 'v') return 'paste';
    if (!e.shiftKey && key === 'd') return 'duplicate';
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
    case 'x': return e.shiftKey ? null : 'cut';
    case 'i': return e.shiftKey ? null : 'markIn';
    case 'o': return e.shiftKey ? null : 'markOut';
    case 'j': return e.shiftKey ? null : 'shuttleBack';
    case 'k': return e.shiftKey ? null : 'shuttleStop';
    case 'l': return e.shiftKey ? null : 'shuttleForward';
    case 'm': return e.shiftKey ? 'nextMarker' : 'addMarker';
    case 'f': return e.shiftKey ? 'freezeFrame' : null;
    case 'z': return e.shiftKey ? null : 'addZoom';
    case 't': return e.shiftKey ? null : 'addText';
    case 'b': return e.shiftKey ? null : 'addBlur';
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
      { keys: ['Home', 'End'], what: 'Go to the start or end' },
      { keys: ['J', 'K', 'L'], what: 'Play backward, stop, play forward (press J or L again to go faster)' }
    ] },
    { group: 'Editing', items: [
      { keys: ['S'], what: 'Split the clip at the playhead' },
      { keys: ['X'], what: 'Cut by typing times' },
      { keys: ['I', 'O'], what: 'Mark the In and Out of a part, then Delete removes it' },
      { keys: [mac ? '⌥X' : 'Alt+X'], what: 'Clear the In and Out marks' },
      { keys: ['M'], what: 'Add a marker at the playhead' },
      { keys: [plus(mac ? '⇧' : 'Shift', 'F')], what: 'Freeze the frame at the playhead for 2 seconds' },
      { keys: [plus(mac ? '⇧' : 'Shift', 'M')], what: 'Go to the next marker' },
      { keys: ['Z'], what: 'Add a zoom at the playhead' },
      { keys: ['T'], what: 'Add text at the playhead' },
      { keys: ['B'], what: 'Add a blur at the playhead' },
      { keys: [plus(mod, 'A')], what: 'Select everything on the timeline' },
      { keys: [plus(mod, 'C'), plus(mod, 'X'), plus(mod, 'V')], what: 'Copy, cut, and paste at the playhead' },
      { keys: [plus(mod, 'D')], what: 'Duplicate what’s selected, right after it' },
      { keys: [mac ? '⌘-click' : 'Ctrl+click', mac ? '⇧-click' : 'Shift+click'], what: 'Select several things' },
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
