import { filterAndSort, formatDate, formatDuration, countLabel } from './model.js';

// The Library window: every recording in the recordings folder. The main
// process (src/main/ipc/library.js) does the file work; this page only asks,
// by folder name, and redraws.

const api = window.loupe.library;
const IS_WINDOWS = window.loupe.platform === 'win32';
const $ = (id) => document.getElementById(id);

let recordings = [];
let displayRoot = '';
let selectedId = null;
let renamingId = null;
let query = '';
let sort = 'newest';
let loadError = null;

// Remember the sort between visits: a convenience, fine to lose.
try { sort = localStorage.getItem('library.sort') || sort; } catch { /* storage off */ }
$('sort').value = sort;
if (!$('sort').value) { sort = 'newest'; $('sort').value = sort; }

$('revealItem').textContent = IS_WINDOWS ? 'Show in File Explorer' : 'Show in Finder';
$('trashItem').textContent = IS_WINDOWS ? 'Move to Recycle Bin' : 'Move to Trash';

// ---- messages ---------------------------------------------------------------

let toastTimer = null;
// `stay` keeps it up until the next message replaces it (work in progress).
function toast(text, { error = false, stay = false } = {}) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (!stay) toastTimer = setTimeout(() => el.classList.remove('show'), error ? 4500 : 2200);
}

// IPC errors arrive as "Error invoking remote method 'x': Error: message".
const plain = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---- loading ----------------------------------------------------------------

// A refresh redraws every card, which would throw away a name being typed
// (the window regaining focus refreshes), so it waits for the rename to end.
let refreshWaiting = false;

async function refresh() {
  if (renamingId) {
    refreshWaiting = true;
    return;
  }
  refreshWaiting = false;
  try {
    ({ recordings, displayRoot } = await api.list());
    loadError = null;
  } catch (err) {
    loadError = plain(err);
  }
  if (selectedId && !recordings.some((r) => r.id === selectedId)) selectedId = null;
  render();
}

// Thumbnails are made on demand, two at a time, and only once each.
const thumbQueue = [];
const thumbAsked = new Set();
let thumbsRunning = 0;

function wantThumbnail(rec) {
  if (rec.thumbnail || !rec.hasVideo || thumbAsked.has(rec.id)) return;
  thumbAsked.add(rec.id);
  thumbQueue.push(rec.id);
  pumpThumbnails();
}

function pumpThumbnails() {
  while (thumbsRunning < 2 && thumbQueue.length) {
    const id = thumbQueue.shift();
    thumbsRunning++;
    api.thumbnail(id).then((url) => {
      const rec = recordings.find((r) => r.id === id);
      if (rec && url) {
        rec.thumbnail = url;
        const img = document.querySelector(`.card[data-id="${CSS.escape(id)}"] img`);
        if (img) setImage(img, url);
      }
    }).catch(() => { /* the placeholder stays */ }).finally(() => {
      thumbsRunning--;
      pumpThumbnails();
    });
  }
}

function setImage(img, url) {
  img.onload = () => img.classList.add('loaded');
  img.src = url;
  // Already in the cache (a redraw): show it at once instead of fading in again.
  if (img.complete) img.classList.add('loaded', 'instant');
  img.hidden = false;
  img.previousElementSibling?.remove(); // the placeholder
}

// ---- drawing ----------------------------------------------------------------

const ICON_MORE = '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.5" cy="8" r="1.4"/></svg>';
const ICON_FILM = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M3 15h18M8 5v4M16 5v4M8 15v4M16 15v4"/></svg>';

