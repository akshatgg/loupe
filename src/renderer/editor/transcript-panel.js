// The transcript beside the preview: what was said, word by word, in the
// order the video plays it. Clicking a word goes there; the word being
// spoken is lit while the video plays. Picking words and pressing Delete
// cuts them from the video (they stay here, struck through, to be put
// back); two switches remove filler words and shorten long pauses
// (core/transcript-edit.js). It reads the captions' transcript
// (core/captions), so it has words once the Captions tab has written them.
//
// The two functions at the top are pure (test/editor-transcript.test.mjs).

import { h, icon, toggle } from './ui.js';
import { cutSource, restoreSource, setFillersCut, setSilencesCut, hasCuts, SILENCE_LONGER_THAN } from '../../core/transcript-edit.js';

// The transcript in output order: [{ text, outStart, outEnd, segmentId,
// first, source, start, end }] -- `first` marks the first word of a caption
// line that plays; source/start/end are the word's moment of the recording.
// A line without word timings is one entry. Words in a part of the recording
// that was cut from the video are left out, or with `withCut` kept, marked
// `cut`, where they would have been said.
export function transcriptWords(project, tl, { withCut = false } = {}) {
  const out = [];
  let order = 0;
  for (const seg of project.captions?.segments ?? []) {
    const words = Array.isArray(seg.words) && seg.words.length
      ? seg.words : [{ text: seg.text, start: seg.start, end: seg.end }];
    let first = true;
    let lastOut = null;
    const pending = [];
    for (const w of words) {
      const text = String(w.text ?? '').trim();
      if (!text) continue;
      const base = { text, segmentId: seg.id, source: seg.source, start: w.start, end: w.end };
      // Cut when its middle doesn't play (an edge may sit on the cut itself).
      const mid = tl.toOutput(seg.source, (w.start + w.end) / 2);
      if (mid === null || mid === undefined) {
        if (!withCut) continue;
        const entry = { ...base, cut: true, outStart: lastOut, outEnd: lastOut, first: false, order: order++ };
        if (lastOut === null) pending.push(entry);
        out.push(entry);
        continue;
      }
      const start = tl.toOutput(seg.source, w.start);
      const outStart = start !== null && start !== undefined && start <= mid ? start : mid;
      const end = tl.toOutput(seg.source, w.end);
      // A word whose end was cut, or that plays backwards, still shows.
      const outEnd = end !== null && end !== undefined && end > outStart ? end : outStart + Math.max(0.05, (w.end - w.start) / 2);
      out.push({ ...base, outStart, outEnd, first, order: order++ });
      // Cut words before the line's first spoken word sit just before it.
      for (const e of pending) { e.outStart = outStart; e.outEnd = outStart; }
      pending.length = 0;
      lastOut = outEnd;
      first = false;
    }
    // A line cut whole has nowhere to sit: it is left out.
    for (const e of pending) out.splice(out.indexOf(e), 1);
  }
  return out.sort((a, b) => a.outStart - b.outStart || a.order - b.order);
}

// The word being said at output time t: the last one that has started, if
// it hasn't been over for more than a moment. -1 when there is none. Cut
// words are never being said.
export function wordAt(words, t, linger = 0.25) {
  let found = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].cut) continue;
    if (words[i].outStart <= t + 1e-6) found = i;
    else break;
  }
  if (found < 0) return -1;
  return t <= words[found].outEnd + linger ? found : -1;
}

// The stretch of one recording that words i..j (in either order) cover, or
// null when they are from different recordings or already cut.
export function wordsRange(words, i, j) {
  const picked = words.slice(Math.min(i, j), Math.max(i, j) + 1).filter((w) => !w.cut);
  if (!picked.length || picked.some((w) => w.source !== picked[0].source)) return null;
  return { source: picked[0].source, start: Math.min(...picked.map((w) => w.start)), end: Math.max(...picked.map((w) => w.end)), count: picked.length };
}

