// Recording a voiceover over the video (the Audio panel's "Record voiceover").
//
//   createVoiceoverSession({ editor, loupe }) -> {
//     start(), stop(), cancel(), phase, onChange(fn)
//   }
//
// Pressing Record counts in 3-2-1 over the preview, starts the microphone,
// then plays the video from where the playhead was while the person talks --
// the preview's own sound is silenced so it doesn't end up in the take.
// Stop (the button, Space, Esc, or reaching the end of the video) saves the
// take into the project folder (IPC voiceover:save) and adds it to the
// project, anchored to the recording moment it started on
// (core/audio/voiceover.js), as one undo step.

import { startVoiceoverRecording, saveVoiceover, createVoiceover } from '../../core/audio/voiceover.js';
import { setAudio } from '../../core/project.js';
import { h } from './ui.js';
import { formatTime } from './timeline-math.js';

export const COUNT_IN = 3;

export function createVoiceoverSession({ editor, loupe = window.loupe, countIn = COUNT_IN, stepMs = 1000 }) {
  const { store, player } = editor;
  let phase = 'idle'; // idle | counting | recording | saving
  let recording = null;
  let anchorOut = 0;
  let timer = null;
  let tick = null;
  let unTime = null;
  const listeners = new Set();

  const count = h('div', { class: 'vo-count' });
  const clock = h('span', { class: 'vo-clock' }, '0:00');
  const stopBtn = h('button', { type: 'button', class: 'btn vo-stop', onclick: () => stop() },
    h('span', { class: 'vo-stop-square' }), 'Stop');
  const bar = h('div', { class: 'vo-bar' }, h('span', { class: 'vo-dot' }), h('span', {}, 'Recording voiceover'), clock, stopBtn);
  const overlay = h('div', { class: 'vo-overlay', hidden: true }, count, bar);
  document.getElementById('stage')?.append(overlay);

  const setPhase = (next) => {
    phase = next;
    overlay.hidden = next === 'idle' || next === 'saving';
    count.hidden = next !== 'counting';
    bar.hidden = next !== 'recording';
    document.body.classList.toggle('vo-active', next !== 'idle');
    for (const fn of listeners) fn(phase);
  };

  // While recording, Space and Esc stop the take instead of reaching the
  // editor's shortcuts (Space would pause the video, not the microphone).
  const onKey = (e) => {
    if (phase === 'idle' || phase === 'saving') return;
    if (e.key === ' ' || e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (phase === 'counting') cancel();
      else stop();
    }
  };
  window.addEventListener('keydown', onKey, true);

  async function start() {
    if (phase !== 'idle') return;
    if (player.time >= store.tl.duration - 0.25) {
      editor.toast('Move the playhead to where the voiceover should start.');
      return;
    }
    player.pause();
    setPhase('counting');
    for (let n = countIn; n > 0; n--) {
      count.textContent = String(n);
      count.classList.remove('pop');
      void count.offsetWidth;
      count.classList.add('pop');
      await new Promise((resolve) => { timer = setTimeout(resolve, stepMs); });
      if (phase !== 'counting') return;
    }
    try {
      recording = await startVoiceoverRecording();
    } catch (err) {
      setPhase('idle');
      editor.toast(err.message);
      return;
    }
    if (phase !== 'counting') { recording.cancel(); recording = null; return; }
    // The take is anchored where recording actually began (opening the
    // microphone takes a moment; the playhead hasn't moved meanwhile).
    anchorOut = player.time;
    player.audio?.setMuted(true);
    setPhase('recording');
    player.play();
    tick = setInterval(() => {
      clock.textContent = formatTime(recording?.elapsed() ?? 0);
      // The microphone went away: keep what was recorded.
      if (recording?.stopped) stop();
    }, 200);
    // The end of the video ends the take.
    unTime = player.onTime((_t, playing) => { if (!playing && phase === 'recording') stop(); });
  }

  function finishUi() {
    clearInterval(tick);
    unTime?.();
    unTime = null;
    player.pause();
    player.audio?.setMuted(false);
  }

  async function stop() {
    if (phase !== 'recording') return null;
    const take = recording;
    recording = null;
    setPhase('saving');
    finishUi();
    try {
      const { blob, duration } = await take.stop();
      if (duration < 0.3 || !blob.size) {
        editor.toast('That voiceover was too short to keep.');
        return null;
      }
      const { file } = await saveVoiceover(blob, loupe);
      let added = null;
      store.apply((p) => {
        added = createVoiceover({ file, tl: store.tl, outT: anchorOut });
        return setAudio(p, { voiceover: [...p.audio.voiceover, added] });
      });
      if (added) {
        editor.toast('Voiceover added');
        player.seek(anchorOut);
      }
      return added;
    } catch (err) {
      editor.toast(err.message);
      return null;
    } finally {
      setPhase('idle');
    }
  }

  function cancel() {
    clearTimeout(timer);
    if (phase === 'recording') finishUi();
    recording?.cancel();
    recording = null;
    setPhase('idle');
  }

  setPhase('idle');
  return {
    start, stop, cancel,
    get phase() { return phase; },
    get elapsed() { return recording?.elapsed() ?? 0; },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}