function card(rec, now) {
  const li = document.createElement('li');
  li.className = 'card';
  li.dataset.id = rec.id;
  li.tabIndex = 0;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', String(rec.id === selectedId));

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const ph = document.createElement('div');
  ph.className = 'ph';
  // Static markup only; the recording's own text is always set with textContent.
  ph.innerHTML = ICON_FILM;
  if (!rec.hasVideo) ph.append('No video');
  thumb.append(ph);
  const img = document.createElement('img');
  img.alt = '';
  img.hidden = true;
  img.draggable = false;
  thumb.append(img);
  if (rec.thumbnail) setImage(img, rec.thumbnail);
  else wantThumbnail(rec);

  const length = formatDuration(rec.duration);
  if (length) {
    const badge = document.createElement('span');
    badge.className = 'duration';
    badge.textContent = length;
    thumb.append(badge);
  }

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'more';
  more.setAttribute('aria-label', 'More actions');
  more.setAttribute('aria-haspopup', 'menu');
  more.innerHTML = ICON_MORE;
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    select(rec.id);
    const r = more.getBoundingClientRect();
    openMenu(rec.id, r.left, r.bottom + 4, more);
  });
  thumb.append(more);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const title = document.createElement('div');
  title.className = 'title';
  if (renamingId === rec.id) {
    title.append(renameField(rec));
  } else {
    title.textContent = rec.title;
    title.title = rec.title;
  }
  const date = document.createElement('div');
  date.className = 'date';
  date.textContent = formatDate(rec.createdAt, now);
  meta.append(title, date);

  li.append(thumb, meta);
  li.addEventListener('click', () => select(rec.id));
  li.addEventListener('dblclick', (e) => {
    if (!e.target.closest('input, .more')) open(rec.id);
  });
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    select(rec.id);
    openMenu(rec.id, e.clientX, e.clientY);
  });
  return li;
}

function renameField(rec) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = rec.customTitle ? rec.title : '';
  input.placeholder = rec.title;
  input.maxLength = 120;
  input.setAttribute('aria-label', 'Recording name');
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    renamingId = null;
    if (save && input.value.trim() !== (rec.customTitle ? rec.title : '')) {
      try {
        Object.assign(rec, await api.rename(rec.id, input.value));
      } catch (err) {
        toast(plain(err), { error: true });
      }
    }
    render();
    document.querySelector(`.card[data-id="${CSS.escape(rec.id)}"]`)?.focus();
    if (refreshWaiting) refresh();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  return input;
}

function render() {
  const now = Date.now();
  // A folder that stopped working shows only the message, not stale cards.
  const shown = loadError ? [] : filterAndSort(recordings, { query, sort, now });
  const grid = $('grid');
  const scroll = $('main').scrollTop;
  grid.textContent = '';
  for (const rec of shown) grid.append(card(rec, now));
  $('main').scrollTop = scroll;

  const none = recordings.length === 0;
  $('failed').hidden = !loadError;
  $('failedText').textContent = loadError ?? '';
  $('empty').hidden = Boolean(loadError) || !none;
  $('noMatch').hidden = Boolean(loadError) || none || shown.length > 0;
  $('noMatchText').textContent = `Nothing matches “${query.trim()}”`;
  $('tools').querySelectorAll('.search, #sort').forEach((el) => { el.hidden = none && !query; });

  const summary = $('summary');
  summary.textContent = '';
  if (!loadError) {
    summary.append(`${countLabel(recordings.length)} in`);
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'link';
    // The marks keep the path's slashes in order inside the right-to-left
    // box that trims it from the start (library.css).
    link.textContent = `\u200E${displayRoot}\u200E`;
    link.title = IS_WINDOWS ? 'Show this folder in File Explorer' : 'Show this folder in Finder';
    link.onclick = () => api.revealFolder();
    summary.append(link);
  }

  const input = grid.querySelector('.title input');
  if (input) { input.focus(); input.select(); }
}

function select(id) {
  selectedId = id;
  for (const el of document.querySelectorAll('.card')) {
    el.setAttribute('aria-selected', String(el.dataset.id === id));
  }
}

// ---- actions ----------------------------------------------------------------

// Pressing ⌘D or Delete twice quickly shouldn't make two copies or ask twice.
const inFlight = new Set();

