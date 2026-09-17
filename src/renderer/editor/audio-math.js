// The DOM-free parts of the editor's sound preview (audio-preview.js,
// audio-worker.js) and the timeline's waveform strip, unit-tested in
// test/editor-audio-math.test.mjs.

// Waveform peaks: the loudest sample in each 1/rate of a second, over every
// channel of every track given (a recording's microphone and system sound
// are drawn as one strip). Tracks are { channels, sampleRate, volume }.
export const PEAK_RATE = 100;

export function computePeaks(tracks, { rate = PEAK_RATE, duration } = {}) {
  const live = tracks.filter((t) => t?.channels?.length && (t.volume ?? 1) > 0);
  const seconds = duration ?? live.reduce((m, t) => Math.max(m, t.channels[0].length / t.sampleRate), 0);
  const values = new Float32Array(Math.max(0, Math.ceil(seconds * rate)));
  for (const t of live) {
    const per = t.sampleRate / rate;
    const gain = t.volume ?? 1;
    for (const c of t.channels) {
      for (let k = 0; k < values.length; k++) {
        const a = Math.floor(k * per);
        const b = Math.min(c.length, Math.floor((k + 1) * per));
        let m = 0;
        for (let i = a; i < b; i++) {
          const v = c[i] < 0 ? -c[i] : c[i];
          if (v > m) m = v;
        }
        m *= gain;
        if (m > values[k]) values[k] = m;
      }
    }
  }
  return { rate, values };
}

// The peak over [from, to) seconds (0 outside the data).
export function peakBetween(peaks, from, to) {
  if (!peaks) return 0;
  const { rate, values } = peaks;
  const a = Math.max(0, Math.floor(from * rate));
  const b = Math.min(values.length, Math.max(a + 1, Math.ceil(to * rate)));
  let m = 0;
  for (let i = a; i < b; i++) if (values[i] > m) m = values[i];
  return m;
}

// Only these parts of a project change what is heard; style, zoom and
// caption edits must not start the sound over. Edits make new objects for
// what they change (core/project.js), so identity is enough.
export function soundInputs(project) {
  return [project.clips, project.speed, project.audio, project.sources];
}

export function sameSound(a, b) {
  if (!a || !b) return false;
  const x = soundInputs(a);
  const y = soundInputs(b);
  return x.every((v, i) => v === y[i]);
}

// Beyond this the sound is restarted at the playhead instead of being left
// to run: a seek, a stall, or the player's clock and the audio clock parting.
export const RESYNC_SECONDS = 0.08;

// What the preview should do this frame.
//   state: { playing, outT, active: { startedAtCtx, startedAtOut, buffer } | null,
//            ctxTime, buffer }
// -> 'start' (restart at outT), 'stop', or 'keep'.
export function playbackAction({ playing, outT, active, ctxTime, buffer }) {
  if (!playing || !buffer) return active ? 'stop' : 'keep';
  if (!active || active.buffer !== buffer) return outT < bufferDuration(buffer) ? 'start' : (active ? 'stop' : 'keep');
  const heardAt = active.startedAtOut + (ctxTime - active.startedAtCtx);
  return Math.abs(heardAt - outT) > RESYNC_SECONDS ? 'start' : 'keep';
}

const bufferDuration = (b) => b.duration ?? (b.length / b.sampleRate);
