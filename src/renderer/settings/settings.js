import {
  SECTIONS, FORMAT_HELP, QUALITY_HELP, deviceOptions, updateView, presetSwatch
} from './model.js';

// The Settings window. Every control saves as soon as it changes (there is no
// OK button); the main process validates each change (src/main/settings.js)
// and sends the result back to every open window as 'settings:changed'.

const loupe = window.loupe;
const IS_WINDOWS = loupe.platform === 'win32';
const $ = (id) => document.getElementById(id);

let settings = null;

// ---- messages ---------------------------------------------------------------

let toastTimer = null;
function toast(text, { error = false } = {}) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), error ? 4500 : 2000);
}

const plain = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function save(patch) {
  try {
    settings = await loupe.setSettings(patch);
  } catch (err) {
    toast(`That couldn’t be saved: ${plain(err)}`, { error: true });
  }
  render();
}

// ---- sections ---------------------------------------------------------------

function showSection(name) {
  const section = SECTIONS.includes(name) ? name : 'general';
  for (const el of document.querySelectorAll('main section')) el.hidden = el.dataset.section !== section;
  for (const a of document.querySelectorAll('.side a')) {
    if (a.dataset.section === section) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.querySelector('main').scrollTop = 0;
  if (section === 'recording') loadDevices();
  if (section === 'about') loadAbout();
}

window.addEventListener('hashchange', () => showSection(location.hash.slice(1)));
loupe.settings.onShowSection((name) => {
  if (location.hash.slice(1) === name) showSection(name);
  else location.hash = name;
});

// ---- general ----------------------------------------------------------------

async function renderFolder() {
  const { recordingsFolder, isDefault } = await loupe.settings.paths();
  const path = $('folderPath');
  path.textContent = '';
  // <bdi> keeps the path reading left to right while the box trims its start
  // (direction: rtl), so the folder's own name stays visible.
  const bdi = document.createElement('bdi');
  bdi.textContent = recordingsFolder;
  path.append(bdi);
  path.title = recordingsFolder;
  $('resetFolder').disabled = isDefault;
}

$('changeFolder').addEventListener('click', async () => {
  try {
    settings = await loupe.settings.chooseRecordingsFolder();
    render();
  } catch (err) {
    toast(plain(err), { error: true });
  }
});
$('resetFolder').addEventListener('click', async () => {
  settings = await loupe.settings.resetRecordingsFolder();
  render();
  toast('New recordings will be saved in the usual folder');
});

// Every switch with data-setting maps straight to a true/false setting.
for (const input of document.querySelectorAll('input[data-setting]')) {
  input.addEventListener('change', () => save({ [input.dataset.setting]: input.checked }));
}

// ---- recording --------------------------------------------------------------

const zoomShortcuts = window.loupeZoomShortcuts.mount({
  captureEls: [...document.querySelectorAll('.capture')],
  clearEls: [...document.querySelectorAll('.clear')],
  onRender: (triggers) => {
    const help = $('zoomHelp');
    const any = window.loupeZoomShortcuts.describe(help, triggers, {
      after: ' and scroll while recording: up to zoom in, down to zoom out.'
    });
    if (!any) help.textContent = 'Zoom is off. Click a box below, then press the key or mouse button you want to hold.';
  },
  onError: (err) => toast(`That shortcut couldn’t be saved: ${plain(err)}`, { error: true })
});

$('copyKey').textContent = IS_WINDOWS ? 'Ctrl+C' : '⌘C';

let devices = [];
let devicesLoaded = false;

// Device names are only shown once the app may use them; asking for the list
// never turns a microphone or camera on.
async function loadDevices() {
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    devices = [];
  }
  devicesLoaded = true;
  renderDevices();
}