async function run(action, id) {
  const rec = recordings.find((r) => r.id === id);
  if (!rec) return;
  const key = `${action}:${id}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    switch (action) {
      case 'open':
        await api.open(id);
        break;
      case 'rename':
        renamingId = id;
        render();
        break;
      case 'duplicate': {
        // A long recording takes a while to copy; say something is happening.
        toast(`Copying “${rec.title}”…`, { stay: true });
        const copy = await api.duplicate(id);
        await refresh();
        select(copy.id);
        document.querySelector(`.card[data-id="${CSS.escape(copy.id)}"]`)?.scrollIntoView({ block: 'nearest' });
        toast(`Made “${copy.title}”`);
        break;
      }
      case 'reveal':
        await api.reveal(id);
        break;
      case 'trash': {
        const { trashed } = await api.trash(id);
        if (trashed) {
          await refresh();
          toast(IS_WINDOWS ? 'Moved to the Recycle Bin' : 'Moved to the Trash');
        }
        break;
      }
    }
  } catch (err) {
    toast(plain(err), { error: true });
    refresh();
  } finally {
    inFlight.delete(key);
  }
}

const open = (id) => run('open', id);

// ---- menu -------------------------------------------------------------------

let menuFor = null;
let menuButton = null;

function openMenu(id, x, y, button = null) {
  const menu = $('menu');
  menuFor = id;
  menuButton = button;
  button?.setAttribute('aria-expanded', 'true');
  menu.hidden = false;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  menu.querySelector('button').focus();
}

function closeMenu() {
  if ($('menu').hidden) return;
  $('menu').hidden = true;
  menuButton?.setAttribute('aria-expanded', 'false');
  menuButton = null;
  menuFor = null;
}

$('menu').addEventListener('click', (e) => {
  const item = e.target.closest('button[data-action]');
  if (!item) return;
  const id = menuFor;
  closeMenu();
  run(item.dataset.action, id);
});
$('menu').addEventListener('keydown', (e) => {
  const items = [...$('menu').querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); }
});
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#menu')) closeMenu(); });
window.addEventListener('blur', closeMenu);
$('main').addEventListener('scroll', closeMenu);

// ---- keyboard ---------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  // A key event sent to the document itself has no closest().
  if (e.target.closest?.('input, select') || !$('menu').hidden) return;
  const mod = IS_WINDOWS ? e.ctrlKey : e.metaKey;
  const focused = document.activeElement?.closest?.('.card')?.dataset.id;
  const id = focused ?? selectedId;
  if (mod && e.key === 'f') { e.preventDefault(); $('search').focus(); return; }
  if (!id) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    open(id);
  } else if (e.key === 'F2') {
    e.preventDefault();
    run('rename', id);
  } else if (mod && e.key === 'd') {
    e.preventDefault();
    run('duplicate', id);
  } else if (e.key === 'Delete' || (mod && e.key === 'Backspace')) {
    e.preventDefault();
    run('trash', id);
  } else if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
    e.preventDefault();
    moveSelection(id, e.key);
  }
});

// Arrow keys move through the grid by columns and rows.
function moveSelection(id, key) {
  const cards = [...document.querySelectorAll('.card')];
  const i = cards.findIndex((c) => c.dataset.id === id);
  if (i < 0) return;
  const top = cards[0].offsetTop;
  const perRow = Math.max(1, cards.filter((c) => c.offsetTop === top).length);
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow }[key];
  const next = cards[Math.max(0, Math.min(cards.length - 1, i + step))];
  select(next.dataset.id);
  next.focus();
  next.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('focusin', (e) => {
  const c = e.target.closest?.('.card');
  if (c) select(c.dataset.id);
});

// ---- toolbar ----------------------------------------------------------------

$('search').addEventListener('input', (e) => { query = e.target.value; render(); });
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && e.target.value) { e.stopPropagation(); e.target.value = ''; query = ''; render(); }
});
$('sort').addEventListener('change', (e) => {
  sort = e.target.value;
  try { localStorage.setItem('library.sort', sort); } catch { /* storage off */ }
  render();
});
$('clearSearch').addEventListener('click', () => { $('search').value = ''; query = ''; render(); });
$('retry').addEventListener('click', refresh);
$('failedSettings').addEventListener('click', () => window.loupe.app.openSettings('general'));
for (const b of [$('newRecording'), $('emptyNew')]) b.addEventListener('click', () => api.newRecording());

api.onChanged(refresh);
window.addEventListener('focus', refresh);
refresh();
