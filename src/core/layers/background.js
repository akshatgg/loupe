// Layer 1: what's behind the recording -- black (none), a colour, a gradient
// or an image (cover-fit) filling the whole output.

export const name = 'background';

// A CSS-style angle (0 = towards the top, 90 = towards the right) as the
// gradient line across a w x h box, long enough that the first and last
// colours land exactly in opposite corners.
export function gradientLine(angleDeg, w, h) {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const cx = w / 2;
  const cy = h / 2;
  return { x0: cx - dx * half, y0: cy - dy * half, x1: cx + dx * half, y1: cy + dy * half };
}

// Cover-fit: the centred part of an iw x ih image with the w x h box's shape.
export function coverCrop(iw, ih, w, h) {
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  return { sx: (iw - sw) / 2, sy: (ih - sh) / 2, sw, sh };
}

export function draw(ctx, state) {
  const { width, height } = state.size;
  const bg = state.project.style.background;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  if (bg.type === 'color') {
    ctx.fillStyle = bg.value;
    ctx.fillRect(0, 0, width, height);
  } else if (bg.type === 'gradient') {
    const { x0, y0, x1, y1 } = gradientLine(bg.value.angle, width, height);
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    const { stops } = bg.value;
    stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
  } else if (bg.type === 'image') {
    // Until the image has loaded (or if it can't be), the background is black.
    const img = state.assets.background;
    const iw = img?.naturalWidth ?? img?.displayWidth ?? img?.width;
    const ih = img?.naturalHeight ?? img?.displayHeight ?? img?.height;
    if (iw > 0 && ih > 0) {
      const { sx, sy, sw, sh } = coverCrop(iw, ih, width, height);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, width, height);
    }
  }
}
