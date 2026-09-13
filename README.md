# MKVBatchMux

A desktop app for scanning MKV collections and batch muxing with a premium, focused workflow.

## Features
- Scan source folders and auto-load media metadata
- Batch mux using MKVToolNix
- Video, Audio, Subtitle, Chapter, and Attachment tabs with dedicated workflows
- External audio/subtitle injection with per-track overrides
- Multi-track extraction and inclusion from a single external file
- Track language, name, default flag, and per-track delay control
- Track reordering with drag handles in edit dialogs
- Per-stream language, name and delay when importing from another video
- Detailed change reports for queued jobs
- Queue management, validation, and progress tracking
- Advanced mux settings (chapters, attachments, tags, safety checks)
- Calm dark UI with a live dependency and update panel in Settings
- Tauri desktop app. Installers are published for **Windows x64**; macOS and
  Linux build from source but are not shipped or tested yet

## Install (Windows)

Download the latest `MKVBatchMux_<version>_x64-setup.exe` from
[Releases](https://github.com/AdkHex/MkvBatchMux/releases/latest) and run it.

The installer is not yet code-signed, so Windows SmartScreen shows
"Windows protected your PC" on first run. Click **More info → Run anyway**.
The download itself can be verified: every release lists the installer's
SHA-256 in its notes, and once installed the app only accepts updates signed
with the key in `src-tauri/tauri.conf.json`.

MKVToolNix and MediaInfo are not bundled; the app offers to download them from
their official sites the first time it finds them missing (Settings →
Dependencies). FFmpeg and the delay-measurement engine are bundled.

## Requirements (building from source)
- Node.js 20+
- Rust (stable toolchain)
- MKVToolNix (for `mkvmerge` / `mkvpropedit`)
- MediaInfo CLI (for `mediainfo`)

Installed builds need nothing else: the delay-measurement dependencies are
bundled into the installer (see below).

### Delay measurement

The **Measure delays** action measures each external audio track's offset
against the video it will be muxed into, and fills in the delay field for you.
It needs FFmpeg (`ffmpeg` and `ffprobe`) and the AudioSync analysis engine.

**Installed builds ship both**, so the feature works on a machine that has
never installed FFmpeg. CI fetches them before bundling and fails the build if
either is missing, so a release can never go out with the feature quietly
disabled.

In a development checkout neither is present by default. The app falls back to
whatever `ffmpeg`/`ffprobe` are on your PATH, and to running AudioSyncMaster's
`python/bridge.py` directly, so the feature is usable without a PyInstaller
build. To mirror a release build locally:

```bash
npm run fetch-ffmpeg                              # downloads a static build
FFMPEG_DIR=/path/to/bin npm run fetch-ffmpeg      # or copy from a local dir

npm run fetch-engine                              # uses ../AudioSyncMaster
AUDIOSYNC_REPO=/path/to/AudioSyncMaster npm run fetch-engine
AUDIOSYNC_ENGINE_DIR=/path/to/prebuilt npm run fetch-engine
```

These write into `src-tauri/resources/ffmpeg/` and `src-tauri/resources/engine/`.
Both are build artifacts and are not committed. The engine is built from
[AudioSyncMaster](https://github.com/AdkHex/AudioSyncMaster) rather than
vendored here so it does not diverge from the fixes made there.

#### The engine is pinned to an AudioSyncMaster release

`package.json` names the AudioSyncMaster release the engine is built from:

```json
"audiosyncEngine": { "repository": "AdkHex/AudioSyncMaster", "ref": "v2.8.0" }
```

CI checks that tag out, `fetch-engine` refuses a checkout that is at any
other commit or has uncommitted engine changes, and the built engine is
stamped with its version (`ENGINE_VERSION`), which Settings shows under
*Audio analysis engine*. Both apps report the same delay for the same files
only while they run the same engine code, and that pin is what makes it so:
building from AudioSyncMaster's `main` once shipped an unreleased engine
rewrite that flagged cuts and drift on files the released engine measured
cleanly, and the two apps disagreed by tens of milliseconds with nothing on
screen to say why.

To move to a newer engine, bump `audiosyncEngine.ref` to the new release tag
in a commit of its own. CI warns when AudioSyncMaster has a newer release
than the pin. To try an unreleased checkout locally, set
`AUDIOSYNC_ALLOW_UNPINNED=1`; the stamp then says so, and the app warns on
the Measure button that its results may differ from AudioSyncMaster's.

The measurement parameters are AudioSyncMaster's defaults (`ENGINE_DEFAULTS`
in `src/shared/types/audiosync.ts`), and the request is the one it sends.
Two things are deliberately different and both are bounded:

- The row shows the delay at the start of the file (`delayAtStartMs`), which
  is the value `--sync` applies and the value AudioSyncMaster's own *Fix*
  applies. AudioSyncMaster's headline is the mid-file value; the two only
  differ on a file flagged *Drift*, where its detail panel shows the same
  start value as *Applied from t=0*.
- The engine decodes with the FFmpeg it can find. This app bundles one;
  AudioSyncMaster uses the one on your PATH. Whether a build trims E-AC3 /
  AC-3 decoder priming inside a container is a property of the build, so on
  such a track the two apps can differ by a constant 5.3 ms (a quarter of a
  frame) if their FFmpeg builds differ. Raw `.ac3`/`.eac3` streams are
  corrected by the engine on every build.

A bundled FFmpeg takes precedence over one on your PATH: it is the version the
app was tested against.

### Windows installer
The Windows build produces an NSIS `.exe` installer. No extra toolchain is
needed; the bundler ships its own NSIS.

## Automatic updates

Installed builds check GitHub Releases shortly after launch and every six
hours, and offer any newer version as a toast with an Install action. Settings
also has a Check now button for an immediate check.

Pushing to `main` bumps the version, builds a signed installer, publishes it as
the latest release, and installed apps pick it up from there.

Nothing installs without being asked. A check is skipped entirely while a mux
batch is running, and each version is offered once per session — an install
restarts the app, and a batch can be many minutes from finishing.

### Repository secrets (required)

Updates are cryptographically signed and the app rejects unsigned ones, so CI
needs two secrets. Without them the build still succeeds and publishes an
installer for manual download, but no `latest.json` is generated and auto-update stays off
(the workflow logs a warning saying so).

| Secret | Value |
|---|---|
| `TAURI_PRIVATE_KEY` | Contents of the updater private key file |
| `TAURI_KEY_PASSWORD` | The key's password (empty string if none) |

**Keep the private key safe.** If it is lost, already-installed apps can no
longer be updated — every user would have to reinstall by hand. The matching
public key lives in `src-tauri/tauri.conf.json` under `tauri.updater.pubkey`.

To generate a fresh keypair (this invalidates existing installs):

```bash
npx tauri signer generate -w ~/.tauri/mkvbatchmux.key
```

## Installation & Usage

### 1) Install dependencies
```bash
npm ci
```

### 2) Run in development
```bash
npm run dev
```

### 3) Build the desktop app
```bash
npm run tauri:build
```

### 4) Build the Windows installer
```bash
npm run tauri:build -- --bundles nsis
```

The installer will be located under:
```
src-tauri/target/release/bundle/nsis/
```

## GitHub Actions

Every push to `main` runs **Build installers**: it bumps the minor version,
builds the Windows installer with the bundled FFmpeg and analysis engine,
signs the updater bundle, and publishes a GitHub release marked *latest*.
Installed apps pick that release up automatically, so **a push to `main` is a
public release**. The release notes are generated from the commit subjects
since the previous release, which is why they are written as behaviour
changes.

The same workflow can be run by hand from the Actions tab (**Run workflow**)
without pushing.

---

## Project Structure
```text
src/
  app/        App entry, routes, and global styles
  features/   Workspace, history, and session-specific code
  shared/     Reusable UI, shared components, utilities, types, and data
src-tauri/    Rust backend and Tauri configuration
docs/         Project documentation assets such as screenshots
scripts/      Project maintenance scripts
```

---

## License

MKVBatchMux is free software under the [GNU GPL v3](LICENSE).
Copyright (c) 2026 Ionicboy (AdkHex).

The installer bundles FFmpeg (GPL) and the AudioSync analysis engine, and can
download MKVToolNix (GPL) and MediaInfo (BSD) on request. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for each component's license
and where to get its source.

## Credits
- Ionicboy (AdkHex)

## Screenshots
![Videos](docs/screenshots/VideoTab.png)
![Audio Tracks](docs/screenshots/AudioTab.png)
![Subtitles](docs/screenshots/SubtitleTab.png)
![Mux Settings](docs/screenshots/MuxSettings.png)
