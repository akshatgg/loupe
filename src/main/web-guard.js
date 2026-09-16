'use strict';
// Keeps every Loupe window on its own page. A window's preload bridge
// (window.loupe) stays attached to the window, not to the page, so a window
// that navigated anywhere else -- a link, a script setting location, or a
// file or .html dropped onto it (Chromium opens those by default) -- would
// hand that page the whole bridge. Nothing in the app navigates a window
// after loadFile(), which does not go through these events, so any
// page-initiated navigation to another document is refused, and so are new
// windows from window.open or target=_blank (the app's own links go through
// shell.openExternal in main).

// The same document (a #hash change) is still allowed: it never leaves the page.
function sameDocument(currentUrl, nextUrl) {
  try {
    const a = new URL(currentUrl);
    const b = new URL(nextUrl);
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch {
    return false;
  }
}

// `contents` is a WebContents.
function guardWebContents(contents, { log = console.warn } = {}) {
  const refuse = (event, url) => {
    if (sameDocument(contents.getURL(), url)) return;
    event.preventDefault();
    log(`Loupe: blocked a window from leaving its page (${String(url).slice(0, 200)})`);
  };
  contents.on('will-navigate', refuse);
  contents.on('will-redirect', refuse);
  contents.on('will-frame-navigate', (event) => {
    // Only frames inside the page; the page itself is covered by will-navigate.
    if (event.isMainFrame) return;
    event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    log(`Loupe: blocked a page from opening a window (${String(url).slice(0, 200)})`);
    return { action: 'deny' };
  });
}

// Guards every web contents the app ever creates, including windows made later.
function installWebGuard({ app }) {
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents));
}

module.exports = { installWebGuard, guardWebContents, sameDocument };
