// Copy, paste and moving several things at once, as edits on the project.
//
//   copyItems(project, items)              -> clip (plain data), or null
//   pasteItems(project, clip, outT)        -> { project, items }
//   moveItems(project, items, deltaOut)    -> project
//
// `items` are the editor's selection ({ kind, id }). Things that live on the
// recording's time (zooms, annotations, captions) and things that live on
// the video's time (audio, overlays, markers) are all placed by where they
// play: a paste puts the earliest copied thing at `outT` and keeps the others
// as far after it as they were. Clips are inserted at `outT`, splitting the
// clip playing there. A paste that can't put everything down (a zoom over
// another zoom, no free row) changes nothing and says why.

import { buildTimeline } from './timeline.js';
import * as P from './project.js';

const fail = (message) => { throw new Error(message); };

// A copy of `obj` without the named fields.
function without(obj, ...keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

// Where each kind of item lives in the project, and what it is called.
const find = (project, it) => {
  switch (it?.kind) {
    case 'clip': return project.clips.find((c) => c.id === it.id);
    case 'zoom': return project.zooms.find((z) => z.id === it.id);
    case 'annotation': return project.annotations.find((a) => a.id === it.id);
    case 'caption': return project.captions.segments.find((c) => c.id === it.id);
    case 'audio': return project.audio.clips.find((c) => c.id === it.id);
    case 'overlay': return project.overlays.find((o) => o.id === it.id);
    case 'marker': return project.markers.find((m) => m.id === it.id);
    default: return undefined;
  }
};

const ON_SOURCE_TIME = new Set(['zoom', 'annotation', 'caption']);

// When an item starts playing in the video (null: it is in a part that was cut).
function outStartOf(project, tl, kind, data) {
  if (kind === 'clip') return tl.clipBounds()[project.clips.indexOf(data)].outStart;
  if (ON_SOURCE_TIME.has(kind)) return tl.toOutput(data.source, data.start);
  if (kind === 'marker') return data.t;
  return data.start;
}

// What's selected, as data that can be pasted later (also into the project
// as it is after more edits). null when nothing in `items` can be copied
// (speed changes can't).
export function copyItems(project, items) {
  const tl = buildTimeline(project);
  const entries = [];
  for (const it of items ?? []) {
    const data = find(project, it);
    if (!data) continue;
    entries.push({ kind: it.kind, data: structuredClone(data), out: outStartOf(project, tl, it.kind, data) });
  }
  if (!entries.length) return null;
  const starts = entries.map((e) => e.out).filter((o) => o !== null && o !== undefined);
  const first = starts.length ? Math.min(...starts) : 0;
  // Clips keep the order they play in.
  const order = new Map(project.clips.map((c, i) => [c.id, i]));
  entries.sort((a, b) => (a.kind === 'clip' && b.kind === 'clip' ? order.get(a.data.id) - order.get(b.data.id) : 0));
  return { entries: entries.map((e) => ({ kind: e.kind, data: e.data, offset: e.out === null || e.out === undefined ? 0 : e.out - first })) };
}

// The recording moment that plays at output time o, for placing something
// there: { source, t }.
function sourceAt(tl, o) {
  const at = tl.toSource(Math.min(Math.max(0, o), Math.max(0, tl.duration - 1e-6)));
  return { source: at.source, t: at.t };
}

function pasteClips(project, clips, outT) {
  if (!clips.length) return { project, ids: [] };
  let p = project;
  for (const c of clips) if (!p.sources[c.source]) fail('That clip’s recording isn’t part of this video');
  const tl = buildTimeline(p);
  const o = Math.min(Math.max(0, outT), tl.duration);
  const bounds = tl.clipBounds();
  let at = bounds.findIndex((b) => o < b.outEnd - 1e-9);
  if (at < 0) at = p.clips.length;
  else if (o - bounds[at].outStart > P.MIN_CLIP_SECONDS && bounds[at].outEnd - o > P.MIN_CLIP_SECONDS) {
    p = P.splitAt(p, o);
    at += 1;
  } else if (bounds[at].outEnd - o <= P.MIN_CLIP_SECONDS) at += 1;
  const list = p.clips.slice();
  const ids = [];
  clips.forEach((c, k) => {
    const copy = { ...c, id: P.nextId('c', [...list]) };
    list.splice(at + k, 0, copy);
    ids.push(copy.id);
  });
  return { project: P.validateProject({ ...p, clips: list }), ids };
}

// Puts a copy of everything in `clip` (from copyItems) into the project,
// the earliest at output time `outT`. Returns the new project and the pasted
// things as selection items.
export function pasteItems(project, clip, outT) {
  if (!clip?.entries?.length) fail('Copy something first');
  if (!Number.isFinite(outT)) fail('Paste needs a moment in the video');
  const pasted = [];
  const clips = clip.entries.filter((e) => e.kind === 'clip');
  const done = pasteClips(project, clips.map((e) => e.data), outT);
  let p = done.project;
  for (const id of done.ids) pasted.push({ kind: 'clip', id });
  for (const e of clip.entries) {
    if (e.kind === 'clip') continue;
    const tl = buildTimeline(p);
    const o = Math.max(0, outT + e.offset);
    const d = e.data;
    if (ON_SOURCE_TIME.has(e.kind)) {
      if (o >= tl.duration - 1e-6) fail('There’s no room to paste that after the end of the video');
      const at = sourceAt(tl, o);
      const length = d.end - d.start;
      const end = Math.min(at.t + length, p.sources[at.source].duration);
      if (e.kind === 'zoom') {
        const before = new Set(p.zooms.map((z) => z.id));
        const rest = d;
        p = P.addZoom(p, { source: at.source, start: at.t, end, level: d.level, follow: d.follow, x: d.x, y: d.y });
        const added = p.zooms.find((z) => !before.has(z.id));
        const extra = Object.fromEntries(Object.entries(rest).filter(([k]) => ['disabled', 'ease'].includes(k)));
        if (Object.keys(extra).length) p = P.updateZoom(p, added.id, extra);
        pasted.push({ kind: 'zoom', id: added.id });
      } else if (e.kind === 'annotation') {
        p = P.addAnnotation(p, { ...without(d, 'id'), source: at.source, start: at.t, end });
        pasted.push({ kind: 'annotation', id: p.annotations.at(-1).id });
      } else {
        const id = P.nextId('cp', p.captions.segments);
        // Its words move with it.
        const shift = at.t - d.start;
        const words = Array.isArray(d.words) ? d.words.map((w) => ({ ...w, start: w.start + shift, end: w.end + shift })) : undefined;
        const seg = { ...d, id, source: at.source, start: at.t, end, ...(words ? { words } : {}) };
        p = P.setCaptions(p, { segments: [...p.captions.segments, seg] });
        pasted.push({ kind: 'caption', id });
      }
    } else if (e.kind === 'audio') {
      p = P.addAudioClip(p, { ...without(d, 'id', 'lane'), start: o });
      pasted.push({ kind: 'audio', id: p.audio.clips.at(-1).id });
    } else if (e.kind === 'overlay') {
      p = P.addOverlay(p, { ...without(d, 'id', 'lane'), start: o });
      pasted.push({ kind: 'overlay', id: p.overlays.at(-1).id });
    } else if (e.kind === 'marker') {
      const before = new Set(p.markers.map((m) => m.id));
      p = P.addMarker(p, { t: Math.min(o, tl.duration), label: d.label, color: d.color });
      pasted.push({ kind: 'marker', id: p.markers.find((m) => !before.has(m.id)).id });
    }
  }
  return { project: p, items: pasted };
}

// When the selection stops playing: where a duplicate goes.
export function itemsEnd(project, items) {
  const tl = buildTimeline(project);
  let end = 0;
  for (const it of items ?? []) {
    const d = find(project, it);
    if (!d) continue;
    if (it.kind === 'clip') end = Math.max(end, tl.clipBounds()[project.clips.indexOf(d)].outEnd);
    else if (ON_SOURCE_TIME.has(it.kind)) end = Math.max(end, tl.toOutput(d.source, d.end) ?? 0);
    else if (it.kind === 'marker') end = Math.max(end, d.t);
    else if (it.kind === 'audio') end = Math.max(end, P.audioClipEnd(d, tl.duration));
    else end = Math.max(end, d.start + d.length);
  }
  return end;
}

// Moves everything in `items` by `deltaOut` seconds of the video, together.
// Clips keep their place (they are reordered, not slid). Refused as a whole
// when any one of them can't go there.
export function moveItems(project, items, deltaOut) {
  if (!Number.isFinite(deltaOut)) fail('Move needs a distance');
  if (Math.abs(deltaOut) < 1e-9) return project;
  const tl = buildTimeline(project);
  let p = project;
  // Later things first when moving later (and earlier first when moving
  // earlier), so zooms never step on each other on the way.
  const movable = (items ?? []).map((it) => ({ it, d: find(project, it) })).filter((x) => x.d && x.it.kind !== 'clip');
  const startOf = (x) => (ON_SOURCE_TIME.has(x.it.kind) ? x.d.start : x.it.kind === 'marker' ? x.d.t : x.d.start);
  movable.sort((a, b) => (deltaOut > 0 ? startOf(b) - startOf(a) : startOf(a) - startOf(b)));
  const zoomMoves = [];
  for (const { it, d } of movable) {
    if (ON_SOURCE_TIME.has(it.kind)) {
      const o = tl.toOutput(d.source, d.start);
      if (o === null || o === undefined) fail('Something selected is in a part that was cut, so it can’t be moved from here');
      const target = o + deltaOut;
      if (target < -1e-6 || target >= tl.duration) fail('That would move something off the video');
      const at = sourceAt(tl, Math.max(0, target));
      if (at.source !== d.source) fail('That would move something onto another recording');
      const length = d.end - d.start;
      const start = Math.min(at.t, project.sources[d.source].duration - length);
      if (start < -1e-6) fail('That would move something off the video');
      const range = { start: Math.max(0, start), end: Math.max(0, start) + length };
      if (it.kind === 'zoom') zoomMoves.push({ id: d.id, range });
      else if (it.kind === 'annotation') p = P.updateAnnotation(p, d.id, range);
      else {
        const shift = range.start - d.start;
        const words = Array.isArray(d.words) ? d.words.map((w) => ({ ...w, start: w.start + shift, end: w.end + shift })) : undefined;
        p = P.setCaptions(p, {
          segments: p.captions.segments.map((c) => (c.id === d.id ? { ...c, ...range, ...(words ? { words } : {}) } : c))
        });
      }
    } else if (it.kind === 'marker') {
      const t = d.t + deltaOut;
      if (t < -1e-6 || t > tl.duration + 1e-6) fail('That would move a marker off the video');
      p = P.updateMarker(p, d.id, { t: Math.min(Math.max(0, t), tl.duration) });
    } else {
      const start = d.start + deltaOut;
      if (start < -1e-6) fail('That would move something before the start of the video');
      p = it.kind === 'audio' ? P.updateAudioClip(p, d.id, { start: Math.max(0, start) })
        : P.updateOverlay(p, d.id, { start: Math.max(0, start) });
    }
  }
  // Zooms all at once: together they don't overlap, though on the way,
  // one at a time, they might.
  if (zoomMoves.length) {
    const byId = new Map(zoomMoves.map((m) => [m.id, m.range]));
    const zooms = p.zooms.map((z) => {
      const r = byId.get(z.id);
      if (!r) return z;
      return { ...without(z, 'keyframes'), ...r };
    }).sort((a, b) => a.start - b.start);
    p = P.validateProject({ ...p, zooms });
  }
  return p;
}
