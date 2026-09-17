// The export's WebM reader (src/renderer/exporter/webm-demux.js), on WebM
// built byte by byte: live-style unknown sizes as MediaRecorder writes them,
// known sizes as other tools do, BlockGroups, lacing and a cut-off file.
import test from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { demuxWebm, codecString } from '../src/renderer/exporter/webm-demux.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

function idBytes(id) {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}

function sizeBytes(n) {
  if (n === null) return [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  if (n < 127) return [0x80 | n];
  return [0x40 | (n >> 8), n & 0xff];
}

const el = (id, ...children) => {
  const body = children.flat(Infinity);
  return [...idBytes(id), ...sizeBytes(body.length), ...body];
};
const open = (id, ...children) => [...idBytes(id), ...sizeBytes(null), ...children.flat(Infinity)];
const uint = (id, v, len = 1) => el(id, Array.from({ length: len }, (_, i) => (v >> (8 * (len - 1 - i))) & 0xff));
const str = (id, s) => el(id, [...s].map((c) => c.charCodeAt(0)));

function block(track, rel, flags, payload) {
  return [0x80 | track, (rel >> 8) & 0xff, rel & 0xff, flags, ...payload];
}
const simple = (track, rel, key, payload) => el(0xa3, block(track, rel, key ? 0x80 : 0, payload));

function file({ live = true, codec = 'V_VP9', extraTrack = true, blocks }) {
  const header = el(0x1a45dfa3, str(0x4282, 'webm'));
  const info = el(0x1549a966, uint(0x2ad7b1, 1000000, 3));
  const tracks = el(0x1654ae6b,
    extraTrack ? el(0xae, uint(0xd7, 1), uint(0x83, 2), str(0x86, 'A_OPUS')) : [],
    el(0xae, uint(0xd7, 2), uint(0x83, 1), str(0x86, codec), el(0xe0, uint(0xb0, 320, 2), uint(0xba, 240, 1))));
  const body = [info, tracks, ...blocks];
  return new Uint8Array(live ? [...header, ...open(0x18538067, body)] : [...header, ...el(0x18538067, body)]).buffer;
}

test('reads a live MediaRecorder-style file: unknown sizes, SimpleBlocks, the video track only', () => {
  const buf = file({
    blocks: [
      open(0x1f43b675, uint(0xe7, 0), simple(2, 0, true, [1, 2, 3]), simple(1, 5, true, [9]), simple(2, 33, false, [4, 5])),
      open(0x1f43b675, uint(0xe7, 1000, 2), simple(2, 0, true, [6]), simple(2, 34, false, [7, 8, 9, 10]))
    ]
  });
  const { video } = demuxWebm(buf);
  assert.strictEqual(video.codec, 'vp09.00.10.08');
  assert.deepStrictEqual([video.width, video.height], [320, 240]);
  assert.deepStrictEqual(video.samples.map((s) => [s.time, s.key, s.size]),
    [[0, true, 3], [0.033, false, 2], [1, true, 1], [1.034, false, 4]]);
  near(video.samples[0].duration, 0.033);
  near(video.samples[1].duration, 0.967);
  const bytes = new Uint8Array(buf);
  assert.deepStrictEqual(Array.from(bytes.subarray(video.samples[3].offset, video.samples[3].offset + 4)), [7, 8, 9, 10]);
});

test('known sizes, BlockGroups (key unless referenced), lacing skipped, a cut-off last frame dropped', () => {
  const group = (rel, ref, payload) => el(0xa0, el(0xa1, block(2, rel, 0, payload)), ref ? uint(0xfb, 1) : []);
  const laced = el(0xa3, block(2, 10, 0x82, [1, 2]));
  const buf = file({
    live: false, codec: 'V_VP8', extraTrack: false,
    blocks: [el(0x1f43b675, uint(0xe7, 0), group(0, false, [1]), laced, group(40, true, [2, 2]))]
  });
  const { video } = demuxWebm(buf);
  assert.strictEqual(video.codec, 'vp8');
  assert.deepStrictEqual(video.samples.map((s) => [s.time, s.key]), [[0, true], [0.04, false]]);
  // The same file cut off in the middle of its last frame (just before its
  // 3-byte ReferenceBlock).
  const cut = buf.slice(0, buf.byteLength - 4);
  assert.strictEqual(demuxWebm(cut).video.samples.length, 1);
});

test('codec names, and files that are not WebM video', () => {
  assert.strictEqual(codecString('V_AV1'), 'av01.0.04M.08');
  assert.strictEqual(codecString('V_MPEG4/ISO/AVC', new Uint8Array([1, 0x64, 0, 0x1f])), 'avc1.64001f');
  assert.strictEqual(codecString('V_THEORA'), null);
  assert.throws(() => demuxWebm(new Uint8Array([1, 2, 3, 4]).buffer), /WebM/);
  assert.throws(() => demuxWebm(file({ codec: 'V_THEORA', blocks: [] })), /format/);
  const audioOnly = new Uint8Array([...el(0x1a45dfa3, []), ...open(0x18538067, el(0x1654ae6b, el(0xae, uint(0xd7, 1), uint(0x83, 2), str(0x86, 'A_OPUS'))))]);
  assert.strictEqual(demuxWebm(audioOnly.buffer).video, null);
});

// The e2e suite records a real one with MediaRecorder; when it's there, read it too.
const REAL = new URL('./e2e/out/visuals/fixture/webcam.webm', import.meta.url);
test('a real MediaRecorder recording (made by npm run test:e2e:visuals)', { skip: !existsSync(REAL) }, () => {
  const buf = readFileSync(REAL);
  const { video } = demuxWebm(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.match(video.codec, /^vp(8|09)/);
  assert.ok(video.samples.length > 60, `${video.samples.length} frames`);
  assert.ok(video.samples[0].key);
  const last = video.samples.at(-1);
  assert.ok(last.time > 3.5 && last.time < 5, `ends at ${last.time}`);
});
