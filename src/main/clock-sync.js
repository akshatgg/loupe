'use strict';

// Maps between the main process's high-resolution clock and the native
// helpers' clock.
//
// The helpers stamp everything on the OS media clock: CACurrentMediaTime()
// (mach_absolute_time) on macOS, QueryPerformanceCounter on Windows. The main
// process's performance.now() is not the same number. On Windows both come
// from QPC but performance.now() starts at process launch; on macOS libuv's
// hrtime is mach_continuous_time, which keeps counting while the Mac sleeps,
// so the two drift apart by every second the machine has ever slept (measured
// on the development Mac: 225,902 s apart). A fixed conversion is therefore
// impossible, but the offset between the two clocks is constant while a
// recording runs, so it can be measured.
//
// Every helper line carries a helper-clock time that is no later than the
// moment the line was written -- an input event's `clock` (stamped when the
// event arrived, then sent), or capture's `now` (stamped as the line is
// written). The line then takes some non-negative time to reach the main
// process. So for each line:
//
//   localArrival - helperTime = trueOffset + delay,   delay >= 0
//
// and the smallest value seen is the best estimate of trueOffset, off by only
// the quickest delivery (well under a millisecond over a local pipe once a
// few dozen samples have arrived; cursor moves alone send 120 a second).
// Mapping a main-process moment into helper time is then
//
//   helperTime = localTime - offset
//
// and into source time (seconds into the recording) is
//
//   sourceTime = localTime - offset - captureStartClock
//
// where captureStartClock is capture's {"type":"started","clock"}. A late
// estimate only ever errs by making events look slightly later than they
// were.
function createClockSync() {
  let offset = null;
  let samples = 0;

  return {
    observe(helperTime, localTime) {
      if (!Number.isFinite(helperTime) || !Number.isFinite(localTime)) return;
      const d = localTime - helperTime;
      if (offset === null || d < offset) offset = d;
      samples++;
    },
    hasSample: () => offset !== null,
    samples: () => samples,
    offset: () => offset,
    // null until the first sample: there is nothing to map with yet.
    toHelper: (localTime) => (offset === null ? null : localTime - offset)
  };
}

module.exports = { createClockSync };
