// What an export will be, before it runs (docs/EDITOR-V2.md section 6): the
// file's pixel size, frame rate and extension for each format, the video
// bitrate for a quality or a size limit, and a rough size estimate with a
// friendly warning for GIFs that will come out long or big. Pure, so the
// export dialog, main and the exporter window all agree.

import { exportSize } from './compose.js';

export { EXPORT_GIF_WIDTHS as GIF_WIDTHS, EXPORT_GIF_FRAME_RATES as GIF_FRAME_RATES } from './project.js';
// "Fit a size limit" presets, in MB (1 MB = 1,000,000 bytes, as Finder,
// Explorer, Slack and mail services count).
export const SIZE_LIMITS = [25, 10];
export const SIZE_LIMIT_MIN = 1;
export const SIZE_LIMIT_MAX = 4000;
export const MB = 1000 * 1000;

export const AUDIO_BITRATES = { mp4: 160000, webm: 128000 };
// Below this the picture turns to mush; a limit that needs less is refused
// with a suggestion instead of producing something unwatchable.
export const MIN_VIDEO_BITRATE = 150000;
// Room left for the container (headers, indexes, per-packet overhead) and for
// encoders that land a little above their target.
const LIMIT_MARGIN = 0.92;

// Bits per pixel per frame. Screen recordings are mostly flat colour and
// sharp text, which compress well; "small" still keeps text readable. VP9
// needs about a third fewer bits than H.264 for the same picture.
const QUALITY_BPP = { high: 0.1, balanced: 0.06, small: 0.035 };
const FORMAT_EFFICIENCY = { mp4: 1, webm: 0.7 };

// GIFs longer than this get a gentle "an MP4 would be better" note.
export const LONG_GIF_SECONDS = 20;
const BIG_GIF_BYTES = 25 * MB;

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export function fileExtension(format) {
  return format === 'gif' ? 'gif' : format === 'webm' ? 'webm' : 'mp4';
}

// The output's pixel size. Videos use the resolution preset; a GIF keeps the
// same shape at `gifWidth` pixels wide (never wider than the 1080p video
// would be, so a portrait GIF isn't blown up).
export function outputSize(project, exp = project.export) {
  if (exp.format !== 'gif') return exportSize(project, exp.resolution);
  const ref = exportSize(project, '1080p');
  const width = Math.min(exp.gifWidth ?? 960, ref.width);
  return { width: even(width), height: even((width * ref.height) / ref.width) };
}

export function outputFps(exp) {
  return exp.format === 'gif' ? (exp.gifFps ?? 15) : exp.fps;
}

export function exportFileName(exp, { width, height }) {
  return `export-${width}x${height}.${fileExtension(exp.format)}`;
}

export function qualityBitrate({ format = 'mp4', width, height, fps, quality = 'balanced' }) {
  const bpp = (QUALITY_BPP[quality] ?? QUALITY_BPP.balanced) * (FORMAT_EFFICIENCY[format] ?? 1);
  return Math.round(Math.min(120e6, Math.max(format === 'webm' ? 5e5 : 1e6, width * height * fps * bpp)));
}

// The video bitrate that fits `limitMB` for `duration` seconds with the sound
// alongside -> { bitrate, fits }. Never more than "High" quality would use:
// a short clip under a big limit doesn't need a bigger file. `fits` is false
// when the limit would need less than MIN_VIDEO_BITRATE.
export function bitrateForLimit({ format = 'mp4', width, height, fps, duration, limitMB, audio = true }) {
  const audioBits = audio ? AUDIO_BITRATES[format] ?? AUDIO_BITRATES.mp4 : 0;
  const budget = (limitMB * MB * 8 * LIMIT_MARGIN) / Math.max(duration, 0.1) - audioBits;
  const high = qualityBitrate({ format, width, height, fps, quality: 'high' });
  if (budget < MIN_VIDEO_BITRATE) return { bitrate: MIN_VIDEO_BITRATE, fits: false };
  return { bitrate: Math.round(Math.min(high, budget)), fits: true };
}

// The bitrate an export aims for, given its settings.
export function videoBitrate(exp, { width, height, fps, duration, audio = true }) {
  if (exp.sizeLimit) {
    return bitrateForLimit({ format: exp.format, width, height, fps, duration, limitMB: exp.sizeLimit, audio }).bitrate;
  }
  return qualityBitrate({ format: exp.format, width, height, fps, quality: exp.quality });
}

// A GIF's size depends on how much of the picture changes, which isn't known
// before encoding: a quiet recording can be a tenth of this. These figures
// (bytes per output pixel) come from real recordings with zooms and scrolling,
// so the estimate reads as "up to about".
const GIF_FIRST_BYTES_PER_PIXEL = 0.5;
const GIF_BYTES_PER_PIXEL_SECOND = 0.75;
const GIF_DITHER_FACTOR = 1.15;

// A rough upper estimate of the file size in bytes, for the export dialog.
export function estimateBytes(exp, { width, height, fps, duration, audio = true }) {
  if (exp.format === 'gif') {
    const pixels = width * height;
    const perSecond = pixels * GIF_BYTES_PER_PIXEL_SECOND * Math.sqrt(fps / 15);
    const bytes = pixels * GIF_FIRST_BYTES_PER_PIXEL + perSecond * duration;
    return Math.round(bytes * (exp.dither ? GIF_DITHER_FACTOR : 1));
  }
  // Busy recordings use about the whole target bitrate; quiet ones far less.
  const video = videoBitrate(exp, { width, height, fps, duration, audio });
  const sound = audio ? AUDIO_BITRATES[exp.format] ?? AUDIO_BITRATES.mp4 : 0;
  return Math.round(((video + sound) * duration) / 8);
}

// "About 12 MB", "About 800 KB".
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  const mb = bytes / MB;
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, '') : Math.round(mb)} MB`;
}

// Everything the dialog shows about the export it is about to make:
// { width, height, fps, duration, bytes, warning, limitTooSmall }.
export function describeExport(project, exp, { duration, audio = true }) {
  const { width, height } = outputSize(project, exp);
  const fps = outputFps(exp);
  const bytes = estimateBytes(exp, { width, height, fps, duration, audio });
  let warning = null;
  let limitTooSmall = false;
  if (exp.format === 'gif') {
    if (duration > LONG_GIF_SECONDS || bytes > BIG_GIF_BYTES) {
      warning = 'This GIF will be large and may play slowly. For anything longer than a few seconds, an MP4 is sharper and much smaller.';
    }
  } else if (exp.sizeLimit) {
    limitTooSmall = !bitrateForLimit({ format: exp.format, width, height, fps, duration, limitMB: exp.sizeLimit, audio }).fits;
    if (limitTooSmall) {
      warning = `${Math.round(duration)} seconds won’t fit in ${exp.sizeLimit} MB. Try a bigger limit, or trim the video first.`;
    }
  }
  return { width, height, fps, duration, bytes, warning, limitTooSmall };
}
