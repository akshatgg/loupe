'use strict';

function clock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

window.loupe.onHud((d) => {
  document.getElementById('time').textContent = clock(d.elapsed ?? 0);
  document.getElementById('zoom').textContent = `${(d.zoom ?? 1).toFixed(1)}×`;
  document.getElementById('mic').textContent = d.hasMic ? '🎤' : '';

  const warn = document.getElementById('warn');
  if (!d.zoomEnabled) warn.textContent = 'zoom off';
  else if (d.tapReenables > 0) warn.textContent = `tap recovered ×${d.tapReenables}`;
  else warn.textContent = '';

  // A helper-reported error (e.g. the video writer failed mid-recording)
  // must be visible here -- previously it was discarded entirely and the
  // HUD kept counting as if nothing had happened. textContent only: this
  // is untrusted-ish diagnostic text from a native helper, never HTML.
  const err = document.getElementById('error');
  err.textContent = d.error ? `${d.error.source}: ${d.error.message}` : '';
});

document.getElementById('stop').onclick = () => window.loupe.stopRecording();