function renderDevices() {
  if (!settings || !devicesLoaded) return;
  const kinds = [
    ['microphone', 'audioinput', 'Same as your computer', 'micHelp',
      'Used when you turn on the microphone for a recording.', 'No microphone found.'],
    ['camera', 'videoinput', 'Same as your computer', 'cameraHelp',
      'Used when you add yourself to a recording.', 'No camera found.']
  ];
  for (const [key, kind, defaultLabel, helpId, help, none] of kinds) {
    const found = devices.filter((d) => d.kind === kind);
    const { options, selected } = deviceOptions(found, settings[key], { defaultLabel });
    const select = $(key);
    select.textContent = '';
    for (const o of options) select.append(new Option(o.label, o.value));
    select.value = selected;
    $(helpId).textContent = found.length || settings[key] ? help : none;
  }
}

for (const key of ['microphone', 'camera']) {
  $(key).addEventListener('change', (e) => {
    const option = e.target.selectedOptions[0];
    const value = e.target.value
      ? { id: e.target.value, label: option.textContent.replace(/ \(not connected\)$/, '') }
      : null;
    save({ [key]: value });
  });
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (devicesLoaded) loadDevices(); });

// ---- presets ----------------------------------------------------------------

let renamingPreset = null;

function renderPresets() {
  const { presets, defaultPresetId } = settings;
  const select = $('defaultPreset');
  select.textContent = '';
  select.append(new Option('Loupe’s standard look', ''));
  for (const p of presets) select.append(new Option(p.name, p.id));
  select.value = defaultPresetId ?? '';
  select.disabled = presets.length === 0;

  const list = $('presetList');
  list.textContent = '';
  list.hidden = presets.length === 0;
  $('noPresets').hidden = presets.length > 0;
  for (const p of presets) {
    const li = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = presetSwatch(p.style);
    const name = document.createElement('span');
    name.className = 'pname';
    if (renamingPreset === p.id) {
      name.append(presetNameField(p));
    } else {
      name.textContent = p.name;
      name.title = p.name;
    }
    li.append(swatch, name);
    if (p.id === defaultPresetId) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'For new recordings';
      li.append(tag);
    }
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'btn';
    rename.textContent = 'Rename';
    rename.onclick = () => { renamingPreset = p.id; renderPresets(); };
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn danger';
    del.textContent = 'Delete';
    del.onclick = async () => {
      try {
        await loupe.presets.remove(p.id);
        toast(`Deleted “${p.name}”`);
      } catch (err) {
        toast(plain(err), { error: true });
      }
    };
    li.append(rename, del);
    list.append(li);
  }
  list.querySelector('input')?.focus();
}

function presetNameField(p) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = p.name;
  input.maxLength = 80;
  input.setAttribute('aria-label', 'Preset name');
  let done = false;
  const finish = async (keep) => {
    if (done) return;
    done = true;
    renamingPreset = null;
    if (keep && input.value.trim() && input.value.trim() !== p.name) {
      try {
        await loupe.presets.rename(p.id, input.value);
      } catch (err) {
        toast(plain(err), { error: true });
      }
    }
    renderPresets();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  return input;
}

$('defaultPreset').addEventListener('change', async (e) => {
  try {
    await loupe.presets.setDefault(e.target.value || null);
  } catch (err) {
    toast(plain(err), { error: true });
  }
});

// ---- export -----------------------------------------------------------------

function exportPatch(changes) {
  return { exportDefaults: { ...settings.exportDefaults, ...changes } };
}
for (const radio of document.querySelectorAll('input[name="format"], input[name="quality"]')) {
  radio.addEventListener('change', () => save(exportPatch({ [radio.name]: radio.value })));
}
$('resolution').addEventListener('change', (e) => save(exportPatch({ resolution: e.target.value })));

// ---- updates ----------------------------------------------------------------

let updateState = null;

