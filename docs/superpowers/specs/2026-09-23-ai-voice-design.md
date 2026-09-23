# AI Voice — Design

**Goal:** someone types a sentence in the editor and gets a spoken line laid over their
video, without an account, an API key, or anything leaving the machine.

**Shape of the change:** a generated line is a *voiceover take whose audio came from a
model instead of a microphone*. Everything downstream of that — placement in source
time, mixing, ducking, dragging, export, undo — already exists and is reused unchanged.

**Source documents:** [`docs/PRD.md`](../../PRD.md), [`docs/TRD.md`](../../TRD.md),
[`docs/EDITOR-V2.md`](../../EDITOR-V2.md) §3 (project shape), §7 (audio).

---

## 1. Why this stack

Three ways to turn text into speech were weighed: a local model, the voices already
installed on the operating system, and a cloud API.

A cloud API is the highest quality and the only one that can clone a voice, but it
breaks the promise the README leads with — *everything stays on your computer, no
account, no upload* — and adds a key to manage and a per-character bill. The system
voices need no download at all and Windows 11's natural voices are genuinely good, but
macOS's are noticeably synthetic and the available list differs from machine to machine,
so two people following the same tutorial get different results.

**Kokoro-82M ONNX** is the choice. It is Apache-2.0, 86 MB in its `q8f16` build, sounds
close to commercial voices, and is identical on macOS and Windows. Loupe already ships
the two things needed to run it: a vendored transformers.js with the ONNX runtime
(`src/vendor/transformers/`), and a proven one-time model download that pins a revision,
verifies every file against its hash, and then works offline (`src/main/speech-models.js`,
built for captions). The 86 MB is *smaller* than the 209 MB captions already downloads.

### The phonemizer, and why it is not espeak

Kokoro takes IPA phonemes, not letters, so it needs a grapheme-to-phoneme step. The
usual one — espeak-ng compiled to WebAssembly, which is what `kokoro-js` and Piper's web
builds use — is **GPL-3.0**. Bundling it into a distributed MIT application would extend
copyleft over the whole app. Rejected on those grounds, not on technical ones.

