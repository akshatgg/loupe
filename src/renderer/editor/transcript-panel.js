// The transcript beside the preview: what was said, word by word, in the
// order the video plays it. Clicking a word goes there; the word being
// spoken is lit while the video plays. It reads the captions' transcript
// (core/captions), so it has words once the Captions tab has written them.
//
// The two functions at the top are pure (test/editor-transcript.test.mjs).

import { h, icon } from './ui.js';

// The transcript in output order: [{ text, outStart, outEnd, segmentId,
// first }] -- `first` marks the first word of a caption line that plays.
// A line without word timings is one entry. Words in a part of the recording
// that was cut from the video are left out.
export function transcriptWords(project, tl) {
  const out = [];
  for (const seg of project.captions?.segments ?? []) {
    const words = Array.isArray(seg.words) && seg.words.length
      ? seg.words : [{ text: seg.text, start: seg.start, end: seg.end }];
    let first = true;
    for (const w of words) {
      const text = String(w.text ?? '').trim();
      if (!text) continue;
      const outStart = tl.toOutput(seg.source, w.start);
      if (outStart === null || outStart === undefined) continue;
      const end = tl.toOutput(seg.source, w.end);
      // A word whose end was cut, or that plays backwards, still shows.
      const outEnd = end !== null && end !== undefined && end > outStart ? end : outStart + Math.max(0.05, w.end - w.start);
      out.push({ text, outStart, outEnd, segmentId: seg.id, first });
      first = false;
    }
  }
  return out.sort((a, b) => a.outStart - b.outStart);
}

// The word being said at output time t: the last one that has started, if
// it hasn't been over for more than a moment. -1 when there is none.
export function wordAt(words, t, linger = 0.25) {
  let found = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].outStart <= t + 1e-6) found = i;
    else break;
  }
  if (found < 0) return -1;
  return t <= words[found].outEnd + linger ? found : -1;
}

export function createTranscriptPanel({ root, store, player, editor, onClose }) {
  const body = h('div', { class: 'transcript-body', id: 'transcriptBody' });
  const empty = h('div', { class: 'transcript-empty' },
    h('p', {}, 'The words spoken in this video show here once its captions are written.'),
    h('button', {
      type: 'button', class: 'btn', id: 'transcriptWrite',
      onclick: () => { store.select(null); editor.showPanel('captions'); }
    }, icon('captions', { size: 16 }), 'Open Captions'));
  root.replaceChildren(
    h('div', { class: 'transcript-head' },
      h('h2', { class: 'panel-title' }, 'Transcript'),
      h('button', { type: 'button', class: 'icon-btn small', id: 'transcriptClose', title: 'Hide the transcript', 'aria-label': 'Hide the transcript', onclick: () => onClose() }, icon('close', { size: 16 }))),
    empty, body);

  let words = [];
  let lit = -1;
  let shownFor = null;

  function render() {
    // Only the transcript and the clips (which decide what plays) matter.
    const key = [store.project.captions.segments, store.project.clips, store.project.speed];
    if (shownFor && key.every((k, i) => k === shownFor[i])) return;
    shownFor = key;
    words = transcriptWords(store.project, store.tl);
    empty.hidden = words.length > 0;
    body.hidden = words.length === 0;
    const lines = [];
    let line = null;
    words.forEach((w, i) => {
      if (w.first || !line) {
        line = h('p', { class: 'transcript-line', dataset: { segment: w.segmentId } });
        lines.push(line);
      }
      line.append(h('span', { class: 'tw', dataset: { i: String(i) }, title: 'Go to this word' }, w.text), ' ');
    });
    body.replaceChildren(...lines);
    lit = -1;
    light(player.time);
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

  body.addEventListener('click', (e) => {
    const el = e.target.closest('.tw');
    if (!el) return;
    const w = words[Number(el.dataset.i)];
    if (w) player.seek(w.outStart + 1e-3);
  });
  store.subscribe((what) => { if (!root.hidden && what !== 'selection') render(); });
  player.onTime((t) => { if (!root.hidden) light(t); });

  return {
    setOpen(open) {
      root.hidden = !open;
      if (open) { shownFor = null; render(); }
    },
    get open() { return !root.hidden; },
    get words() { return words; }
  };
}
