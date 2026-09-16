// What the export needs beyond each recording's own picture, cursor and
// sound (docs/EDITOR-V2.md section 5, layers 6, 7 and 9):
//
//  - keys.json for the keystroke badges
//  - webcam.webm, demuxed here (webm-demux.js) and decoded with the same
//    VideoSource as the recordings
//  - for a crossfade, the other clip's held picture: a second VideoSource on
//    that recording, so the main one keeps decoding forward undisturbed
//
//   openVisuals(job, project, keys, { openRecording }) ->
//     { assets: { keys }, extraFrames(outT, tl) -> frames to merge, close() }

import { readFile } from './demux.js';
import { demuxWebm } from './webm-demux.js';
import { openVideoSource } from './video-source.js';
import { normalizeKeys } from '../../core/layers/keystrokes.js';
import { webcamFrameKey, webcamTime } from '../../core/layers/webcam.js';
import { transitionAt, TRANSITION_FRAME } from '../../core/layers/transitions.js';

export async function openVisuals(job, project, keys, { openRecording }) {
  const keyLists = {};
  const webcams = {};
  const holders = {};
  for (const key of keys) {
    const files = job.sources?.[key] ?? {};
    const meta = project.sources[key];
    if (files.keys && project.style.keystrokes.show) {
      // Badges are extra: an unreadable keys.json just means none.
      keyLists[key] = await fetch(files.keys)
        .then((r) => (r.ok ? r.json() : []))
        .then(normalizeKeys, () => []);
    }
    if (files.webcam && meta.webcam && project.style.webcam.show) {
      try {
        const demuxed = demuxWebm(await readFile(files.webcam, 'the webcam video'));
        if (demuxed.video?.samples.length) {
          const source = await openVideoSource(demuxed, 'the webcam video');
          const { samples } = demuxed.video;
          const last = samples.reduce((m, s) => Math.max(m, s.time + s.duration), 0);
          webcams[key] = { source, first: samples.reduce((m, s) => Math.min(m, s.time), Infinity), last };
        }
      } catch (err) {
        // The recording still exports without its bubble.
        console.error(err);
      }
    }
  }

  // The other side of a crossfade is a still: decoded once, kept until the
  // transition moves on.
  let held = null; // { id: 'source@t', frame }
  async function heldFrame(source, t) {
    const id = `${source}@${t}`;
    if (held?.id === id) return held.frame;
    holders[source] ??= await openRecording(source);
    const frame = (await holders[source].frameAt(t)).clone();
    held?.frame.close();
    held = { id, frame };
    return frame;
  }

  async function extraFrames(outT, tl, at) {
    const frames = {};
    const cam = webcams[at.source];
    if (cam) {
      const wt = webcamTime(project.sources[at.source], at.t);
      if (wt !== null && wt >= cam.first - 0.05 && wt <= cam.last + 0.05) {
        frames[webcamFrameKey(at.source)] = await cam.source.frameAt(wt);
      }
    }
    const tr = transitionAt(project, tl, outT);
    if (tr?.type === 'crossfade') frames[TRANSITION_FRAME] = await heldFrame(tr.other.source, tr.other.t);
    else if (held) { held.frame.close(); held = null; }
    return frames;
  }

  return {
    assets: { keys: keyLists },
    extraFrames,
    close() {
      held?.frame.close();
      for (const w of Object.values(webcams)) w.source.close();
      for (const h of Object.values(holders)) h.close();
    }
  };
}
