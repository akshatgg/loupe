'use strict';
// Draws the bundled wallpapers (src/core/wallpapers.js) into
// src/assets/wallpapers/*.png. Run with:  electron packaging/make-wallpapers.js
//
// Each is a few soft colour fields blended on a base. They are drawn at
// 640x360: nothing in them is sharp, so scaling up to any export size looks
// the same, and the files stay small.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'src', 'assets', 'wallpapers');

// [base top-left, base bottom-right, blobs: [x, y, radius, colour]]
const DESIGNS = {
  dusk: ['#1d1537', '#3a1c4d', [[0.15, 0.2, 0.7, '#5b3fd1'], [0.85, 0.85, 0.75, '#f0766b'], [0.7, 0.2, 0.5, '#b44fc9']]],
  ocean: ['#04233a', '#0a4b6e', [[0.2, 0.85, 0.8, '#0e9fb3'], [0.85, 0.15, 0.7, '#2a5bd7'], [0.55, 0.55, 0.4, '#23c4b0']]],
  aurora: ['#07120f', '#0d1b24', [[0.25, 0.3, 0.65, '#1db57c'], [0.75, 0.7, 0.7, '#6f45d8'], [0.6, 0.15, 0.45, '#2ab3c6']]],
  sand: ['#f4e7d3', '#e9c9a4', [[0.2, 0.2, 0.7, '#fff4e2'], [0.85, 0.8, 0.8, '#e0a47a'], [0.6, 0.35, 0.5, '#f2d5b0']]],
  blush: ['#f6d7dc', '#e7b9d8', [[0.15, 0.8, 0.7, '#ffb199'], [0.85, 0.2, 0.7, '#c9a7f5'], [0.5, 0.5, 0.45, '#ffd3e0']]],
  graphite: ['#16171b', '#26282e', [[0.3, 0.15, 0.8, '#3a3d46'], [0.9, 0.9, 0.6, '#1b1c20'], [0.75, 0.3, 0.4, '#30343d']]]
};

const PAGE = `(${String(async (designs) => {
  const out = {};
  for (const [id, [a, b, blobs]] of Object.entries(designs)) {
    const W = 640;
    const H = 360;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const base = ctx.createLinearGradient(0, 0, W, H);
    base.addColorStop(0, a);
    base.addColorStop(1, b);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    for (const [x, y, r, c] of blobs) {
      const g = ctx.createRadialGradient(x * W, y * H, 0, x * W, y * H, r * W);
      // An eased falloff, so no ring shows where each field ends.
      for (let k = 0; k <= 8; k++) {
        const u = k / 8;
        const alpha = Math.round(255 * (1 - u) ** 2 * (1 + 2 * u) * 0.9);
        g.addColorStop(u, `${c}${alpha.toString(16).padStart(2, '0')}`);
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    out[id] = Array.from(new Uint8Array(await blob.arrayBuffer()));
  }
  return out;
})})(${JSON.stringify(DESIGNS)})`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<meta charset="utf-8">');
  const files = await win.webContents.executeJavaScript(PAGE);
  fs.mkdirSync(OUT, { recursive: true });
  for (const [id, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(OUT, `${id}.png`), Buffer.from(bytes));
    process.stdout.write(`${id}.png ${(bytes.length / 1024).toFixed(0)} KB\n`);
  }
  app.exit(0);
}).catch((err) => { console.error(err); app.exit(1); });
