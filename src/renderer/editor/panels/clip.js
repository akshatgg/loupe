// Clip: the selected clip's own settings, as an editor's inspector shows
// them. A video clip: play it backwards, or (a freeze frame) how long it
// holds; its position, size, rotation and crop; its colour and LUT. An
// overlay (a picture or video over the video): where it sits, its size,
// turn, opacity, fades and timing. Position, size, turn and opacity can be
// animated: ◆ beside a slider sets a keyframe at the playhead (or removes
// the one there); once a property has keyframes, moving its slider sets its
// value at the playhead. Every change is one undo step (a slider's drag is
// one too).

import { h, icon, toggle, section, slider, segmented } from '../ui.js';
import * as P from '../../../core/project.js';
import { clipTransform, clipColor, COLOR_FILTERS } from '../../../core/look.js';
import { formatTime, parseTime } from '../timeline-math.js';
import { valueAt, keyframeAt, neighbours } from '../../../core/keyframes.js';

const FILTER_LABELS = {
  none: 'None', bw: 'B&W', sepia: 'Sepia', vivid: 'Vivid', warm: 'Warm', cool: 'Cool', faded: 'Faded', dramatic: 'Dramatic'
};
const percent = (v) => `${Math.round(v * 100)}%`;
const signed = (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;

export default {
  id: 'clip',
  title: 'Clip',
  icon: 'clips',
  mount(container, editor) {
    const { store } = editor;
    const selected = () => {
      const sel = store.selection;
      if (sel?.kind !== 'clip') return null;
      const i = store.project.clips.findIndex((c) => c.id === sel.id);
      return i < 0 ? null : { clip: store.project.clips[i], index: i, bounds: store.tl.clipBounds()[i] };
    };
    const apply = (edit) => store.apply(edit);
    const { player } = editor;

    // What is selected, as one shape for the keyframed sliders: its
    // keyframes, the time in its own clock at the playhead (null when the
    // playhead isn't over it), and how to set a value or a keyframe.
    function item() {
      const sel = store.selection;
      if (sel?.kind === 'clip') {
        const s = selected();
        if (!s) return null;
        const at = store.tl.toSource(player.time);
        return {
          kind: 'clip', id: s.clip.id, keyframes: s.clip.keyframes ?? {},
          local: at && at.clipIndex === s.index && !(s.clip.hold > 0) ? at.t : null,
          toOutput: (t) => store.tl.toOutput(s.clip.source, t),
          base: (prop) => clipTransform(s.clip)[prop],
          setBase: (prop, v) => P.setClipLook(store.project, s.clip.id, { transform: { [prop]: v } }),
          setKf: (prop, t, v) => (p) => P.setClipKeyframe(p, s.clip.id, prop, t, v),
          removeKf: (prop, t) => (p) => P.removeClipKeyframe(p, s.clip.id, prop, t)
        };
      }
      if (sel?.kind === 'overlay') {
        const o = (store.project.overlays ?? []).find((q) => q.id === sel.id);
        if (!o) return null;
        const t = player.time - o.start;
        return {
          kind: 'overlay', id: o.id, keyframes: o.keyframes ?? {}, overlay: o,
          local: t >= -1e-6 && t <= o.length + 1e-6 ? Math.max(0, Math.min(o.length, t)) : null,
          toOutput: (k) => o.start + k,
          base: (prop) => o[prop],
          setBase: (prop, v) => P.updateOverlay(store.project, o.id, { [prop]: v }),
          setKf: (prop, k, v) => (p) => P.setOverlayKeyframe(p, o.id, prop, k, v),
          removeKf: (prop, k) => (p) => P.removeOverlayKeyframe(p, o.id, prop, k)
        };
      }
      return null;
    }
    const valueNow = (it, prop) => (it.local === null ? it.base(prop) : valueAt(it.keyframes[prop], it.local, it.base(prop)));

    // A slider whose property can be keyframed, with its ◆ button.
    function kfSlider(id, label, prop, min, max, step, format) {
      const row = slider({
        label, min, max, step, value: 0, format,
        onInput: (v) => {
          const it = item();
          if (!it) return;
          const animated = it.keyframes[prop]?.length;
          if (animated && it.local !== null) store.apply(it.setKf(prop, it.local, v), { gesture: `${id}:${it.id}` });
          else if (!animated) store.apply(() => it.setBase(prop, v), { gesture: `${id}:${it.id}` });
        },
        onChange: () => store.endGesture()
      });
      row.querySelector('input').id = id;
      const kf = h('button', {
        type: 'button', class: 'kf-btn', id: `${id}Key`, title: 'Keyframe at the playhead', 'aria-label': `${label}: keyframe at the playhead`,
        onclick: (e) => {
          e.preventDefault();
          const it = item();
          if (!it) return;
          if (it.local === null) { editor.toast('Move the playhead over it to set a keyframe.'); return; }
          const here = keyframeAt(it.keyframes[prop], it.local);
          store.apply(here ? it.removeKf(prop, here.t) : it.setKf(prop, it.local, valueNow(it, prop)));
        }
      }, icon('keyframe', { size: 12 }));
      row.querySelector('.field-row').append(kf);
      row.refresh = (it) => {
        row.set(valueNow(it, prop));
        const list = it.keyframes[prop] ?? [];
        kf.classList.toggle('has', list.length > 0);
        kf.classList.toggle('on', it.local !== null && Boolean(keyframeAt(list, it.local)));
      };
      return row;
    }

    // Previous / next keyframe of the selected item, any property.
    const keyNav = h('div', { class: 'clip-actions key-nav' },
      h('button', { type: 'button', class: 'btn small', id: 'prevKeyframe', onclick: () => jumpKey(-1) }, '◀ Previous keyframe'),
      h('button', { type: 'button', class: 'btn small', id: 'nextKeyframe', onclick: () => jumpKey(1) }, 'Next keyframe ▶'));
    function jumpKey(dir) {
      const it = item();
      if (!it) return;
      const all = Object.values(it.keyframes).flat().sort((a, b) => a.t - b.t);
      const here = it.local ?? (dir > 0 ? -Infinity : Infinity);
      const { prev, next } = neighbours(all, here);
      const k = dir > 0 ? next : prev;
      const out = k ? it.toOutput(k.t) : null;
      if (out === null || out === undefined) editor.toast(all.length ? 'No more keyframes that way' : 'No keyframes yet: ◆ beside a slider sets one');
      else player.seek(out);
    }

    const empty = h('div', { class: 'panel-empty' },
      h('div', { class: 'empty-icon' }, icon('clips', { size: 28 })),
      h('h3', {}, 'Select a clip'),
      h('p', {}, 'Click a clip on the timeline to see its settings here: play it backwards, freeze a frame of it, and more.'));

    const title = h('h3', { class: 'clip-title' });
    const length = h('p', { class: 'hint' });

    const reverse = toggle({
      label: 'Play backwards', hint: 'Reverses this clip. Its sound is left out while it plays backwards.',
      onChange: (on) => { const s = selected(); if (s) apply((p) => P.setClipReverse(p, s.clip.id, on)); }
    });
    reverse.input.id = 'clipReverse';

    // A freeze frame's length.
    const holdInput = h('input', { type: 'text', id: 'holdLength', class: 'time-input small', inputMode: 'decimal', autocomplete: 'off' });
    holdInput.addEventListener('change', () => {
      const s = selected();
      const t = parseTime(holdInput.value);
      if (s && t !== null && t >= 0.1) apply((p) => P.setHold(p, s.clip.id, t));
      update();
    });
    holdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); holdInput.blur(); } });
    const holdRow = h('div', { class: 'music-times' },
      h('label', { class: 'label', for: 'holdLength' }, 'Holds for'), holdInput, h('span'),
      h('p', { class: 'hint' }, 'A still of one moment. Drag its right edge on the timeline to hold it longer.'));

    const freezeBtn = h('button', {
      type: 'button', class: 'btn', id: 'freezeFrame', title: 'A 2-second still of the frame at the playhead (⇧F)',
      onclick: () => editor.freezeAtPlayhead()
    }, icon('pause', { size: 16 }), 'Freeze frame at playhead');

    // ---- position, size, rotation, crop
    const look = (patch, gesture) => {
      const s = selected();
      if (s) store.apply((p) => P.setClipLook(p, s.clip.id, patch), { gesture: gesture ? `${gesture}:${s.clip.id}` : null });
    };
    const done = () => store.endGesture();
    const sl = (id, label, min, max, step, format, patchOf) => {
      const row = slider({ label, min, max, step, value: 0, format, onInput: (v) => look(patchOf(v), id), onChange: done });
      row.querySelector('input').id = id;
      return row;
    };
    const scale = kfSlider('clipScale', 'Scale', 'scale', 0.1, 3, 0.01, percent);
    const posX = kfSlider('clipX', 'Left / right', 'x', -1, 1, 0.01, signed);
    const posY = kfSlider('clipY', 'Up / down', 'y', -1, 1, 0.01, signed);
    const rotate = kfSlider('clipRotate', 'Rotate', 'rotate', -180, 180, 1, (v) => `${Math.round(v)}°`);
    const crops = ['left', 'top', 'right', 'bottom'].map((side) =>
      sl(`clipCrop${side[0].toUpperCase()}${side.slice(1)}`, `Crop ${side}`, 0, 0.45, 0.01, percent, (v) => ({ transform: { crop: { [side]: v } } })));
    const flips = h('div', { class: 'clip-actions' },
      h('button', { type: 'button', class: 'btn small', id: 'clipFlipH', onclick: () => { look({ transform: { flipH: !clipTransform(selected()?.clip).flipH } }); } }, '⇋ Flip left to right'),
      h('button', { type: 'button', class: 'btn small', id: 'clipFlipV', onclick: () => { look({ transform: { flipV: !clipTransform(selected()?.clip).flipV } }); } }, '⇵ Flip upside down'));
    const resetPlace = h('button', { type: 'button', class: 'btn small', id: 'clipResetPlace', onclick: () => look({ transform: null }) }, 'Reset position');
    const clipKeyNav = keyNav.cloneNode(true);
    clipKeyNav.querySelector('#prevKeyframe').id = 'clipPrevKeyframe';
    clipKeyNav.querySelector('#nextKeyframe').id = 'clipNextKeyframe';
    clipKeyNav.children[0].onclick = () => jumpKey(-1);
    clipKeyNav.children[1].onclick = () => jumpKey(1);
    const place = section('Position & size', scale, posX, posY, rotate, clipKeyNav, flips, ...crops, resetPlace);

    // ---- colour
    const filters = segmented({
      label: 'Look', value: 'none',
      options: COLOR_FILTERS.map((f) => ({ value: f, label: FILTER_LABELS[f], title: FILTER_LABELS[f] })),
      onChange: (v) => look({ color: { filter: v } })
    });
    filters.classList.add('filter-grid');
    const bright = sl('clipBrightness', 'Brightness', -1, 1, 0.01, signed, (v) => ({ color: { brightness: v } }));
    const contrast = sl('clipContrast', 'Contrast', -1, 1, 0.01, signed, (v) => ({ color: { contrast: v } }));
    const saturation = sl('clipSaturation', 'Saturation', -1, 1, 0.01, signed, (v) => ({ color: { saturation: v } }));
    const resetColour = h('button', { type: 'button', class: 'btn small', id: 'clipResetColour', onclick: () => look({ color: null }) }, 'Reset colour');
    // A LUT: a colourist's .cube file, copied into the project.
    const lutName = h('span', { class: 'music-name', id: 'clipLutName' });
    const lutRow = h('div', { class: 'music-file' }, icon('style', { size: 16 }), lutName,
      h('button', {
        type: 'button', class: 'btn small', id: 'clipLoadLut', title: 'Grade this clip with a .cube LUT',
        onclick: async () => {
          try {
            const got = await window.loupe.chooseLut();
            if (got) { look({ color: { lut: got.file, lutMix: 1 } }); editor.toast(`LUT “${got.name}” applied`); }
          } catch (err) {
            editor.toast(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
          }
        }
      }, 'Load LUT…'),
      h('button', {
        type: 'button', class: 'icon-btn small', id: 'clipRemoveLut', title: 'Remove the LUT', 'aria-label': 'Remove the LUT',
        onclick: () => look({ color: { lut: null } })
      }, icon('trash', { size: 16 })));
    const removeLut = lutRow.lastElementChild;
    const lutMix = sl('clipLutMix', 'LUT amount', 0, 1, 0.01, percent, (v) => ({ color: { lutMix: v } }));
    const colourSection = section('Colour', filters, bright, contrast, saturation, lutRow, lutMix, resetColour);

    // ---- an overlay: a picture or video over the video
    const oTitle = h('h3', { class: 'clip-title' });
    const oInfo = h('p', { class: 'hint' });
    const oX = kfSlider('overlayX', 'Left / right', 'x', -1, 1, 0.01, signed);
    const oY = kfSlider('overlayY', 'Up / down', 'y', -1, 1, 0.01, signed);
    const oScale = kfSlider('overlayScale', 'Size', 'scale', 0.02, 2, 0.01, percent);
    const oRotate = kfSlider('overlayRotate', 'Rotate', 'rotate', -180, 180, 1, (v) => `${Math.round(v)}°`);
    const oOpacity = kfSlider('overlayOpacity', 'Opacity', 'opacity', 0, 1, 0.01, percent);
    const overlayEdit = (patch, gesture) => {
      const it = item();
      if (it?.kind === 'overlay') store.apply((p) => P.updateOverlay(p, it.id, patch), { gesture: gesture ? `${gesture}:${it.id}` : null });
    };
    const oFadeIn = slider({ label: 'Fade in', min: 0, max: 5, step: 0.1, value: 0, format: (v) => `${v.toFixed(1)} s`, onInput: (v) => overlayEdit({ fadeIn: Math.min(v, item()?.overlay.length ?? v) }, 'overlayFadeIn'), onChange: () => store.endGesture() });
    oFadeIn.querySelector('input').id = 'overlayFadeIn';
    const oFadeOut = slider({ label: 'Fade out', min: 0, max: 5, step: 0.1, value: 0, format: (v) => `${v.toFixed(1)} s`, onInput: (v) => overlayEdit({ fadeOut: Math.min(v, item()?.overlay.length ?? v) }, 'overlayFadeOut'), onChange: () => store.endGesture() });
    oFadeOut.querySelector('input').id = 'overlayFadeOut';
    const timeField = (id, label, apply) => {
      const input = h('input', { type: 'text', id, class: 'time-input small', inputMode: 'decimal', autocomplete: 'off' });
      input.addEventListener('change', () => { const t = parseTime(input.value); if (t !== null) apply(t); update(); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
      return { input, label: h('label', { class: 'label', for: id }, label) };
    };
    const oStart = timeField('overlayStart', 'Starts at', (t) => overlayEdit({ start: t }));
    const oLength = timeField('overlayLength', 'Length', (t) => {
      const o = item()?.overlay;
      if (!o) return;
      const most = o.kind === 'video' && o.fileDuration > 0 ? o.fileDuration - o.from : Infinity;
      overlayEdit({ length: Math.max(0.1, Math.min(t, most)) });
    });
    const oTimes = h('div', { class: 'music-times' }, oStart.label, oStart.input,
      h('button', { type: 'button', class: 'btn small', id: 'overlayAtPlayhead', onclick: () => overlayEdit({ start: player.time }) }, 'Playhead'),
      oLength.label, oLength.input, h('span'));
    const oDelete = h('button', {
      type: 'button', class: 'btn small danger-quiet', id: 'deleteOverlay',
      onclick: () => { const it = item(); if (it) { store.apply((p) => P.removeOverlay(p, it.id)); editor.select(null); } }
    }, icon('trash', { size: 14 }), 'Delete overlay');
    const overlaySection = section(null, oTitle, oInfo, oX, oY, oScale, oRotate, oOpacity, keyNav, oFadeIn, oFadeOut, oTimes, oDelete);

    // ---- speed: the whole clip at once (⌥-drag on the timeline for a part)
    const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 8];
    const speedChips = h('div', { class: 'chips', id: 'clipSpeeds' }, SPEEDS.map((rate) => h('button', {
      type: 'button', class: 'chip', dataset: { rate: String(rate) },
      onclick: () => {
        const s = selected();
        if (s) apply((p) => P.paintSpeed(p, { source: s.clip.source, start: s.clip.start, end: s.clip.end, rate }));
      }
    }, rate === 1 ? 'Normal' : `${rate}×`)));
    const speedHint = h('p', { class: 'hint' });
    const speedSection = section('Speed', speedChips, speedHint);

    const settings = section(null, title, length, reverse, holdRow);
    const tools = section(null, freezeBtn,
      h('p', { class: 'hint' }, 'Holds the frame at the playhead for 2 seconds, splitting the clip there.'));
    container.append(empty, overlaySection, settings, speedSection, place, colourSection, tools);

    function update() {
      const s = selected();
      const it = item();
      const o = it?.kind === 'overlay' ? it.overlay : null;
      empty.hidden = Boolean(s || o);
      overlaySection.hidden = !o;
      settings.hidden = !s;
      place.hidden = !s;
      colourSection.hidden = !s;
      speedSection.hidden = !s || s.clip.hold > 0;
      if (s && !(s.clip.hold > 0)) {
        // The clip's speed changes: one rate over all of it, several, or none.
        const inside = store.project.speed.filter((q) => q.source === s.clip.source && q.end > s.clip.start + 1e-6 && q.start < s.clip.end - 1e-6);
        const whole = inside.length === 1 && inside[0].start <= s.clip.start + 1e-6 && inside[0].end >= s.clip.end - 1e-6;
        const rate = !inside.length ? 1 : whole ? inside[0].rate : null;
        for (const b of speedChips.children) b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === rate));
        speedHint.textContent = rate === null
          ? 'Parts of this clip play at different speeds. Pick one to set the whole clip.'
          : 'For just a part, hold ⌥ (Alt) and drag across it on the timeline.';
      }
      if (o) {
        oTitle.textContent = o.name || 'Overlay';
        oInfo.textContent = `${o.kind === 'video' ? 'A video' : 'A picture'} on row V${o.lane + 2}, ${formatTime(o.start, { fraction: true })} to ${formatTime(o.start + o.length, { fraction: true })}`;
        for (const row of [oX, oY, oScale, oRotate, oOpacity]) row.refresh(it);
        oFadeIn.set(o.fadeIn);
        oFadeOut.set(o.fadeOut);
        if (document.activeElement !== oStart.input) oStart.input.value = formatTime(o.start, { fraction: true });
        if (document.activeElement !== oLength.input) oLength.input.value = formatTime(o.length, { fraction: true });
      }
      if (!s) return;
      const t = clipTransform(s.clip);
      const c = clipColor(s.clip);
      for (const row of [scale, posX, posY, rotate]) row.refresh(it);
      crops.forEach((row, k) => row.set(t.crop[['left', 'top', 'right', 'bottom'][k]]));
      filters.set(c.filter);
      bright.set(c.brightness);
      contrast.set(c.contrast);
      saturation.set(c.saturation);
      lutName.textContent = c.lut ? c.lut.replace(/^luts\//, '').replace(/\.cube$/i, '') : 'No LUT';
      lutMix.hidden = !c.lut;
      lutMix.set(c.lutMix);
      removeLut.hidden = !c.lut;
      const { clip, index, bounds } = s;
      const held = clip.hold > 0;
      title.textContent = held ? `Freeze frame (clip ${index + 1})` : `Clip ${index + 1}`;
      length.textContent = held
        ? `A still of ${formatTime(clip.start, { fraction: true })} of the recording`
        : `${formatTime(bounds.outEnd - bounds.outStart, { fraction: true })} long, from ${formatTime(clip.start, { fraction: true })} to ${formatTime(clip.end, { fraction: true })} of the recording`;
      reverse.hidden = held;
      reverse.set(Boolean(clip.reverse));
      holdRow.hidden = !held;
      if (held && document.activeElement !== holdInput) holdInput.value = formatTime(clip.hold, { fraction: true });
    }
    update();
    return { update };
  }
};
