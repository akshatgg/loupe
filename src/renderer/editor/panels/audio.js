// Audio: one row per kind of sound the video has.
//
//   Microphone      volume, mute, "Clean up background noise", "Even out volume"
//   Computer sound  volume, mute
//   Music           Add music (file picker, or drop a file anywhere on the
//                   editor), volume, "Lower music when I talk", remove
//   Voiceover       Record voiceover at the playhead, the takes: jump to one,
//                   move it to the playhead, delete it
//
// Every change is a project edit (core setAudio), so it is undoable, saved,
// heard in the preview (audio-preview.js) and in the export.

import { h, icon, slider, toggle, section } from '../ui.js';
import { setAudio } from '../../../core/project.js';
import { anchorAt } from '../../../core/audio/voiceover.js';
import { MUSIC_EXTENSIONS } from '../../../core/audio/music.js';
import { formatTime } from '../timeline-math.js';
import { createVoiceoverSession } from '../voiceover-session.js';
import { plainError } from '../export-dialog.js';

const SVG = 'http://www.w3.org/2000/svg';
// Icons only this panel uses, drawn like ui.js's.
const PATHS = {
  mic: 'M12 3.5a2.8 2.8 0 0 0-2.8 2.8v5.4a2.8 2.8 0 0 0 5.6 0V6.3A2.8 2.8 0 0 0 12 3.5zM6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5M9 20.5h6',
  screen: 'M3.5 5h17v11h-17zM9 20h6M12 16v4',
  music: 'M9 17.5V6l10-2v11.5M9 17.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  speaker: 'M4 10v4h3.5L12 18V6L7.5 10zM15.5 9a4 4 0 0 1 0 6',
  speakerOff: 'M4 10v4h3.5L12 18V6L7.5 10zM16 9.5l5 5M21 9.5l-5 5',
  record: 'M12 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z',
  here: 'M12 3v18M7 7.5 12 3l5 4.5'
};

function glyph(name, size = 18) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', PATHS[name]);
  if (name === 'record') {
    path.setAttribute('fill', 'currentColor');
  } else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.7');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.append(path);
  return svg;
}

const percent = (v) => `${Math.round(v * 100)}%`;
const baseName = (file) => String(file).split('/').pop();

export const isMusicFile = (name) => MUSIC_EXTENSIONS.some((ext) => String(name).toLowerCase().endsWith(ext));

// Adding (or replacing) the music keeps the volume and ducking chosen before.
export function withMusic(project, file) {
  const before = project.audio.music;
  return setAudio(project, { music: { file, volume: before?.volume ?? 0.3, duck: before?.duck ?? true } });
}

async function addMusic(editor, pick) {
  try {
    const result = await pick();
    if (!result) return;
    editor.store.apply((p) => withMusic(p, result.file));
    editor.toast(`Added “${result.name ?? baseName(result.file)}”`);
    editor.showPanel('audio');
  } catch (err) {
    editor.toast(plainError(err));
  }
}

// A song dropped anywhere on the editor becomes its music. Called once by
// editor.js, since the panel itself is only built when first opened.
export function installMusicDrop(editor, loupe = window.loupe) {
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  let depth = 0;
  const shade = h('div', { class: 'drop-shade', hidden: true },
    h('div', { class: 'drop-card' }, glyph('music', 30), h('strong', {}, 'Drop to add music'),
      h('span', {}, 'MP3, M4A, WAV, FLAC or Ogg')));
  document.body.append(shade);
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    shade.hidden = false;
  });
  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) shade.hidden = true;
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    shade.hidden = true;
    const file = [...e.dataTransfer.files].find((f) => isMusicFile(f.name));
    if (!file) {
      editor.toast('That file type isn’t supported. Try an MP3, M4A, WAV or FLAC file.');
      return;
    }
    addMusic(editor, () => loupe.importMusicFile(file));
  });
}

