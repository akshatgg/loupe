// The fonts captions and text can be set in: a short fixed list of font
// stacks made of fonts that come with macOS and Windows, so a project looks
// the same wherever it is opened or exported and no font file is bundled.
// Each stack names the macOS font, then the Windows one, then a generic
// family as the last resort.
//
//   FONTS            [{ id, label, stack }]
//   fontStack(id)    the CSS font-family list for an id (the system stack for
//                    an id it doesn't know, so a hand-edited project still draws)
//   canvasFont(id, px, weight)   the string for ctx.font

export const DEFAULT_FONT = 'system';

export const FONTS = [
  { id: 'system', label: 'System', stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif' },
  { id: 'serif', label: 'Serif', stack: 'Georgia, "Times New Roman", serif' },
  { id: 'mono', label: 'Fixed width', stack: 'Menlo, Consolas, "Courier New", monospace' },
  { id: 'rounded', label: 'Rounded', stack: '"Arial Rounded MT Bold", "Trebuchet MS", "Segoe UI", sans-serif' },
  { id: 'condensed', label: 'Narrow', stack: '"Avenir Next Condensed", "Bahnschrift Condensed", "Arial Narrow", Impact, sans-serif' }
];

export const FONT_IDS = FONTS.map((f) => f.id);

export function fontStack(id) {
  return (FONTS.find((f) => f.id === id) ?? FONTS[0]).stack;
}

export function canvasFont(id, px, weight = 600) {
  return `${weight} ${px}px ${fontStack(id)}`;
}
