'use strict';

// End-to-end test of captions, in real Electron on macOS:
//
//   npm run test:e2e:captions          (electron test/e2e/captions.e2e.js)
//
// Speech is synthesized with `say`, encoded to AAC with `afconvert` (and, if
// ffmpeg is installed, muxed under a video track into a .mov like a real
// recording), then transcribed by the real engine: preload bridge, model
// download through main, audio decode in the page, Whisper in the worker.
// Checks that the transcript has the spoken words (word error rate), that
// word times line up with where the speech actually is, language detection,
// cancel, and that nothing reaches the network once the model is on disk.
//
// The model (about 200 MB) downloads once into LOUPE_E2E_CACHE (default: the
// OS temp dir) and is reused. CAPTIONS_MODEL=accurate tests the larger model.
// Prints a report (accuracy and speed) and writes test/e2e/out/captions-report.json.

const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { registerCaptionsIpc } = require('../../src/main/ipc/captions');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const CACHE = process.env.LOUPE_E2E_CACHE || path.join(os.tmpdir(), 'loupe-e2e-cache');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-captions-'));
const MODEL = process.env.CAPTIONS_MODEL || 'standard';

app.setPath('userData', path.join(CACHE, 'userData'));

const EN_A = 'Welcome to the demo. Today I will show you how to record your screen and share the video with your team.';
const EN_B = 'First, open the settings window and choose a microphone. Then press the record button and start talking.';
const DE = 'Guten Tag. Heute zeige ich Ihnen, wie Sie Ihren Bildschirm aufnehmen und das Video mit Ihrem Team teilen.';
const LONG = [
  'Good morning everyone, and thank you for joining this short product walkthrough.',
  'We will start with the library, where every recording you make is saved automatically.',
  'Each recording has a title, a date, and a small preview, so you can find it again later.',
  'Next we will open the editor. The timeline at the bottom shows your clips, zooms, and speed changes.',
  'You can drag the edges of a clip to trim it, or split it at the playhead to remove a mistake.',
  'Zooms are added automatically while you record, but you can move them, resize them, or delete them.',
  'When you are happy with the result, press export and choose the size and quality you need.',
  'Finally, you can copy the file, drag it into a chat, or create a link to share with your colleagues.',
  'That is everything for today. If you have questions, please send us a message.'
];

const results = [];
const report = { model: MODEL, runs: [], checks: results };

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

function has(cmd) {
  try { execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
}

function say(voice, text, file) {
  const aiff = file.replace(/\.\w+$/, '.aiff');
  execFileSync('/usr/bin/say', ['-v', voice, '-o', aiff, text]);
  execFileSync('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac@48000', aiff, file]);
  return file;
}

function afDuration(file) {
  const out = execFileSync('/usr/bin/afinfo', [file]).toString();
  return Number(/estimated duration: ([\d.]+)/.exec(out)[1]);
}

