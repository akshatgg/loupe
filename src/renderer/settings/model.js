// The Settings window's wording and choices, as pure functions (no DOM), so
// they are unit-tested (test/shell-models.test.js).

export const SECTIONS = ['general', 'recording', 'export', 'updates', 'privacy', 'about'];

export const FORMAT_HELP = {
  mp4: 'Plays everywhere. The best choice for most videos.',
  webm: 'Smaller files for websites. Some apps can’t open it.',
  gif: 'A silent, looping picture for chats and docs. Best for short clips.'
};

export const QUALITY_HELP = {
  high: 'Sharpest picture, largest file.',
  balanced: 'Looks great at a sensible size.',
  small: 'Easy to send by email or chat. Fine detail may soften.'
};

// The options for a microphone or camera menu. The first entry means "use
// whatever the computer is set to". A device that was chosen before but isn't
// connected now stays in the list (and selected), marked as such, so opening
// Settings with a headset unplugged doesn't quietly forget the choice.
export function deviceOptions(devices, saved, { defaultLabel }) {
  const options = [{ value: '', label: defaultLabel }];
  const seen = new Set();
  for (const d of devices) {
    // "default" and "communications" are aliases of real devices, which are
    // listed on their own.
    if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications' || seen.has(d.deviceId)) continue;
    seen.add(d.deviceId);
    options.push({ value: d.deviceId, label: d.label || `Device ${options.length}` });
  }
  let selected = '';
  if (saved) {
    const byId = options.find((o) => o.value === saved.id);
    // Browser device ids can change (after clearing site data, say); the
    // name is what the user recognises, so fall back to it.
    const byLabel = options.find((o) => o.value && o.label === saved.label);
    const match = byId ?? byLabel;
    if (match) selected = match.value;
    else {
      options.push({ value: saved.id, label: `${saved.label || 'Chosen device'} (not connected)` });
      selected = saved.id;
    }
  }
  return { options, selected };
}

// What the Updates section says for an updater state (src/main/updates.js).
export function updateView(state) {
  const v = state?.currentVersion ?? '';
  const latest = state?.latest?.version;
  const base = {
    title: `Loupe ${v}`, text: '', error: false, busy: false,
    showActions: false, showBrew: false, showDownload: false, showInstall: false, badge: false
  };
  switch (state?.status) {
    case 'checking':
      return { ...base, text: 'Checking for updates…', busy: true };
    case 'current':
      return { ...base, text: `You have the newest version.${checked(state)}` };
    case 'available':
      return {
        ...base, title: `Loupe ${latest} is available`,
        text: `You have ${v}.`,
        showActions: true, badge: true,
        showBrew: state.kind === 'homebrew',
        showDownload: state.kind === 'download'
      };
    case 'downloading':
      return { ...base, title: `Loupe ${latest} is available`, text: 'Downloading the update…', busy: true, badge: true };
    case 'ready':
      return {
        ...base, title: `Loupe ${latest} is ready to install`,
        text: 'Restart Loupe to update now, or it will install the next time you quit.',
        showActions: true, showInstall: true, badge: true
      };
    case 'error':
      // An update that was found but failed to download still says so, and
      // offers the release page instead.
      if (latest) {
        return {
          ...base, title: `Loupe ${latest} is available`, error: true,
          text: `The update couldn’t be downloaded. ${state.error ?? ''}`.trim(),
          showActions: true, showDownload: true, badge: true
        };
      }
      return { ...base, text: `Couldn’t check for updates. ${state.error ?? ''}`.trim(), error: true };
    default:
      return { ...base, text: 'Loupe checks for new versions once a day.' };
  }
}

function checked(state) {
  if (!state.checkedAt) return '';
  const t = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(state.checkedAt);
  return ` Checked at ${t}.`;
}

// Only plain colours reach the page's CSS -- a preset is stored data, and a
// url() or anything else in it is ignored.
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+\s*)?\))$/i;
const isColor = (c) => typeof c === 'string' && COLOR_RE.test(c.trim());

// A small preview for a preset, from its background.
export function presetSwatch(style) {
  const bg = style?.background;
  if (!bg || bg.type === 'none') return '#1c1d1f';
  if (bg.type === 'color' && isColor(bg.value)) return bg.value.trim();
  if (bg.type === 'gradient' && Array.isArray(bg.value) && bg.value.length >= 2 && bg.value.every(isColor)) {
    return `linear-gradient(135deg, ${bg.value.map((c) => c.trim()).join(', ')})`;
  }
  return '#5f6368';
}
