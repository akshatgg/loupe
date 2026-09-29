// Colour lookup tables (.cube LUTs): src/core/lut.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCube, sampleLut } from '../src/core/lut.js';

// A 2-point identity cube, and one that swaps red and blue.
const identity = `TITLE "Identity"
# a comment
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;
const swap = identity.replace('TITLE "Identity"', 'TITLE "Swap"').split('\n').map((l) => {
  const m = /^([\d.]+) ([\d.]+) ([\d.]+)$/.exec(l);
  return m ? `${m[3]} ${m[2]} ${m[1]}` : l;
}).join('\n');

test('a .cube file is read: its size, title and table, red changing fastest', () => {
  const lut = parseCube(identity);
  assert.equal(lut.size, 2);
  assert.equal(lut.title, 'Identity');
  assert.equal(lut.data.length, 2 * 2 * 2 * 3);
  assert.deepEqual([...lut.data.slice(3, 6)], [1, 0, 0], 'the second entry is red');
});

test('looking a colour up: exact at the table’s points, blended between them', () => {
  const lut = parseCube(identity);
  assert.deepEqual(sampleLut(lut, 1, 0, 0), [1, 0, 0]);
  const mid = sampleLut(lut, 0.25, 0.5, 0.75);
  mid.forEach((v, i) => assert.ok(Math.abs(v - [0.25, 0.5, 0.75][i]) < 1e-9));
  assert.deepEqual(sampleLut(parseCube(swap), 1, 0, 0.5), [0.5, 0, 1], 'red and blue swapped');
});

test('bad files are refused in plain words; a DOMAIN is honoured', () => {
  assert.throws(() => parseCube('LUT_1D_SIZE 4\n0 0 0'), /3D/);
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n1 1 1'), /8 colours/);
  assert.throws(() => parseCube('LUT_3D_SIZE 300'), /size/);
  assert.throws(() => parseCube('hello'), /3D/);
  const scaled = parseCube(identity.replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2'));
  assert.deepEqual(sampleLut(scaled, 1, 1, 1), [0.5, 0.5, 0.5], 'inputs scaled from its domain');
});
