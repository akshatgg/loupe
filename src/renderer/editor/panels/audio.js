// Audio: one row per kind of sound the video has.
//
//   Microphone      volume, mute, "Clean up background noise", "Even out volume"
//   Computer sound  volume, mute
//   Selected audio  the audio clip selected on the timeline (its inspector):
//                   volume, fades, where it starts, where in the song it
//                   plays from, its length, repeat, lower under speech,
//                   mute, split, duplicate, delete
//   Songs & sounds  Add audio (file picker, several at once, or drop files
//                   anywhere on the editor), and every audio clip
//   Voiceover       Record voiceover at the playhead, the takes: jump to one,
//                   move it to the playhead, delete it
//
// The microphone, the computer sound and the selected audio each end with a
// folded "Advanced" part (advancedTone below): left or right, low / middle /
// high tones, and evening out loud and quiet parts (core/audio/tone.js).
//
// Every change is a project edit (core setAudio), so it is undoable, saved,
// heard in the preview (audio-preview.js) and in the export.

import { h, icon, slider, toggle, section } from '../ui.js';
import * as P from '../../../core/project.js';
import { setAudio } from '../../../core/project.js';
import { anchorAt } from '../../../core/audio/voiceover.js';
import { MUSIC_EXTENSIONS } from '../../../core/audio/music.js';
import { defaultTone, toneOf, isNeutralTone } from '../../../core/audio/tone.js';
import { formatTime, parseTime } from '../timeline-math.js';
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

// S with an audio clip selected splits that clip at the playhead.
export function splitSelectedAudio(editor) {
  const { store, player } = editor;
  const id = store.selection?.kind === 'audio' ? store.selection.id : null;
  if (!id) return false;
  const next = store.apply((p) => P.splitAudioClip(p, id, player.time));
  if (next) editor.toast('Split the audio in two');
  return true;
}

const clipGain = (clip, t) => P.audioClipGainAt(clip, t);

const stem = (name) => String(name ?? '').replace(/\.[^.]+$/, '');

// Songs or sound files, already copied into the project (`pick()` resolves
// with [{ file, name }], one { file, name }, or null), as audio clips: the
// first at the playhead, the others one after another, each on the first
// audio row where it fits -- one undo step, the last one selected.
export async function addAudioFiles(editor, pick) {
  const { store, player } = editor;
  try {
    const picked = await pick();
    const results = (Array.isArray(picked) ? picked : [picked]).filter(Boolean);
    if (!results.length) return [];
    const ready = [];
    for (const r of results) {
      // Its length decides the clip's; one the preview can't decode can't be
      // heard in the export either.
      const entry = await (player.audio?.ready?.('music', r.file) ?? null);
      if (entry?.status === 'failed') {
        editor.toast(`“${r.name ?? baseName(r.file)}” can’t be played. Try an MP3, M4A or WAV file.`);
        continue;
      }
      ready.push({ ...r, fileDuration: entry?.duration > 0 ? entry.duration : null });
    }
    if (!ready.length) return [];
    const duration = store.tl.duration;
    const before = new Set(store.project.audio.clips.map((c) => c.id));
    const next = store.apply((p) => {
      let q = p;
      let at = Math.min(player.time, Math.max(0, duration - 0.1));
      for (const r of ready) {
        q = P.addAudioClip(q, { file: r.file, name: stem(r.name ?? baseName(r.file)), start: at, fileDuration: r.fileDuration });
        at = Math.min(P.audioClipEnd(q.audio.clips.at(-1), duration), Math.max(0, duration - 0.1));
      }
      return q;
    });
    if (!next) return [];
    const added = next.audio.clips.filter((c) => !before.has(c.id));
    if (added.length) editor.select({ kind: 'audio', id: added.at(-1).id });
    editor.toast(added.length === 1 ? `Added “${added[0].name}”` : `Added ${added.length} audio files`);
    return added;
  } catch (err) {
    editor.toast(plainError(err));
    return [];
  }
}

