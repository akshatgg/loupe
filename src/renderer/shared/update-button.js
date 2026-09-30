'use strict';
/* global module -- defined only under node --test */
// ---- Update now -------------------------------------------------------------
// The button at the top right of the picker and the Library: shown only while
// a newer Loupe exists, hidden otherwise. A plain script (not a module), like
// zoom-shortcuts.js, so the picker's classic script can use it too. Defines
// window.loupeUpdateButton; under node --test, module.exports instead.
//
// view(state) is what the button shows for an updater state
// (src/main/updates.js). mount(button) wires one to window.loupe.updates.
(function (root) {
  const SHOWN = ['available', 'downloading', 'ready'];

  function view(state) {
    const latest = state?.latest?.version;
    const pending = Boolean(state?.pending);
    const shown = Boolean(latest) && (SHOWN.includes(state.status) || state.status === 'error'
      || (pending && state.status === 'checking'));
    if (!shown) return { hidden: true, label: '', title: '', busy: false };
    const busy = pending && (state.status === 'downloading' || state.status === 'checking');
    const pct = Math.round((state.progress ?? 0) * 100);
    return {
      hidden: false,
      busy,
      label: busy ? `Updating… ${pct}%` : 'Update now',
      title: `Loupe ${latest} is available — you have ${state.currentVersion}`
    };
  }

  function mount(button) {
    const render = (state) => {
      const v = view(state);
      button.hidden = v.hidden;
      if (v.hidden) return;
      button.textContent = v.label;
      button.title = v.title;
      button.disabled = v.busy;
    };
    button.addEventListener('click', () => root.loupe.updates.install());
    root.loupe.updates.onChanged(render);
    root.loupe.updates.state().then(render, () => {});
  }

  const api = { view, mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.loupeUpdateButton = api;
})(typeof window === 'undefined' ? globalThis : window);
