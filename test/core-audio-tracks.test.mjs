import test from 'node:test';
import assert from 'node:assert';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import { recordingTracks, exportMix } from '../src/core/audio/tracks.js';

const SR = 48000;
const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} !== ${b} (±${eps})`);

function tone(seconds, value) {
  return new Float32Array(Math.round(seconds * SR)).fill(value);
}

const project = () => P.createProject({ main: { width: 100, height: 100, duration: 4, mic: true } });

test('nothing decoded means no sound at all, not a silent track', () => {
  const p = project();
  assert.strictEqual(exportMix(p, buildTimeline(p), {}), null);
  assert.strictEqual(exportMix(p, buildTimeline(p), { mic: {}, system: {} }), null);
});

test('mic and system audio both follow the timeline, each at its own volume', () => {
  let p = project();
  p = P.setAudio(p, { mic: { volume: 1 }, system: { volume: 0.5 } });
  const tl = buildTimeline(p);
  const decoded = {
    mic: { main: { channels: [tone(4, 0.2)], sampleRate: SR } },
    system: { main: { channels: [tone(4, 0.2), tone(4, 0.2)], sampleRate: SR } }
  };
  const tracks = recordingTracks(p, tl, decoded);
  assert.deepStrictEqual(tracks.map((t) => [t.kind, t.volume]), [['mic', 1], ['system', 0.5]]);
  const mix = exportMix(p, tl, decoded);
  assert.strictEqual(mix.channels[0].length, 4 * SR);
  near(mix.channels[0][2 * SR], 0.3, 1e-4, 'mic + half of system');
});

test('a muted kind is left out, and a cut shortens the mix', () => {
  let p = project();
  p = P.setAudio(p, { mic: { muted: true } });
  p = P.cutRange(p, 1, 2);
  const tl = buildTimeline(p);
  const decoded = {
    mic: { main: { channels: [tone(4, 0.2)], sampleRate: SR } },
    system: { main: { channels: [tone(4, 0.1)], sampleRate: SR } }
  };
  assert.deepStrictEqual(recordingTracks(p, tl, decoded).map((t) => t.kind), ['system', 'system']);
  const mix = exportMix(p, tl, decoded);
  assert.strictEqual(mix.channels[0].length, 3 * SR);
  near(mix.channels[1][Math.round(2.5 * SR)], 0.08, 1e-4, 'system at 0.8 volume');
});

test('extra tracks (voiceover, music) join the mix', () => {
  const p = P.setAudio(project(), { mic: { muted: true } });
  const extra = { channels: [tone(1, 0.25)], sampleRate: SR, startOffset: 1, volume: 1 };
  const mix = exportMix(p, buildTimeline(p), {}, { extraTracks: [extra] });
  assert.strictEqual(mix.channels[0].length, 4 * SR);
  near(mix.channels[0][Math.round(1.5 * SR)], 0.25, 1e-4);
  assert.strictEqual(mix.channels[0][Math.round(0.5 * SR)], 0);
});
