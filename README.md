# MKV Batch Muxing Tool

A desktop app for scanning MKV collections and batch muxing with a premium, focused workflow.

## Features
- Scan source folders and auto-load media metadata
- Batch mux using MKVToolNix
- Video, Audio, Subtitle, Chapter, and Attachment tabs with dedicated workflows
- External audio/subtitle injection with per-track overrides
- Multi-track extraction and inclusion from a single external file
- Track language, name, default/forced flags, and per-track delay control
- Track reordering with drag handles in edit dialogs
- Bulk apply external files with selectable track subsets
- Detailed change reports for queued jobs
- Queue management, validation, and progress tracking
- Advanced mux settings (chapters, attachments, tags, safety checks)
- Polished dark cinematic UI (Cinematic Graphite + Soft Gold)
- Tauri desktop app (Windows/macOS/Linux)

## Requirements
- Node.js 20+
- Rust (stable toolchain)
- MKVToolNix (for `mkvmerge` / `mkvpropedit`)
- MediaInfo CLI (for `mediainfo`)

### Windows extras (MSI installer)
- WiX Toolset (required to build `.msi`)

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

### 4) Build a Windows MSI installer
```bash
npm run tauri:build -- --bundles msi
```

The MSI will be located under:
```
src-tauri/target/release/bundle/msi/
```

## GitHub Actions (manual build)
This repo ships a manual workflow for building installers. It does not run on every push.

1) Go to the Actions tab  
2) Select **Build installers**  
3) Click **Run workflow**

Artifacts will be attached to the workflow run.

---

## Credits
- Ionicboy (AdkHexx)
