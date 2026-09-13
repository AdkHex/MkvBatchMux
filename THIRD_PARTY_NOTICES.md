# Third-party notices

MKVBatchMux is proprietary software (see [LICENSE](LICENSE)). The installer
also ships, or downloads on request, the software listed here. Each remains
under its own license; nothing below is relicensed by being distributed with
MKVBatchMux.

## Bundled in the installer

### FFmpeg 8.1 (`ffmpeg.exe`, `ffprobe.exe`)

- Build: [BtbN FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), static
  `win64-lgpl` variant
- License: **GNU LGPL v2.1 or later**. The build is configured without
  `--enable-gpl` and without `--enable-nonfree`, so no GPL-only component is
  included. MKVBatchMux invokes the binaries as separate processes and does not
  link against them.
- Copyright: the FFmpeg developers, <https://ffmpeg.org>
- Source: <https://ffmpeg.org/download.html#get-sources>; the build scripts
  and exact configure flags are in the BtbN repository above, and are printed
  by `ffmpeg -version`.

### AudioSync analysis engine (`audiosync-cli.exe`)

- Built from [AudioSyncMaster](https://github.com/AdkHex/AudioSyncMaster) at
  the tag recorded in `package.json` (`audiosyncEngine.ref`) and stamped in the
  bundled `ENGINE_VERSION` file
- Author: Ionicboy (AdkHex)
- Frozen with [PyInstaller](https://pyinstaller.org), whose bootloader is GPL
  v2+ with an exception that lets it be bundled with a program of any license
- Contains the following runtime libraries:
  - [Python](https://www.python.org) 3.12 — PSF License
  - [NumPy](https://numpy.org) — BSD-3-Clause

## Downloaded from Settings on request

These are not in the installer. The app offers to fetch them from their
official sites the first time it finds them missing, and verifies each download
against a pinned SHA-256 before running it.

### MKVToolNix (`mkvmerge.exe`, `mkvpropedit.exe`)

- <https://mkvtoolnix.download>, © Moritz Bunkus
- License: GNU GPL v2

### MediaInfo CLI (`mediainfo.exe`)

- <https://mediaarea.net/en/MediaInfo>, © MediaArea.net SARL
- License: BSD-2-Clause

## Frontend and runtime libraries

The desktop shell is [Tauri](https://tauri.app) (MIT / Apache-2.0). The user
interface is built with React (MIT), Radix UI (MIT), shadcn/ui (MIT), Tailwind
CSS (MIT), Lucide (ISC), Zustand (MIT), TanStack Query (MIT), Zod (MIT) and the
other packages listed in `package.json`. Their licenses are MIT, ISC,
Apache-2.0, BSD-3-Clause, 0BSD and BlueOak-1.0.0 — all permissive. The Rust
backend depends on the crates listed in `src-tauri/Cargo.toml`; their licenses
are MIT and/or Apache-2.0 for the large majority, with a handful under
BSD-2/3-Clause, Unicode-3.0, Unlicense, CC0-1.0, BSL-1.0, Zlib and MPL-2.0
(the `cssparser`/`selectors` family used by Tauri's HTML processing). All are
permissive or weak-copyleft licenses that permit use in proprietary software.

The complete dependency trees with their license texts can be regenerated
from a checkout with `npx license-checker --production` and
`cargo license` (from the `cargo-license` crate) respectively.
