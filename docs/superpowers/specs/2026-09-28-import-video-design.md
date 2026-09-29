# Import a video, and cut it by typed times

## What people get

- **Library:** an "Import video" button beside "New recording", and dropping
  a video file anywhere on the window. The video becomes a new Library item
  and opens in the editor.
- **Editor, "Add a recording":** "Choose a video file…" imports a file the
  same way and plays it after the current video (one undo step).
- **Editor, "Cut" (timeline toolbar):** From / To fields that take `1:30`,
  `90`, `1:30.5` or `0:01:30`, then **Remove this part** or **Keep only this
  part**. Times are the timeline's own (output) times. One undo step.

Every existing edit (trim, split, delete, zoom, speed, captions, music,
export...) works on an imported video as on a recording.

## Accepted files

`.mp4`, `.mov`, `.m4v` whose video is H.264, HEVC, VP9 or AV1 (the codecs
the exporter can decode; it reads only MP4/QuickTime). Anything else is
refused in plain words ("Loupe can open MP4 and MOV videos." / "This video
is in a format Loupe can't read (such as ProRes). Export it as an H.264 or
HEVC MP4 and import that."). AAC sound is used; a video whose sound is in
another format is imported silent, and the person is told.

## How it works

`src/main/video-probe.js` `probeVideo(file)`: walks the file's top-level
boxes with `fs` (the index only, never the media data, as the exporter's
`openRecording` does), parses them with the vendored mp4box and returns
`{ duration, width, height, fps, rotation, codec, sound: 'aac'|'other'|null }`.
`rotation` (0/90/180/270 clockwise) comes from the video track's matrix;
width/height are the upright picture's.

`src/main/import-video.js` `importedProject(probe, { title, createdAt })`:
the project.json for it, built with the core's `createProject`:
`sources.main = { kind: 'file', video: 'video.<ext>', cursor: null,
mic: sound === 'aac', rotation, ... }`, a plain look (no background,
padding, corners or shadow, so the export is the video itself), mic
clean-up and levelling off (they would damage music), export fps from the
video (≤ 60) and the smallest resolution preset not below the video's.

`library.importVideo(path, { onProgress })` (ipc/library.js): copies the
file into a hidden `.copying-…` folder (the same one Duplicate uses, so an
abandoned import is swept the same way) -- a copy-on-write clone when the
disk allows, else a streamed copy reporting progress -- writes project.json,
then renames the folder into the Library. Title = the file's name.

IPC: `library:importVideo(path)` / `library:chooseVideo()` (Library window;
progress on `library:importProgress`; the editor opens unless a recording or
export is in progress) and editor `project:importVideo()` (dialog, import,
then the same path as `project:appendRecording`).

Picture: the preview's `<video>` shows a rotated video upright on its own;
the exporter's decoder does not, so `video-source.js` turns frames upright
with the source's `rotation`. Everything after sees upright frames.

No cursor: a zoom that follows the cursor holds the middle of the picture
(`solveCamera` falls back to the centre, not the top-left corner).

## Tests

- Unit: `probeVideo` on fixtures (`test/fixtures/videos`: H.264+AAC,
  silent .mov, rotated, Opus sound, ProRes, not a video); `importedProject`;
  `library.importVideo` (copy then rename, title, failure leaves nothing
  behind); `parseTime` + keep/remove ranges; camera centre fallback.
- e2e: import the fixture, keep a range with the Cut box, export, check the
  export's length and that a rotated video exports upright.
