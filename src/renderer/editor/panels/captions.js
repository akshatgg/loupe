// Captions: write them from what was said (on this computer, with a one-time
// download of the speech model), fix the words in a transcript that follows
// the playhead, and choose how they look on the video.
//
// Three states: nothing yet ("Generate captions", the language, and what the
// first time downloads), working (progress with Cancel), and editing (show
// on the video, style, the transcript). Every change is one undo step; the
// transcript's text is committed when a caption loses focus or Enter is
// pressed, so typing a sentence is one step too.

import { h, icon, slider, toggle, segmented, section } from '../ui.js';
import { setCaptions } from '../../../core/project.js';
import { languageChoices } from '../../../core/captions/languages.js';
import { editText, removeSegment, mergeWithNext, splitSegment, addSegment } from '../../../core/captions/edit.js';
import { captionsToOutput } from '../../../core/captions/timeline.js';
import { toSRT } from '../../../core/captions/format.js';
import { createCaptionsEngine } from '../../captions/client.js';
import { clipLayout, formatTime } from '../timeline-math.js';
import { transcriptRows, captionIdAt, newCaptionRange, replaceSegments } from '../captions-math.js';

const MODEL = 'standard';

const megabytes = (bytes) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

// "Error invoking remote method 'x': Error: message" -> "message"
const plain = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');

