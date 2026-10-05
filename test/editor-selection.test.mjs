import test from 'node:test';
import assert from 'node:assert/strict';
import { sameItem, hasItem, toggleItem, aliveItems } from '../src/renderer/editor/selection.js';
import { createStore } from '../src/renderer/editor/store.js';
import { createProject, addZoom, removeZoom } from '../src/core/project.js';

const project = () => {
  let p = createProject({ main: { width: 1920, height: 1080, duration: 20 }, createdAt: 0 });
  p = addZoom(p, { start: 1, end: 3 });
  return addZoom(p, { start: 5, end: 7 });
};

test('items are the same by kind and id; speed by its range', () => {
  assert.ok(sameItem({ kind: 'zoom', id: 'z1' }, { kind: 'zoom', id: 'z1' }));
  assert.ok(!sameItem({ kind: 'zoom', id: 'z1' }, { kind: 'clip', id: 'z1' }));
  assert.ok(sameItem({ kind: 'speed', source: 'main', start: 1, end: 2 }, { kind: 'speed', source: 'main', start: 1, end: 2 }));
  assert.ok(!sameItem({ kind: 'speed', source: 'main', start: 1, end: 2 }, { kind: 'speed', source: 'main', start: 1, end: 3 }));
});

test('toggle adds, then removes', () => {
  const a = { kind: 'zoom', id: 'z1' };
  const once = toggleItem([], a);
  assert.ok(hasItem(once, a));
  assert.deepEqual(toggleItem(once, a), []);
});

test('aliveItems drops what the project no longer has, and keeps the list when nothing went', () => {
  const p = project();
  assert.deepEqual(aliveItems(p, [{ kind: 'zoom', id: 'z1' }, { kind: 'zoom', id: 'gone' }]), [{ kind: 'zoom', id: 'z1' }]);
  const all = [{ kind: 'zoom', id: 'z1' }, { kind: 'zoom', id: 'z2' }];
  assert.equal(aliveItems(p, all), all);
});

test('the store selects one, adds, toggles and reports one selection only when one', () => {
  const store = createStore(project());
  const events = [];
  store.subscribe((what) => events.push(what));
  store.select({ kind: 'zoom', id: 'z1' });
  assert.deepEqual(store.selection, { kind: 'zoom', id: 'z1' });
  store.select({ kind: 'zoom', id: 'z2' }, { add: true });
  assert.equal(store.selected.length, 2);
  assert.equal(store.selection, null);
  store.select({ kind: 'zoom', id: 'z2' }, { add: true });
  assert.equal(store.selected.length, 2, 'adding what is selected changes nothing');
  store.select({ kind: 'zoom', id: 'z2' }, { toggle: true });
  assert.deepEqual(store.selected, [{ kind: 'zoom', id: 'z1' }]);
  store.select(null);
  assert.deepEqual(store.selected, []);
  assert.ok(events.every((e) => e === 'selection'));
});

test('selectMany drops repeats and things that are not there', () => {
  const store = createStore(project());
  store.selectMany([{ kind: 'zoom', id: 'z1' }, { kind: 'zoom', id: 'z1' }, { kind: 'zoom', id: 'nope' }, { kind: 'zoom', id: 'z2' }]);
  assert.deepEqual(store.selected.map((s) => s.id), ['z1', 'z2']);
});

test('an edit that removes a selected item drops it from the selection', () => {
  const store = createStore(project());
  store.selectMany([{ kind: 'zoom', id: 'z1' }, { kind: 'zoom', id: 'z2' }]);
  store.apply((p) => removeZoom(p, 'z1'));
  assert.deepEqual(store.selected, [{ kind: 'zoom', id: 'z2' }]);
  store.undo();
  assert.deepEqual(store.selected, [{ kind: 'zoom', id: 'z2' }]);
});
