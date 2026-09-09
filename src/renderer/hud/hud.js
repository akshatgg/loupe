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
});

document.getElementById('stop').onclick = () => window.loupe.stopRecording();