export default {
  id: 'captions',
  title: 'Captions',
  icon: 'captions',
  mount(container, editor) {
    const { store, player } = editor;
    const loupe = globalThis.window?.loupe;
    let engine = null;
    let model = null;        // { bytes, downloaded } of the speech model, once known
    let working = null;      // { cancel } while captions are being written
    let failure = null;      // a message to show instead of the start view
    let replacing = false;   // "Write captions again" asked once already

    const captions = () => store.project.captions;
    const edit = (fn, gesture = null) => store.apply((p) => setCaptions(p, fn(p.captions)), { gesture });
    const editSegments = (fn) => edit((c) => ({ segments: fn(c.segments) }));
    const done = () => store.endGesture();

    // Which recordings in the video have sound to listen to, and where it is.
    function soundSources() {
      const p = store.project;
      const keys = [...new Set(p.clips.map((c) => c.source))];
      return keys.map((key) => {
        const meta = p.sources[key];
        const files = editor.sources?.[key] ?? {};
        const url = meta.mic && files.video ? files.video : files.systemAudio ?? null;
        return url && !files.missing ? { key, url } : null;
      }).filter(Boolean);
    }

    // ---- the language, shared by the start view and "Write captions again"
    const language = h('select', { id: 'captionsLanguage', class: 'select', 'aria-label': 'Spoken language' },
      languageChoices().map((l) => h('option', { value: l.code }, l.name)));
    language.value = captions().language;
    const languageField = h('label', { class: 'field' }, h('span', { class: 'label' }, 'Spoken language'), language);

    // ---- start
    const downloadNote = h('div', { class: 'cap-note', id: 'captionsDownloadNote', hidden: true });
    const noSound = h('div', { class: 'cap-note', hidden: true }, icon('alert', { size: 16 }),
      h('span', {}, 'This video has no sound to write captions from. Captions come from the microphone or computer sound.'));
    const generateBtn = h('button', { type: 'button', class: 'btn primary wide', id: 'captionsGenerate', onclick: () => generate() },
      icon('captions'), 'Generate captions');
    const startIntro = h('div', { class: 'panel-empty compact' },
      h('div', { class: 'empty-icon' }, icon('captions', { size: 28 })),
      h('h3', {}, 'Add captions'),
      h('p', {}, 'Loupe listens to your recording and writes captions for you. It all happens on this computer.'));
    // The language and the download note sit here, or under "Write captions again".
    const startSlot = h('div', {}, languageField, downloadNote);
    const startView = h('div', { class: 'cap-start' }, startIntro, startSlot, noSound, generateBtn);

    // ---- working
    const workTitle = h('h3', { class: 'cap-work-title' }, 'Writing captions');
    const bar = h('div', { class: 'progress-fill' });
    const percent = h('span', { class: 'percent', id: 'captionsPercent' }, '0%');
    const stage = h('p', { class: 'hint', id: 'captionsStage' }, 'Getting ready…');
    const cancelBtn = h('button', { type: 'button', class: 'btn', id: 'captionsCancel', onclick: () => working?.cancel() }, 'Cancel');
    const workView = h('div', { class: 'cap-work', hidden: true },
      workTitle, h('div', { class: 'progress-row' }, h('div', { class: 'progress', role: 'progressbar' }, bar), percent), stage,
      h('p', { class: 'hint' }, 'You can keep editing while this runs.'), cancelBtn);

    // ---- failed
    const errorText = h('p', { id: 'captionsError' });
    const errorView = h('div', { class: 'cap-error', hidden: true },
      h('div', { class: 'export-error' }, icon('alert', { size: 20 }), errorText),
      h('button', { type: 'button', class: 'btn', onclick: () => { failure = null; update(); } }, 'Try again'));

    // ---- editing
    const show = toggle({
      label: 'Show captions on the video', checked: captions().show,
      onChange: (v) => { edit(() => ({ show: v })); }
    });
    show.input.id = 'captionsShow';
    const size = slider({
      label: 'Text size', min: 0.5, max: 2, step: 0.05, value: captions().style.size,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => edit(() => ({ style: { size: v } }), 'captions:size'), onChange: done
    });
    size.querySelector('input').id = 'captionsSize';
    const position = segmented({
      label: 'Position', value: captions().style.position,
      options: [{ value: 'bottom', label: 'Bottom' }, { value: 'top', label: 'Top' }],
      onChange: (v) => edit(() => ({ style: { position: v } }))
    });
    position.id = 'captionsPosition';
    const box = toggle({
      label: 'Background box', hint: 'A dark box behind the words keeps them easy to read.', checked: captions().style.box,
      onChange: (v) => edit(() => ({ style: { box: v } }))
    });
    box.input.id = 'captionsBox';

    const count = h('h3', {});
    const list = h('div', { class: 'cap-list', id: 'captionsList' });
    const addBtn = h('button', { type: 'button', class: 'btn', id: 'captionsAdd', onclick: () => addHere() }, icon('plus'), 'Add a caption here');
    const saveBtn = h('button', { type: 'button', class: 'btn', id: 'captionsSave', onclick: () => saveSubtitles() }, 'Save subtitles…');
    const againHint = h('p', { class: 'hint', hidden: true }, 'This replaces your captions, and any changes you made to them.');
    const againBtn = h('button', { type: 'button', class: 'btn', id: 'captionsAgain', onclick: () => writeAgain() }, 'Write captions again');
    const keepBtn = h('button', { type: 'button', class: 'btn', hidden: true, onclick: () => { replacing = false; update(); } }, 'Keep them');
    const againLanguage = h('div', {});
    const editView = h('div', { class: 'cap-edit', hidden: true },
      section(null, show),
      section('Look', size, position, box),
      section(null, count, h('p', { class: 'hint cap-list-hint' }, 'Click a time to jump there, and fix any words right here.'), list,
        h('div', { class: 'cap-buttons' }, addBtn, saveBtn)),
      section('Captions from speech', againLanguage, againHint, h('div', { class: 'cap-buttons' }, againBtn, keepBtn)));

    container.append(startView, workView, errorView, editView);

    // ---- the speech model
    async function refreshModel() {
      try {
        engine ??= createCaptionsEngine();
        const models = await engine.listModels();
        model = models.find((m) => m.key === MODEL) ?? null;
      } catch {
        model = null;
      }
      update();
    }

    function renderDownloadNote() {
      downloadNote.hidden = !model || model.downloaded;
      if (downloadNote.hidden) return;
      downloadNote.replaceChildren(icon('folder', { size: 16 }), h('span', {},
        `The first time, Loupe downloads its speech model (${megabytes(model.bytes)}). This only happens once, and your recording never leaves this computer.`));
    }

    // ---- writing captions
    async function generate() {
      if (working) return;
      const sources = soundSources();
      if (!sources.length) return;
      engine ??= createCaptionsEngine();
      const lang = language.value;
      failure = null;
      replacing = false;
      let current = null;
      let cancelled = false;
      working = { cancel: () => { cancelled = true; current?.cancel(); } };
      const bytes = model?.bytes ?? 0;
      const fresh = [];
      bar.style.width = '0%';
      percent.textContent = '0%';
      stage.textContent = 'Getting ready…';
      cancelBtn.disabled = false;
      update();
      try {
        for (const [i, src] of sources.entries()) {
          if (cancelled) break;
          current = engine.transcribe({
            url: src.url, source: src.key, language: lang, model: MODEL,
            onProgress: (pr) => {
              const pct = Math.min(100, Math.round(((i + pr.overall) / sources.length) * 100));
              bar.style.width = `${pct}%`;
              percent.textContent = `${pct}%`;
              let text = pr.text;
              if (pr.stage === 'model' && bytes) text = `${text} ${megabytes(bytes * pr.fraction)} of ${megabytes(bytes)}`;
              if (pr.stage !== 'model' && sources.length > 1) text = `${text} (recording ${i + 1} of ${sources.length})`;
              stage.textContent = text;
            }
          });
          const result = await current.promise;
          fresh.push(...result.segments);
        }
        if (!cancelled) {
          const next = edit((c) => ({
            segments: replaceSegments(c.segments, sources.map((s) => s.key), fresh), language: lang, show: true
          }));
          if (next && !fresh.length) editor.toast('No speech was found in this recording.');
        }
      } catch (err) {
        if (err?.code !== 'cancelled' && !cancelled) failure = plain(err);
      } finally {
        working = null;
        refreshModel();
      }
    }

    function writeAgain() {
      if (!replacing) {
        replacing = true;
        update();
        return;
      }
      generate();
    }

    // ---- the transcript
    const rows = new Map(); // id -> { el, time, text, split, merge }
    const carets = new Map(); // id -> the text cursor's last position

    function commitText(id, textarea) {
      const seg = captions().segments.find((s) => s.id === id);
      if (!seg) return;
      const value = textarea.value.trim();
      if (value === seg.text) return;
      if (!value) {
        editSegments((segs) => removeSegment(segs, id));
        return;
      }
      editSegments((segs) => editText(segs, id, value));
    }

    function splitRow(id) {
      const seg = captions().segments.find((s) => s.id === id);
      if (!seg) return;
      const at = carets.get(id);
      let where;
      if (at > 0 && at < seg.text.length) {
        where = { index: at };
      } else {
        // No cursor inside the words: split at the playhead if it's on this
        // caption, otherwise at the space nearest the middle.
        const src = store.tl.toSource(player.time);
        if (src.source === seg.source && src.t > seg.start && src.t < seg.end) where = { time: src.t };
        else {
          const mid = seg.text.length / 2;
          const spaces = [...seg.text.matchAll(/\s/g)].map((m) => m.index);
          if (!spaces.length) { editor.toast('Put the text cursor where this caption should be split.'); return; }
          where = { index: spaces.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a)) };
        }
      }
      const before = captions().segments.length;
      const next = editSegments((segs) => splitSegment(segs, id, where));
      if (next && next.captions.segments.length === before) editor.toast('This caption is too short to split there.');
    }

    function makeRow(seg) {
      const time = h('button', { type: 'button', class: 'cap-time', title: 'Jump to this caption' });
      const text = h('textarea', { class: 'cap-text', rows: '1', spellcheck: true, 'aria-label': 'Caption text' });
      const keepFocus = (e) => e.preventDefault(); // the text cursor stays put for Split
      const split = h('button', { type: 'button', class: 'icon-btn small', title: 'Split in two at the text cursor', 'aria-label': 'Split', onmousedown: keepFocus, onclick: () => splitRow(seg.id) }, icon('split', { size: 15 }));
      const merge = h('button', { type: 'button', class: 'icon-btn small', title: 'Join with the next caption', 'aria-label': 'Join with the next caption', onmousedown: keepFocus, onclick: () => editSegments((segs) => mergeWithNext(segs, seg.id)) }, icon('merge', { size: 15 }));
      const del = h('button', { type: 'button', class: 'icon-btn small', title: 'Delete this caption', 'aria-label': 'Delete caption', onclick: () => editSegments((segs) => removeSegment(segs, seg.id)) }, icon('trash', { size: 15 }));
      const el = h('div', { class: 'cap-row', dataset: { id: seg.id } },
        h('div', { class: 'cap-row-head' }, time, h('span', { class: 'cap-actions' }, split, merge, del)), text);
      const row = { el, time, text, merge, outStart: null };
      time.addEventListener('click', () => {
        if (row.outStart !== null) player.seek(row.outStart + 0.01);
        editor.select({ kind: 'caption', id: seg.id });
      });
      const fit = () => { text.style.height = 'auto'; text.style.height = `${text.scrollHeight}px`; };
      const remember = () => carets.set(seg.id, text.selectionStart);
      text.addEventListener('input', () => { fit(); remember(); });
      text.addEventListener('keyup', remember);
      text.addEventListener('click', remember);
      text.addEventListener('focus', () => {
        el.classList.add('editing');
        if (row.outStart !== null && !player.playing) player.seek(row.outStart + 0.01);
      });
      text.addEventListener('blur', () => { el.classList.remove('editing'); commitText(seg.id, text); });
      text.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); text.blur(); }
        if (e.key === 'Escape') {
          e.stopPropagation();
          text.value = captions().segments.find((s) => s.id === seg.id)?.text ?? text.value;
          text.blur();
        }
      });
      row.fit = fit;
      return row;
    }

    function renderList() {
      const p = store.project;
      const ordered = transcriptRows(p, clipLayout(p, store.tl));
      const alive = new Set(ordered.map((r) => r.seg.id));
      for (const id of [...rows.keys()]) if (!alive.has(id)) { rows.delete(id); carets.delete(id); }
      const sel = store.selection?.kind === 'caption' ? store.selection.id : null;
      const els = ordered.map((r, i) => {
        let row = rows.get(r.seg.id);
        if (!row) { row = makeRow(r.seg); rows.set(r.seg.id, row); }
        row.outStart = r.outStart;
        row.time.textContent = r.outStart === null ? 'Cut from the video'
          : `${formatTime(r.outStart, { fraction: true })} – ${formatTime(r.outEnd, { fraction: true })}`;
        row.el.classList.toggle('cut', r.outStart === null);
        row.el.classList.toggle('selected', r.seg.id === sel);
        const next = ordered.slice(i + 1).some((o) => o.seg.source === r.seg.source);
        row.merge.disabled = !next;
        if (document.activeElement !== row.text && row.text.value !== r.seg.text) {
          row.text.value = r.seg.text;
        }
        return row.el;
      });
      const same = els.length === list.children.length && els.every((el, i) => list.children[i] === el);
      if (!same) {
        const focused = document.activeElement;
        list.replaceChildren(...els);
        if (focused && list.contains(focused)) focused.focus();
      }
      // Heights once the rows are in the page (scrollHeight is 0 before).
      requestAnimationFrame(() => { for (const r of rows.values()) r.fit(); });
      count.textContent = `Transcript (${ordered.length})`;
      markPlaying(player.time);
    }

    let playingId = null;
    function markPlaying(t) {
      const id = captionIdAt(store.project, store.tl, t);
      if (id === playingId) return;
      rows.get(playingId)?.el.classList.remove('playing');
      playingId = id;
      const row = rows.get(id);
      if (!row) return;
      row.el.classList.add('playing');
      // Follow along while playing, unless a caption is being edited.
      if (player.playing && !editView.hidden && !list.contains(document.activeElement)) {
        row.el.scrollIntoView({ block: 'nearest' });
      }
    }
    player.onTime((t) => { if (!editView.hidden) markPlaying(t); });

    function addHere() {
      const p = store.project;
      const range = newCaptionRange(p, clipLayout(p, store.tl), player.time);
      if (!range) {
        editor.toast('There’s already a caption here. Move the playhead to a gap to add one.');
        return;
      }
      const before = new Set(captions().segments.map((s) => s.id));
      const next = editSegments((segs) => addSegment(segs, { ...range, text: 'New caption' }));
      const added = next?.captions.segments.find((s) => !before.has(s.id));
      if (!added) return;
      editor.select({ kind: 'caption', id: added.id });
      const row = rows.get(added.id);
      if (row) { row.text.focus(); row.text.select(); }
    }

    async function saveSubtitles() {
      const p = store.project;
      const cues = captionsToOutput(p.captions.segments, store.tl);
      if (!cues.length) { editor.toast('None of the captions are in the video.'); return; }
      try {
        const res = await loupe.captions.saveSubtitles({ format: 'srt', text: toSRT(cues), name: p.title });
        if (res?.saved) editor.toast('Subtitles saved');
      } catch (err) {
        editor.toast(`The subtitles couldn’t be saved: ${plain(err)}`);
      }
    }

    // Scrolls to and outlines a caption chosen on the timeline.
    function reveal(id, { focus = false } = {}) {
      const row = rows.get(id);
      if (!row) return;
      row.el.scrollIntoView({ block: 'nearest' });
      if (focus) row.text.focus();
    }

    // ---- keeping in step
    function update() {
      const c = captions();
      const hasCaptions = c.segments.length > 0;
      workView.hidden = !working;
      errorView.hidden = Boolean(working) || !failure;
      startView.hidden = Boolean(working) || Boolean(failure) || hasCaptions;
      editView.hidden = Boolean(working) || Boolean(failure) || !hasCaptions;
      if (failure) errorText.textContent = failure;
      const sources = soundSources();
      noSound.hidden = sources.length > 0;
      generateBtn.disabled = !sources.length;
      againBtn.disabled = !sources.length;
      renderDownloadNote();
      const slot = editView.hidden ? startSlot : replacing ? againLanguage : null;
      if (slot && !slot.contains(languageField)) slot.append(languageField, downloadNote);
      if (!slot && againLanguage.contains(languageField)) startSlot.append(languageField, downloadNote);
      if (!editView.hidden) {
        againHint.hidden = !replacing;
        keepBtn.hidden = !replacing;
        againBtn.textContent = replacing ? 'Replace my captions' : 'Write captions again';
        againBtn.classList.toggle('primary', replacing);
        show.set(c.show);
        size.set(c.style.size);
        position.set(c.style.position);
        box.set(c.style.box);
        renderList();
      }
    }

    refreshModel();
    update();
    return {
      update(what) {
        // Coming back to the panel: the model may have been downloaded meanwhile.
        if (what === 'panel' && !working) refreshModel();
        update();
        if ((what === 'selection' || what === 'panel') && store.selection?.kind === 'caption') reveal(store.selection.id);
      },
      reveal,
      get busy() { return Boolean(working); }
    };
  }
};
