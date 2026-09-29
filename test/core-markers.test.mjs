// Markers: notes on moments of the video (src/core/project.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/core/project.js';

const project = () => P.createProject({ main: { width: 100, height: 100, duration: 30 } });

test('markers: added at a moment, kept in time order, renamed, recoloured, moved and removed', () => {
  let p = project();
  assert.deepEqual(p.markers, []);
  p = P.addMarker(p, { t: 12 });
  p = P.addMarker(p, { t: 3, label: 'Intro ends' });
  assert.deepEqual(p.markers.map((m) => [m.id, m.t, m.label, m.color]), [['m2', 3, 'Intro ends', 'yellow'], ['m1', 12, '', 'yellow']]);
  p = P.updateMarker(p, 'm1', { label: 'Demo', color: 'red', t: 1 });
  assert.deepEqual(p.markers.map((m) => m.id), ['m1', 'm2'], 'resorted');
  assert.throws(() => P.updateMarker(p, 'm1', { color: 'plaid' }), /colour/);
  assert.throws(() => P.addMarker(p, { t: -1 }), /Marker time/);
  assert.throws(() => P.addMarker(p, { t: 3 }), /already a marker/);
  p = P.removeMarker(p, 'm2');
  assert.deepEqual(p.markers.map((m) => m.id), ['m1']);
  // A project from before markers opens with none.
  const old = JSON.parse(JSON.stringify(project()));
  delete old.markers;
  assert.deepEqual(P.loadProjectData(old).markers, []);
});
