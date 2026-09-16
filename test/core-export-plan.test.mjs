import test from 'node:test';
import assert from 'node:assert';
import * as P from '../src/core/project.js';
import * as E from '../src/core/export-plan.js';

const MAIN = { kind: 'display', width: 1600, height: 1000, duration: 30, mic: true };
const fresh = () => P.createProject({ main: MAIN, createdAt: 0 });

test('new projects have the GIF and size limit settings, and old ones gain them', () => {
  const p = fresh();
  assert.strictEqual(p.export.sizeLimit, null);
  assert.strictEqual(p.export.gifWidth, 960);
  assert.strictEqual(p.export.gifFps, 15);
  assert.strictEqual(p.export.dither, true);
  const old = { ...p, export: { format: 'mp4', resolution: '720p', quality: 'high', fps: 60, codec: 'h264' } };
  const loaded = P.validateProject(old);
  assert.strictEqual(loaded.export.resolution, '720p');
  assert.strictEqual(loaded.export.gifWidth, 960);
});

test('export settings are checked', () => {
  const p = fresh();
  assert.strictEqual(P.setExport(p, { sizeLimit: 25 }).export.sizeLimit, 25);
  assert.strictEqual(P.setExport(p, { sizeLimit: 12.5 }).export.sizeLimit, 12.5);
  assert.throws(() => P.setExport(p, { sizeLimit: 0 }), /size limit/);
  assert.throws(() => P.setExport(p, { gifWidth: 1000 }), /GIF width/);
  assert.throws(() => P.setExport(p, { gifFps: 60 }), /GIF frame rate/);
  assert.throws(() => P.setExport(p, { dither: 'yes' }), /dithering/);
  assert.throws(() => P.setExport(p, { format: 'avi' }), /Export format/);
});

test('output size and frame rate per format', () => {
  const p = fresh();
  assert.deepStrictEqual(E.outputSize(p), { width: 1728, height: 1080 });
  assert.strictEqual(E.outputFps(p.export), 60);
  const gif = { ...p.export, format: 'gif' };
  assert.deepStrictEqual(E.outputSize(p, gif), { width: 960, height: 600 });
  assert.strictEqual(E.outputFps(gif), 15);
  assert.deepStrictEqual(E.outputSize(p, { ...gif, gifWidth: 480 }), { width: 480, height: 300 });
  // Portrait: 1080p 9:16 is 1080 wide, so a 960 GIF stays 960 and keeps the shape.
  const portrait = P.setStyle(p, { aspect: '9:16' });
  assert.deepStrictEqual(E.outputSize(portrait, gif), { width: 960, height: 1706 });
  assert.strictEqual(E.exportFileName(gif, { width: 960, height: 600 }), 'export-960x600.gif');
  assert.strictEqual(E.exportFileName({ format: 'webm' }, { width: 2, height: 2 }), 'export-2x2.webm');
  assert.strictEqual(E.exportFileName({ format: 'mp4' }, { width: 2, height: 2 }), 'export-2x2.mp4');
});

test('a size limit picks the bitrate from the duration', () => {
  const size = { width: 1920, height: 1080, fps: 60 };
  const a = E.bitrateForLimit({ ...size, duration: 60, limitMB: 25 });
  // 25 MB over 60 s with margin, minus 160 kb/s of sound.
  assert.ok(a.fits);
  assert.ok(Math.abs(a.bitrate - (25e6 * 8 * 0.92 / 60 - 160000)) < 1);
  // Twice as long, about half the bitrate.
  const b = E.bitrateForLimit({ ...size, duration: 120, limitMB: 25 });
  assert.ok(b.bitrate < a.bitrate / 2 + 100000 && b.bitrate > a.bitrate / 2 - 100000);
  // Without sound there is more room for the picture.
  assert.ok(E.bitrateForLimit({ ...size, duration: 60, limitMB: 25, audio: false }).bitrate > a.bitrate);
  // A short clip never goes above High quality.
  const short = E.bitrateForLimit({ ...size, duration: 2, limitMB: 25 });
  assert.strictEqual(short.bitrate, E.qualityBitrate({ ...size, quality: 'high' }));
  // An hour in 10 MB can't be done.
  assert.strictEqual(E.bitrateForLimit({ ...size, duration: 3600, limitMB: 10 }).fits, false);
  // WebM sound is Opus at a lower rate.
  assert.ok(E.bitrateForLimit({ ...size, format: 'webm', duration: 60, limitMB: 25 }).bitrate > a.bitrate);
});

test('videoBitrate follows the quality, or the limit when there is one', () => {
  const dims = { width: 1920, height: 1080, fps: 30, duration: 10 };
  const high = E.videoBitrate({ format: 'mp4', quality: 'high', sizeLimit: null }, dims);
  const small = E.videoBitrate({ format: 'mp4', quality: 'small', sizeLimit: null }, dims);
  assert.ok(high > small);
  assert.ok(E.videoBitrate({ format: 'webm', quality: 'high', sizeLimit: null }, dims) < high, 'VP9 needs fewer bits');
  const limited = E.videoBitrate({ format: 'mp4', quality: 'high', sizeLimit: 1 }, dims);
  assert.ok(Math.abs(limited - (1e6 * 8 * 0.92 / 10 - 160000)) < 1);
});

test('estimates and warnings', () => {
  const p = fresh();
  const tenSeconds = E.describeExport(p, { ...p.export, format: 'gif' }, { duration: 10 });
  assert.strictEqual(tenSeconds.width, 960);
  assert.strictEqual(tenSeconds.fps, 15);
  assert.ok(tenSeconds.bytes > 1e6 && tenSeconds.bytes < 25e6, `${tenSeconds.bytes}`);
  assert.strictEqual(tenSeconds.warning, null);
  const long = E.describeExport(p, { ...p.export, format: 'gif' }, { duration: 45 });
  assert.match(long.warning, /MP4/);
  const plainDither = E.estimateBytes({ format: 'gif', dither: false }, { width: 960, height: 600, fps: 15, duration: 10 });
  assert.ok(plainDither < tenSeconds.bytes, 'dithering makes GIFs bigger');

  const mp4 = E.describeExport(p, p.export, { duration: 30 });
  assert.strictEqual(mp4.warning, null);
  assert.ok(mp4.bytes > 0);
  const fits = E.describeExport(p, { ...p.export, sizeLimit: 25 }, { duration: 30 });
  assert.ok(fits.bytes <= 25e6);
  assert.strictEqual(fits.limitTooSmall, false);
  const tooSmall = E.describeExport(p, { ...p.export, sizeLimit: 1 }, { duration: 600 });
  assert.strictEqual(tooSmall.limitTooSmall, true);
  assert.match(tooSmall.warning, /won’t fit in 1 MB/);
});

test('formatBytes reads naturally', () => {
  assert.strictEqual(E.formatBytes(0), '0 KB');
  assert.strictEqual(E.formatBytes(800), '1 KB');
  assert.strictEqual(E.formatBytes(812_000), '812 KB');
  assert.strictEqual(E.formatBytes(2_000_000), '2 MB');
  assert.strictEqual(E.formatBytes(2_450_000), '2.5 MB');
  assert.strictEqual(E.formatBytes(24_600_000), '25 MB');
});