function renderUpdates() {
  if (!updateState) return;
  const view = updateView(updateState);
  $('updateTitle').textContent = view.title;
  const text = $('updateText');
  text.textContent = '';
  if (view.busy) {
    const spin = document.createElement('span');
    spin.className = 'spinner';
    text.append(spin);
  }
  text.append(view.text);
  text.classList.toggle('error', view.error);
  $('checkNow').disabled = view.busy;
  $('updateActions').hidden = !view.showActions;
  $('brewBox').hidden = !view.showBrew;
  $('downloadUpdate').hidden = !view.showDownload;
  $('installUpdate').hidden = !view.showInstall;
  $('updateDot').hidden = !view.badge;
}

$('checkNow').addEventListener('click', () => loupe.updates.check());
$('copyBrew').addEventListener('click', async () => {
  await loupe.updates.copyBrewCommand();
  $('copyBrew').textContent = 'Copied';
  setTimeout(() => { $('copyBrew').textContent = 'Copy'; }, 1600);
});
$('downloadUpdate').addEventListener('click', () => loupe.updates.openReleasePage());
$('releaseNotes').addEventListener('click', () => loupe.updates.openReleasePage());
$('installUpdate').addEventListener('click', () => loupe.updates.install());
loupe.updates.onChanged((state) => { updateState = state; renderUpdates(); });

// ---- privacy ----------------------------------------------------------------

$('reportProblem').addEventListener('click', () => loupe.app.reportProblem());
$('showLogs').addEventListener('click', () => loupe.app.showLogs());

// ---- about ------------------------------------------------------------------

let aboutLoaded = false;

async function loadAbout() {
  if (aboutLoaded) return;
  aboutLoaded = true;
  const [about, licenses] = await Promise.all([loupe.app.about(), loupe.app.licenses()]);
  $('aboutVersion').textContent = `Version ${about.version}`;
  const os = { darwin: 'macOS', win32: 'Windows' }[about.platform] ?? about.platform;
  $('aboutBuild').textContent = `Electron ${about.electron} · Chromium ${about.chrome} · ${os} ${about.osVersion} (${about.arch})`;

  const box = $('licenses');
  box.textContent = '';
  for (const lic of licenses) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.append(lic.name);
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = licenseKind(lic.text);
    summary.append(kind);
    const pre = document.createElement('pre');
    pre.textContent = lic.text.trim();
    details.append(summary, pre);
    if (lic.chromiumCredits) {
      const credits = document.createElement('button');
      credits.type = 'button';
      credits.className = 'btn small credits';
      credits.textContent = 'Chromium credits';
      credits.onclick = () => loupe.app.openChromiumCredits();
      details.append(credits);
    }
    box.append(details);
  }
}

function licenseKind(text) {
  if (/MIT License|Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/Apache License/i.test(text)) return 'Apache 2.0';
  if (/BSD/i.test(text) || /Redistribution and use in source and binary forms/i.test(text)) return 'BSD';
  if (/ISC License/i.test(text)) return 'ISC';
  return '';
}

for (const b of document.querySelectorAll('[data-link]')) {
  b.addEventListener('click', () => loupe.app.openLink(b.dataset.link));
}

// ---- drawing ----------------------------------------------------------------

function render() {
  if (!settings) return;
  for (const input of document.querySelectorAll('input[data-setting]')) {
    input.checked = Boolean(settings[input.dataset.setting]);
  }
  const { format, resolution, quality } = settings.exportDefaults;
  for (const r of document.querySelectorAll('input[name="format"]')) r.checked = r.value === format;
  for (const r of document.querySelectorAll('input[name="quality"]')) r.checked = r.value === quality;
  $('resolution').value = resolution;
  $('formatHelp').textContent = FORMAT_HELP[format];
  $('qualityHelp').textContent = QUALITY_HELP[quality];
  zoomShortcuts.set(settings.zoomTriggers);
  renderDevices();
  if (renamingPreset === null) renderPresets();
  renderFolder();
}

loupe.onSettingsChanged((next) => { settings = next; render(); });

(async () => {
  [settings, updateState] = await Promise.all([loupe.getSettings(), loupe.updates.state()]);
  showSection(location.hash.slice(1));
  render();
  renderUpdates();
})();
