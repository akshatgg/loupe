// Extra fixtures for the visuals e2e tests (visuals.e2e.js), next to lab.js
// on the same page:
//
//   visualsLab.makeWebcam({ name, seconds, width, height, fps })
//     records a webcam-like WebM with MediaRecorder, as the webcam bubble
//     does: a solid colour that changes every half second (WEBCAM_COLOURS).
//     Main writes it with the room for a duration the bubble's writer makes.
//   visualsLab.coverPixel(url, width, height, x, y)
//     the colour a picture has at (x, y) when cover-fitted to width x height

export const WEBCAM_COLOURS = [[250, 60, 60], [60, 220, 90], [60, 110, 250], [250, 230, 60], [230, 70, 230], [60, 230, 230], [250, 150, 40], [150, 90, 220]];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeWebcam({ name, seconds = 4, width = 320, height = 240, fps = 30 }) {
  const el = document.createElement('canvas');
  el.width = width;
  el.height = height;
  const ctx = el.getContext('2d');
  const stream = el.captureStream(fps);
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const paint = (t) => {
    const [r, g, b] = WEBCAM_COLOURS[Math.floor(t * 2) % WEBCAM_COLOURS.length];
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, width, height);
  };
  paint(0);
  recorder.start(250);
  const started = performance.now();
  for (;;) {
    const t = (performance.now() - started) / 1000;
    if (t >= seconds) break;
    paint(t);
    await sleep(1000 / fps / 2);
  }
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.stop();
  await stopped;
  const parts = await Promise.all(chunks.map((c) => c.arrayBuffer().then((b) => new Uint8Array(b))));
  await window.labHost.saveChunks(name, parts, (performance.now() - started));
  return { chunks: parts.length, mimeType };
}

async function coverPixel(url, width, height, x, y) {
  const blob = await (await fetch(url)).blob();
  const img = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const scale = Math.max(width / img.width, height / img.height);
  const sw = width / scale;
  const sh = height / scale;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, width, height);
  const d = ctx.getImageData(x - 3, y - 3, 7, 7).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
  return sum.map((v) => Math.round(v / 49));
}

window.visualsLab = { makeWebcam, coverPixel, WEBCAM_COLOURS };
window.visualsLabReady = true;
