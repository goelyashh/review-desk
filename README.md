# Review Desk

A local, Frame.io-style video review app (Electron). Nothing is uploaded anywhere.

- App: `F:\Tools\review-desk\dist\Review Desk\Review Desk.exe` (Desktop and Start-menu shortcut "Review Desk")
- Library (default, changeable in the app): `F:\Editing\Review Library`
- Settings, recents, log: `F:\Tools\review-desk\userdata`

## Library layout

```
Review Library\
  _review-index.md                 every project, version, open-note count and notes path
  <Project>\                       one folder per project
    cut_v1.mp4                     every video file = one version (newest date modified = LATEST)
    cut_v2.mp4
    _review\cut_v2.mp4\
      notes.md                     <- hand this path to an agent
      notes.json                   same data, machine-readable (normalised 0-1 shape coords)
      frames\f000123_<id>.png      the exact frame with the drawing composited
      proxy.mp4                    preview copy for ProRes/DNx/10-bit files (same frames and fps)
```

Rendering straight into a project folder works: the app watches the library and shows new files (marked "writing…" while a render is still being written).

## For agents

Read `notes.md`. Frames are 0-based. Timecode is HH:MM:SS:FF. Box, arrow and brush coordinates are in source-video pixels from the top-left. Each remark lists its snapshot PNG. When a remark is fixed, the reviewer ticks it as resolved in the app; agents should not edit `notes.json` while the app has that version open.

## Keys

Space play/pause · ←/→ one frame · Shift+←/→ ten frames · Home/End · J back 1 s · K pause · L play / faster · S cycle speed (1, 1.5, 2, 2.5, 3, 0.5x) · [ ] previous/next remark · B brush · R box · A arrow · V/Esc pointer · C type a remark · Ctrl+Enter save · Ctrl+Q/W/E bring back your last/2nd-last/3rd-last remark at the current frame · Ctrl+Z undo drawing · M mute · F5 reload · F12 devtools

## Develop

`npm start` from this folder runs the source. `electron . --selftest <video>` seeks known frames, screenshots them, saves a remark and builds a proxy (results in `selftest-result.json` next to the video); `test\clip.mp4` has the frame number burned in.
Packaging: `@electron/packager` and Electron's own installer fail to extract zips on Node 26 here, so the app was packaged by hand: copy `node_modules\electron\dist` to `dist\Review Desk`, rename `electron.exe`, put `src` + `package.json` in `resources\app`.
