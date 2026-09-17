// The wallpapers that come with Loupe (src/assets/wallpapers/<id>.png, made
// by packaging/make-wallpapers.js). A project names one as the background
// value "wallpaper:<id>"; a picture the user chose is copied into the
// recording's folder and named "background/<file>" instead.

export const WALLPAPERS = [
  { id: 'dusk', name: 'Dusk' },
  { id: 'ocean', name: 'Ocean' },
  { id: 'aurora', name: 'Aurora' },
  { id: 'sand', name: 'Sand' },
  { id: 'blush', name: 'Blush' },
  { id: 'graphite', name: 'Graphite' }
];

const PREFIX = 'wallpaper:';

// "wallpaper:dusk" -> "dusk", or null for anything else (or an unknown one).
export function wallpaperId(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null;
  const id = value.slice(PREFIX.length);
  return WALLPAPERS.some((w) => w.id === id) ? id : null;
}

export const wallpaperValue = (id) => `${PREFIX}${id}`;

// The file of a wallpaper, relative to src/.
export const wallpaperPath = (id) => `assets/wallpapers/${id}.png`;

// A copied picture's value: "background/<name>" with a plain file name.
export function isProjectBackground(value) {
  return typeof value === 'string' && /^background\/[^/\\:\0]+$/.test(value) &&
    !/^background\/\.\.?$/.test(value);
}
