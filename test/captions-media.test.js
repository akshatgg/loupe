'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { segmentToOutput, captionsToOutput } = require('../src/core/captions/timeline.js');
const { parseAudioTrack, readAudioTrack, planReads, parseAudioSpecificConfig, listBoxes } = require('../src/core/captions/mp4-audio.js');
const { drawCaptions, layoutCaptions } = require('../src/core/layers/captions.js');

// --- output time -----------------------------------------------------------

// A stand-in for core/timeline.js: clips in order, each at one constant rate.
// Only toOutput is part of the contract captions rely on.
function fakeTimeline(clips) {
  return {
    toOutput(source, t) {
      let out = 0;
      for (const c of clips) {
        const rate = c.rate ?? 1;
        if (c.source === source && t >= c.start && t < c.end) return out + (t - c.start) / rate;
        out += (c.end - c.start) / rate;
      }
      return null;
    }
  };
}

const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

test('an uncut recording keeps caption times as they are', () => {
  const tl = fakeTimeline([{ source: 'main', start: 0, end: 60 }]);
  const cues = segmentToOutput({ id: 'a', source: 'main', start: 2, end: 4, text: 'hi' }, tl);
  assert.strictEqual(cues.length, 1);
  assert.ok(near(cues[0].start, 2) && near(cues[0].end, 4), JSON.stringify(cues));
  assert.deepStrictEqual([cues[0].id, cues[0].text], ['a', 'hi']);
});

test('trimming the start moves captions earlier; a caption fully cut away is gone', () => {
  const tl = fakeTimeline([{ source: 'main', start: 10, end: 60 }]);
  assert.deepStrictEqual(segmentToOutput({ source: 'main', start: 2, end: 4, text: 'x' }, tl), []);
  const [c] = segmentToOutput({ source: 'main', start: 8, end: 12, text: 'x' }, tl);
  assert.ok(near(c.start, 0) && near(c.end, 2), JSON.stringify(c));
});

test('a cut through the middle of a caption shows it on both sides of the cut', () => {
  const tl = fakeTimeline([{ source: 'main', start: 0, end: 5 }, { source: 'main', start: 7, end: 20 }]);
  const cues = segmentToOutput({ source: 'main', start: 4, end: 9, text: 'x' }, tl);
  assert.strictEqual(cues.length, 2, JSON.stringify(cues));
  assert.ok(near(cues[0].start, 4) && near(cues[0].end, 5));
  assert.ok(near(cues[1].start, 5) && near(cues[1].end, 7));
});

test('sped-up and reordered clips map captions correctly', () => {
  const tl = fakeTimeline([
    { source: 'main', start: 10, end: 20, rate: 2 }, // output 0..5
    { source: 'main', start: 0, end: 10 }, // output 5..15
    { source: 'src2', start: 0, end: 4 } // output 15..19
  ]);
  const cues = captionsToOutput([
    { id: 'early', source: 'main', start: 1, end: 3, text: 'early' },
    { id: 'fast', source: 'main', start: 12, end: 16, text: 'fast' },
    { id: 'other', source: 'src2', start: 1, end: 2, text: 'other' }
  ], tl);
  assert.deepStrictEqual(cues.map((c) => c.id), ['fast', 'early', 'other']);
  assert.ok(near(cues[0].start, 1) && near(cues[0].end, 3), JSON.stringify(cues[0]));
  assert.ok(near(cues[1].start, 6) && near(cues[1].end, 8));
  assert.ok(near(cues[2].start, 16) && near(cues[2].end, 17));
});

test('a caption spanning two clips played out of order splits at the join', () => {
  const tl = fakeTimeline([{ source: 'main', start: 5, end: 10 }, { source: 'main', start: 0, end: 5 }]);
  const cues = captionsToOutput([{ source: 'main', start: 4, end: 6, text: 'x' }], tl);
  assert.strictEqual(cues.length, 2, JSON.stringify(cues));
  // 5..6 plays first (output 0..1), 4..5 plays last (output 9..10), with no
  // gap at the join.
  assert.ok(near(cues[0].start, 0, 0.002) && near(cues[0].end, 1, 0.002), JSON.stringify(cues));
  assert.ok(near(cues[1].start, 9, 0.002) && near(cues[1].end, 10, 0.002), JSON.stringify(cues));
});

test('slivers left over by a cut are dropped', () => {
  const tl = fakeTimeline([{ source: 'main', start: 0, end: 4.05 }]);
  assert.deepStrictEqual(segmentToOutput({ source: 'main', start: 4, end: 6, text: 'x' }, tl), []);
});

// --- MP4 audio index -------------------------------------------------------

function box(type, ...payload) {
  const body = Buffer.concat(payload.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
const full = (type, ...payload) => box(type, Buffer.alloc(4), ...payload);
const u32 = (...v) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4)); return b; };
const u16 = (...v) => { const b = Buffer.alloc(2 * v.length); v.forEach((x, i) => b.writeUInt16BE(x, i * 2)); return b; };