Instead: **`phonemize`** (https://github.com/hans00/phonemize) — MIT, pure JavaScript, no
native code, a 125,000-word dictionary with rule-based fallback for unknown words, IPA
output, and written with Kokoro in mind. Vendored like transformers.js so the app keeps
zero runtime npm dependencies and loads nothing from a CDN.

| Piece | Licence | Where it lives |
|---|---|---|
| Kokoro-82M ONNX `q8f16` (86 MB) | Apache-2.0 | downloaded once into userData |
| `phonemize` | MIT | vendored, `src/vendor/phonemize/` |
| transformers.js + ONNX runtime | Apache-2.0 / MIT | already vendored |

**Known cost of this choice:** a dictionary-and-rules phonemizer has no part-of-speech
tagging, so homographs are sometimes wrong — "I *read* the docs" versus "please *read*
this", "a *live* demo" versus "I *live* here" — and unusual names come out approximate.
This is the weakest link in the feature, and it is a limitation of the phonemizer, not
the model. Per-word pronunciation overrides are the obvious follow-up (§8).

---

## 2. What someone does

The **Voiceover** row of the Audio panel gains a second button beside "Record voiceover":

```
 Voiceover
  [● Record]  [✨ AI voice]
```

**First use.** "AI voice needs a one-time 86 MB download." Progress, cancellable,
resumable — the same treatment and the same machinery captions already uses for its
model. Afterwards the feature is fully offline.

**The panel.**

```
  ┌─ AI voice ────────────────┐
  │ ┌───────────────────────┐ │
  │ │ Hold the zoom key and │ │
  │ │ scroll to magnify.    │ │
  │ └───────────────────────┘ │
  │ Voice  [ Heart  ▾ ] [▶]   │
  │ Speed  ──────●──── 1.0x   │
  │ ☐ Also add as a caption   │
  │        [ Generate ]       │
  └───────────────────────────┘
```

A text box, a voice picker with a preview button, a speed slider, a caption checkbox
(off by default), and Generate.

**After Generate.** A few seconds, then a clip appears on the Sound track at the
playhead, labelled with the first few words of its text and marked so it reads as
generated rather than recorded. Its duration is shown.

**Afterwards it is an ordinary take.** Drag it, move it to the playhead, jump to it,
change its volume, delete it. Music ducks under it. It mixes into the export. Selecting
it reopens the panel with its text intact; editing and pressing Regenerate replaces the
clip in place. Every one of those is a project edit, so all of it is undoable and saved.

**On length.** A line is as long as its words take. If it runs past the moment it
describes it keeps playing and overlaps — exactly what a recorded take does today. The
duration readout, the speed slider and editing the text are the tools for making it fit.
Stretching the video to match narration is explicitly not in this version (§8).

---

## 3. Data model

One optional field on the existing entry:

```js
audio.voiceover: [{ id, file, source, t, volume,
                    tts?: { text, voice, speed } }]   // new, optional
```

`tts` present means generated; absent means recorded from a microphone. That is the only
difference between the two.

`validateAudio()` in `core/project.js` validates the fields it knows and passes the rest
through, so `tts` survives a save and load today — but it gets validated all the same
(text length, a known voice id, speed in range), because `project.json` is a file on
disk that anything can write to.

Because generated lines live in the array that already exists, **source-time anchoring,
placement, mixing, ducking, dragging, export and undo work with no new code** — that
logic is written and tested in `core/audio/voiceover.js`, `mix.js`, `duck.js` and
`project-audio.js`. A separate track would have meant reimplementing all of it.

Captions get the mirror of it. When the checkbox is on, a caption segment is created at
the clip's source anchor spanning its duration, carrying:

```js
captions.segments: [{ id, source, start, end, text,
                      from?: <voiceover id> }]        // new, optional
```

`from` is what lets an edit to the line update its caption and a deleted clip take its
caption with it. A segment whose text is edited by hand keeps `from` but is not
overwritten on regenerate — the same rule `words` already follows in
`core/captions/model.js`, where a hand edit invalidates derived data.

Both fields are optional and ignored by older readers, so a project written by this
version still opens in the previous one, minus the extras.

---

## 4. Where the code goes

| Path | Responsibility |
|---|---|
| `src/vendor/phonemize/` | the MIT phonemizer, vendored with sha256 in a README, as `src/vendor/transformers/` does |
| `src/main/model-download.js` | **extracted** from `speech-models.js`: fetch a pinned, hash-verified model set with progress, cancel and resume |
| `src/main/speech-models.js` | refactored onto it — no behaviour change, tests unchanged |
| `src/main/voice-model.js` | the Kokoro catalogue and its voice list, using the same machinery |
| `src/main/ipc/voice.js` | `voice:model-*` channels, mirroring `ipc/captions.js` |
| `src/main/ipc/voiceover.js` | accept RIFF/WAVE in `containerExtension()`, which today sniffs only webm/ogg/m4a, and name generated files `AI voice N.wav` |
| `src/core/audio/wav.js` | gains `writeWav()` — it only parses WAV today |
| `src/core/audio/tts.js` | pure: validate text, build the entry, name the clip, link and unlink the caption |
| `src/renderer/editor/tts-worker.js` | phonemize → tokenize → ONNX → Float32, mirroring `src/renderer/captions/worker.js` |
| `src/renderer/editor/panels/audio.js` | the panel UI |

Extracting the downloader is the only existing code *restructured*; everything else is
added, including `writeWav()` alongside the `parseWav()` already in `wav.js`.
`speech-models.js` is 11 KB of download-and-verify logic that a second model would
otherwise be copy-pasted from; one model catalogue per file, one downloader shared.

**Division of labour** follows captions exactly: generation runs in a renderer worker,
main owns the disk. The renderer is sandboxed and cannot write files; a model is hundreds
of megabytes and must stream to disk rather than through memory; and keeping the URL list
in main means no page can make the app fetch anything unlisted.

---

## 5. The path a sentence takes

```
playhead + text + voice + speed
  → worker: phonemize (in-process, MIT) → tokenize → Kokoro ONNX → Float32 PCM
  → core/audio/wav.js writeWav()                       (new; parseWav() exists)
  → IPC voiceover:save → file in the project folder    (needs the RIFF case)
  → createVoiceover() + tts field → project edit
  → preview (audio-preview.js) and export (project-audio.js) pick it up unchanged
```

Only the generation and the WAV writing are new. Everything after the save is already
there and was checked against the code: `audioFileUrls()` serves any file inside the
project's `voiceover/` folder regardless of extension, and both the preview
(`audio-preview.js`) and the export (`exporter/audio.js decodeAudioFile`) decode through
`decodeAudioData`, which reads WAV. Only `containerExtension()` in `ipc/voiceover.js`
stands in the way, and only because it sniffs for three containers and WAV is not one
of them.

---

## 6. When it goes wrong

| Situation | Behaviour |
|---|---|
| Model not downloaded | the download step, before the panel is usable |
| Download interrupted or fails | retry, resuming verified files — as captions does |
| Empty text | Generate disabled |
| Text too long for one line | capped per line, with a nudge to split it into two |
| Worker crash, or out of memory | a plain message, **and the panel keeps the text** so nothing typed is lost |
| Disk full while saving | the existing `voiceover:save` error path |
| Model files corrupted on disk | hash check fails on load, offer to re-download |
| Mispronounced name or homograph | known limitation, documented; §8 |

---

## 7. Testing

Unit tests under `node --test` — no Electron, no download, nothing fetched in CI:

- entry creation, text validation, clip naming (`core/audio/tts.js`)
- caption linking, editing and deletion, including the hand-edited-segment rule
- WAV encode/decode round-trip through `core/audio/wav.js`
- a golden phoneme test over a fixed word list, so a phonemizer update cannot silently
  change how everything sounds
- integrity of the model catalogue: every file has a size and a hash, and the advertised
  total matches

End-to-end alongside `test/e2e/audio.e2e.js`: drive the panel with a faked worker, assert
that a clip lands at the playhead with the right anchor, that regenerate replaces it in
place, and that the caption checkbox produces exactly one linked segment. CI never
downloads 86 MB.

---

## 8. Not in this version

- **Languages other than English.** Kokoro has seven more, but they need a different
  phonemizer (Japanese and Chinese need a model of their own).
- **Voice cloning.** Needs a cloud service, and the privacy line is the point.
- **Per-word pronunciation overrides.** The most likely follow-up, given §1.
- **Fitting the video to the narration** — stretching or holding a shot to match a line.
- **Generating a script from the video.** A different feature wearing this one's clothes.
