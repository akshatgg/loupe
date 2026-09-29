// Songs and sounds as clips on the timeline's audio rows
// (src/core/audio/clips.js and the audio clip edits in src/core/project.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/core/project.js';
import { clipLength, clipEnd, freeLane, MAX_LANES } from '../src/core/audio/clips.js';

const project = (duration = 60) => P.createProject({ main: { width: 100, height: 100, duration, mic: true } });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !== ${b}`);

test('a clip plays for its trimmed length, the rest of its song, or to the end of the video', () => {
  const base = { start: 10, from: 5, length: null, fileDuration: 30, loop: false };
  assert.equal(clipLength(base, 60), 25);
  assert.equal(clipLength({ ...base, length: 8 }, 60), 8);
  assert.equal(clipLength({ ...base, loop: true }, 60), 50, 'repeating: to the end of the video');
  assert.equal(clipLength({ ...base, fileDuration: null }, 60), 50, 'length not known yet');
  assert.equal(clipEnd({ ...base, length: 8 }, 60), 18);
});

test('a new clip takes the first row where it fits', () => {
  const clips = [
    { id: 'a1', start: 0, from: 0, length: 10, lane: 0 },
    { id: 'a2', start: 5, from: 0, length: 10, lane: 1 }
  ];
  assert.equal(freeLane(clips, 20, 30, 60), 0);
  assert.equal(freeLane(clips, 8, 12, 60), 2);
  assert.equal(freeLane(clips, 12, 14, 60), 0);
  assert.equal(freeLane(clips, 12, 14, 60, { prefer: 1 }), 0, 'row 1 is taken there; the first free one');
  assert.equal(freeLane(clips, 16, 20, 60, { prefer: 1 }), 1, 'the row it was dropped on, when free');
  assert.equal(freeLane(clips, 0, 10, 60, { except: 'a1' }), 0, 'a clip never collides with itself');
});

test('adding songs: at the playhead, one row each when they overlap, one undo step each', () => {
  let p = project(60);
  p = P.addAudioClip(p, { file: 'music/a.mp3', name: 'a', start: 0, fileDuration: 40 });
  p = P.addAudioClip(p, { file: 'music/b.mp3', name: 'b', start: 20, fileDuration: 10 });
  p = P.addAudioClip(p, { file: 'music/c.mp3', name: 'c', start: 45, fileDuration: 10 });
  assert.deepEqual(p.audio.clips.map((c) => [c.id, c.start, c.lane]), [['a1', 0, 0], ['a2', 20, 1], ['a3', 45, 0]]);
  const a = p.audio.clips[0];
  assert.equal(a.volume, 0.3);
  assert.equal(a.duck, true);
  assert.equal(a.loop, false);
  assert.deepEqual([a.fadeIn, a.fadeOut, a.from, a.length, a.muted], [0, 0, 0, null, false]);
  assert.throws(() => P.addAudioClip(p, { file: 'music/x.mp3', start: -1 }), /Audio start/);
});

test('moving a clip over another puts it on a free row; trimming and fades are checked', () => {
  let p = project(60);
  p = P.addAudioClip(p, { file: 'music/a.mp3', start: 0, fileDuration: 20 });
  p = P.addAudioClip(p, { file: 'music/b.mp3', start: 30, fileDuration: 20 });
  assert.equal(p.audio.clips[1].lane, 0);
  p = P.updateAudioClip(p, 'a2', { start: 10 });
  assert.equal(p.audio.clips[1].lane, 1, 'overlapping a1 now');
  p = P.updateAudioClip(p, 'a2', { start: 25, lane: 0 });
  assert.equal(p.audio.clips[1].lane, 0, 'back on row 0 once there is room');
  p = P.updateAudioClip(p, 'a1', { from: 4, length: 6, fadeIn: 1, fadeOut: 2, volume: 1.5 });
  assert.deepEqual(['from', 'length', 'fadeIn', 'fadeOut', 'volume'].map((k) => p.audio.clips[0][k]), [4, 6, 1, 2, 1.5]);
  assert.throws(() => P.updateAudioClip(p, 'a1', { volume: 3 }), /Audio volume/);
  assert.throws(() => P.updateAudioClip(p, 'a1', { length: 0 }), /Audio length/);
  assert.throws(() => P.updateAudioClip(p, 'a1', { fadeIn: 4, fadeOut: 4 }), /fades/);
  assert.throws(() => P.updateAudioClip(p, 'nope', { start: 1 }), /No audio clip/);
  assert.throws(() => P.updateAudioClip(p, 'a1', { id: 'x' }), /can't be changed/);
});

test('split at the playhead: two clips that play on from each other', () => {
  let p = project(60);
  p = P.addAudioClip(p, { file: 'music/a.mp3', start: 10, fileDuration: 30 });
  p = P.updateAudioClip(p, 'a1', { from: 2, fadeIn: 1, fadeOut: 1 });
  p = P.splitAudioClip(p, 'a1', 15);
  const [a, b] = p.audio.clips;
  assert.deepEqual([a.start, a.from, a.length, a.fadeIn, a.fadeOut], [10, 2, 5, 1, 0]);
  assert.deepEqual([b.id, b.start, b.from, b.length, b.fadeIn, b.fadeOut, b.lane], ['a2', 15, 7, null, 0, 1, a.lane]);
  near(clipEnd(b, 60), 10 + 28);
  assert.throws(() => P.splitAudioClip(p, 'a1', 10.01), /edge/);
  assert.throws(() => P.splitAudioClip(p, 'a1', 40), /inside/);
});

test('duplicate goes right after the original; remove takes it away', () => {
  let p = project(60);
  p = P.addAudioClip(p, { file: 'music/a.mp3', start: 0, fileDuration: 10 });
  p = P.duplicateAudioClip(p, 'a1');
  assert.deepEqual(p.audio.clips.map((c) => [c.id, c.start, c.lane, c.file]), [['a1', 0, 0, 'music/a.mp3'], ['a2', 10, 0, 'music/a.mp3']]);
  p = P.removeAudioClip(p, 'a1');
  assert.deepEqual(p.audio.clips.map((c) => c.id), ['a2']);
});

test('a project from before audio clips: its music becomes a clip that repeats as it did', () => {
  const p = project(60);
  const old = { ...p, audio: { ...p.audio, music: { file: 'music/song.mp3', volume: 0.4, duck: false, start: 3, from: 7 } } };
  delete old.audio.clips;
  const loaded = P.loadProjectData(JSON.parse(JSON.stringify(old)));
  assert.equal('music' in loaded.audio, false);
  const [c] = loaded.audio.clips;
  assert.deepEqual(
    [c.id, c.file, c.name, c.start, c.from, c.length, c.volume, c.duck, c.loop, c.fadeOut, c.lane],
    ['a1', 'music/song.mp3', 'song', 3, 7, null, 0.4, false, true, 3, 0]
  );
  const none = { ...p, audio: { ...p.audio, music: null } };
  delete none.audio.clips;
  assert.deepEqual(P.loadProjectData(JSON.parse(JSON.stringify(none))).audio.clips, []);
});

test('rows are limited', () => {
  let p = project(60);
  for (let i = 0; i < MAX_LANES; i++) p = P.addAudioClip(p, { file: `music/${i}.mp3`, start: 0, fileDuration: 10 });
  assert.equal(new Set(p.audio.clips.map((c) => c.lane)).size, MAX_LANES);
  assert.throws(() => P.addAudioClip(p, { file: 'music/x.mp3', start: 0, fileDuration: 10 }), /rows/);
});

// ---- volume points, rows, detach

import { clipGainAt, splitPoints, shiftPoints, laneOf } from '../src/core/audio/clips.js';

test('volume points: the clip volume changes over time between them; without points it is the volume', () => {
  const flat = { volume: 0.4, points: [] };
  assert.equal(clipGainAt(flat, 3), 0.4);
  const c = { volume: 0.4, points: [{ t: 1, gain: 1 }, { t: 3, gain: 0.2 }] };
  assert.equal(clipGainAt(c, 0), 1, 'before the first point: its level');
  near(clipGainAt(c, 2), 0.6, 1e-9);
  assert.equal(clipGainAt(c, 9), 0.2, 'after the last: its level');
});

test('volume points follow a split and a trimmed start', () => {
  const pts = [{ t: 1, gain: 1 }, { t: 3, gain: 0.2 }];
  const [a, b] = splitPoints(pts, 2);
  assert.deepEqual(a.map((p) => p.t), [1, 2]);
  assert.deepEqual(b.map((p) => p.t), [0, 1]);
  near(a[1].gain, 0.6, 1e-9);
  near(b[0].gain, 0.6, 1e-9);
  const shifted = shiftPoints(pts, 2);
  assert.deepEqual(shifted.map((p) => p.t), [0, 1]);
  near(shifted[0].gain, 0.6, 1e-9);
  assert.deepEqual(shiftPoints([], 2), []);
});

test('points are checked, kept in time order, and a split keeps the envelope', () => {
  let p = project(60);
  p = P.addAudioClip(p, { file: 'music/a.mp3', start: 0, fileDuration: 10 });
  p = P.updateAudioClip(p, 'a1', { points: [{ t: 4, gain: 0.5 }, { t: 1, gain: 1.5 }] });
  assert.deepEqual(p.audio.clips[0].points.map((q) => q.t), [1, 4], 'sorted');
  assert.throws(() => P.updateAudioClip(p, 'a1', { points: [{ t: 1, gain: 3 }] }), /Volume point/);
  p = P.splitAudioClip(p, 'a1', 2);
  assert.equal(p.audio.clips[0].points.at(-1).t, 2);
  assert.equal(p.audio.clips[1].points[0].t, 0);
});

test('rows: mute, solo and lock are kept per row; a locked row refuses changes and new clips', () => {
  let p = project(60);
  p = P.addAudioClip(p, { file: 'music/a.mp3', start: 0, fileDuration: 10 });
  p = P.setAudioLane(p, 0, { locked: true });
  assert.deepEqual(laneOf(p.audio, 0), { muted: false, solo: false, locked: true });
  assert.deepEqual(laneOf(p.audio, 3), { muted: false, solo: false, locked: false });
  assert.throws(() => P.updateAudioClip(p, 'a1', { start: 2 }), /locked/);
  assert.throws(() => P.removeAudioClip(p, 'a1'), /locked/);
  assert.throws(() => P.splitAudioClip(p, 'a1', 5), /locked/);
  p = P.addAudioClip(p, { file: 'music/b.mp3', start: 20, fileDuration: 5 });
  assert.equal(p.audio.clips[1].lane, 1, 'a new clip skips the locked row');
  p = P.setAudioLane(p, 1, { muted: true, solo: true });
  assert.deepEqual(laneOf(p.audio, 1), { muted: true, solo: true, locked: false });
  assert.throws(() => P.setAudioLane(p, 9, { muted: true }), /row/);
  assert.throws(() => P.setAudioLane(p, 0, { loud: true }), /Unknown/);
});

test('detach: a video clip’s own sound becomes an audio clip at the same moment; reattach puts it back', () => {
  let p = project(20);
  p = P.cutRange(p, 5, 8); // clips 0-5 and 8-20 of the recording
  p = P.detachAudio(p, p.clips[1].id);
  assert.equal(p.clips[1].detached, true);
  assert.equal(p.clips[0].detached ?? false, false);
  const [c] = p.audio.clips;
  assert.deepEqual([c.source, c.file, c.start, c.from, c.length, c.volume, c.duck], ['main', null, 5, 8, 12, 1, false]);
  assert.throws(() => P.detachAudio(p, p.clips[1].id), /already/);
  p = P.detachAllAudio(p);
  assert.equal(p.clips.every((k) => k.detached), true);
  assert.equal(p.audio.clips.length, 2);
  p = P.reattachAudio(p, 'a1');
  assert.equal(p.clips[1].detached, false);
  assert.equal(p.audio.clips.length, 1);
  // A part with a speed change can't be detached (its sound would drift).
  let s = P.paintSpeed(project(20), { start: 2, end: 4, rate: 2 });
  assert.throws(() => P.detachAudio(s, s.clips[0].id), /speed/);
  s = P.detachAllAudio(s);
  assert.equal(s.audio.clips.length, 0);
});
