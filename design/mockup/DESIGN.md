# MKVBatchMux redesign — mockup

A clickable prototype of every page, every state, the menus, History, Output
and each Preferences tab. It is the spec for `src/`: the app matches these
screens.

It follows AudioSyncMaster's approved workstation design (its
`design/mockup/`, commit 472db8e) so the two apps read as one family. These were
rejected there, so they are not used here:

- cards, gradients, chips and helper text everywhere (read as AI-made);
- a left sidebar (reads as SaaS);
- a web-style tab strip (reads as a website).

## Open it

- `npm run dev`, then <http://localhost:8080/design/mockup/>
- One file, no server: `node design/mockup/export.mjs` →
  `design/mockup/dist/MKVBatchMux-mockup.html`
- The left list is the mockup's own screen picker, not part of the app. It has
  these controls:
  - *All screens* shows every screen side by side.
  - Dark/Light, Windows/macOS and 1180×780/900×600 switch live.
  - `←` `→` step through screens, `G` shows all screens, `T` switches the theme.

## The frame

```
┌ ■ File Edit View Tools Help         Audio — MKVBatchMux            – □ × ┐  title bar + menu bar
│ 📂 Choose folder ⤓ ⟳ ⧉ 🗑    [ ⚠ 44 measured · 2 different cuts   ]  ⟳ [Apply 44] │  toolbar + status display
│ ♫ Audio 1 · Hindi   ♫ Audio 2 · English   + New track          ⧉  🗑          │  track strip (Audio, Subtitles)
│ ┌ Audio 1  D:\Dubs\Goblin ── ext ▾ filter ▾ ↑ ↓ 🔍 ┐ ┌ Audio 1 ───────────┐   │
│ │ #  Video            Audio file       Delay Status │ │ language, delay…  │   │  workspace
│ │ 1  Goblin.S01E01…   Goblin.S01E01…  +1.312 ✓      │ ├ selected file ────┤   │
│ └───────────────────────────────────────────────────┘ └ result, actions  ┘   │
│ ┌ Output | History ──────────────────────────────────────────── tools ┐        │  bottom dock (when open)
│ MKVToolNix 88.0 · FFmpeg 7.1  ▣ Videos Subtitles Audio Chapters Attachments Mux  ⟲ ▤ ⚙ │  page bar
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Title bar**
  - On Windows it holds the menu bar (File, Edit, View, Tools, Help), the title
    in the middle, and caption buttons drawn by the app (decorations off).
  - On macOS the menus live in the system menu bar. The window keeps its
    traffic lights over an overlay title bar.
- **Status display** (the LCD) is the one place that always says what the app
  is doing:
  - ready: "48 videos · 312 GB";
  - running: "Muxing 4 of 12", with a progress line and the time left;
  - done: "12 muxed" or "11 muxed · 1 failed";
  - warning: "3 audio files have no video".
- **Page bar** runs along the bottom, like Resolve's pages.
  - Pages: Videos · Subtitles · Audio · Chapters · Attachments · Mux, on
    Ctrl+1–6, in the order the old sidebar had them.
  - A page that holds the engine shows a small spinner.
  - A page with files that cannot be muxed shows a small warning mark.
  - On the right sit History, Output and Preferences.
  - On the left, the tool versions, or an update when one is ready.
- **Track strip** (Audio and Subtitles only) sits under the toolbar and lists
  the track slots: Audio 1 · Hindi, Audio 2 · English. It replaces the old
  "Audio #1" dropdown, the way editors show tool modes.
- **Workspace** is docked panels on a darker base.
  - The list on the left is one row per pair: row *n* is video *n* and file
    *n*, which is exactly how the mux pairs them.
  - The inspector on the right has the track slot's settings on top and the
    selection below.
  - The bottom dock holds Output (the engine log) and History (finished runs).
    Mux adds a Report tab for the selected job.
- **Preferences** is its own window with icon tabs:
  - General;
  - Presets (folders, file types, languages);
  - Measurement;
  - Tools (MKVToolNix, FFmpeg, the engine);
  - Updates.

## Pages

| Page | Toolbar | Status display | List | Inspector | Next action (accent) |
|---|---|---|---|---|---|
| Videos | Choose folder, Rescan, Remove, Edit tracks, Media info | files, size; reading media info N of M | Name, Tracks, FPS, Duration, Size, Status | the video's tracks and added files; totals when nothing is selected | Add to queue |
| Subtitles | Choose folder, Import from a video, Rescan, Duplicate, Remove | files, linked; unlinked warning | #, Video, Subtitle, Language, Delay | slot settings (language, delay, name, order, default, forced) + selection | Add to queue |
| Audio | Choose folder, Import from a video, Rescan, Duplicate, Remove | measuring N of M; measured summary | #, Video, Audio file, Delay, Status | slot settings (language, delay, name, order, default) + measurement of the selection | Measure delays → Apply N delays |
| Chapters | Choose folder, Rescan, Move to top/bottom | files, linked | #, Chapter file, Video (pick to link), Delay | Chapters on/off, delay for all, discard old + selection | Add to queue |
| Attachments | Add files, Choose folder, Rescan, Remove | files, size | #, Name, Type, Size | Attachments on/off, discard old, allow duplicates, expert mode + selection | Add to queue |
| Mux | Add to queue, Validate, Remove, Clear, Report, Open log file | queue, validating, muxing N of M, paused, done, stopped | #, Name, Status, Before, After, Time left | output folder, naming, cleanup, track rules, safety, performance | Start muxing (Pause/Resume and Stop while running) |

## Menus

| Menu | Items |
|---|---|
| File | Choose folder… (Ctrl+O), Add files… (Attachments), Import from a video…, Open log file, Preferences… (Ctrl+,), Exit |
| Edit | Select all (Ctrl+A), Remove (Del), Clear the list, Move up (Alt+↑), Move down (Alt+↓), New track (Ctrl+N), Duplicate track |
| View | the six pages (Ctrl+1–6), Output (Ctrl+`), History (Ctrl+H) |
| Tools | Measure delays, Apply measured delays, Modify tracks… (Ctrl+M), Media info (Ctrl+I), Add to queue, Validate, Start muxing (Ctrl+Enter), Tools and dependencies… |
| Help | Keyboard shortcuts (?), Check for updates…, Release notes, About MKVBatchMux |

