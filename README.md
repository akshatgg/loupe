# Loupe

**A Mac screen recorder that zooms in while you record** — for demo and tutorial videos where the viewer has to see the detail.

Website: **https://loupeapp.vercel.app**

## Install

macOS 14 Sonoma or later, Apple Silicon or Intel.

**Homebrew** (recommended — installs and opens with no warning dialog):

```sh
brew install --cask akshatgg/tap/loupe
```

**Or download a DMG** from the [latest release](https://github.com/akshatgg/loupe/releases/latest):
[Apple Silicon](https://github.com/akshatgg/loupe/releases/latest/download/Loupe-arm64.dmg) ·
[Intel](https://github.com/akshatgg/loupe/releases/latest/download/Loupe-x64.dmg).
The app isn't notarized yet, so a downloaded copy has to be approved once in
System Settings → Privacy & Security → **Open Anyway**.

On first launch Loupe asks for **Screen Recording** (required) and
**Accessibility** (for the zoom gesture). Recordings are saved to `~/Movies/Loupe`.

## What it does

- **Record** the entire screen, one window, or part of one (drag a rectangle — e.g. a browser window without its toolbar).
- **Zoom while recording:** hold a zoom key (⌥ by default; pick ⌃ ⌘ or ⇧ instead) or a mouse side button and scroll — up to zoom in, back to zoom out, up to 4×. The view follows your cursor smoothly.
- **See what's in shot:** while zoomed, a frame on your screen shows exactly what the video will show, and its zoom level. It is never recorded, and neither is the control bar.
- **Edit:** jump to, remove, undo or restore zooms; speed up or slow down any stretch (0.25×–8×, voices keep a natural pitch); show or hide the cursor.
- **Export** MP4 at 1080p, 1440p or 4K, 60 fps.
- Everything stays on your Mac — no account, no upload.

## Develop

```sh
npm install
npm run build:native   # Swift helpers → bin/ (universal: arm64 + x86_64)
npm start
npm test               # lint + tests
```

The Electron app (`src/main`, `src/renderer`) drives four Swift helpers in
`src/native`: `sources` (list displays/windows), `capture` (ScreenCaptureKit),
`inputtap` (zoom gesture, clicks, cursor) and `render` (export). `docs/` has the
product and technical design.

## Release

Cutting a release builds both DMGs, publishes a GitHub Release, and updates
the Homebrew cask ([`.github/workflows/release.yml`](.github/workflows/release.yml)):

```sh
npm run release:patch   # or release:minor / release:major
```

or Actions → **Release** → Run workflow with a version. The website (`web/`)
deploys to Vercel on every push to `master`; its download buttons always
point at the newest release, so it needs nothing per release.

Optional repository secrets: `HOMEBREW_TAP_TOKEN` (lets the workflow push the
cask to [akshatgg/homebrew-tap](https://github.com/akshatgg/homebrew-tap)
itself) and the Developer ID / notarization secrets listed in
[`electron-builder.config.js`](electron-builder.config.js).

## License

MIT
