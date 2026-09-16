// Little pictures along each clip on the timeline, so you can see where you
// are in a recording without scrubbing.
//
// Each recording gets its own hidden <video> (the player's one is busy
// playing) that is seeked from picture to picture; each frame is drawn small
// and kept as a JPEG data URL. Pictures are asked for by source moment,
// rounded to `step` seconds so a zoomed-out timeline reuses the ones it
// already has. The newest request goes first: those are the ones on screen.

const HEIGHT = 96;          // stored picture height, px (shown at about half)
const MAX_KEPT = 600;

export function createThumbnails({ onReady = () => {} } = {}) {
  const sources = new Map();  // key -> { video, ready, width, height }
  const cache = new Map();    // "key:t" -> data URL
  const wanted = [];          // [{ key, t, id }] newest last
  const queued = new Set();
  let busy = false;
  let readyTimer = 0;

  function addSource(key, url) {
    if (!url || sources.has(key)) return;
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = url;
    const entry = { video, ready: false };
    sources.set(key, entry);
    video.addEventListener('loadeddata', () => {
      entry.ready = true;
      pump();
    }, { once: true });
    video.addEventListener('error', () => { entry.failed = true; }, { once: true });
  }

  // Tells the timeline, once per burst of new pictures rather than per picture.
  function announce() {
    if (readyTimer) return;
    readyTimer = setTimeout(() => {
      readyTimer = 0;
      onReady();
    }, 60);
  }

  function grab(entry) {
    const { video } = entry;
    const w = Math.max(1, Math.round((HEIGHT * video.videoWidth) / Math.max(1, video.videoHeight)));
    const canvas = grab.canvas ??= document.createElement('canvas');
    canvas.width = w;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, w, HEIGHT);
    return canvas.toDataURL('image/jpeg', 0.7);
  }

  function seekTo(video, t) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        video.removeEventListener('seeked', done);
        resolve();
      };
      // A seek that never lands (a damaged file) must not stop the queue.
      const timer = setTimeout(done, 1500);
      video.addEventListener('seeked', done);
      video.currentTime = t;
    });
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (wanted.length) {
        const job = wanted.pop();
        queued.delete(job.id);
        const entry = sources.get(job.key);
        if (!entry || entry.failed || cache.has(job.id)) continue;
        if (!entry.ready) { wanted.unshift(job); queued.add(job.id); break; }
        const t = Math.min(job.t, Math.max(0, (entry.video.duration || job.t) - 0.05));
        await seekTo(entry.video, t);
        try {
          cache.set(job.id, grab(entry));
        } catch {
          continue;
        }
        if (cache.size > MAX_KEPT) cache.delete(cache.keys().next().value);
        announce();
      }
    } finally {
      busy = false;
    }
  }

  // The picture for source `key` at moment `t` (rounded to `step`), or null
  // while it is being made -- onReady fires when there are new ones.
  function get(key, t, step) {
    const at = Math.max(0, Math.round(t / step) * step);
    const id = `${key}:${at.toFixed(3)}`;
    const hit = cache.get(id);
    if (hit) return hit;
    if (!queued.has(id)) {
      queued.add(id);
      wanted.push({ key, t: at, id });
      pump();
    }
    return null;
  }

  // Width a picture takes when shown `height` px tall.
  function widthFor(key, height) {
    const v = sources.get(key)?.video;
    const ratio = v && v.videoWidth ? v.videoWidth / v.videoHeight : 16 / 10;
    return Math.max(16, Math.round(height * ratio));
  }

  function destroy() {
    clearTimeout(readyTimer);
    for (const { video } of sources.values()) { video.removeAttribute('src'); video.load(); }
    sources.clear();
    cache.clear();
    wanted.length = 0;
  }

  return { addSource, get, widthFor, destroy, get size() { return cache.size; } };
}