// A QuickTime file like AVAssetWriter writes: mdat first (video and audio
// interleaved), then moov with a video track and an AAC track.
function buildMov({ audio = true, edit = true } = {}) {
  const asc = Buffer.from([0x11, 0x90]); // AAC-LC, 48 kHz, 2 channels
  const esds = full('esds',
    Buffer.from([0x03, 25, 0, 1, 0]),
    Buffer.from([0x04, 17, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([0x05, 2]), asc,
    Buffer.from([0x06, 1, 2]));
  const mp4a = box('mp4a',
    Buffer.alloc(6), u16(1), // reserved, data ref index
    u16(0, 0), u32(0), u16(2, 16, 0, 0), u32(48000 * 65536),
    esds);
  const frameSizes = [10, 12, 14, 16, 18];
  // mdat: 8 header + video 100 bytes, audio frames 0-2, video 5000 bytes, audio 3-4
  const mdatStart = 16; // after the 16-byte ftyp
  const firstAudio = mdatStart + 8 + 100;
  const secondAudio = firstAudio + 36 + 5000;
  const mdat = box('mdat', Buffer.alloc(100, 0xee), Buffer.alloc(36, 0xa1), Buffer.alloc(5000, 0xee), Buffer.alloc(34, 0xa2));
  const stbl = box('stbl',
    full('stsd', u32(1), mp4a),
    full('stts', u32(1), u32(5, 1024)),
    full('stsc', u32(2), u32(1, 3, 1), u32(2, 2, 1)),
    full('stsz', u32(0, 5), u32(...frameSizes)),
    full('stco', u32(2), u32(firstAudio, secondAudio)));
  const soundTrak = box('trak',
    edit ? box('edts', full('elst', u32(1), u32(5 * 600, 2048), u16(1, 0))) : Buffer.alloc(0),
    box('mdia',
      full('mdhd', u32(0, 0, 48000, 5 * 1024), u16(0, 0)),
      full('hdlr', u32(0), Buffer.from('soun'), Buffer.alloc(13)),
      box('minf', stbl)));
  const videoTrak = box('trak', box('mdia', full('hdlr', u32(0), Buffer.from('vide'), Buffer.alloc(13))));
  const moov = box('moov', full('mvhd', u32(0, 0, 600, 3000)), videoTrak, ...(audio ? [soundTrak] : []));
  return { file: Buffer.concat([box('ftyp', Buffer.from('qt  '), u32(0)), mdat, moov]), frameSizes, firstAudio, secondAudio };
}

const readerOf = (buf) => async (offset, length) => new Uint8Array(buf.subarray(offset, offset + length));

test('the AAC track of a .mov is indexed without reading the video', async () => {
  const { file, frameSizes, firstAudio, secondAudio } = buildMov();
  const reads = [];
  const read = readerOf(file);
  const track = await readAudioTrack(async (o, l) => { reads.push([o, l]); return read(o, l); });
  assert.strictEqual(track.codec, 'mp4a.40.2');
  assert.strictEqual(track.sampleRate, 48000);
  assert.strictEqual(track.channels, 2);
  assert.deepStrictEqual(Array.from(track.description), [0x11, 0x90]);
  assert.strictEqual(track.count, 5);
  assert.deepStrictEqual(Array.from(track.sizes), frameSizes);
  assert.deepStrictEqual(Array.from(track.offsets), [firstAudio, firstAudio + 10, firstAudio + 22, secondAudio, secondAudio + 16]);
  assert.deepStrictEqual(Array.from(track.times), [0, 1024, 2048, 3072, 4096]);
  // Priming skipped by the edit list: media time 2048 is presentation time 0.
  assert.ok(Math.abs(track.startSeconds - (-2048 / 48000)) < 1e-9);
  assert.ok(Math.abs(track.duration - 5 * 1024 / 48000) < 1e-9);
  // Box headers and the moov only: never the 5 KB of "video".
  assert.ok(reads.every(([, l]) => l < 1000), JSON.stringify(reads));

  // The audio at both ends of the video frame is read in two ranges.
  const plan = planReads(track, { maxGap: 1024 });
  assert.deepStrictEqual(plan.map((r) => [r.first, r.last]), [[0, 2], [3, 4]]);
  assert.deepStrictEqual(planReads(track).map((r) => [r.first, r.last]), [[0, 4]]);
  for (const r of plan) {
    const bytes = await read(r.start, r.end - r.start);
    assert.ok(bytes[0] === 0xa1 || bytes[0] === 0xa2);
  }
});

test('a recording without a sound track has no audio track', () => {
  const { file } = buildMov({ audio: false });
  assert.strictEqual(parseAudioTrack(new Uint8Array(file.subarray(file.indexOf('moov') - 4))), null);
  const { file: noEdit } = buildMov({ edit: false });
  const moov = new Uint8Array(noEdit.subarray(noEdit.indexOf('moov') - 4));
  assert.strictEqual(parseAudioTrack(moov).startSeconds, 0);
});

test('AudioSpecificConfig and box listing handle odd input', () => {
  assert.deepStrictEqual(parseAudioSpecificConfig(Uint8Array.from([0x12, 0x08])), { objectType: 2, sampleRate: 44100, channels: 1 });
  assert.strictEqual(parseAudioSpecificConfig(Uint8Array.from([1])), null);
  // A box claiming more bytes than exist ends the listing instead of throwing.
  const bad = Buffer.concat([box('free', Buffer.alloc(4)), Buffer.from([0, 0, 0xff, 0xff, 0x6d, 0x6f, 0x6f, 0x76])]);
  assert.deepStrictEqual(listBoxes(new Uint8Array(bad)).map((b) => b.type), ['free']);
});

test('real AAC files from afconvert are indexed (macOS)', { skip: process.platform !== 'darwin' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-mp4a-'));
  try {
    const aiff = path.join(dir, 'x.aiff');
    const m4a = path.join(dir, 'x.m4a');
    execFileSync('/usr/bin/say', ['-o', aiff, 'Testing one two three']);
    execFileSync('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac@48000', aiff, m4a]);
    const buf = fs.readFileSync(m4a);
    const track = await readAudioTrack(readerOf(buf));
    const info = execFileSync('/usr/bin/afinfo', [m4a]).toString();
    const duration = Number(/estimated duration: ([\d.]+)/.exec(info)[1]);
    assert.strictEqual(track.codec, 'mp4a.40.2');
    assert.strictEqual(track.sampleRate, 48000);
    assert.ok(track.count > 10);
    // afinfo reports 2112 priming frames; the rest of the difference is the
    // encoder's padding at the end (under one 1024-frame packet).
    assert.ok(Math.abs(track.startSeconds + 2112 / 48000) < 1e-9, String(track.startSeconds));
    const end = track.startSeconds + track.duration;
    assert.ok(end >= duration && end - duration < 1024 / 48000, `${end} ${duration}`);
    for (let i = 0; i < track.count; i++) assert.ok(track.offsets[i] + track.sizes[i] <= buf.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- burned-in captions ------------------------------------------------------

// Records calls; text is measured as half the font size per character.
function fakeCtx() {
  const calls = [];
  let px = 10;
  const ctx = {
    calls,
    set font(f) { px = Number(/(\d+)px/.exec(f)[1]); calls.push(['font', f]); },
    get font() { return `${px}px`; },
    measureText: (s) => ({ width: s.length * px * 0.5 }),
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    beginPath() {}, roundRect() {}, fill: () => calls.push(['fill']),
    fillText: (t, x, y) => calls.push(['fillText', t, x, y])
  };
  return ctx;
}

test('captions sit centered near the bottom (or top) and scale with the frame', () => {
  const area = { x: 0, y: 0, w: 1920, h: 1080 };
  const ctx = fakeCtx();
  const box = drawCaptions(ctx, area, [{ text: 'Hello there' }], { size: 1, position: 'bottom' });
  assert.ok(box.y + box.h < 1080 && box.y > 900, JSON.stringify(box));
  assert.ok(Math.abs(box.x + box.w / 2 - 960) < 1);
  assert.deepStrictEqual(ctx.calls[0], ['save']);
  assert.deepStrictEqual(ctx.calls[ctx.calls.length - 1], ['restore']);
  assert.deepStrictEqual(ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]), ['Hello there']);

  const top = drawCaptions(fakeCtx(), area, [{ text: 'Hello there' }], { position: 'top' });
  assert.ok(top.y < 200);

  // 4K: same share of the frame.
  const big = layoutCaptions(fakeCtx(), { x: 0, y: 0, w: 3840, h: 2160 }, [{ text: 'Hello there' }], {});
  const small = layoutCaptions(fakeCtx(), area, [{ text: 'Hello there' }], {});
  assert.strictEqual(big.px, small.px * 2);
  // Vertical 9:16: sized by the narrow side, wrapped inside the width.
  const tall = layoutCaptions(fakeCtx(), { x: 0, y: 0, w: 1080, h: 1920 },
    [{ text: 'A long caption that will certainly need to wrap onto more than one line here' }], {});
  assert.strictEqual(tall.px, small.px);
  assert.ok(tall.lines.length >= 2 && tall.w <= 1080);
});

test('nothing to show draws nothing; too many lines keep the latest', () => {
  const ctx = fakeCtx();
  assert.strictEqual(drawCaptions(ctx, { x: 0, y: 0, w: 1280, h: 720 }, [], {}), null);
  assert.strictEqual(drawCaptions(ctx, { x: 0, y: 0, w: 1280, h: 720 }, [{ text: '  ' }], {}), null);
  assert.strictEqual(ctx.calls.filter((c) => c[0] === 'fill').length, 0);
  assert.deepStrictEqual(ctx.calls.slice(-1), [['restore']]);
  const l = layoutCaptions(fakeCtx(), { x: 0, y: 0, w: 1280, h: 720 }, [1, 2, 3, 4, 5, 6].map((i) => ({ text: `line ${i}` })), {});
  assert.deepStrictEqual(l.lines, ['line 3', 'line 4', 'line 5', 'line 6']);
});
