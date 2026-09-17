'use strict';

// Pause/resume while recording. The capture helpers keep running while
// paused -- stopping and restarting them would mean several files to stitch
// and a gap in every clock -- so a pause is only a remembered range, cut out
// of the recording afterwards (sources.main.pauses, and the clips written at
// stop leave those ranges out).
//
// The tracker works on any one clock (main.js feeds it the main process's
// seconds); recorder.js maps the finished ranges into source time with
// clock-sync.js.
function createPauseTracker() {
  const ranges = [];
  let openStart = null;

  return {
    // Both return whether anything changed, so a double press is harmless.
    pause(t) {
      if (openStart !== null || !Number.isFinite(t)) return false;
      openStart = t;
      return true;
    },
    resume(t) {
      if (openStart === null || !Number.isFinite(t)) return false;
      ranges.push({ start: openStart, end: Math.max(t, openStart) });
      openStart = null;
      return true;
    },
    isPaused: () => openStart !== null,
    // How long the recording has been paused in total, as of `now` -- what
    // the bar's timer leaves out.
    pausedTotal(now) {
      let total = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
      if (openStart !== null && Number.isFinite(now)) total += Math.max(0, now - openStart);
      return total;
    },
    // Every range, with one still open at `now` closed there (stopping while
    // paused ends the pause at the stop).
    ranges(now) {
      const out = ranges.map((r) => ({ ...r }));
      if (openStart !== null && Number.isFinite(now)) {
        out.push({ start: openStart, end: Math.max(now, openStart) });
      }
      return out;
    }
  };
}

// Maps ranges from the tracker's clock into source time with `toSource`,
// keeps them inside the recording, merges overlaps and drops anything too
// short to be a real pause (under a frame at 60 fps).
const MIN_PAUSE = 1 / 60;

function toSourcePauses(ranges, toSource, duration) {
  const mapped = [];
  for (const r of ranges) {
    let start = toSource(r.start);
    let end = toSource(r.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, start);
    end = Number.isFinite(duration) && duration > 0 ? Math.min(duration, end) : end;
    if (end - start < MIN_PAUSE) continue;
    mapped.push({ start, end });
  }
  mapped.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of mapped) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

// The v2 clips for a recording: the whole of it, minus the pauses.
function clipsFromPauses(duration, pauses) {
  const clips = [];
  let at = 0;
  const push = (start, end) => {
    if (end - start >= MIN_PAUSE) {
      clips.push({ id: `clip-${clips.length + 1}`, source: 'main', start, end });
    }
  };
  for (const p of pauses) {
    push(at, p.start);
    at = Math.max(at, p.end);
  }
  push(at, duration);
  return clips;
}

module.exports = { createPauseTracker, toSourcePauses, clipsFromPauses, MIN_PAUSE };
