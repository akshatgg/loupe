// SubRip (.srt) and WebVTT (.vtt) files from output-time cues
// ([{ start, end, text }], see timeline.js captionsToOutput).

import { wrapText, LINE_DEFAULTS } from './lines.js';

function pad(n, w) {
  return String(n).padStart(w, '0');
}

// Rounded to whole milliseconds first, so 59.9996 becomes 01:00.000 and not
// 00:59.1000.
export function formatTimestamp(seconds, separator = ',') {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${separator}${pad(ms % 1000, 3)}`;
}

function usable(cues) {
  return cues
    .filter((c) => c && typeof c.text === 'string' && c.text.trim() && c.end > c.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

export function toSRT(cues, { maxCharsPerLine = LINE_DEFAULTS.maxCharsPerLine } = {}) {
  return usable(cues).map((c, i) => [
    String(i + 1),
    `${formatTimestamp(c.start, ',')} --> ${formatTimestamp(c.end, ',')}`,
    // A blank line ends an SRT cue, so the text itself can never contain one.
    ...wrapText(c.text, maxCharsPerLine)
  ].join('\n')).join('\n\n') + '\n';
}

function escapeVtt(text) {
  // "-->" would read as a timing line; & and < start markup in cue text.
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function toVTT(cues, { maxCharsPerLine = LINE_DEFAULTS.maxCharsPerLine } = {}) {
  const body = usable(cues).map((c) => [
    `${formatTimestamp(c.start, '.')} --> ${formatTimestamp(c.end, '.')}`,
    ...wrapText(c.text, maxCharsPerLine).map(escapeVtt)
  ].join('\n'));
  return ['WEBVTT', ...body].join('\n\n') + '\n';
}

export function formatSubtitles(cues, format, options) {
  if (format === 'srt') return toSRT(cues, options);
  if (format === 'vtt') return toVTT(cues, options);
  throw new Error(`Unknown subtitle format: ${JSON.stringify(format)}`);
}
