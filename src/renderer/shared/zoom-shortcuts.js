'use strict';
// ---- zoom shortcuts ---------------------------------------------------------
// Shared by the picker and the Settings window: a plain script (not a module)
// so the picker's classic script can use it too. Defines
// window.loupeZoomShortcuts.
//
// Two slots, each set by clicking it and then pressing the button you want.
// Saved in main (settings.js) and handed to bin/inputtap at record time.
// Only buttons you can HOLD while scrolling without side effects are taken:
// modifier keys and the middle/side mouse buttons. A letter key would type
// into whatever is being recorded; left/right click are needed for the demo.
//
// mount({ captureEls, clearEls, onRender, onError }) wires two
// .capture buttons and their two .clear buttons, and returns
// { set(triggers) } for when settings change elsewhere. onRender(triggers)
// runs after every change; onError(err) when saving fails.
window.loupeZoomShortcuts = (() => {
  // The saved names are the same on both systems (settings.js); Windows just
  // calls the keys Alt, Ctrl and the Windows key.
  const IS_WINDOWS = window.loupe.platform === 'win32';
  const TRIGGERS = IS_WINDOWS ? {
    option: { label: 'Alt', key: 'Alt' },
    control: { label: 'Ctrl', key: 'Ctrl' },
    command: { label: '⊞ Windows key', key: '⊞ Win' },
    shift: { label: '⇧ Shift', key: 'Shift' },
    'mouse-side': { label: '🖱 Mouse side button', words: 'a mouse side button' },
    'mouse-middle': { label: '🖱 Middle mouse button', words: 'the middle mouse button' }
  } : {
    option: { label: '⌥ Option', key: '⌥' },
    control: { label: '⌃ Control', key: '⌃' },
    command: { label: '⌘ Command', key: '⌘' },
    shift: { label: '⇧ Shift', key: '⇧' },
    'mouse-side': { label: '🖱 Mouse side button', words: 'a mouse side button' },
    'mouse-middle': { label: '🖱 Middle mouse button', words: 'the middle mouse button' }
  };
  const KEY_TRIGGERS = { Alt: 'option', Control: 'control', Meta: 'command', Shift: 'shift' };
  // MouseEvent.button: 1 middle, 3 back, 4 forward (0/2 are left/right).
  const MOUSE_TRIGGERS = { 1: 'mouse-middle', 3: 'mouse-side', 4: 'mouse-side' };
  const PROMPT = 'Press a key or mouse button…';

  // "Hold ⌥ or a mouse side button" as DOM nodes (never innerHTML), into `el`.
  // Returns false when no shortcut is set.
  function describe(el, triggers, { before = 'Hold ', after = '' } = {}) {
    el.textContent = '';
    const set = triggers.filter(Boolean);
    if (set.length === 0) return false;
    el.append(before);
    set.forEach((t, i) => {
      if (i > 0) el.append(' or ');
      if (TRIGGERS[t].key) {
        const kbd = document.createElement('kbd');
        kbd.textContent = TRIGGERS[t].key;
        el.append(kbd);
      } else {
        el.append(TRIGGERS[t].words);
      }
    });
    el.append(after);
    return true;
  }

  function mount({ captureEls, clearEls, onRender = () => {}, onError = () => {} }) {
    let zoomTriggers = [null, null];
    let capturing = null; // slot index being set, or null
    let refusedTimer = null;

    function render() {
      captureEls.forEach((el, slot) => {
        const t = zoomTriggers[slot];
        el.classList.toggle('capturing', capturing === slot);
        el.classList.remove('refused');
        el.classList.toggle('empty', !t && capturing !== slot);
        el.textContent = capturing === slot ? PROMPT : (t ? TRIGGERS[t].label : 'Click to set');
        clearEls[slot].hidden = !t || capturing === slot;
      });
      onRender(zoomTriggers);
    }

    function stopCapture() {
      clearTimeout(refusedTimer);
      capturing = null;
      render();
    }

    // Says why a button wasn't taken, in the field itself, then goes back to
    // waiting for another press.
    function refuse(message) {
      const el = captureEls[capturing];
      clearTimeout(refusedTimer);
      el.classList.add('refused');
      el.textContent = message;
      refusedTimer = setTimeout(() => {
        if (capturing === null) return;
        el.classList.remove('refused');
        el.textContent = PROMPT;
      }, 1600);
    }

    async function save(next) {
      try {
        ({ zoomTriggers } = await window.loupe.setSettings({ zoomTriggers: next }));
      } catch (err) {
        onError(err);
      }
      render();
    }

    function commit(trigger) {
      const slot = capturing;
      if (zoomTriggers[1 - slot] === trigger) {
        refuse('Already your other shortcut');
        return;
      }
      const next = [...zoomTriggers];
      next[slot] = trigger;
      capturing = null;
      clearTimeout(refusedTimer);
      save(next);
    }

    captureEls.forEach((el, slot) => {
      el.addEventListener('click', () => {
        capturing = slot;
        render();
      });
    });
    clearEls.forEach((el, slot) => {
      el.addEventListener('click', () => {
        const next = [...zoomTriggers];
        next[slot] = null;
        save(next);
      });
    });

    // Capture phase, so nothing else in the window reacts to the press being
    // recorded (e.g. Space/Enter re-"clicking" the focused field).
    document.addEventListener('keydown', (e) => {
      if (capturing === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { stopCapture(); return; }
      const trigger = KEY_TRIGGERS[e.key];
      if (trigger) commit(trigger);
      else refuse(IS_WINDOWS ? 'Use Alt, Ctrl, Shift, Win or a mouse button' : 'Use ⌥ ⌃ ⌘ ⇧ or a mouse button');
    }, true);

    document.addEventListener('mousedown', (e) => {
      if (capturing === null) return;
      const trigger = MOUSE_TRIGGERS[e.button];
      if (trigger) {
        e.preventDefault();
        e.stopPropagation();
        commit(trigger);
      } else if (e.button === 2) {
        e.preventDefault();
        refuse('Use a side or middle mouse button');
      } else if (e.target !== captureEls[capturing]) {
        stopCapture(); // an ordinary click elsewhere just cancels
      }
    }, true);

    // A side button's release would otherwise also count as browser Back/Forward.
    for (const type of ['mouseup', 'auxclick']) {
      document.addEventListener(type, (e) => {
        if (e.button === 3 || e.button === 4) e.preventDefault();
      }, true);
    }
    window.addEventListener('blur', () => { if (capturing !== null) stopCapture(); });

    // Nothing is drawn until set() brings the saved shortcuts, so the fields
    // never flash "Click to set" on the way in.
    return {
      set(triggers) {
        zoomTriggers = [...triggers];
        if (capturing === null) render();
      }
    };
  }

  return { TRIGGERS, describe, mount };
})();