// A track's heading: icon, name, and a mute button on the right.
function trackHead(iconName, name, { onMute } = {}) {
  const mute = onMute ? h('button', { type: 'button', class: 'icon-btn small mute-btn', onclick: onMute }) : null;
  const head = h('div', { class: 'track-head' },
    h('span', { class: 'track-icon' }, glyph(iconName, 17)), h('span', { class: 'track-name' }, name), mute);
  head.setMuted = (muted) => {
    if (!mute) return;
    mute.replaceChildren(glyph(muted ? 'speakerOff' : 'speaker', 17));
    mute.setAttribute('aria-pressed', String(muted));
    mute.title = muted ? `Turn ${name.toLowerCase()} back on` : `Mute ${name.toLowerCase()}`;
    mute.setAttribute('aria-label', mute.title);
    head.classList.toggle('muted-track', muted);
  };
  return head;
}

export default {
  id: 'audio',
  title: 'Audio',
  icon: 'audio',
  mount(container, editor) {
    const { store, player } = editor;
    const change = (patch, gesture = null) => store.apply((p) => setAudio(p, patch), { gesture });
    const done = () => store.endGesture();
    const session = createVoiceoverSession({ editor });

    // ---- microphone
    const micHead = trackHead('mic', 'Microphone', { onMute: () => change({ mic: { muted: !store.project.audio.mic.muted } }) });
    const micVolume = slider({
      label: 'Volume', min: 0, max: 2, step: 0.05, value: 1, format: percent,
      onInput: (v) => change({ mic: { volume: v } }, 'audio:mic'), onChange: done
    });
    micVolume.querySelector('input').id = 'micVolume';
    const cleanUp = toggle({
      label: 'Clean up background noise', hint: 'Removes hum, fans and keyboard clicks',
      onChange: (on) => change({ mic: { cleanUp: on } })
    });
    cleanUp.input.id = 'micCleanUp';
    const even = toggle({
      label: 'Even out volume', hint: 'Quiet and loud moments sound alike',
      onChange: (on) => change({ mic: { level: on } })
    });
    even.input.id = 'micLevel';
    const micSection = section(null, micHead, micVolume, cleanUp, even);

    // ---- computer sound
    const sysHead = trackHead('screen', 'Computer sound', { onMute: () => change({ system: { muted: !store.project.audio.system.muted } }) });
    const sysVolume = slider({
      label: 'Volume', min: 0, max: 2, step: 0.05, value: 0.8, format: percent,
      onInput: (v) => change({ system: { volume: v } }, 'audio:system'), onChange: done
    });
    sysVolume.querySelector('input').id = 'systemVolume';
    const sysSection = section(null, sysHead, sysVolume);

    // ---- music
    const musicHead = trackHead('music', 'Music');
    const addBtn = h('button', { type: 'button', class: 'btn', id: 'addMusic', onclick: () => addMusic(editor, () => window.loupe.chooseMusic()) },
      icon('plus', { size: 16 }), 'Add music');
    const musicEmpty = h('div', { class: 'music-empty' }, addBtn, h('p', { class: 'hint' }, 'Or drop a song file anywhere on this window.'));
    const musicName = h('span', { class: 'music-name' });
    const musicRow = h('div', { class: 'music-file' }, glyph('music', 16), musicName,
      h('button', { type: 'button', class: 'icon-btn small', id: 'replaceMusic', title: 'Choose another song', 'aria-label': 'Choose another song',
        onclick: () => addMusic(editor, () => window.loupe.chooseMusic()) }, icon('folder', { size: 16 })),
      h('button', { type: 'button', class: 'icon-btn small', id: 'removeMusic', title: 'Remove music', 'aria-label': 'Remove music',
        onclick: () => change({ music: null }) }, icon('trash', { size: 16 })));
    const musicVolume = slider({
      label: 'Volume', min: 0, max: 1, step: 0.05, value: 0.3, format: percent,
      onInput: (v) => change({ music: { volume: v } }, 'audio:music'), onChange: done
    });
    musicVolume.querySelector('input').id = 'musicVolume';
    const duck = toggle({
      label: 'Lower music when I talk', hint: 'So your voice is always clear',
      onChange: (on) => change({ music: { duck: on } })
    });
    duck.input.id = 'musicDuck';
    const musicSet = h('div', {}, musicRow, musicVolume, duck);
    const musicSection = section(null, musicHead, musicEmpty, musicSet);

    // ---- voiceover
    const recordBtn = h('button', { type: 'button', class: 'btn record-btn', id: 'recordVoiceover', onclick: () => session.start() });
    const voHint = h('p', { class: 'hint' });
    const takes = h('div', { class: 'take-list' });
    const voSection = section(null, trackHead('mic', 'Voiceover'), recordBtn, voHint, takes);

    const status = h('p', { class: 'audio-status', hidden: true }, h('span', { class: 'audio-note-dot' }), 'Preparing audio…');
    container.append(status, micSection, sysSection, musicSection, voSection);

    function renderTakes() {
      const p = store.project;
      const list = [...p.audio.voiceover]
        .map((take) => ({ take, at: store.tl.toOutput(take.source, take.t) }))
        .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
      takes.replaceChildren(...list.map(({ take, at }, i) => {
        const info = player.audio?.file('take', take.file);
        const length = info?.duration ? ` · ${formatTime(info.duration, { fraction: info.duration < 10 })}` : '';
        return h('div', { class: 'take-row', dataset: { id: take.id } },
          h('button', {
            type: 'button', class: 'take-main', title: at === null ? 'This part of the video was cut' : 'Jump to this voiceover',
            onclick: () => { if (at !== null) player.seek(at); }
          },
          h('span', { class: 'take-dot' }),
          h('span', { class: 'take-name' }, `Take ${i + 1}`),
          h('span', { class: 'muted' }, at === null ? 'Cut from the video' : `at ${formatTime(at, { fraction: true })}${length}`)),
          h('button', {
            type: 'button', class: 'icon-btn small take-move', title: 'Move to the playhead', 'aria-label': 'Move to the playhead',
            onclick: () => store.apply((q) => setAudio(q, {
              voiceover: q.audio.voiceover.map((v) => (v.id === take.id ? { ...v, ...anchorAt(store.tl, player.time) } : v))
            }))
          }, glyph('here', 16)),
          h('button', {
            type: 'button', class: 'icon-btn small take-delete', title: 'Delete this voiceover', 'aria-label': 'Delete this voiceover',
            onclick: () => store.apply((q) => setAudio(q, { voiceover: q.audio.voiceover.filter((v) => v.id !== take.id) }))
          }, icon('trash', { size: 16 })));
      }));
    }

    function renderRecord(phase = session.phase) {
      const busy = phase !== 'idle';
      recordBtn.replaceChildren(glyph('record', 14), phase === 'counting' ? 'Get ready…' : phase === 'recording' ? 'Recording…' : phase === 'saving' ? 'Saving…' : 'Record voiceover');
      recordBtn.disabled = busy;
      voHint.textContent = busy
        ? 'Press Space or Stop when you’re done.'
        : 'Starts at the playhead. The video plays while you talk.';
    }
    session.onChange((phase) => renderRecord(phase));

    function update() {
      const p = store.project;
      const a = p.audio;
      const sources = Object.values(p.sources);
      micSection.hidden = !sources.some((s) => s.mic);
      sysSection.hidden = !sources.some((s) => s.systemAudio);
      micHead.setMuted(a.mic.muted);
      micVolume.set(a.mic.volume);
      cleanUp.set(a.mic.cleanUp);
      even.set(a.mic.level);
      for (const el of [micVolume, cleanUp, even]) el.classList.toggle('disabled', a.mic.muted);
      sysHead.setMuted(a.system.muted);
      sysVolume.set(a.system.volume);
      sysVolume.classList.toggle('disabled', a.system.muted);
      musicEmpty.hidden = Boolean(a.music);
      musicSet.hidden = !a.music;
      if (a.music) {
        musicName.textContent = baseName(a.music.file);
        musicName.title = baseName(a.music.file);
        musicVolume.set(a.music.volume);
        duck.set(a.music.duck);
        const failed = player.audio?.file('music', a.music.file)?.status === 'failed';
        musicRow.classList.toggle('bad', failed);
        if (failed) musicName.textContent = `${baseName(a.music.file)} (can’t be played)`;
      }
      renderTakes();
      renderRecord();
    }

    player.audio?.onState((s) => {
      status.hidden = !s.preparing;
      if (!container.hidden) update();
    });
    update();
    return { update, session };
  }
};
