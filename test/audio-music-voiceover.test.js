'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Blob } = require('node:buffer');
const { fitMusic, musicTrack, MUSIC_EXTENSIONS } = require('../src/core/audio/music.js');
const {
  anchorAt, createVoiceover, placeVoiceovers, pickMimeType, startVoiceoverRecording, saveVoiceover
} = require('../src/core/audio/voiceover.js');
const { mixTracks, gainAt } = require('../src/core/audio/mix.js');
const { speechLike, rmsDb } = require('./audio-fixtures');

const SR = 48000;

// A ramp makes positions checkable: sample i of the song has value i.
const rampSong = (n) => ({ channels: [Float32Array.from({ length: n }, (_, i) => i)], sampleRate: SR });

test('fitMusic trims a long song to the exact length and fades out to silence', () => {
  const song = { channels: [new Float32Array(SR * 20).fill(0.5), new Float32Array(SR * 20).fill(0.5)], sampleRate: SR };
  const { channels } = fitMusic(song, 7.5, { fadeOut: 2 });
  assert.strictEqual(channels.length, 2);
  assert.strictEqual(channels[0].length, 7.5 * SR);
  assert.strictEqual(channels[0][SR], 0.5, 'body untouched');
  assert.ok(Math.abs(channels[0][5.5 * SR - 1] - 0.5) < 1e-3, 'fade starts 2 s before the end');
  assert.ok(Math.abs(channels[0][6.5 * SR] - 0.25) < 1e-3, 'halfway down halfway through');
  assert.ok(Math.abs(channels[0][7.5 * SR - 1]) < 1e-4, 'silent at the end');
});

test('fitMusic loops a short song with crossfaded seams', () => {
  const len = 3 * SR;
  const xf = SR / 2;
  const { channels: [out] } = fitMusic(rampSong(len), 10, { crossfade: 0.5, fadeOut: 0 });
  assert.strictEqual(out.length, 10 * SR);
  // First pass verbatim up to the seam.
  assert.strictEqual(out[1000], 1000);
  assert.strictEqual(out[len - xf - 1], len - xf - 1);
  // Second pass begins xf early; after the crossfade it is the song again.
  const second = len - xf;
  assert.strictEqual(out[second + xf + 5], xf + 5);
  // Inside the crossfade it is an equal-power blend of the tail and the head.
  const i = xf / 2;
  const p = (i + 0.5) / xf;
  const expect = (len - xf + i) * Math.cos((p * Math.PI) / 2) + i * Math.sin((p * Math.PI) / 2);
  assert.ok(Math.abs(out[second + i] - expect) < 1);
  // Third pass.
  const third = second + len - xf;
  assert.strictEqual(out[third + xf + 7], xf + 7);
});

test('fitMusic without loop leaves silence after the song; offset skips an intro', () => {
  const { channels: [out] } = fitMusic(rampSong(SR), 3, { loop: false, fadeOut: 0 });
  assert.strictEqual(out.length, 3 * SR);
  assert.strictEqual(out[SR - 1], SR - 1);
  assert.strictEqual(out[SR + 10], 0);
  const skipped = fitMusic(rampSong(SR * 4), 1, { offset: 2, fadeOut: 0 }).channels[0];
  assert.strictEqual(skipped[0], 2 * SR);
});

test('musicTrack: volume, ducking under the voice, and it mixes', () => {
  const song = { channels: [new Float32Array(SR * 4).fill(0.4)], sampleRate: SR };
  const voice = { channels: [speechLike(2, SR, { seed: 2 })], sampleRate: SR, startOffset: 3 };
  const track = musicTrack({ volume: 0.5, duck: true }, song, 8, { voiceTracks: [voice], fitOptions: { fadeOut: 0 } });
  assert.strictEqual(track.volume, 0.5);
  assert.ok(gainAt(track.gain, 1) === 1);
  assert.ok(gainAt(track.gain, 3.5) < 0.3);
  const noDuck = musicTrack({ volume: 0.3, duck: false }, song, 8);
  assert.strictEqual(noDuck.gain, null);
  const mixed = mixTracks([track], { duration: 8 }).channels[0];
  assert.ok(rmsDb(mixed, SR * 0.5, SR * 1.5) - rmsDb(mixed, SR * 3.2, SR * 4.5) > 10);
});

test('music extensions match between core and the main-process importer', () => {
  const { MUSIC_EXTENSIONS: mainList } = require('../src/main/ipc/music.js');
  assert.deepStrictEqual([...mainList].sort(), [...MUSIC_EXTENSIONS].sort());
});

// A timeline stand-in with the core/timeline.js interface: one source, the
// stretch 2-4 s cut out, the rest at normal speed.
const fakeTl = {
  duration: 8,
  toOutput(source, t) {
    if (source !== 'main') return null;
    if (t < 2) return t;
    if (t < 4) return null;
    return t - 2;
  },
  toSource(outT) {
    return outT < 2 ? { clipIndex: 0, source: 'main', t: outT } : { clipIndex: 1, source: 'main', t: outT + 2 };
  }
};