// Songs or sound files dropped anywhere on the editor become audio clips.
// Called once by editor.js, since the panel itself is only built when first
// opened.
export function installMusicDrop(editor, loupe = window.loupe) {
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  let depth = 0;
  const shade = h('div', { class: 'drop-shade', hidden: true },
    h('div', { class: 'drop-card' }, glyph('music', 30), h('strong', {}, 'Drop to add audio'),
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
    const files = [...e.dataTransfer.files].filter((f) => isMusicFile(f.name));
    if (!files.length) {
      editor.toast('That file type isn’t supported. Try an MP3, M4A, WAV or FLAC file.');
      return;
    }
    addAudioFiles(editor, async () => {
      const added = [];
      for (const f of files.slice(0, 20)) added.push(await loupe.importMusicFile(f));
      return added;
    });
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

const panWords = (v) => (Math.abs(v) < 0.005 ? 'Middle' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'left' : 'right'}`);
const decibels = (v) => `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10} dB`;

// The folded "Advanced" part of one sound's settings: pan, a three-band
// equalizer and a compressor, in plain words (the usual names are in the
// tooltips). `prefix` names the sound in the controls' ids ('clip', 'mic',
// 'system'); read() gives its settings (or null), write(patch, gesture) is
// the edit, done() ends a slider drag's undo step. Whether it is open is
// remembered in this page's localStorage, not in the project.
function advancedTone(prefix, { read, write, done, storage = globalThis.localStorage }) {
  const key = `loupe.audio.advanced.${prefix}`;
  const tone = () => toneOf(read() ?? {});
  const named = (row, id, title) => {
    (row.input ?? row.querySelector('input')).id = id;
    row.title = title;
    return row;
  };
  const pan = named(slider({
    label: 'Left or right', min: -1, max: 1, step: 0.05, value: 0, format: panWords,
    onInput: (v) => write({ pan: v }, 'pan'), onChange: done
  }), `${prefix}Pan`, 'Pan: which side the sound comes from');
  const band = (name, label, id, title) => named(slider({
    label, min: -12, max: 12, step: 0.5, value: 0, format: decibels,
    onInput: (v) => write({ eq: { ...tone().eq, [name]: v } }, `eq-${name}`), onChange: done
  }), id, title);
  const low = band('low', 'Low tones', `${prefix}EqLow`, 'Equalizer: bass, below about 200 Hz');
  const mid = band('mid', 'Middle tones', `${prefix}EqMid`, 'Equalizer: the middle, around 1 kHz');
  const high = band('high', 'High tones', `${prefix}EqHigh`, 'Equalizer: treble, above about 4 kHz');
  const compressor = (patch, gesture = null) => write({ compressor: { ...tone().compressor, ...patch } }, gesture);
  const on = named(toggle({
    label: 'Even out loud and quiet parts', hint: 'Turns the loudest moments down',
    onChange: (checked) => compressor({ on: checked })
  }), `${prefix}CompOn`, 'Compressor');
  const threshold = named(slider({
    label: 'Turn down above', min: -60, max: 0, step: 1, value: -24, format: decibels,
    onInput: (v) => compressor({ threshold: v }, 'threshold'), onChange: done
  }), `${prefix}CompThreshold`, 'Compressor threshold: louder than this is turned down');
  const ratio = named(slider({
    label: 'How much', min: 1, max: 20, step: 0.5, value: 4, format: (v) => `${v}:1`,
    onInput: (v) => compressor({ ratio: v }, 'ratio'), onChange: done
  }), `${prefix}CompRatio`, 'Compressor ratio: 4:1 lets a quarter of the extra loudness through');
  const makeup = named(slider({
    label: 'Then turn it all up', min: 0, max: 24, step: 0.5, value: 0, format: decibels,
    onInput: (v) => compressor({ makeup: v }, 'makeup'), onChange: done
  }), `${prefix}CompMakeup`, 'Makeup gain: added after the loud parts are turned down');
  const reset = h('button', {
    type: 'button', class: 'btn small', id: `${prefix}ToneReset`, title: 'Back to the middle, flat tones and no evening out',
    onclick: () => { if (!isNeutralTone(read() ?? {})) write(defaultTone()); }
  }, 'Reset');
  const note = h('span', { class: 'advanced-note' });
  const details = h('details', { class: 'advanced', id: `${prefix}Advanced` },
    h('summary', {}, 'Advanced', note),
    h('div', { class: 'advanced-body' }, pan, low, mid, high, on, threshold, ratio, makeup,
      h('div', { class: 'clip-actions' }, reset)));
  try { details.open = storage?.getItem(key) === '1'; } catch { /* private storage unavailable: it starts folded */ }
  details.addEventListener('toggle', () => {
    try { storage?.setItem(key, details.open ? '1' : '0'); } catch { /* it just starts folded next time */ }
  });
  details.update = () => {
    const t = tone();
    pan.set(t.pan);
    low.set(t.eq.low);
    mid.set(t.eq.mid);
    high.set(t.eq.high);
    on.set(t.compressor.on);
    threshold.set(t.compressor.threshold);
    ratio.set(t.compressor.ratio);
    makeup.set(t.compressor.makeup);
    for (const el of [threshold, ratio, makeup]) el.hidden = !t.compressor.on;
    const neutral = isNeutralTone(t);
    reset.disabled = neutral;
    // Folded, it still says that something in it is changing the sound.
    note.textContent = neutral ? '' : 'in use';
  };
  return details;
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
    const micAdvanced = advancedTone('mic', {
      read: () => store.project.audio.mic, write: (patch, gesture) => change({ mic: patch }, gesture && `audio:mic:${gesture}`), done
    });
    const micSection = section(null, micHead, micVolume, cleanUp, even, micAdvanced);

    // ---- computer sound
    const sysHead = trackHead('screen', 'Computer sound', { onMute: () => change({ system: { muted: !store.project.audio.system.muted } }) });
    const sysVolume = slider({
      label: 'Volume', min: 0, max: 2, step: 0.05, value: 0.8, format: percent,
      onInput: (v) => change({ system: { volume: v } }, 'audio:system'), onChange: done
    });
    sysVolume.querySelector('input').id = 'systemVolume';
    const sysAdvanced = advancedTone('system', {
      read: () => store.project.audio.system, write: (patch, gesture) => change({ system: patch }, gesture && `audio:system:${gesture}`), done
    });
    const sysSection = section(null, sysHead, sysVolume, sysAdvanced);
    sysSection.id = 'systemSection';

    // ---- the video's own sound as its own clips ("detach audio")
    const detachBtn = h('button', {
      type: 'button', class: 'btn', id: 'detachAudio',
      onclick: () => {
        const sel = store.selection;
        const one = sel?.kind === 'clip';
        const before = store.project.audio.clips.length;
        const next = store.apply((p) => (one ? P.detachAudio(p, sel.id) : P.detachAllAudio(p)));
        if (!next) return;
        const added = next.audio.clips.length - before;
        if (!added) {
          editor.toast('There\u2019s no video sound left to detach (parts with a speed change keep theirs).');
          return;
        }
        editor.select({ kind: 'audio', id: next.audio.clips.at(-1).id });
        editor.toast(added === 1 ? 'The video\u2019s sound is now its own clip' : `The video\u2019s sound is now ${added} clips`);
      }
    }, icon('detach', { size: 16 }), 'Detach video sound');
    const detachSection = section(null, detachBtn,
      h('p', { class: 'hint' }, 'Makes the video\u2019s own sound a clip on the audio rows, to move, trim or delete (keep only the music). Select a clip on the timeline first to detach just that part.'));
    detachSection.id = 'detachSection';

    // ---- songs and sounds
    // Every audio clip in the video, and -- when one is selected on the
    // timeline -- its own settings above everything else, as an editor's
    // inspector shows the selected clip.
    const byId = (id) => store.project.audio.clips.find((c) => c.id === id);
    const selectedClip = () => (store.selection?.kind === 'audio' ? byId(store.selection.id) ?? null : null);
    const clipChange = (patch, gesture = null) => {
      const c = selectedClip();
      if (c) store.apply((p) => P.updateAudioClip(p, c.id, patch), { gesture });
    };
    // A typed time: applied on Enter or leaving the field; anything that
    // isn't a time puts the current one back.
    const timeField = (id, label, apply) => {
      const input = h('input', { type: 'text', id, class: 'time-input small', inputMode: 'decimal', spellcheck: 'false', autocomplete: 'off' });
      const commit = () => {
        const t = parseTime(input.value);
        if (t !== null) apply(t);
        update();
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
      return { input, label: h('label', { class: 'label', for: id }, label) };
    };
    const lastStart = () => Math.max(0, store.tl.duration - 0.1);
    const seconds = (v) => `${v.toFixed(1)} s`;

    const clipName = h('span', { class: 'music-name', id: 'clipName' });
    const clipHead = h('div', { class: 'music-file' }, glyph('music', 16), clipName,
      h('button', {
        type: 'button', class: 'icon-btn small', id: 'deselectClip', title: 'Back to all audio', 'aria-label': 'Back to all audio',
        onclick: () => editor.select(null)
      }, icon('close', { size: 16 })));
    const clipVolume = slider({
      label: 'Volume', min: 0, max: 2, step: 0.05, value: 0.3, format: percent,
      onInput: (v) => clipChange({ volume: v }, `audio:${store.selection?.id}:volume`), onChange: done
    });
    clipVolume.querySelector('input').id = 'clipVolume';
    const fadeIn = slider({
      label: 'Fade in', min: 0, max: 10, step: 0.1, value: 0, format: seconds,
      onInput: (v) => {
        const c = selectedClip();
        if (c) clipChange({ fadeIn: Math.min(v, P.audioClipLength(c, store.tl.duration) - c.fadeOut) }, `audio:${c.id}:fadeIn`);
      },
      onChange: done
    });
    fadeIn.querySelector('input').id = 'clipFadeIn';
    const fadeOut = slider({
      label: 'Fade out', min: 0, max: 10, step: 0.1, value: 0, format: seconds,
      onInput: (v) => {
        const c = selectedClip();
        if (c) clipChange({ fadeOut: Math.min(v, P.audioClipLength(c, store.tl.duration) - c.fadeIn) }, `audio:${c.id}:fadeOut`);
      },
      onChange: done
    });
    fadeOut.querySelector('input').id = 'clipFadeOut';
    const clipStart = timeField('clipStart', 'Starts at', (t) => clipChange({ start: Math.min(t, lastStart()) }));
    const clipFrom = timeField('clipFrom', 'Song from', (t) => {
      const c = selectedClip();
      if (!c) return;
      const most = c.fileDuration > 0 ? c.fileDuration - 0.1 : Infinity;
      const from = Math.min(t, most);
      // Starting later into the song leaves less of it to play.
      const length = c.length !== null && !c.loop && c.fileDuration > 0 ? Math.min(c.length, c.fileDuration - from) : c.length;
      clipChange({ from, length });
    });
    const clipLength = timeField('clipLength', 'Length', (t) => {
      const c = selectedClip();
      if (!c) return;
      const most = !c.loop && c.fileDuration > 0 ? c.fileDuration - c.from : Infinity;
      clipChange({ length: Math.max(0.1, Math.min(t, most)) });
    });
    const atPlayhead = h('button', {
      type: 'button', class: 'btn small', id: 'clipAtPlayhead', title: 'Start this audio where the playhead is',
      onclick: () => clipChange({ start: Math.min(player.time, lastStart()) })
    }, 'Playhead');
    // A grid: label | time | button, so the times line up.
    const clipTimes = h('div', { class: 'music-times' },
      clipStart.label, clipStart.input, atPlayhead,
      clipFrom.label, clipFrom.input, h('span'),
      clipLength.label, clipLength.input, h('span'));
    const loop = toggle({
      label: 'Repeat until the end', hint: 'Plays the song again and again to the end of the video',
      onChange: (on) => clipChange({ loop: on, length: null })
    });
    loop.input.id = 'clipLoop';
    const duck = toggle({
      label: 'Lower it when someone talks', hint: 'So voices are always clear',
      onChange: (on) => clipChange({ duck: on })
    });
    duck.input.id = 'clipDuck';
    const mute = toggle({ label: 'Mute this audio', onChange: (on) => clipChange({ muted: on }) });
    mute.input.id = 'clipMute';
    const beats = toggle({
      label: 'Beat marks', hint: 'Marks the song\u2019s beats on its clip; drags snap to them',
      onChange: (on) => clipChange({ beats: on })
    });
    beats.input.id = 'clipBeats';
    // Volume over time: points on the clip's volume line.
    const pointsNote = h('p', { class: 'hint points-note' });
    const pointsRow = h('div', { class: 'clip-actions' },
      h('button', {
        type: 'button', class: 'btn small', id: 'addVolumePoint', title: 'A volume point where the playhead is (or ⌥-click the line on the clip)',
        onclick: () => {
          const c = selectedClip();
          if (!c) return;
          const t = player.time - c.start;
          const len = P.audioClipLength(c, store.tl.duration);
          if (t < 0 || t > len) {
            editor.toast('Move the playhead over this audio first.');
            return;
          }
          clipChange({ points: [...c.points, { t: Math.round(t * 100) / 100, gain: clipGain(c, t) }] });
        }
      }, icon('plus', { size: 14 }), 'Volume point at playhead'),
      h('button', {
        type: 'button', class: 'btn small', id: 'clearVolumePoints', title: 'Back to one volume for the whole clip',
        onclick: () => {
          const c = selectedClip();
          // Back to the clip's own volume, as before the points.
          if (c?.points.length) clipChange({ points: [] });
        }
      }, 'Clear points'));
    const lockedNote = h('p', { class: 'hint locked-note' }, 'Its row is locked: unlock it (the lock beside “A1” on the timeline) to change it.');
    const reattach = h('button', {
      type: 'button', class: 'btn small', id: 'reattachAudio', title: 'Remove this clip and play the sound from the video again',
      onclick: () => {
        const c = selectedClip();
        if (!c) return;
        const next = store.apply((p) => P.reattachAudio(p, c.id));
        if (next) { editor.select(null); editor.toast('The sound is back on the video'); }
      }
    }, 'Put back on the video');
    const clipActions = h('div', { class: 'clip-actions' },
      h('button', {
        type: 'button', class: 'btn small', id: 'splitAudio', title: 'Split this audio at the playhead (S)',
        onclick: () => splitSelectedAudio(editor)
      }, icon('split', { size: 14 }), 'Split'),
      h('button', {
        type: 'button', class: 'btn small', id: 'duplicateAudio', title: 'Put a copy right after it (or ⌥-drag it)',
        onclick: () => {
          const c = selectedClip();
          if (!c) return;
          const next = store.apply((p) => P.duplicateAudioClip(p, c.id));
          if (next) editor.select({ kind: 'audio', id: next.audio.clips.at(-1).id });
        }
      }, icon('duplicate', { size: 14 }), 'Duplicate'),
      h('button', {
        type: 'button', class: 'btn small danger-quiet', id: 'deleteAudio', title: 'Delete this audio (Delete)',
        onclick: () => {
          const c = selectedClip();
          if (!c) return;
          store.apply((p) => P.removeAudioClip(p, c.id));
          editor.select(null);
        }
      }, icon('trash', { size: 14 }), 'Delete'));
    clipActions.append(reattach);
    const clipAdvanced = advancedTone('clip', {
      read: selectedClip, write: (patch, gesture) => clipChange(patch, gesture && `audio:${store.selection?.id}:${gesture}`), done
    });
    const inspector = section(null, trackHead('music', 'Selected audio'), clipHead, lockedNote, clipVolume, pointsNote, pointsRow,
      fadeIn, fadeOut, clipTimes, loop, beats, duck, mute, clipActions, clipAdvanced);
    inspector.classList.add('audio-inspector');
    inspector.id = 'audioInspector';

    const addBtn = h('button', {
      type: 'button', class: 'btn', id: 'addMusic', onclick: () => addAudioFiles(editor, () => window.loupe.chooseMusic())
    }, icon('plus', { size: 16 }), 'Add audio');
    const clipList = h('div', { class: 'audio-list', id: 'audioList', role: 'list' });
    const musicSection = section(null, trackHead('music', 'Songs & sounds'), addBtn,
      h('p', { class: 'hint music-hint' }, 'Or drop audio files anywhere on this window. Each one is a clip on the timeline: click it there (or here) to change it.'),
      clipList);

    function renderClipList() {
      const clips = store.project.audio.clips;
      const d = store.tl.duration;
      const sel = selectedClip();
      clipList.replaceChildren(...[...clips].sort((a, b) => a.start - b.start).map((c) => h('button', {
        type: 'button', role: 'listitem', class: `audio-row${sel?.id === c.id ? ' selected' : ''}${c.muted ? ' muted' : ''}`,
        dataset: { id: c.id },
        onclick: () => { editor.select({ kind: 'audio', id: c.id }); player.seek(Math.min(c.start, d)); }
      },
      glyph('music', 15),
      h('span', { class: 'audio-row-name' }, c.name || 'Audio'),
      h('span', { class: 'audio-row-time' },
        `${formatTime(c.start)}–${formatTime(P.audioClipEnd(c, d))} · Row ${c.lane + 1}${c.muted ? ' · muted' : ''}`))));
    }

    // ---- voiceover
    const recordBtn = h('button', { type: 'button', class: 'btn record-btn', id: 'recordVoiceover', onclick: () => session.start() });
    const voHint = h('p', { class: 'hint' });
    const takes = h('div', { class: 'take-list' });
    const voSection = section(null, trackHead('mic', 'Voiceover'), recordBtn, voHint, takes);

    const status = h('p', { class: 'audio-status', hidden: true }, h('span', { class: 'audio-note-dot' }), 'Preparing audio…');
    container.append(status, inspector, micSection, sysSection, detachSection, musicSection, voSection);

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
      const attached = p.clips.some((k) => !k.detached);
      detachSection.hidden = !sources.some((s) => s.mic || s.systemAudio) || !attached;
      detachBtn.lastChild.textContent = store.selection?.kind === 'clip' ? 'Detach this clip\u2019s sound' : 'Detach video sound';
      micHead.setMuted(a.mic.muted);
      micVolume.set(a.mic.volume);
      cleanUp.set(a.mic.cleanUp);
      even.set(a.mic.level);
      micAdvanced.update();
      for (const el of [micVolume, cleanUp, even, micAdvanced]) el.classList.toggle('disabled', a.mic.muted);
      sysHead.setMuted(a.system.muted);
      sysVolume.set(a.system.volume);
      sysVolume.classList.toggle('disabled', a.system.muted);
      sysAdvanced.update();
      sysAdvanced.classList.toggle('disabled', a.system.muted);
      const c = selectedClip();
      inspector.hidden = !c;
      if (c) {
        const d = store.tl.duration;
        const failed = player.audio?.file('music', c.file)?.status === 'failed';
        clipName.textContent = failed ? `${c.name || 'Audio'} (can’t be played)` : (c.name || 'Audio');
        clipName.title = baseName(c.file);
        clipHead.classList.toggle('bad', failed);
        clipVolume.set(c.volume);
        fadeIn.set(c.fadeIn);
        fadeOut.set(c.fadeOut);
        // Not while it's being typed in. To the nearest tenth (a dragged
        // start of 0.598 s reads 0:00.6, not 0:00.5).
        const shown = (t) => formatTime(Math.round((t ?? 0) * 10) / 10, { fraction: true });
        if (document.activeElement !== clipStart.input) clipStart.input.value = shown(c.start);
        if (document.activeElement !== clipFrom.input) clipFrom.input.value = shown(c.from);
        if (document.activeElement !== clipLength.input) clipLength.input.value = shown(P.audioClipLength(c, d));
        loop.set(c.loop);
        duck.set(c.duck);
        mute.set(c.muted);
        beats.set(c.beats);
        const found = !c.source ? player.audio?.file('music', c.file)?.beats : null;
        beats.querySelector('.hint')?.replaceChildren(found?.bpm
          ? `${Math.round(found.bpm)} BPM · marks the beats on the clip; drags snap to them`
          : found ? 'No steady beat found in this song' : 'Marks the song\u2019s beats on its clip; drags snap to them');
        const locked = P.audioLaneOf(store.project.audio, c.lane).locked;
        lockedNote.hidden = !locked;
        lockedNote.textContent = `Its row is locked: unlock it (the lock beside “A${c.lane + 1}” on the timeline) to change it.`;
        const hasPoints = c.points.length > 0;
        pointsNote.textContent = hasPoints
          ? `The volume follows ${c.points.length} point${c.points.length > 1 ? 's' : ''} on the clip\u2019s line: drag them, double-click one to remove it.`
          : 'To change the volume over time, ⌥-click the line on the clip, or add a point here.';
        clipVolume.classList.toggle('disabled', hasPoints || c.muted || locked);
        clipAdvanced.update();
        for (const el of [fadeIn, fadeOut, duck, pointsRow, clipTimes, loop, beats, mute, clipActions, clipAdvanced]) el.classList.toggle('disabled', locked);
        for (const el of [fadeIn, fadeOut, duck, clipAdvanced]) if (c.muted) el.classList.add('disabled');
        // Detached video sound: no song settings, and a way back.
        clipFrom.label.textContent = c.source ? 'Video from' : 'Song from';
        loop.hidden = Boolean(c.source);
        beats.hidden = Boolean(c.source);
        reattach.hidden = !c.source;
      }
      renderClipList();
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