## Rules

- **One accent**, used for the next action, the selection and progress.
  Green, amber and red appear only as status icons and status words.
- **No cards, gradients, badges or helper text.** Panels, dividers and spacing
  carry the structure. A setting gets one short description line only where
  the old UI needed a warning to be safe (overwrite source, timeline scan).
- **One status vocabulary:** Ready, Waiting, a progress bar, Done, a warning
  word, Failed.
- **File names keep their end.** The middle is ellipsized, so the episode and
  the extension stay visible.
- **Metrics:**
  - Windows 11 metrics and Fluent System Icons;
  - 13 px text, 32 px controls, 32 px rows;
  - dark and light themes;
  - no shadows except on flyouts and windows.

## Differences from AudioSyncMaster's mockup

- Rows are 32 px, not 36. Batches here are whole seasons, and the brief asks
  for 32.
- There is a track strip for track slots, where AudioSyncMaster has a tool
  strip.
- The inspector can stack two panels: the slot's settings, then the selection.
- Dialogs larger than a ContentDialog (Edit tracks, Modify tracks, Media info)
  use `.dialog.wide`: 760 px wide, the body scrolls, and the buttons sit on the
  right.

## Where the app differs from this mockup

The app in `src/` was compared with these screens at 1180×780 and 900×600, in
dark and light. It matches them, except for these deliberate differences:

- **Default window size.** The window stays 1600×1000, with a minimum of
  900×600. The mockup is drawn at 1180×780 only to check the tightest size a
  laptop gives.
- **macOS traffic lights.** Tauri 1 cannot move them, so the menu bar starts
  after their default position.
- **Update progress.** The bar is indeterminate, because Tauri 1's updater
  reports no download progress.
- **Track rules.** They offer every language, not only eng, hin and jpn.
- **Mux toolbar.** It has Remove and Clear but no Open log: six commands
  overflow at 1180. Open log is in File and on the Output dock.
- **Paired columns.** They truncate from the head (`…S01E05.Hindi.eac3`), so
  the episode stays visible when the column is narrow.
- **Shortcuts.** Ctrl+O chooses a folder, as in every other app; Options moved
  to Ctrl+, (it was Ctrl+O). The old sidebar toggle Ctrl+B is gone, since
  there is no sidebar. Cmd works for all of them on macOS.
- **Escape.** Escape closes only the innermost thing: a language list, then a
  name being edited, then the top dialog. With no dialog open, it stops the
  running engine.
