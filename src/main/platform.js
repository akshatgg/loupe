'use strict';

const path = require('node:path');

// What differs between the macOS and Windows builds, kept in one place and
// free of Electron so it is testable anywhere.
//
// macOS: one Swift binary per helper (bin/sources, bin/capture, ...), which
// capture to a HEVC .mov. Windows: one .NET binary, bin/loupe-native.exe,
// with the helper named as its first argument, capturing to an H.264 .mp4.
// Both speak the same NDJSON protocol, so nothing above this layer cares.

function helperCommand(binDir, name, platform = process.platform) {
  if (platform === 'win32') {
    return { file: path.join(binDir, 'loupe-native.exe'), args: [name] };
  }
  return { file: path.join(binDir, name), args: [] };
}

function captureFileName(platform = process.platform) {
  return platform === 'win32' ? 'raw.mp4' : 'raw.mov';
}

// Recordings go in the user's Movies folder on macOS and Videos on Windows.
// `getPath` is Electron's app.getPath.
function recordingsRoot(getPath, homedir, platform = process.platform) {
  if (platform === 'win32') return path.join(getPath('videos'), 'Loupe');
  return path.join(homedir, 'Movies', 'Loupe');
}

// Windows helpers work in physical pixels, while Electron positions windows
// in DIPs (Windows' equivalent of macOS points, and what the rest of Loupe
// measures in). These map between the two using Electron's own per-monitor
// conversion; on macOS every helper already speaks points, so both are
// identities. `getScreen` returns Electron's screen module, which can only be
// touched once the app is ready -- hence a getter, called per conversion.
function coordinateMapper(getScreen, platform = process.platform) {
  if (platform !== 'win32') {
    return { toDipPoint: (p) => p, toDipRect: (r) => r, toScreenRect: (r) => r };
  }
  return {
    toDipPoint: (p) => getScreen().screenToDipPoint({ x: Math.round(p.x), y: Math.round(p.y) }),
    toDipRect: (r) => getScreen().screenToDipRect(null, roundRect(r)),
    toScreenRect: (r) => getScreen().dipToScreenRect(null, roundRect(r))
  };
}

function roundRect(r) {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

// Merges desktopCapturer thumbnails into bin/sources output on Windows, where
// the helper doesn't render them itself. Window ids match directly
// ("window:<hwnd>:0"); displays match by their DIP bounds, since
// desktopCapturer knows Electron's display ids, not monitor handles.
function attachThumbnails(sources, captured, displays) {
  const byWindow = new Map();
  const byDisplayId = new Map();
  for (const c of captured) {
    const [kind, id] = String(c.id).split(':');
    if (kind === 'window') byWindow.set(id, c);
    else if (c.display_id) byDisplayId.set(String(c.display_id), c);
  }
  return sources.map((s) => {
    const [kind, id] = s.id.split(':');
    let match = null;
    if (kind === 'window') {
      match = byWindow.get(id);
    } else {
      const display = displays.find((d) => Math.abs(d.bounds.x - s.x) <= 1 && Math.abs(d.bounds.y - s.y) <= 1);
      if (display) match = byDisplayId.get(String(display.id));
    }
    const thumbnail = match && !match.thumbnail.isEmpty() ? match.thumbnail.toDataURL() : s.thumbnail ?? null;
    return { ...s, thumbnail };
  });
}

module.exports = {
  helperCommand, captureFileName, recordingsRoot, coordinateMapper, attachThumbnails
};
