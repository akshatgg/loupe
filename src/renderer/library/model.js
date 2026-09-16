// What the Library shows, as pure functions (no DOM), so searching, sorting
// and the wording of dates and lengths are unit-tested
// (test/shell-models.test.js).

// "0:07", "2:05", "1:02:05". Unknown length: an empty string, never "NaN".
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// "Today, 19:24", "Yesterday, 08:02", "Monday, 11:40" (this week),
// "3 Sept 2026, 10:15" -- in the user's own date and time style.
export function formatDate(ms, now = Date.now(), locale = undefined) {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(ms);
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86400000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  if (days > 1 && days < 7) {
    return `${new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(ms)}, ${time}`;
  }
  const date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(ms);
  return `${date}, ${time}`;
}

export const SORTS = {
  newest: (a, b) => b.createdAt - a.createdAt,
  oldest: (a, b) => a.createdAt - b.createdAt,
  name: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' })
    || b.createdAt - a.createdAt,
  longest: (a, b) => (b.duration ?? -1) - (a.duration ?? -1) || b.createdAt - a.createdAt
};

// Every word of the query has to appear somewhere in the title or the date
// as shown, ignoring case and accents -- so "sept demo" finds a recording
// called "Demo" made in September.
const fold = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export function filterAndSort(recordings, { query = '', sort = 'newest', now = Date.now(), locale } = {}) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const matches = words.length === 0 ? recordings : recordings.filter((r) => {
    const haystack = fold(`${r.title} ${formatDate(r.createdAt, now, locale)}`);
    return words.every((w) => haystack.includes(w));
  });
  return [...matches].sort(SORTS[sort] ?? SORTS.newest);
}

// "3 recordings", "1 recording", "No recordings".
export function countLabel(n) {
  if (n === 0) return 'No recordings';
  return `${n} recording${n === 1 ? '' : 's'}`;
}
