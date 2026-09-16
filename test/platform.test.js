'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  helperCommand, captureFileName, recordingsRoot, coordinateMapper, attachThumbnails
} = require('../src/main/platform');
const { createRecorder } = require('../src/main/recorder');

test('macOS runs one binary per helper', () => {
  assert.deepStrictEqual(helperCommand('/b', 'capture', 'darwin'), { file: path.join('/b', 'capture'), args: [] });
});

test('Windows runs loupe-native.exe with the helper as its first argument', () => {
  assert.deepStrictEqual(helperCommand('/b', 'render', 'win32'),
    { file: path.join('/b', 'loupe-native.exe'), args: ['render'] });
});

test('the capture file is a .mov on macOS and an .mp4 on Windows', () => {
  assert.strictEqual(captureFileName('darwin'), 'raw.mov');
  assert.strictEqual(captureFileName('win32'), 'raw.mp4');
});

test('recordings go to Movies on macOS and Videos on Windows', () => {
  const getPath = (name) => (name === 'videos' ? path.join('C:', 'Users', 'a', 'Videos') : null);
  assert.strictEqual(recordingsRoot(getPath, '/Users/a', 'darwin'), path.join('/Users/a', 'Movies', 'Loupe'));
  assert.strictEqual(recordingsRoot(getPath, '/Users/a', 'win32'), path.join('C:', 'Users', 'a', 'Videos', 'Loupe'));
});

test('coordinates pass through untouched on macOS', () => {
  const map = coordinateMapper(() => { throw new Error('screen must not be touched'); }, 'darwin');
  assert.deepStrictEqual(map.toDipPoint({ x: 3, y: 4 }), { x: 3, y: 4 });
  assert.deepStrictEqual(map.toScreenRect({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 });
});

test('on Windows coordinates go through Electron\'s DIP conversion', () => {
  const screen = {
    screenToDipPoint: (p) => ({ x: p.x / 1.5, y: p.y / 1.5 }),
    screenToDipRect: (_w, r) => ({ x: r.x / 1.5, y: r.y / 1.5, width: r.width / 1.5, height: r.height / 1.5 }),
    dipToScreenRect: (_w, r) => ({ x: r.x * 1.5, y: r.y * 1.5, width: r.width * 1.5, height: r.height * 1.5 })
  };
  const map = coordinateMapper(() => screen, 'win32');
  assert.deepStrictEqual(map.toDipPoint({ x: 150, y: 300 }), { x: 100, y: 200 });
  assert.deepStrictEqual(map.toDipRect({ x: 0, y: 0, width: 1920, height: 1080 }), { x: 0, y: 0, width: 1280, height: 720 });
  assert.deepStrictEqual(map.toScreenRect({ x: 10, y: 20, width: 100, height: 50 }), { x: 15, y: 30, width: 150, height: 75 });
});

test('thumbnails attach to windows by handle and to displays by position', () => {
  const image = (url) => ({ isEmpty: () => false, toDataURL: () => url });
  const sources = [
    { id: 'display:65537', kind: 'display', x: 1280, y: 0, width: 1280, height: 720, thumbnail: null },
    { id: 'window:1234', kind: 'window', x: 10, y: 10, width: 400, height: 300, thumbnail: null },
    { id: 'window:999', kind: 'window', x: 10, y: 10, width: 400, height: 300, thumbnail: null }
  ];
  const captured = [
    { id: 'screen:1:0', display_id: '42', thumbnail: image('data:second') },
    { id: 'window:1234:0', display_id: '', thumbnail: image('data:win') }
  ];
  const displays = [{ id: 7, bounds: { x: 0, y: 0 } }, { id: 42, bounds: { x: 1280, y: 0 } }];
  const out = attachThumbnails(sources, captured, displays);
  assert.strictEqual(out[0].thumbnail, 'data:second');
  assert.strictEqual(out[1].thumbnail, 'data:win');
  assert.strictEqual(out[2].thumbnail, null);
});

test('a Windows recorder spawns loupe-native, maps input to DIPs and the crop to pixels', async () => {
  const spawned = [];
  const sinks = {};
  const spawnHelper = (file, args, opts) => {
    spawned.push({ file, args });
    sinks[args[0]] = opts.onMessage;
    return { kill() {}, exitCode: null, signalCode: null, once() {} };
  };
  const rec = createRecorder({
    binDir: 'C:\\app\\bin', spawnHelper, stopHelper: async () => 0, platform: 'win32',
    toDipPoint: (p) => ({ x: p.x / 2, y: p.y / 2 }),
    toCaptureRect: (r) => ({ x: r.x * 2, y: r.y * 2, width: r.width * 2, height: r.height * 2 })
  });
  await rec.start({
    source: 'display:1', mic: false, dir: 'C:\\rec', x: 0, y: 0, width: 800, height: 600,
    region: { x: 100, y: 50, width: 400, height: 300 }, inputTapArgs: ['--zoom-triggers', 'option']
  });

  const capture = spawned.find((s) => s.args[0] === 'capture');
  assert.ok(capture.file.endsWith('loupe-native.exe'));
  assert.ok(capture.args.includes(path.join('C:\\rec', 'raw.mp4')));
  const at = (flag) => capture.args[capture.args.indexOf(flag) + 1];
  assert.deepStrictEqual([at('--crop-x'), at('--crop-y'), at('--crop-w'), at('--crop-h')], ['200', '100', '800', '600']);
  assert.deepStrictEqual(spawned.find((s) => s.args[0] === 'inputtap').args, ['inputtap', '--zoom-triggers', 'option']);

  sinks.capture({ type: 'started', clock: 10 });
  // 440,300 physical is 220,150 in DIPs, which is 120,100 inside the region.
  sinks.inputtap({ type: 'click', clock: 11, x: 440, y: 300, button: 'left' });
  assert.deepStrictEqual(rec.state().clicks[0], { t: 1, x: 120, y: 100, button: 'left' });
});
