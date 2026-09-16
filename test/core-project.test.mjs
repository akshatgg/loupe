import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Real v1 projects copied from ~/Movies/Loupe: one with recorded zooms (one
// of which dips 4x -> 1.2x -> 4x, and one still zoomed at the end), one with
// a click and no zooms.
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const V1_ZOOMS = fixture('v1-project-zooms.json');
const V1_CLICKS = fixture('v1-project-clicks.json');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

const MAIN = { kind: 'display', id: 'display:1', title: 'Display', width: 1600, height: 1000, duration: 20, mic: true };
const fresh = () => P.createProject({ main: MAIN, createdAt: Date.UTC(2026, 8, 16, 12, 0) });

test('migrates a real v1 project into sources.main and one whole clip', () => {
  const p = P.migrate(V1_CLICKS, { createdAt: 1789562219597 });
  assert.strictEqual(p.version, 2);
  const m = p.sources.main;
  assert.deepStrictEqual(
    [m.kind, m.id, m.title, m.width, m.height, m.originX, m.originY, m.video, m.fps, m.mic, m.cursor, m.dir],
    ['display', 'display:1', 'Display 1470x956', 1470, 956, 0, 0, 'raw.mov', 60, true, 'cursor.bin', '.']
  );
  near(m.duration, 3.456151583348401, 1e-12);
  assert.deepStrictEqual(m.clicks, V1_CLICKS.clicks);
  assert.deepStrictEqual(p.clips, [{ id: 'c1', source: 'main', start: 0, end: m.duration }]);
  assert.deepStrictEqual(p.zooms, []);
  assert.deepStrictEqual(p.speed, []);
  assert.match(p.title, /^Recording \d{1,2} [A-Z][a-z]{2} 2026, \d\d:\d\d$/);
  assert.strictEqual(p.createdAt, 1789562219597);
});

test('a migrated project keeps v1 looks: no background, padding, corners or shadow', () => {
  const p = P.migrate(V1_ZOOMS);
  assert.deepStrictEqual(p.style.background, { type: 'none', value: null });
  assert.strictEqual(p.style.padding, 0);
  assert.strictEqual(p.style.radius, 0);
  assert.strictEqual(p.style.shadow, 0);
  assert.strictEqual(p.style.aspect, 'source');
  // No showCursor key in this old project means shown; v1 never smoothed.
  assert.deepStrictEqual(p.style.cursor, { show: true, size: 1, hideWhenIdle: false, smooth: false, highlight: 'none', clicks: true });
  assert.strictEqual(p.audio.mic.cleanUp, false);
  assert.strictEqual(p.audio.mic.level, false);
  assert.deepStrictEqual(p.export, {
    format: 'mp4', resolution: '1080p', quality: 'balanced', fps: 60, codec: 'h264',
    sizeLimit: null, gifWidth: 960, gifFps: 15, dither: true
  });
});

test('v1 settings map onto the cursor style', () => {
  const v1 = { ...V1_CLICKS, settings: { ...V1_CLICKS.settings, showCursor: false, clickHighlights: false } };
  const p = P.migrate(v1);
  assert.strictEqual(p.style.cursor.show, false);
  assert.strictEqual(p.style.cursor.clicks, false);
});

test('recorded zoom keyframes become zooms with their keyframes kept', () => {
  const p = P.migrate(V1_ZOOMS);
  assert.strictEqual(p.zooms.length, 3);
  const [a, b, c] = p.zooms;
  near(a.start, 6.422797709000406, 1e-12);
  near(a.end, 9.306418167333732, 1e-12);
  assert.strictEqual(a.level, 4);
  assert.strictEqual(a.recorded, true);
  assert.strictEqual(a.follow, true);
  // The whole in-out, including the dip back to 1.24x and the return to 1x.
  assert.strictEqual(a.keyframes.length, 26);
  assert.strictEqual(a.keyframes.at(-1).zoom, 1);
  near(b.start, 16.24543420900045, 1e-12);
  near(b.end, 16.537117417333775, 1e-12);
  // Still zoomed in when the recording stopped: ends at the end.
  near(c.end, V1_ZOOMS.capture.duration, 1e-12);
  assert.deepStrictEqual(p.zooms.map((z) => z.id), ['z1', 'z2', 'z3']);
  // x/y (used if switched to fixed) is where the cursor was when zooming.
  assert.deepStrictEqual([c.x, c.y], [530.12109375, 271.4296875]);
});

test('a zoom removed in the v1 editor stays removed after migration', () => {
  // v1 kept every recorded zoom and derived zoomKeyframes minus the removed
  // ones; the export read zoomKeyframes, so migration must too.
  const v1 = require('../src/main/segments.js');
  const segs = v1.zoomSegments(V1_ZOOMS.zoomKeyframes, V1_ZOOMS.capture.duration);
  const edited = JSON.parse(JSON.stringify(v1.removeZoom(V1_ZOOMS, segs[1])));
  assert.strictEqual(edited.recordedZoomKeyframes.length, V1_ZOOMS.zoomKeyframes.length);
  const p = P.migrate(edited);
  assert.strictEqual(p.zooms.length, 2);
  near(p.zooms[0].start, 6.422797709000406, 1e-12);
  near(p.zooms[1].end, V1_ZOOMS.capture.duration, 1e-12);
  assert.ok(p.zooms.every((z) => z.start > segs[1].end || z.end < segs[1].start));
});

test('a zoom stretch that never passes 1.05x is dropped', () => {
  const zooms = P.zoomsFromKeyframes([
    { t: 1, zoom: 1.02 }, { t: 1.2, zoom: 1.04 }, { t: 2, zoom: 1 },
    { t: 3, zoom: 1.5 }, { t: 4, zoom: 1 }
  ], 10);
  assert.strictEqual(zooms.length, 1);
  assert.deepStrictEqual([zooms[0].start, zooms[0].end, zooms[0].level], [3, 4, 1.5]);
});

test('migration survives a JSON round trip and validates as v2', () => {
  const p = P.migrate(V1_ZOOMS);
  const again = P.loadProjectData(JSON.parse(JSON.stringify(p)));
  assert.deepStrictEqual(again, p);
  assert.deepStrictEqual(P.loadProjectData(V1_ZOOMS), p);
});

test('loadProjectData refuses unknown versions and non-projects', () => {
  assert.throws(() => P.loadProjectData({ version: 3 }), /newer version/);
  assert.throws(() => P.loadProjectData(null), /not a project/);
  assert.throws(() => P.migrate({ version: 2 }), /version 1/);
});

test('validation rejects things that cannot be drawn', () => {
  const p = fresh();
  assert.throws(() => P.validateProject({ ...p, clips: [] }), /no clips/);
  assert.throws(() => P.validateProject({ ...p, clips: [{ id: 'c1', source: 'nope', start: 0, end: 1 }] }), /unknown source/);
  assert.throws(() => P.validateProject({ ...p, clips: [{ id: 'c1', source: 'main', start: 0, end: 99 }] }), /outside/);
  assert.throws(() => P.validateProject({ ...p, style: { ...p.style, padding: 'lots' } }), /Padding/);
  assert.throws(() => P.validateProject({ ...p, speed: [{ source: 'main', start: 0, end: 1, rate: 100 }] }), /Speed/);
  assert.throws(() => P.validateProject({ ...p, sources: { main: { ...p.sources.main, width: NaN } } }), /width/);
});

test('a new project has pretty defaults and clips around pauses', () => {
  const p = fresh();
  assert.strictEqual(p.title, 'Recording 16 Sep 2026, ' + new Date(Date.UTC(2026, 8, 16, 12, 0)).toTimeString().slice(0, 5));
  assert.strictEqual(p.style.background.type, 'gradient');
  assert.strictEqual(p.style.padding, 0.06);
  assert.strictEqual(p.style.radius, 12);
  const paused = P.createProject({ main: { ...MAIN, pauses: [{ start: 5, end: 8 }] } });
  assert.deepStrictEqual(paused.clips.map((c) => [c.id, c.start, c.end]), [['c1', 0, 5], ['c2', 8, 20]]);
});

// ---------------------------------------------------------------- clip edits

test('trimStart and trimEnd move clip edges, clamped, without touching the old project', () => {
  const p = fresh();
  const a = P.trimStart(p, 'c1', 2);
  const b = P.trimEnd(a, 'c1', 15);
  assert.deepStrictEqual([b.clips[0].start, b.clips[0].end], [2, 15]);
  assert.deepStrictEqual([p.clips[0].start, p.clips[0].end], [0, 20]);
  assert.strictEqual(P.trimStart(p, 'c1', -5).clips[0].start, 0);
  near(P.trimStart(p, 'c1', 50).clips[0].start, 20 - P.MIN_CLIP_SECONDS);
  assert.strictEqual(P.trimEnd(p, 'c1', 50).clips[0].end, 20);
  assert.throws(() => P.trimStart(p, 'nope', 1), /No clip/);
  assert.throws(() => P.trimEnd(p, 'c1', NaN), /Trim time/);
  // Untouched parts are shared, not copied.
  assert.strictEqual(a.zooms, p.zooms);
  assert.strictEqual(a.style, p.style);
});

test('splitAt splits the clip under an output time, with speed taken into account', () => {
  let p = P.paintSpeed(fresh(), { start: 0, end: 10, rate: 2 });
  const tl = buildTimeline(p);
  const out = tl.toOutput('main', 12);
  p = P.splitAt(p, out);
  assert.deepStrictEqual(p.clips.map((c) => c.id), ['c1', 'c2']);
  near(p.clips[0].end, 12, 1e-6);
  near(p.clips[1].start, 12, 1e-6);
  near(buildTimeline(p).duration, tl.duration, 1e-9);
  assert.throws(() => P.splitAt(p, 0), /inside/);
  assert.throws(() => P.splitAt(p, out + 0.01), /edge/);
});

test('splitAt moves a transition to the second half', () => {
  let p = P.splitAt(fresh(), 10);
  p = P.setTransition(p, 'c1', 'fade');
  p = P.splitAt(p, 5);
  assert.deepStrictEqual(p.transitions.map((t) => t.after), ['c3']);
  assert.deepStrictEqual(p.clips.map((c) => c.id), ['c1', 'c3', 'c2']);
});

test('cutRange removes an output stretch across clips', () => {
  const p = P.splitAt(fresh(), 10);
  const cut = P.cutRange(p, 8, 12);
  assert.deepStrictEqual(cut.clips.map((c) => [c.id, c.start, c.end]), [['c1', 0, 8], ['c2', 12, 20]]);
  near(buildTimeline(cut).duration, 16);
  // Inside one clip: split around it.
  const inner = P.cutRange(fresh(), 3, 5);
  assert.deepStrictEqual(inner.clips.map((c) => [c.id, c.start, c.end]), [['c1', 0, 3], ['c2', 5, 20]]);
  // Reversed arguments are the same cut; a whole-clip cut deletes it.
  assert.deepStrictEqual(P.cutRange(p, 12, 8).clips, cut.clips);
  assert.deepStrictEqual(P.cutRange(p, 0, 10).clips.map((c) => c.id), ['c2']);
  assert.throws(() => P.cutRange(p, 0, 20), /whole video/);
  assert.throws(() => P.cutRange(p, 4, 4), /Select/);
});

test('moveClip reorders and deleteClip removes, keeping at least one clip', () => {
  let p = P.splitAt(P.splitAt(fresh(), 5), 10);
  p = P.moveClip(p, 2, 0);
  assert.deepStrictEqual(p.clips.map((c) => c.id), ['c3', 'c1', 'c2']);
  assert.strictEqual(P.moveClip(p, 1, 1), p);
  assert.throws(() => P.moveClip(p, 0, 3), /position/);
  assert.throws(() => P.moveClip(p, -1, 0), /position/);
  p = P.setTransition(p, 'c1', 'dip');
  p = P.deleteClip(p, 'c1');
  assert.deepStrictEqual(p.clips.map((c) => c.id), ['c3', 'c2']);
  assert.deepStrictEqual(p.transitions, []);
  p = P.deleteClip(p, 'c3');
  assert.throws(() => P.deleteClip(p, 'c2'), /at least one/);
});

test('appendRecording adds a source and its clip at the end', () => {
  const p = P.appendRecording(fresh(), 'src2', { dir: '/abs/other', width: 800, height: 600, duration: 4, video: 'raw.mp4' });
  assert.strictEqual(p.sources.src2.dir, '/abs/other');
  assert.deepStrictEqual(p.clips.at(-1), { id: 'c2', source: 'src2', start: 0, end: 4 });
  near(buildTimeline(p).duration, 24);
  assert.throws(() => P.appendRecording(p, 'src2', { width: 1, height: 1, duration: 1 }), /already/);
  assert.throws(() => P.appendRecording(p, '../x', { width: 1, height: 1, duration: 1 }), /Bad source/);
  assert.throws(() => P.appendRecording(p, 'src3', { width: 0, height: 1, duration: 1 }), /width/);
});

// ---------------------------------------------------------------- zooms

test('addZoom, updateZoom and removeZoom', () => {
  let p = P.addZoom(fresh(), { start: 2, end: 4, level: 2.5 });
  assert.deepStrictEqual(p.zooms, [{ id: 'z1', source: 'main', start: 2, end: 4, level: 2.5, follow: true, x: 800, y: 500, recorded: false }]);
  p = P.addZoom(p, { start: 6, end: 5, follow: false, x: 100, y: 200 });
  assert.deepStrictEqual([p.zooms[1].start, p.zooms[1].end, p.zooms[1].level], [5, 6, 2]);
  assert.throws(() => P.addZoom(p, { start: 3, end: 5.5 }), /overlap/);
  assert.throws(() => P.addZoom(p, { start: 8, end: 8.01 }), /too short/);
  assert.throws(() => P.addZoom(p, { start: 8, end: 9, level: 20 }), /Zoom level/);
  assert.throws(() => P.addZoom(p, { source: 'x', start: 8, end: 9 }), /unknown recording/);
  p = P.updateZoom(p, 'z2', { level: 3, follow: true });
  assert.deepStrictEqual([p.zooms[1].level, p.zooms[1].follow], [3, true]);
  assert.throws(() => P.updateZoom(p, 'z2', { start: 3 }), /overlap/);
  assert.throws(() => P.updateZoom(p, 'z2', { id: 'z9' }), /change a zoom's id/);
  assert.throws(() => P.updateZoom(p, 'nope', { level: 2 }), /No zoom/);
  p = P.removeZoom(p, 'z1');
  assert.deepStrictEqual(p.zooms.map((z) => z.id), ['z2']);
  assert.throws(() => P.removeZoom(p, 'z1'), /No zoom/);
  assert.strictEqual(P.addZoom(p, { start: 10, end: 11 }).zooms.at(-1).id, 'z3');
});

test('editing a recorded zoom\u2019s timing or level drops its recorded keyframes, follow does not', () => {
  const p = P.migrate(V1_ZOOMS);
  assert.ok(P.updateZoom(p, 'z1', { follow: false }).zooms[0].keyframes);
  assert.strictEqual(P.updateZoom(p, 'z1', { level: 3 }).zooms[0].keyframes, undefined);
  assert.strictEqual(P.updateZoom(p, 'z1', { end: 10 }).zooms[0].keyframes, undefined);
  assert.ok(P.updateZoom(p, 'z1', { level: 4 }).zooms[0].keyframes, 'same level is not an edit');
});

// ---------------------------------------------------------------- speed

test('paintSpeed replaces, splits and merges like v1 speed.js', () => {
  let p = P.paintSpeed(fresh(), { start: 2, end: 8, rate: 2 });
  p = P.paintSpeed(p, { start: 4, end: 5, rate: 0.5 });
  assert.deepStrictEqual(p.speed.map((s) => [s.start, s.end, s.rate]), [[2, 4, 2], [4, 5, 0.5], [5, 8, 2]]);
  p = P.paintSpeed(p, { start: 4, end: 5, rate: 2 });
  assert.deepStrictEqual(p.speed.map((s) => [s.start, s.end, s.rate]), [[2, 8, 2]]);
  p = P.paintSpeed(p, { start: 0, end: 30, rate: 1 });
  assert.deepStrictEqual(p.speed, []);
  assert.throws(() => P.paintSpeed(p, { start: 0, end: 1, rate: 9 }), /Speed/);
  assert.throws(() => P.paintSpeed(p, { start: 0, end: 0.05, rate: 2 }), /too short/);
  // Other sources' speed is left alone.
  let two = P.appendRecording(fresh(), 'src2', { width: 10, height: 10, duration: 5 });
  two = P.paintSpeed(two, { source: 'src2', start: 1, end: 2, rate: 4 });
  two = P.paintSpeed(two, { start: 1, end: 2, rate: 1 });
  assert.deepStrictEqual(two.speed, [{ source: 'src2', start: 1, end: 2, rate: 4 }]);
});

// ---------------------------------------------------------------- annotations

test('annotations are added with defaults, updated and removed', () => {
  let p = P.addAnnotation(fresh(), { type: 'text', start: 1, end: 3, text: 'Hello' });
  assert.deepStrictEqual(p.annotations[0], {
    id: 'a1', type: 'text', source: 'main', start: 1, end: 3, x: 0.1, y: 0.1, w: 0.3, h: 0.15,
    x2: 0.4, y2: 0.25, text: 'Hello', color: '#ffffff', size: 1
  });
  p = P.updateAnnotation(p, 'a1', { text: 'Hi', color: '#ff0000', x: 0.5 });
  assert.deepStrictEqual([p.annotations[0].text, p.annotations[0].color, p.annotations[0].x], ['Hi', '#ff0000', 0.5]);
  assert.throws(() => P.updateAnnotation(p, 'a1', { color: 'red' }), /colour/);
  assert.throws(() => P.updateAnnotation(p, 'a1', { id: 'x' }), /Invalid/);
  assert.throws(() => P.addAnnotation(p, { type: 'sparkle', start: 1, end: 2 }), /Annotation type/);
  p = P.removeAnnotation(p, 'a1');
  assert.deepStrictEqual(p.annotations, []);
  assert.throws(() => P.removeAnnotation(p, 'a1'), /No annotation/);
});

// ---------------------------------------------------------------- settings

test('setStyle merges nested patches and validates them', () => {
  const p = fresh();
  const q = P.setStyle(p, { padding: 0.1, cursor: { size: 2 }, background: { type: 'color', value: '#112233' } });
  assert.strictEqual(q.style.padding, 0.1);
  assert.strictEqual(q.style.cursor.size, 2);
  assert.strictEqual(q.style.cursor.show, true);
  assert.deepStrictEqual(q.style.background, { type: 'color', value: '#112233' });
  assert.strictEqual(p.style.cursor.size, 1);
  assert.throws(() => P.setStyle(p, { aspect: '2:1' }), /Aspect/);
  assert.throws(() => P.setStyle(p, { sparkles: true }), /Unknown style/);
  assert.throws(() => P.setStyle(p, { background: { type: 'gradient', value: { angle: 0, stops: ['#fff'] } } }), /2 to 8/);
  assert.throws(() => P.setStyle(p, { background: { type: 'image', value: '' } }), /image/);
  assert.strictEqual(P.setStyle(p, { background: { type: 'image', value: 'bg.jpg' } }).style.background.value, 'bg.jpg');
});

test('setAudio, setCaptions, setExport and setTitle validate their patches', () => {
  const p = fresh();
  const a = P.setAudio(p, { mic: { volume: 0.5 }, music: { file: 'song.m4a', volume: 0.3, duck: true } });
  assert.deepStrictEqual(a.audio.mic, { volume: 0.5, muted: false, cleanUp: true, level: true });
  assert.strictEqual(a.audio.music.file, 'song.m4a');
  assert.strictEqual(P.setAudio(a, { music: null }).audio.music, null);
  assert.throws(() => P.setAudio(p, { mic: { volume: 5 } }), /volume/);
  assert.throws(() => P.setAudio(p, { voiceover: [{ id: 'v1', file: 'v.m4a', source: 'main', t: -1, volume: 1 }] }), /Voiceover time/);
  const c = P.setCaptions(p, { show: true, segments: [{ id: 's1', source: 'main', start: 1, end: 2, text: 'hi' }] });
  assert.strictEqual(c.captions.segments.length, 1);
  assert.throws(() => P.setCaptions(p, { style: { position: 'middle' } }), /Caption position/);
  const e = P.setExport(p, { format: 'gif', fps: 15 });
  assert.deepStrictEqual([e.export.format, e.export.fps, e.export.quality], ['gif', 15, 'balanced']);
  assert.throws(() => P.setExport(p, { format: 'avi' }), /Export format/);
  assert.throws(() => P.setExport(p, { bitrate: 5 }), /Unknown export/);
  assert.strictEqual(P.setTitle(p, '  Demo  ').title, 'Demo');
  assert.throws(() => P.setTitle(p, '   '), /Title/);
});

test('setTransition sets, replaces and removes', () => {
  let p = P.splitAt(fresh(), 10);
  p = P.setTransition(p, 'c1', 'fade');
  p = P.setTransition(p, 'c1', 'crossfade', 1);
  assert.deepStrictEqual(p.transitions, [{ after: 'c1', type: 'crossfade', duration: 1 }]);
  assert.throws(() => P.setTransition(p, 'c1', 'wipe'), /Transition type/);
  assert.deepStrictEqual(P.setTransition(p, 'c1', null).transitions, []);
});

test('every edit result is still a valid project', () => {
  let p = P.migrate(V1_ZOOMS);
  p = P.paintSpeed(p, { start: 1, end: 3, rate: 4 });
  p = P.splitAt(p, 5);
  p = P.cutRange(p, 2, 2.5);
  p = P.moveClip(p, 0, 2);
  p = P.addZoom(p, { start: 10, end: 12 });
  p = P.addAnnotation(p, { type: 'box', start: 1, end: 2 });
  p = P.setStyle(p, { aspect: '9:16' });
  assert.deepStrictEqual(P.validateProject(JSON.parse(JSON.stringify(p))), JSON.parse(JSON.stringify(p)));
});
