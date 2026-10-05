import test from 'node:test';
import assert from 'node:assert/strict';
import { panelFor, itemTitle } from '../src/renderer/editor/inspector.js';
import { describeItems } from '../src/renderer/editor/panels/multi.js';
import * as P from '../src/core/project.js';

test('nothing selected shows the last tab', () => {
  assert.equal(panelFor([], 'style'), 'style');
  assert.equal(panelFor([], 'audio'), 'audio');
});

test('one thing shows the panel for its kind', () => {
  assert.equal(panelFor([{ kind: 'zoom', id: 'z1' }], 'style'), 'zoom');
  assert.equal(panelFor([{ kind: 'clip', id: 'c1' }], 'style'), 'clip');
  assert.equal(panelFor([{ kind: 'overlay', id: 'o1' }], 'style'), 'clip');
  assert.equal(panelFor([{ kind: 'annotation', id: 'a1' }], 'style'), 'annotations');
  assert.equal(panelFor([{ kind: 'caption', id: 's1' }], 'style'), 'captions');
  assert.equal(panelFor([{ kind: 'audio', id: 'a1' }], 'style'), 'audio');
});

test('a marker has no settings: the tab stays', () => {
  assert.equal(panelFor([{ kind: 'marker', id: 'm1' }], 'captions'), 'captions');
});

test('several things show the selection panel', () => {
  assert.equal(panelFor([{ kind: 'zoom', id: 'z1' }, { kind: 'clip', id: 'c1' }], 'style'), 'multi');
});

test('the header names what is selected', () => {
  let p = P.createProject({ main: { width: 1920, height: 1080, duration: 20 }, createdAt: 0 });
  assert.equal(itemTitle(p, []), null);
  assert.equal(itemTitle(p, [{ kind: 'clip', id: p.clips[0].id }]), 'Clip');
  p = P.splitAt(p, 5);
  p = P.splitAt(p, 10);
  assert.equal(itemTitle(p, [{ kind: 'clip', id: p.clips[1].id }]), 'Clip 2');
  const gapped = P.deleteClip(p, p.clips[1].id, { leaveGap: true });
  assert.equal(itemTitle(gapped, [{ kind: 'clip', id: gapped.clips[1].id }]), 'Gap');
  p = P.addZoom(p, { start: 1, end: 3 });
  assert.equal(itemTitle(p, [{ kind: 'zoom', id: 'z1' }]), 'Zoom');
  p = P.addAnnotation(p, { type: 'blur', start: 1, end: 3 });
  assert.equal(itemTitle(p, [{ kind: 'annotation', id: p.annotations[0].id }]), 'Blur');
  assert.equal(itemTitle(p, [{ kind: 'zoom', id: 'z1' }, { kind: 'clip', id: p.clips[0].id }]), '2 items selected');
});

test('several things are described by kind', () => {
  assert.equal(describeItems([{ kind: 'zoom' }, { kind: 'zoom' }, { kind: 'clip' }]), '2 zooms, 1 clip');
});
