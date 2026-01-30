# MKV Batch Muxing Tool

A desktop app for scanning MKV collections and batch muxing with a clean UI.

## Features
- Scan folders and load media metadata
- Batch mux with MKVToolNix
- Track selection and language handling
- Tauri desktop app (Windows/macOS/Linux)

## Requirements
- Node.js 20+
- Rust (stable toolchain)
- MKVToolNix (for `mkvmerge` / `mkvpropedit`)
- MediaInfo CLI (for `mediainfo`)

### Windows extras (MSI installer)
- WiX Toolset (required to build `.msi`)

## Install dependencies
```bash
npm ci
```

## Run in development
```bash
npm run dev
```

## Build the app (desktop)
```bash
npm run tauri:build
```

### Build an MSI installer (Windows)
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

Made with Love by Ionicboy
