'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reserveDuration, durationElement, readId, readSize } = require('../src/main/webm');

// Minimal EBML writing, enough to build a file shaped like Chromium's
// MediaRecorder output: EBML header, a Segment of unknown size, Info without
// a Duration, Tracks, then a Cluster.
function vsize(n) {
  if (n < 0x7f) return Buffer.from([0x80 | n]);
  if (n < 0x3fff) return Buffer.from([0x40 | (n >> 8), n & 0xff]);
  throw new Error('test sizes are small');
}
function el(idHex, ...children) {
  const id = Buffer.from(idHex, 'hex');
  const data = Buffer.concat(children.map((c) => (typeof c === 'string' ? Buffer.from(c) : c)));
  return Buffer.concat([id, vsize(data.length), data]);
}
const uint = (n, bytes) => { const b = Buffer.alloc(bytes); b.writeUIntBE(n, 0, bytes); return b; };
const UNKNOWN = Buffer.from('01ffffffffffffff', 'hex');

function chromiumLikeHead({ timecodeScale = 1000000, segmentSize = null } = {}) {
  const ebml = el('1a45dfa3', el('4286', uint(1, 1)), el('4282', 'webm'));
  const info = el('1549a966', el('2ad7b1', uint(timecodeScale, 3)), el('4d80', 'Chrome'), el('5741', 'Chrome'));
  const tracks = el('1654ae6b', el('ae', el('d7', uint(1, 1)), el('86', 'V_VP9')));
  const cluster = el('1f43b675', el('e7', uint(0, 1)), el('a3', Buffer.from([0x81, 0, 0, 0x80, 1, 2, 3])));
  const body = Buffer.concat([info, tracks, cluster]);
  const size = segmentSize === null ? UNKNOWN : Buffer.concat([Buffer.from([0x01, 0]), uint(body.length, 6)]);
  return { buf: Buffer.concat([ebml, Buffer.from('18538067', 'hex'), size, body]), info, tracks, cluster };
}

// Walks Info's children in a finished file and returns its Duration, if any.
function findDuration(buf) {
  let pos = 0;
  const ebml = readId(buf, pos);
  const ebmlSize = readSize(buf, ebml.length);
  pos = ebml.length + ebmlSize.length + ebmlSize.value;
  const seg = readId(buf, pos);
  const segSize = readSize(buf, pos + seg.length);
  pos += seg.length + segSize.length;
  for (;;) {
    const id = readId(buf, pos);
    const size = readSize(buf, pos + id.length);
    const data = pos + id.length + size.length;
    if (id.id === 0x1549a966) {
      for (let p = data; p < data + size.value;) {
        const c = readId(buf, p);
        const cs = readSize(buf, p + c.length);
        const cd = p + c.length + cs.length;
        if (c.id === 0x4489) return buf.readDoubleBE(cd);
        p = cd + cs.value;
      }
      return null;
    }
    pos = data + size.value;
  }
}

test('room is made inside Info, and the rest of the chunk follows unchanged', () => {
  const { buf, tracks, cluster } = chromiumLikeHead();
  const r = reserveDuration(buf);
  assert.strictEqual(r.chunk.length, buf.length + 11 + 7, '11 reserved bytes plus the widened Info size');
  assert.strictEqual(r.timecodeScale, 1000000);
  assert.ok(r.chunk.subarray(-(tracks.length + cluster.length)).equals(Buffer.concat([tracks, cluster])));
  assert.strictEqual(r.chunk[r.durationOffset], 0xec, 'a Void element sits at the reserved offset');
  assert.strictEqual(findDuration(r.chunk), null, 'no duration yet');
});

test('the duration written into the room reads back in timecode-scale units', () => {
  const { buf } = chromiumLikeHead();
  const r = reserveDuration(buf);
  const file = Buffer.from(r.chunk);
  durationElement(12345.5, r.timecodeScale).copy(file, r.durationOffset);
  assert.strictEqual(findDuration(file), 12345.5);
});

test('a non-default timecode scale is honoured', () => {
  const { buf } = chromiumLikeHead({ timecodeScale: 500000 });
  const r = reserveDuration(buf);
  assert.strictEqual(r.timecodeScale, 500000);
  const file = Buffer.from(r.chunk);
  durationElement(1000, r.timecodeScale).copy(file, r.durationOffset);
  assert.strictEqual(findDuration(file), 2000);
});

test('a known Segment size grows by what was inserted', () => {
  const { buf } = chromiumLikeHead({ segmentSize: true });
  const before = readSize(buf, 4 + readSize(buf, 4).length + readSize(buf, 4).value + 4);
  const r = reserveDuration(buf);
  const segSizePos = 4 + readSize(r.chunk, 4).length + readSize(r.chunk, 4).value + 4;
  const after = readSize(r.chunk, segSizePos);
  assert.strictEqual(after.value - before.value, r.chunk.length - buf.length);
});

test('anything unexpected is left exactly as it was', () => {
  const junk = Buffer.from('not a webm file at all');
  assert.strictEqual(reserveDuration(junk).durationOffset, null);
  assert.ok(reserveDuration(junk).chunk.equals(junk));
  // Header cut short before Info ends.
  const { buf } = chromiumLikeHead();
  assert.strictEqual(reserveDuration(buf.subarray(0, 50)).durationOffset, null);
  // A SeekHead stores byte positions that the insert would break.
  const ebml = el('1a45dfa3', el('4286', uint(1, 1)));
  const withSeek = Buffer.concat([ebml, Buffer.from('18538067', 'hex'), UNKNOWN,
    el('114d9b74', el('4dbb', el('53ab', uint(0x1549a966, 4)))), el('1549a966', el('2ad7b1', uint(1000000, 3)))]);
  assert.strictEqual(reserveDuration(withSeek).durationOffset, null);
});
