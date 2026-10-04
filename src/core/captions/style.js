// How captions look beyond size, position and the box: the font, the
// colours, and whether the words move as they are spoken.
//
//   captions.style: { size, position, box,
//                     preset, font, color, activeColor, animation }
//
// A preset is a name for a bundle of the other fields (the spoken-word colour
// is part of it only where a word is picked out). Picking one sets them;
// changing one of them afterwards keeps the name only while the style still
// matches it, and is "custom" otherwise. A project saved before presets
// existed has none of the new fields: it gets the defaults, which draw
// exactly what it drew before, and the name that matches its box setting.
//
// animation:
//   none        the whole line, as always
//   highlight   the whole line; the word being spoken in activeColor, the
//               ones already spoken bright, the ones to come dimmer
//   pop         the same, and the spoken word a little larger for a moment
//   typewriter  words appear as they are spoken

import { DEFAULT_FONT } from '../fonts.js';

export const CAPTION_ANIMATIONS = ['none', 'highlight', 'pop', 'typewriter'];

const WHITE = '#ffffff';
const YELLOW = '#ffd60a';

export const CAPTION_PRESETS = [
  { id: 'classic', label: 'Classic box', style: { box: true, font: 'system', color: WHITE, animation: 'none' } },
  { id: 'outline', label: 'Outline', style: { box: false, font: 'system', color: WHITE, animation: 'none' } },
  { id: 'karaoke', label: 'Karaoke', style: { box: true, font: 'system', color: WHITE, activeColor: YELLOW, animation: 'highlight' } },
  { id: 'pop', label: 'Pop', style: { box: false, font: 'rounded', color: WHITE, activeColor: '#30d158', animation: 'pop' } },
  { id: 'typewriter', label: 'Typewriter', style: { box: true, font: 'mono', color: WHITE, animation: 'typewriter' } }
];

// What a style can be called: a preset, or "custom" once it matches none.
export const CUSTOM_PRESET = 'custom';
export const CAPTION_PRESET_NAMES = [...CAPTION_PRESETS.map((p) => p.id), CUSTOM_PRESET];

// The new fields' values for a project saved without them.
export const CAPTION_STYLE_DEFAULTS = {
  preset: 'classic', font: DEFAULT_FONT, color: WHITE, activeColor: YELLOW, animation: 'none'
};

export function captionPreset(id) {
  return CAPTION_PRESETS.find((p) => p.id === id) ?? null;
}

const same = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b);

// The preset this style is, or "custom".
export function presetFor(style) {
  const hit = CAPTION_PRESETS.find((p) => Object.entries(p.style).every(([k, v]) => same(style?.[k], v)));
  return hit ? hit.id : CUSTOM_PRESET;
}

// A saved style with the new fields filled in. Without a saved preset name
// the name follows what the style is.
export function completeCaptionStyle(saved) {
  const style = { ...CAPTION_STYLE_DEFAULTS, ...saved };
  if (saved?.preset === undefined) style.preset = presetFor(style);
  return style;
}

// `patch` applied to `style`. A preset in the patch sets its bundle first,
// then the rest of the patch; the name that comes out is the one the result
// really matches. A preset name nobody knows is left in for the validator to
// turn down in plain words.
export function restyleCaptions(style, patch) {
  const preset = 'preset' in patch ? captionPreset(patch.preset) : null;
  const out = { ...style, ...(preset ? preset.style : null), ...patch };
  if (!('preset' in patch) || preset || patch.preset === CUSTOM_PRESET) out.preset = presetFor(out);
  return out;
}