const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
  .replace(/[^a-z0-9ß\s']/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

// Word error rate: word-level edit distance over the reference length.
function wer(reference, hypothesis) {
  const r = norm(reference);
  const h = norm(hypothesis);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...new Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
  }
  return d[r.length][h.length] / Math.max(1, r.length);
}

const transcriptOf = (r) => r.words.map((w) => w.text).join('').trim();

function findRealRecording(withMic) {
  const base = path.join(os.homedir(), 'Movies', 'Loupe');
  try {
    for (const d of fs.readdirSync(base).sort().reverse()) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(base, d, 'project.json'), 'utf8'));
        const video = path.join(base, d, p.capture?.file || 'raw.mov');
        if (Boolean(p.capture?.hasMicTrack) === withMic && fs.existsSync(video)) return { video, duration: p.capture.duration };
      } catch { /* not a recording */ }
    }
  } catch { /* no recordings folder */ }
  return null;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  registerCaptionsIpc({ ipcMain, app, dialog, BrowserWindow });

  // Anything the page or worker fetches from the internet is a failure once
  // the model is on disk (main's own download is not a renderer request).
  const netRequests = [];
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    if (/^https?:/.test(details.url)) netRequests.push(details.url);
    cb({});
  });

  // --- fixtures --------------------------------------------------------
  const t0 = Date.now();
  const enM4a = say('Samantha', `${EN_A} [[slnc 2500]] ${EN_B}`, path.join(WORK, 'en.m4a'));
  const deM4a = say('Anna', DE, path.join(WORK, 'de.m4a'));
  const longM4a = say('Samantha', LONG.join(' [[slnc 600]] '), path.join(WORK, 'long.m4a'));
  let enMov = null;
  if (has('ffmpeg')) {
    enMov = path.join(WORK, 'raw.mov');
    const dur = afDuration(enM4a);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=navy:s=640x360:r=30:d=${dur}`,
      '-i', enM4a, '-map', '0:v', '-map', '1:a', '-c:v', 'h264_videotoolbox', '-b:v', '1M',
      '-c:a', 'copy', '-movflags', '+faststart', enMov]);
  }
  console.log(`fixtures ready in ${Date.now() - t0} ms (${WORK})`);

  const win = new BrowserWindow({
    show: false, width: 1280, height: 720,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'preload.js') }
  });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') console.log(`[page ${e.level}] ${e.message}`);
  });
  await win.loadFile(path.join(__dirname, 'captions.html'));
  const js = (code) => win.webContents.executeJavaScript(code);
  for (let i = 0; i < 100 && !(await js('window.captionsTestReady === true')); i++) await new Promise((r) => setTimeout(r, 50));

  const url = (f) => pathToFileURL(f).href;
  const run = (opts) => js(`window.captionsTest.transcribe(${JSON.stringify(opts)})`);

  // --- audio decode ----------------------------------------------------
  const enDur = afDuration(enM4a);
  const dec = await js(`window.captionsTest.decode(${JSON.stringify(url(enM4a))})`);
  check('decodes the AAC track to 16 kHz mono of the right length', dec.sampleRate === 16000 && Math.abs(dec.duration - enDur) < 0.25,
    { decoded: dec.duration, afinfo: enDur, ms: Math.round(dec.ms) });
  check('decoded audio has sound in it', dec.peak > 0.1, { peak: dec.peak });
  check('finds the two spoken phrases (pause between them)', dec.onsets.length === 2, dec.onsets);

  if (enMov) {
    const decMov = await js(`window.captionsTest.decode(${JSON.stringify(url(enMov))})`);
    check('decodes the mic track out of a .mov with video', Math.abs(decMov.duration - enDur) < 0.3 &&
      Math.abs((decMov.onsets[1] ?? 0) - (dec.onsets[1] ?? 99)) < 0.1, { duration: decMov.duration, onsets: decMov.onsets });
  }

  const real = findRealRecording(true);
  if (real) {
    const copy = path.join(WORK, 'real.mov');
    fs.copyFileSync(real.video, copy);
    const d = await js(`window.captionsTest.decode(${JSON.stringify(url(copy))})`);
    check('decodes a real Loupe recording\'s mic track', Math.abs(d.duration - real.duration) < 0.5,
      { decoded: d.duration, recording: real.duration, ms: Math.round(d.ms) });
  }

  // --- English, auto language -------------------------------------------
  const en = await run({ url: url(enM4a), language: 'auto', model: MODEL });
  check('English transcription finishes', en.ok, en.ok ? `device ${en.device}` : en.message);
  if (en.ok) {
    const text = transcriptOf(en);
    const e = wer(`${EN_A} ${EN_B}`, text);
    report.runs.push({ name: 'english (auto)', device: en.device, audioSeconds: en.duration, ms: Math.round(en.ms), transcribeMs: Math.round(en.transcribeMs), wer: e, text, stages: en.stages });
    check('detects English', en.language === 'en', en.language);
    check('transcript matches what was said (WER <= 15%)', e <= 0.15, { wer: e.toFixed(3), text });
    for (const w of ['record', 'screen', 'microphone', 'settings']) {
      check(`transcript contains "${w}"`, norm(text).includes(w));
    }
    const ordered = en.words.every((w, i) => w.end >= w.start && (i === 0 || w.start >= en.words[i - 1].start - 0.05));
    check('word times are ordered and inside the audio', ordered && en.words.every((w) => w.start >= 0 && w.end <= en.duration + 0.05));
    const firstB = en.words.find((w) => /first/i.test(w.text));
    check('second phrase starts where its sound starts (within 0.6 s)', firstB && Math.abs(firstB.start - dec.onsets[1]) < 0.6,
      { word: firstB && firstB.start, onset: dec.onsets[1] });
    check('first word starts near the start of speech (within 0.6 s)', Math.abs(en.words[0].start - dec.onsets[0]) < 0.6,
      { word: en.words[0].start, onset: dec.onsets[0] });
    const lastA = [...en.words].reverse().find((w) => /team/i.test(w.text));
    check('no caption spans the pause between the phrases', en.segments.every((s) => !(s.start < dec.onsets[1] - 0.5 && s.end > dec.onsets[1] + 0.2)),
      en.segments.map((s) => [s.start.toFixed(2), s.end.toFixed(2)]));
    check('word before the pause ends before the pause', lastA && lastA.end < dec.onsets[1], lastA);
    const { wrapText } = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'captions', 'lines.js')).href);
    check('captions are readable (<= 2 lines of 42 characters)',
      en.segments.every((s) => s.source === 'main' && wrapText(s.text, 42).length <= 2 && wrapText(s.text, 42).every((l) => l.length <= 42)),
      en.segments.map((s) => s.text));
    const draw = await js(`window.captionsTest.draw(${JSON.stringify([{ text: en.segments[0].text }])}, { size: 1, position: 'bottom' })`);
    check('burn-in draws a dark caption box at the bottom', draw.box && draw.box.y > 720 / 2 && draw.center[0] < 60 && draw.outside[2] > 90, draw);
    fs.writeFileSync(path.join(OUT, 'captions-burn-in.png'), (await win.webContents.capturePage()).toPNG());
  }

  // --- the same speech inside a .mov, on the CPU --------------------------
  if (enMov) {
    const cpu = await run({ url: url(enMov), language: 'en', model: MODEL, device: 'wasm' });
    check('transcribes a .mov on the CPU (no GPU)', cpu.ok && cpu.device === 'wasm', cpu.ok ? cpu.device : cpu.message);
    if (cpu.ok) {
      const e = wer(`${EN_A} ${EN_B}`, transcriptOf(cpu));
      report.runs.push({ name: 'english .mov (cpu)', device: cpu.device, audioSeconds: cpu.duration, ms: Math.round(cpu.ms), transcribeMs: Math.round(cpu.transcribeMs), wer: e, text: transcriptOf(cpu), stages: cpu.stages });
      check('CPU transcript matches too (WER <= 15%)', e <= 0.15, e.toFixed(3));
    }
  }

  // --- German, auto language ----------------------------------------------
  const de = await run({ url: url(deM4a), language: 'auto', model: MODEL });
  if (de.ok) {
    const e = wer(DE, transcriptOf(de));
    report.runs.push({ name: 'german (auto)', device: de.device, audioSeconds: de.duration, ms: Math.round(de.ms), transcribeMs: Math.round(de.transcribeMs), wer: e, text: transcriptOf(de) });
    check('detects German', de.language === 'de', de.language);
    check('German transcript matches (WER <= 30%)', e <= 0.3, { wer: e.toFixed(3), text: transcriptOf(de) });
  } else {
    check('German transcription finishes', false, de.message);
  }

  // --- longer than one 30 s piece -------------------------------------------
  const longDur = afDuration(longM4a);
  const lng = await run({ url: url(longM4a), language: 'en', model: MODEL });
  if (lng.ok) {
    const e = wer(LONG.join(' '), transcriptOf(lng));
    report.runs.push({ name: `long ${Math.round(longDur)} s`, device: lng.device, audioSeconds: lng.duration, ms: Math.round(lng.ms), transcribeMs: Math.round(lng.transcribeMs), wer: e, text: transcriptOf(lng) });
    check(`long recording (${longDur.toFixed(0)} s, several pieces) matches (WER <= 15%)`, e <= 0.15, { wer: e.toFixed(3) });
    const last = lng.words[lng.words.length - 1];
    check('long recording is transcribed to the end', last && last.end > longDur - 3, { lastWord: last, duration: longDur });
    check('long recording captions stay in order without overlaps',
      lng.segments.every((s, i) => i === 0 || s.start >= lng.segments[i - 1].end - 1e-6));
  } else {
    check('long transcription finishes', false, lng.message);
  }

  // --- speed on the CPU, model already loaded -------------------------------
  const lngCpu = await run({ url: url(longM4a), language: 'en', model: MODEL, device: 'wasm' });
  if (lngCpu.ok) {
    const e = wer(LONG.join(' '), transcriptOf(lngCpu));
    report.runs.push({ name: `long ${Math.round(longDur)} s (cpu)`, device: lngCpu.device, audioSeconds: lngCpu.duration, ms: Math.round(lngCpu.ms), transcribeMs: Math.round(lngCpu.transcribeMs), wer: e, text: transcriptOf(lngCpu) });
    check('long recording on the CPU matches (WER <= 15%)', e <= 0.15, { wer: e.toFixed(3) });
  } else {
    check('long transcription on the CPU finishes', false, lngCpu.message);
  }

  // --- cancel -------------------------------------------------------------
  const cancelled = await run({ url: url(longM4a), language: 'en', model: MODEL, device: 'wasm', cancelAfterProgress: true });
  check('cancel stops a running transcription', !cancelled.ok && cancelled.code === 'cancelled', cancelled);
  check('cancel takes effect within 3 s', cancelled.cancelLatencyMs !== null && cancelled.cancelLatencyMs < 3000, Math.round(cancelled.cancelLatencyMs));
  const after = await run({ url: url(deM4a), language: 'de', model: MODEL, device: 'wasm' });
  check('a new transcription works after a cancel', after.ok, after.ok ? transcriptOf(after) : after.message);

  // --- a recording without sound ------------------------------------------
  let silentVideo = null;
  const realNoMic = findRealRecording(false);
  if (realNoMic) {
    silentVideo = path.join(WORK, 'nomic.mov');
    fs.copyFileSync(realNoMic.video, silentVideo);
  } else if (has('ffmpeg')) {
    silentVideo = path.join(WORK, 'nomic.mov');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=2', '-c:v', 'h264_videotoolbox', silentVideo]);
  }
  if (silentVideo) {
    const none = await run({ url: url(silentVideo), language: 'auto', model: MODEL });
    check('a recording without the mic says so plainly', !none.ok && none.code === 'no-audio', none.message);
  }

  check('nothing was fetched from the internet by the page or worker', netRequests.length === 0, netRequests.slice(0, 5));

  // "total" includes any model download, reading the audio and starting the
  // model; "speech to text" is the model's own work.
  console.log('\nspeed and accuracy:');
  for (const r of report.runs) {
    console.log(`  ${r.name.padEnd(22)} ${String(r.device).padEnd(7)} ${r.audioSeconds.toFixed(1).padStart(6)} s audio  ` +
      `${(r.ms / 1000).toFixed(1).padStart(5)} s total  ${(r.transcribeMs / 1000).toFixed(1).padStart(5)} s speech to text ` +
      `(${(r.audioSeconds / (r.transcribeMs / 1000)).toFixed(1)}x real time)  WER ${(r.wer * 100).toFixed(1)}%`);
  }
  fs.writeFileSync(path.join(OUT, 'captions-report.json'), JSON.stringify(report, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  return failed.length ? 1 : 0;
}

app.whenReady()
  .then(main)
  .catch((err) => { console.error(err); return 1; })
  .then((code) => {
    fs.rmSync(WORK, { recursive: true, force: true });
    app.exit(code);
  });
