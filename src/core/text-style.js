// How text and title-card annotations are styled and how they arrive and
// leave. All of it is optional on an annotation:
//
//   font            an id from fonts.js
//   weight          regular | medium | bold
//   align           left | center | right (the lines within the block)
//   outline         0..1, how thick a line is drawn round the letters
//   background      text only: null for the usual dark backing, or a colour
//                   (a fully clear one, e.g. #00000000, for no backing)
//   animateIn       none | fade | slide | pop | typewriter
//   animateOut      the same, played backwards as it leaves
//   animateSeconds  0.1..2, how long each takes
//
// An annotation with none of these looks and moves exactly as it did before
// they existed: medium weight, centred, the dark backing, and the short fade
// it always had (0.2 s, 0.5 s for a title card). Once an animation is chosen
// the length is animateSeconds, 0.4 s unless set.
//
// Everything here is computed from the frame's own time inside the
// annotation (source time), so the preview and every export draw the same.

export const TEXT_WEIGHTS = ['regular', 'medium', 'bold'];
export const TEXT_ALIGNS = ['left', 'center', 'right'];
export const TEXT_ANIMATIONS = ['none', 'fade', 'slide', 'pop', 'typewriter'];
export const ANIMATE_SECONDS_MIN = 0.1;
export const ANIMATE_SECONDS_MAX = 2;
export const ANIMATE_SECONDS = 0.4;

// The fade annotations have always had.
export const FADE_SECONDS = 0.2;
export const TITLE_FADE_SECONDS = 0.5;

// What the settings show for an annotation that has none saved.
export const TEXT_STYLE_DEFAULTS = {
  font: 'system', weight: 'medium', align: 'center', outline: 0, background: null,
  animateIn: 'fade', animateOut: 'fade', animateSeconds: ANIMATE_SECONDS
};

// Numeric font weights: for text, and for a title card's heading and the
// smaller lines under it.
export const TEXT_FONT_WEIGHT = { regular: 400, medium: 600, bold: 800 };
export const TITLE_FONT_WEIGHTS = { regular: [500, 400], medium: [700, 500], bold: [800, 600] };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (p) => 1 - (1 - p) * (1 - p);
// Past its mark and back: the little bounce of something popping in.
const easeOutBack = (p) => 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2;

// How long this annotation's in and out animations take.
export function animateSecondsOf(a) {
  let seconds = a.animateSeconds;
  if (seconds === undefined) {
    const untouched = a.animateIn === undefined && a.animateOut === undefined;
    seconds = untouched ? (a.type === 'title' ? TITLE_FADE_SECONDS : FADE_SECONDS) : ANIMATE_SECONDS;
  }
  // A short annotation still spends some of its time at rest.
  return Math.min(seconds, (a.end - a.start) / 3);
}

const alphaFor = (kind, p) => (kind === 'fade' || kind === 'slide' ? p : kind === 'pop' ? Math.min(1, p * 2) : 1);

// Where annotation `a` is in its animations at source time t:
//
//   alpha    0..1 opacity (0 outside start..end)
//   slide    how far below its place it is, in text heights (0 at rest)
//   scale    its size (1 at rest)
//   reveal   0..1, the share of its letters showing (1 at rest)
export function textAnimationAt(a, t) {
  if (t < a.start || t >= a.end) return { alpha: 0, slide: 0, scale: 1, reveal: 1 };
  const seconds = animateSecondsOf(a);
  const pin = seconds > 0 ? clamp01((t - a.start) / seconds) : 1;
  const pout = seconds > 0 ? clamp01((a.end - t) / seconds) : 1;
  const kin = a.animateIn ?? 'fade';
  const kout = a.animateOut ?? 'fade';
  return {
    alpha: alphaFor(kin, pin) * alphaFor(kout, pout),
    slide: (kin === 'slide' ? 1 - easeOut(pin) : 0) + (kout === 'slide' ? 1 - easeOut(pout) : 0),
    scale: (kin === 'pop' ? 0.6 + 0.4 * easeOutBack(pin) : 1) * (kout === 'pop' ? 0.6 + 0.4 * easeOut(pout) : 1),
    reveal: Math.min(kin === 'typewriter' ? pin : 1, kout === 'typewriter' ? pout : 1)
  };
}

// `lines` with only the first `reveal` share of their letters, in reading
// order: the typewriter. Every line is kept (possibly empty) so nothing moves.
export function revealLines(lines, reveal) {
  if (reveal >= 1) return lines;
  const letters = lines.map((l) => [...l]);
  let left = Math.floor(letters.reduce((n, l) => n + l.length, 0) * Math.max(0, reveal) + 1e-9);
  return letters.map((l) => {
    const take = Math.min(l.length, left);
    left -= take;
    return l.slice(0, take).join('');
  });
}

// Whether a colour (#rgba or #rrggbbaa) is fully see-through.
export function isClear(hex) {
  const v = String(hex ?? '').replace('#', '');
  return (v.length === 4 && v[3] === '0') || (v.length === 8 && v.slice(6) === '00');
}

export const CLEAR = '#00000000';

// Lower thirds and the like: saved text styles offered when adding text.
// `look` is everything the new text annotation gets, position included (x, y
// are the middle of the block, as fractions of the picture).
export const LOWER_THIRDS = [
  {
    id: 'name', label: 'Name and title', hint: 'Who is speaking, low on the left',
    look: {
      text: 'Your name\nWhat you do', x: 0.2, y: 0.84, size: 0.8, color: '#ffffff', font: 'system', weight: 'bold',
      align: 'left', outline: 0, background: '#1f1f23', animateIn: 'slide', animateOut: 'fade', animateSeconds: 0.4
    }
  },
  {
    id: 'chapter', label: 'Chapter', hint: 'A heading for the next part, typed out',
    look: {
      text: 'Chapter one', x: 0.5, y: 0.14, size: 1.3, color: '#ffffff', font: 'serif', weight: 'bold',
      align: 'center', outline: 0.5, background: CLEAR, animateIn: 'typewriter', animateOut: 'fade', animateSeconds: 0.8
    }
  },
  {
    id: 'callout', label: 'Callout', hint: 'A bright note that pops in',
    look: {
      text: 'Look here', x: 0.5, y: 0.8, size: 0.9, color: '#1f1f23', font: 'rounded', weight: 'bold',
      align: 'center', outline: 0, background: '#ffd60a', animateIn: 'pop', animateOut: 'fade', animateSeconds: 0.3
    }
  }
];

export function lowerThird(id) {
  return LOWER_THIRDS.find((t) => t.id === id) ?? null;
}