test('voiceovers are anchored to source time and placed through the timeline', () => {
  assert.deepStrictEqual(anchorAt(fakeTl, 3), { source: 'main', t: 5 });
  assert.deepStrictEqual(anchorAt(fakeTl, 99), { source: 'main', t: 10 });
  const vo = createVoiceover({ file: 'voiceover/Voiceover.webm', tl: fakeTl, outT: 1, id: 'a' });
  assert.deepStrictEqual(vo, { id: 'a', file: 'voiceover/Voiceover.webm', source: 'main', t: 1, volume: 1 });
  assert.throws(() => createVoiceover({ tl: fakeTl, outT: 1 }));

  const audio = (seconds) => ({ channels: [new Float32Array(seconds * SR).fill(0.1)], sampleRate: SR });
  const items = [
    { id: 'late', file: 'x', source: 'main', t: 6, volume: 0.5 },   // out 4
    { id: 'early', file: 'x', source: 'main', t: 1 },               // out 1
    { id: 'cut', file: 'x', source: 'main', t: 3 },                 // cut out
    { id: 'missing', file: 'x', source: 'main', t: 5 },             // not decoded
    { id: 'tail', file: 'x', source: 'main', t: 9 }                 // out 7, 3 s long -> 1 s left
  ];
  const decoded = new Map([['late', audio(1)], ['early', audio(1)], ['cut', audio(1)], ['tail', audio(3)]]);
  const tracks = placeVoiceovers(items, fakeTl, decoded);
  assert.deepStrictEqual(tracks.map((t) => [t.id, t.startOffset, t.duration, t.volume]),
    [['early', 1, 1, 1], ['late', 4, 1, 0.5], ['tail', 7, 1, 1]]);
  // Plain-object lookup works too, and they mix at the right places.
  const mixed = mixTracks(placeVoiceovers(items, fakeTl, Object.fromEntries(decoded)), { duration: 8 }).channels[0];
  assert.strictEqual(mixed[SR - 1], 0);
  assert.ok(Math.abs(mixed[SR] - 0.1) < 1e-7);
  assert.ok(Math.abs(mixed[4 * SR + 1] - 0.05) < 1e-7);
  assert.strictEqual(mixed.length, 8 * SR);
});

// ---------------------------------------------------------------------------
// Recording, against fake browser media APIs.

function fakeMedia({ supported = ['audio/webm;codecs=opus'] } = {}) {
  const log = { constraints: null, stoppedTracks: 0, closed: 0 };
  const stream = { getTracks: () => [{ stop: () => { log.stoppedTracks++; } }] };
  const mediaDevices = { getUserMedia: async (c) => { log.constraints = c; return stream; } };
  class FakeRecorder {
    static isTypeSupported(t) { return supported.includes(t); }
    constructor(s, opts) { this.stream = s; this.opts = opts; this.state = 'inactive'; this.mimeType = opts?.mimeType ?? ''; log.recorder = this; }
    start(slice) { this.state = 'recording'; this.slice = slice; }
    stop() {
      this.state = 'inactive';
      setImmediate(() => {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2])]) });
        this.onstop?.();
      });
    }
  }
  class FakeAudioContext {
    createAnalyser() { return { fftSize: 0, getFloatTimeDomainData: (b) => { b.fill(0); b[3] = -0.6; } }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { log.closed++; }
  }
  return { log, mediaDevices, MediaRecorderImpl: FakeRecorder, AudioContextImpl: FakeAudioContext };
}

test('pickMimeType prefers webm/opus and falls back', () => {
  assert.strictEqual(pickMimeType({ isTypeSupported: () => true }), 'audio/webm;codecs=opus');
  assert.strictEqual(pickMimeType({ isTypeSupported: (t) => t === 'audio/mp4' }), 'audio/mp4');
  assert.strictEqual(pickMimeType({ isTypeSupported: () => false }), '');
});

test('recording a voiceover: constraints, meter, stop gives a blob and releases the mic', async () => {
  const media = fakeMedia();
  let clock = 1000;
  const rec = await startVoiceoverRecording({ ...media, deviceId: 'mic-2', now: () => clock });
  assert.deepStrictEqual(media.log.constraints.audio.deviceId, { exact: 'mic-2' });
  assert.strictEqual(media.log.constraints.audio.autoGainControl, false);
  assert.strictEqual(media.log.recorder.state, 'recording');
  assert.strictEqual(rec.mimeType, 'audio/webm;codecs=opus');
  assert.ok(Math.abs(rec.level() - 0.6) < 1e-6);
  clock = 3500;
  assert.strictEqual(rec.elapsed(), 2.5);
  const take = await rec.stop();
  assert.strictEqual(take.duration, 2.5);
  assert.strictEqual(take.mimeType, 'audio/webm;codecs=opus');
  assert.strictEqual(take.blob.size, 6);
  assert.strictEqual(media.log.stoppedTracks, 1);
  assert.strictEqual(media.log.closed, 1);
  await assert.rejects(rec.stop());
});

test('cancel releases the mic; missing APIs give a friendly error', async () => {
  const media = fakeMedia();
  const rec = await startVoiceoverRecording(media);
  rec.cancel();
  assert.strictEqual(media.log.stoppedTracks, 1);
  await assert.rejects(startVoiceoverRecording({ mediaDevices: null, MediaRecorderImpl: null }), /microphone/);
  // No AudioContext: recording still works, the meter reads 0.
  const noMeter = await startVoiceoverRecording({ ...fakeMedia(), AudioContextImpl: null });
  assert.strictEqual(noMeter.level(), 0);
});

test('saveVoiceover sends the bytes through window.loupe', async () => {
  let sent;
  const loupe = { saveVoiceover: async (p) => { sent = p; return { file: 'voiceover/Voiceover.webm' }; } };
  const res = await saveVoiceover(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), loupe);
  assert.deepStrictEqual(res, { file: 'voiceover/Voiceover.webm' });
  assert.deepStrictEqual([...sent.data], [1, 2, 3]);
  assert.strictEqual(sent.mimeType, 'audio/webm');
  await assert.rejects(saveVoiceover(new Blob([]), {}));
});
