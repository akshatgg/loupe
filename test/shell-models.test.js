'use strict';
// The Library and Settings windows' pure helpers (ES modules, loaded with
// require() -- Node supports that for ESM without top-level await).
const test = require('node:test');
const assert = require('node:assert');
const { formatDuration, formatDate, filterAndSort, countLabel } = require('../src/renderer/library/model.js');
const {
  deviceOptions, updateView, presetSwatch, FORMAT_HELP, QUALITY_HELP, SECTIONS
} = require('../src/renderer/settings/model.js');
const { SECTIONS: MAIN_SECTIONS } = require('../src/main/app-shell');
const { EXPORT_FORMATS, EXPORT_QUALITIES } = require('../src/main/settings');

test('lengths read like a video player\'s', () => {
  assert.strictEqual(formatDuration(0), '0:00');
  assert.strictEqual(formatDuration(7.4), '0:07');
  assert.strictEqual(formatDuration(125), '2:05');
  assert.strictEqual(formatDuration(3725), '1:02:05');
  assert.strictEqual(formatDuration(59.6), '1:00');
  assert.strictEqual(formatDuration(null), '');
  assert.strictEqual(formatDuration(NaN), '');
});

test('dates: today, yesterday, this week by name, older by date', () => {
  const now = new Date(2026, 8, 16, 19, 30).getTime(); // Wed 16 Sep 2026
  const at = (d, h, m) => new Date(2026, 8, d, h, m).getTime();
  assert.match(formatDate(at(16, 9, 5), now, 'en-GB'), /^Today, 09:05$/);
  assert.match(formatDate(at(15, 23, 59), now, 'en-GB'), /^Yesterday, 23:59$/);
  assert.match(formatDate(at(14, 8, 0), now, 'en-GB'), /^Monday, 08:00$/);
  assert.match(formatDate(at(3, 10, 15), now, 'en-GB'), /^3 Sept? 2026, 10:15$/);
});

const recs = [
  { id: 'a', title: 'Checkout flow', createdAt: new Date(2026, 8, 10).getTime(), duration: 30 },
  { id: 'b', title: 'Recording 12 Sept 2026, 10:00', createdAt: new Date(2026, 8, 12).getTime(), duration: 5 },
  { id: 'c', title: 'Café demo', createdAt: new Date(2026, 7, 1).getTime(), duration: null },
  { id: 'd', title: 'recording 2', createdAt: new Date(2026, 8, 11).getTime(), duration: 90 },
  { id: 'e', title: 'Recording 10', createdAt: new Date(2026, 8, 9).getTime(), duration: 90 }
];
const ids = (list) => list.map((r) => r.id).join('');
const opts = { now: new Date(2026, 8, 16).getTime(), locale: 'en-GB' };

test('sorting: newest, oldest, by name (numbers in order), longest', () => {
  assert.strictEqual(ids(filterAndSort(recs, { ...opts, sort: 'newest' })), 'bdaec');
  assert.strictEqual(ids(filterAndSort(recs, { ...opts, sort: 'oldest' })), 'ceadb');
  assert.strictEqual(ids(filterAndSort(recs, { ...opts, sort: 'name' })), 'cadeb');
  assert.strictEqual(ids(filterAndSort(recs, { ...opts, sort: 'longest' })), 'deabc');
  assert.strictEqual(ids(filterAndSort(recs, { ...opts, sort: 'bogus' })), 'bdaec');
  assert.strictEqual(recs[0].id, 'a', 'the input is not reordered');
});

test('search: every word, any case or accent, in the title or the date', () => {
  assert.strictEqual(ids(filterAndSort(recs, { ...opts, query: 'CHECKOUT' })), 'a');
  assert.strictEqual(ids(filterAndSort(recs, { ...opts, query: 'cafe' })), 'c');
  assert.strictEqual(ids(filterAndSort(recs, { ...opts, query: 'demo aug' })), 'c');
  assert.strictEqual(ids(filterAndSort(recs, { ...opts, query: 'recording 2' })), 'bde', '2 is also in 2026');
  assert.strictEqual(ids(filterAndSort(recs, { ...opts, query: '   ' })), 'bdaec');
  assert.strictEqual(filterAndSort(recs, { ...opts, query: 'zebra' }).length, 0);
});

test('counts', () => {
  assert.strictEqual(countLabel(0), 'No recordings');
  assert.strictEqual(countLabel(1), '1 recording');
  assert.strictEqual(countLabel(12), '12 recordings');
});

