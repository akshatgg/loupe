// Sound for the preview, on the player's clock: the microphone (inside each
// recording's video file) and system audio, each as an <audio> element kept
// at the moment and speed the timeline plays -- pitch kept, as in the export.
//
// This is the plain version: volume and mute from the project, nothing else.
// The sound clean-up work replaces it with processed audio; it only needs
// to keep this interface:
//
//   createAudioPreview({ sources }) -> { sync({ project, at, rate, playing, jumped }), stop() }

const SEEK_DRIFT = 0.2;

export function createAudioPreview({ sources }) {
  // key -> [{ el, kind: 'mic' | 'system' }]
  const tracks = {};

  function element(url) {
    const el = new Audio();
    el.preload = 'auto';
    el.preservesPitch = true;
    el.src = url;
    return el;
  }

  function tracksFor(project, key) {
    if (!tracks[key]) {
      const files = sources[key] ?? {};
      tracks[key] = [];
      if (files.video && project.sources[key]?.mic) tracks[key].push({ el: element(files.video), kind: 'mic' });
      if (files.systemAudio) tracks[key].push({ el: element(files.systemAudio), kind: 'system' });
    }
    return tracks[key];
  }

  function sync({ project, at, rate, playing, jumped }) {
    for (const key of Object.keys(project.sources)) {
      const list = tracksFor(project, key);
      for (const { el, kind } of list) {
        const settings = project.audio[kind];
        el.volume = Math.min(1, Math.max(0, settings.volume));
        el.muted = settings.muted;
        if (!playing || key !== at.source) {
          if (!el.paused) el.pause();
          continue;
        }
        if (el.readyState < 1) continue;
        const drift = el.currentTime - at.t;
        if ((jumped && Math.abs(drift) > 0.05) || Math.abs(drift) > SEEK_DRIFT) el.currentTime = at.t;
        const target = Math.min(16, Math.max(0.0625, rate));
        if (Math.abs(el.playbackRate - target) > 0.01) el.playbackRate = target;
        if (el.paused) el.play().catch(() => {});
      }
    }
  }

  function stop() {
    for (const list of Object.values(tracks)) {
      for (const { el } of list) { el.pause(); el.removeAttribute('src'); el.load(); }
    }
  }

  return { sync, stop, tracks };
}