export function createTranscriptPanel({ root, store, player, editor, onClose }) {
  const body = h('div', { class: 'transcript-body', id: 'transcriptBody', tabIndex: 0, 'aria-label': 'Transcript: select words and press Delete to cut them from the video' });
  const empty = h('div', { class: 'transcript-empty' },
    h('p', {}, 'The words spoken in this video show here once its captions are written.'),
    h('button', {
      type: 'button', class: 'btn', id: 'transcriptWrite',
      onclick: () => { store.select(null); editor.showPanel('captions'); }
    }, icon('captions', { size: 16 }), 'Open Captions'));
  // What can be done with the words picked (or the cut word clicked).
  const cutBtn = h('button', { type: 'button', class: 'btn small danger-quiet', id: 'transcriptCut', hidden: true, onclick: () => cutPicked() });
  const restoreBtn = h('button', { type: 'button', class: 'btn small', id: 'transcriptRestore', hidden: true, onclick: () => restorePicked() }, 'Put this part back');
  const actionBar = h('div', { class: 'transcript-actions' }, cutBtn, restoreBtn);
  const fillers = toggle({
    label: 'Remove filler words', hint: '“um”, “uh” and the like',
    checked: false, onChange: (on) => flip('filler', on)
  });
  fillers.input.id = 'transcriptFillers';
  const silences = toggle({
    label: 'Shorten long pauses', hint: `Pauses over ${SILENCE_LONGER_THAN} second become a short breath`,
    checked: false, onChange: (on) => flip('silence', on)
  });
  silences.input.id = 'transcriptSilences';
  const foot = h('div', { class: 'transcript-foot' }, fillers, silences);
  root.replaceChildren(
    h('div', { class: 'transcript-head' },
      h('h2', { class: 'panel-title' }, 'Transcript'),
      h('button', { type: 'button', class: 'icon-btn small', id: 'transcriptClose', title: 'Hide the transcript', 'aria-label': 'Hide the transcript', onclick: () => onClose() }, icon('close', { size: 16 }))),
    empty, body, actionBar, foot);

  let words = [];
  let lit = -1;
  let shownFor = null;
  // The words picked: indexes into `words` (anchor first), or null.
  let picked = null;
  // A cut word that was clicked, to put back.
  let restoreAt = null;

  function flip(reason, on) {
    const before = store.tl.duration;
    const next = store.apply((p) => (reason === 'filler' ? setFillersCut(p, on) : setSilencesCut(p, on)));
    render(true);
    if (!next) return;
    const saved = before - store.tl.duration;
    if (on && Math.abs(saved) < 1e-6) editor.toast(reason === 'filler' ? 'No filler words found' : 'No long pauses found');
    else if (on) editor.toast(`${reason === 'filler' ? 'Filler words removed' : 'Pauses shortened'}: ${saved.toFixed(1)} s shorter`);
    else editor.toast(reason === 'filler' ? 'Filler words are back' : 'Pauses are back');
  }

  function cutPicked() {
    if (!picked) return;
    const range = wordsRange(words, picked[0], picked[1]);
    if (!range) { editor.toast('Pick words from one recording to cut them.'); return; }
    const at = Math.min(...[picked[0], picked[1]].map((i) => words[i]?.outStart ?? 0));
    if (store.apply((p) => cutSource(p, range.source, range.start, range.end))) {
      picked = null;
      player.seek(Math.max(0, at - 1e-3));
      editor.toast(range.count === 1 ? 'Cut 1 word from the video' : `Cut ${range.count} words from the video`);
      render(true);
    }
  }

  function restorePicked() {
    if (!restoreAt) return;
    const { source, t } = restoreAt;
    if (store.apply((p) => restoreSource(p, source, t))) {
      restoreAt = null;
      editor.toast('Back in the video');
      render(true);
    }
  }

  function showActions() {
    const range = picked ? wordsRange(words, picked[0], picked[1]) : null;
    cutBtn.hidden = !range;
    if (range) cutBtn.replaceChildren(icon('cut', { size: 15 }), range.count === 1 ? 'Cut this word' : `Cut ${range.count} words`);
    restoreBtn.hidden = !restoreAt;
    const lo = picked ? Math.min(picked[0], picked[1]) : -1;
    const hi = picked ? Math.max(picked[0], picked[1]) : -1;
    for (const el of body.querySelectorAll('.tw')) {
      const i = Number(el.dataset.i);
      el.classList.toggle('picked', i >= lo && i <= hi && !words[i].cut);
    }
  }

  function render(force = false) {
    // Only the transcript and the clips (which decide what plays) matter.
    const key = [store.project.captions.segments, store.project.clips, store.project.speed];
    fillers.set(hasCuts(store.project, 'filler'));
    silences.set(hasCuts(store.project, 'silence'));
    if (!force && shownFor && key.every((k, i) => k === shownFor[i])) return;
    shownFor = key;
    words = transcriptWords(store.project, store.tl, { withCut: true });
    const any = words.length > 0;
    empty.hidden = any;
    body.hidden = !any;
    foot.hidden = !any;
    const timed = (store.project.captions.segments ?? []).some((seg) => seg.words?.length);
    foot.classList.toggle('disabled', !timed);
    foot.title = timed ? '' : 'These need the captions written from speech (Captions tab), which times each word.';
    const lines = [];
    let line = null;
    let lineOf = null;
    words.forEach((w, i) => {
      if (!line || w.first || w.segmentId !== lineOf) {
        line = h('p', { class: 'transcript-line', dataset: { segment: w.segmentId } });
        lineOf = w.segmentId;
        lines.push(line);
      }
      line.append(h('span', {
        class: `tw${w.cut ? ' cut' : ''}`, dataset: { i: String(i) },
        title: w.cut ? 'Cut from the video. Click to put it back.' : 'Click to go here; drag or ⇧-click to pick words, then Delete'
      }, w.text), ' ');
    });
    body.replaceChildren(...lines);
    if (picked && (picked[0] >= words.length || picked[1] >= words.length)) picked = null;
    restoreAt = null;
    lit = -1;
    light(player.time);
    showActions();
  }

  function light(t) {
    const i = wordAt(words, t);
    if (i === lit) return;
    body.querySelector('.tw.now')?.classList.remove('now');
    lit = i;
    if (i < 0) return;
    const el = body.querySelector(`.tw[data-i="${i}"]`);
    if (!el) return;
    el.classList.add('now');
    // Keep the spoken word in view without stealing the scroll mid-read.
    const r = el.getBoundingClientRect();
    const box = body.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) el.scrollIntoView({ block: 'center' });
  }

  // A click goes to the word; a drag across words, or ⇧-click, picks them.
  let dragging = false;
  body.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.tw');
    if (!el || e.button !== 0) { picked = null; restoreAt = null; showActions(); return; }
    const i = Number(el.dataset.i);
    const w = words[i];
    if (w.cut) {
      picked = null;
      restoreAt = { source: w.source, t: (w.start + w.end) / 2 };
      showActions();
      return;
    }
    restoreAt = null;
    if (e.shiftKey && picked) picked = [picked[0], i];
    else {
      picked = [i, i];
      player.seek(w.outStart + 1e-3);
    }
    dragging = true;
    showActions();
  });
  body.addEventListener('pointermove', (e) => {
    if (!dragging || !(e.buttons & 1)) { dragging = false; return; }
    const el = e.target.closest?.('.tw');
    if (!el || !picked) return;
    const i = Number(el.dataset.i);
    if (i !== picked[1]) { picked = [picked[0], i]; showActions(); }
  });
  document.addEventListener('pointerup', () => { dragging = false; });
  // Delete here means the picked words, not what's selected on the timeline.
  body.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && picked) {
      e.preventDefault();
      e.stopPropagation();
      cutPicked();
    } else if (e.key === 'Escape' && (picked || restoreAt)) {
      e.stopPropagation();
      picked = null;
      restoreAt = null;
      showActions();
    }
  });
  store.subscribe((what) => { if (!root.hidden && what !== 'selection') render(); });
  player.onTime((t) => { if (!root.hidden) light(t); });

  return {
    setOpen(open) {
      root.hidden = !open;
      if (open) { shownFor = null; render(); }
    },
    get open() { return !root.hidden; },
    get words() { return words; },
    get picked() { return picked; }
  };
}
