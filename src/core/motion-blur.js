// Motion blur: what moves between frames is smeared along its path, as a
// camera's shutter would. Only movement Loupe itself makes is blurred --
// the view gliding into a zoom or following the cursor, and the cursor --
// by drawing a few earlier moments of it and averaging them. A still view
// costs nothing and is left exactly as it was. Pure; compose.js draws.

// The longest the "shutter" stays open (seconds), at full strength: two
// frames of a 60 fps video.
export const MAX_SHUTTER = 1 / 30;
// How many moments are averaged, the frame's own included.
export const SAMPLES = 5;
// Movement under this many output pixels over the shutter isn't blurred.
export const MIN_SHIFT_PX = 0.75;

export function shutterSeconds(amount) {
  return Math.max(0, Math.min(1, amount || 0)) * MAX_SHUTTER;
}

// The earlier output times to draw as well as `outT`, nearest first; none
// when there is no blur or the video has only just begun.
export function earlierTimes(outT, amount, samples = SAMPLES) {
  const shutter = shutterSeconds(amount);
  if (!(shutter > 0) || samples < 2) return [];
  const out = [];
  for (let k = 1; k < samples; k++) {
    const t = outT - (shutter * k) / (samples - 1);
    if (t < 0) break;
    out.push(t);
  }
  return out;
}

// How far (output pixels) the view moved between two frame states: the
// most any corner of the recording shifted on the canvas.
export function viewShift(a, b) {
  const { width, height } = a.meta;
  let most = 0;
  for (const [x, y] of [[0, 0], [width, 0], [0, height], [width, height]]) {
    const p = a.toCanvas(x, y);
    const q = b.toCanvas(x, y);
    most = Math.max(most, Math.hypot(p.x - q.x, p.y - q.y));
  }
  return most;
}
