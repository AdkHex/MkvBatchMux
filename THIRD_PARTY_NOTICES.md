# Third-party notices

MKVBatchMux is licensed under the GNU General Public License v3.0 (see
[LICENSE](LICENSE)). The installer also ships, or downloads on request, the
software listed here. Each remains under its own license; nothing below is
relicensed by being distributed with MKVBatchMux.

## Bundled in the installer

### FFmpeg 7.1 (`ffmpeg.exe`, `ffprobe.exe`)

- Build: [gyan.dev "essentials" build](https://www.gyan.dev/ffmpeg/builds/),
  fetched from <https://github.com/GyanD/codexffmpeg/releases/tag/7.1>
- License: **GNU GPL v3** (the build enables GPL components such as libx264
  and libx265, so the whole binary is GPL)
- Copyright: the FFmpeg developers, <https://ffmpeg.org>
- Source: <https://ffmpeg.org/download.html#get-sources> (FFmpeg 7.1). The
  exact configure flags for the shipped build are printed by `ffmpeg -version`
  and listed on the gyan.dev builds page. On request, the maintainer of
  MKVBatchMux will provide the corresponding complete source for the shipped
  binaries, as required by GPL §6; open an issue at
  <https://github.com/AdkHex/MkvBatchMux/issues>.

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
(the `cssparser`/`selectors` family used by Tauri's HTML processing). No
dependency is under a license incompatible with GPL-3.0.

The complete dependency trees with their license texts can be regenerated
from a checkout with `npx license-checker --production` and
`cargo license` (from the `cargo-license` crate) respectively.