test('device menus: the computer\'s default first, aliases skipped, a missing chosen device kept', () => {
  const devices = [
    { deviceId: 'default', kind: 'audioinput', label: 'Default - MacBook Pro Microphone' },
    { deviceId: 'mbp', kind: 'audioinput', label: 'MacBook Pro Microphone' },
    { deviceId: 'usb', kind: 'audioinput', label: 'USB Mic' },
    { deviceId: 'usb', kind: 'audioinput', label: 'USB Mic' },
    { deviceId: 'nolabel', kind: 'audioinput', label: '' }
  ];
  const base = deviceOptions(devices, null, { defaultLabel: 'Same as your computer' });
  assert.deepStrictEqual(base.options.map((o) => o.value), ['', 'mbp', 'usb', 'nolabel']);
  assert.strictEqual(base.options[3].label, 'Device 3');
  assert.strictEqual(base.selected, '');

  assert.strictEqual(deviceOptions(devices, { id: 'usb', label: 'USB Mic' }, { defaultLabel: 'x' }).selected, 'usb');
  // The id changed, the name didn't.
  assert.strictEqual(deviceOptions(devices, { id: 'old-id', label: 'USB Mic' }, { defaultLabel: 'x' }).selected, 'usb');
  // Unplugged.
  const gone = deviceOptions(devices, { id: 'rode', label: 'Rode NT-USB' }, { defaultLabel: 'x' });
  assert.strictEqual(gone.selected, 'rode');
  assert.strictEqual(gone.options.at(-1).label, 'Rode NT-USB (not connected)');
});

test('the Updates section says the right thing in every state', () => {
  const base = { currentVersion: '0.2.0', kind: 'homebrew', latest: null };
  assert.match(updateView({ ...base, status: 'idle' }).text, /once a day/);
  assert.strictEqual(updateView({ ...base, status: 'checking' }).busy, true);
  assert.match(updateView({ ...base, status: 'current', checkedAt: Date.now() }).text, /newest version\. Checked at/);

  const latest = { version: '0.3.0' };
  const brew = updateView({ ...base, status: 'available', latest });
  assert.strictEqual(brew.title, 'Loupe 0.3.0 is available');
  assert.deepStrictEqual([brew.showBrew, brew.showDownload, brew.showInstall, brew.badge], [true, false, false, true]);
  const dl = updateView({ ...base, kind: 'download', status: 'available', latest });
  assert.deepStrictEqual([dl.showBrew, dl.showDownload], [false, true]);

  const win = { ...base, kind: 'installer', latest };
  assert.strictEqual(updateView({ ...win, status: 'downloading' }).busy, true);
  const ready = updateView({ ...win, status: 'ready' });
  assert.strictEqual(ready.showInstall, true);
  assert.match(ready.text, /next time you quit/);

  const offline = updateView({ ...base, status: 'error', error: 'Could not reach GitHub.' });
  assert.strictEqual(offline.error, true);
  assert.strictEqual(offline.title, 'Loupe 0.2.0');
  assert.strictEqual(offline.showActions, false);
  const badDownload = updateView({ ...win, status: 'error', error: 'Checksum mismatch.' });
  assert.strictEqual(badDownload.title, 'Loupe 0.3.0 is available');
  assert.strictEqual(badDownload.showDownload, true);
  assert.match(badDownload.text, /couldn.t be downloaded/);
});

test('preset swatches only ever use plain colours', () => {
  assert.strictEqual(presetSwatch({ background: { type: 'color', value: '#123abc' } }), '#123abc');
  assert.strictEqual(presetSwatch({ background: { type: 'gradient', value: ['#000', 'rgba(1, 2, 3, 0.5)'] } }),
    'linear-gradient(135deg, #000, rgba(1, 2, 3, 0.5))');
  assert.strictEqual(presetSwatch({ background: { type: 'color', value: 'url(file:///etc/passwd)' } }), '#5f6368');
  assert.strictEqual(presetSwatch({ background: { type: 'gradient', value: ['#000', 'red; background: url(x)'] } }), '#5f6368');
  assert.strictEqual(presetSwatch({}), '#1c1d1f');
});

test('every export choice has help text, and the window knows the same sections as main', () => {
  assert.deepStrictEqual(Object.keys(FORMAT_HELP), EXPORT_FORMATS);
  assert.deepStrictEqual(Object.keys(QUALITY_HELP), EXPORT_QUALITIES);
  assert.deepStrictEqual(SECTIONS, MAIN_SECTIONS);
});
