// What's selected in the editor, as a list of items, and the rules for it.
// Pure, so it can be tested without a window (test/editor-selection.test.mjs).
//
// An item is { kind, id } -- kind one of clip, zoom, annotation, caption,
// audio, overlay, marker -- or a speed stretch, which has no id:
// { kind: 'speed', source, start, end }.

export function sameItem(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'speed') return a.source === b.source && a.start === b.start && a.end === b.end;
  return a.id === b.id;
}

export function hasItem(list, item) {
  return list.some((it) => sameItem(it, item));
}

// The list with `item` added, or taken out if it was there (a ⌘-click).
export function toggleItem(list, item) {
  return hasItem(list, item) ? list.filter((it) => !sameItem(it, item)) : [...list, item];
}

const byId = (items, id) => (items ?? []).some((x) => x.id === id);

// Whether the project still has this item (undo or an edit may have removed it).
export function isAlive(p, item) {
  switch (item?.kind) {
    case 'clip': return byId(p.clips, item.id);
    case 'zoom': return byId(p.zooms, item.id);
    case 'annotation': return byId(p.annotations, item.id);
    case 'caption': return byId(p.captions.segments, item.id);
    case 'audio': return byId(p.audio.clips, item.id);
    case 'overlay': return byId(p.overlays, item.id);
    case 'marker': return byId(p.markers, item.id);
    case 'speed': return p.speed.some((s) => s.source === item.source && s.start === item.start && s.end === item.end);
    default: return false;
  }
}

// The same list when everything in it is still there, so nothing redraws.
export function aliveItems(p, list) {
  const alive = list.filter((it) => isAlive(p, it));
  return alive.length === list.length ? list : alive;
}
