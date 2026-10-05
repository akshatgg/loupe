// An overlay's effects (project.overlays[], all optional -- without them an
// overlay is drawn as it always was):
//
//   blend  how its picture mixes with what is under it: one of
//          OVERLAY_BLENDS (the canvas's globalCompositeOperation; 'add' is
//          the canvas's 'lighter').
//   mask   { shape: 'none' | 'rectangle' | 'ellipse', feather: 0..1 } -- the
//          picture cut to that shape inside its own box; feather is how much
//          of the way from the edge to the middle fades out.
//   key    { on, color: '#rrggbb', tolerance: 0..1, softness: 0..1 } -- a
//          green screen: pixels whose colour is near `color` become
//          see-through. "Near" is measured in chroma (the Cb/Cr of YCbCr),
//          so a shaded or brighter patch of the screen still goes.
//
// The maths here is the reference: layers/key-gl.js does keyAlpha in a
// shader, layers/overlays.js draws maskAlpha with canvas gradients.

export const OVERLAY_BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'soft-light', 'add'];
export const MASK_SHAPES = ['none', 'rectangle', 'ellipse'];

const DEFAULT_MASK = { shape: 'none', feather: 0 };
const DEFAULT_KEY = { on: false, color: '#00ff00', tolerance: 0.5, softness: 0.2 };

export const defaultMask = () => ({ ...DEFAULT_MASK });
export const defaultKey = () => ({ ...DEFAULT_KEY });

// An overlay's effects with everything filled in.
export function overlayEffects(o) {
  return {
    blend: o?.blend ?? 'normal',
    mask: { ...DEFAULT_MASK, ...(o?.mask ?? {}) },
    key: { ...DEFAULT_KEY, ...(o?.key ?? {}) }
  };
}

// The canvas operation for a blend.
export function compositeOf(blend) {
  if (blend === 'add') return 'lighter';
  return !blend || blend === 'normal' ? 'source-over' : blend;
}

// '#rrggbb' as [r, g, b] in 0..1.
export function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// A colour's chroma: [Cb, Cr] of YCbCr (BT.601), each -0.5..0.5; greys are
// [0, 0] whatever their brightness.
export const CB = [-0.168736, -0.331264, 0.5];
export const CR = [0.5, -0.418688, -0.081312];
export function chroma([r, g, b]) {
  return [CB[0] * r + CB[1] * g + CB[2] * b, CR[0] * r + CR[1] * g + CR[2] * b];
}

// How far (in chroma) from the key colour a pixel is fully see-through
// (inner) and from where it is fully there (outer).
export function keyRange(key) {
  const inner = 0.5 * key.tolerance;
  return { inner, outer: inner + 0.5 * key.softness + 0.004 };
}

const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// How much of a pixel is left by the green screen: 0 see-through .. 1 there.
export function keyAlpha(rgb, key) {
  const [kb, kr] = chroma(hexToRgb(key.color));
  const [cb, cr] = chroma(rgb);
  const { inner, outer } = keyRange(key);
  return smoothstep(inner, outer, Math.hypot(cb - kb, cr - kr));
}

// How much of the picture is left by its mask at (u, v), each 0..1 across
// its box.
export function maskAlpha(u, v, mask) {
  const f = mask.feather;
  const ramp = (d) => (f > 0 ? Math.max(0, Math.min(1, d / f)) : d >= 0 ? 1 : 0);
  if (mask.shape === 'ellipse') return ramp(1 - Math.hypot(2 * u - 1, 2 * v - 1));
  if (mask.shape === 'rectangle') {
    if (!(f > 0)) return 1;
    return ramp(1 - Math.abs(2 * u - 1)) * ramp(1 - Math.abs(2 * v - 1));
  }
  return 1;
}
