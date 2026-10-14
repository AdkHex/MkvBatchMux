# Remote status, access password and per-user install

Every installed copy of MKVBatchMux reads a small JSON document from a secret GitHub Gist. With it the
developer can:

1. **Stop every copy** ("Work is in progress"): all work stops, a full-window screen shows, and
   everything the lock stopped carries on by itself when the document says `ok` again.
2. **Require an access password**: each user on each computer enters it once; after that it is
   remembered permanently for that OS user. Changing the password asks everyone again.
3. Lock out old builds with **"Update required"** (`minVersion`).

On Windows the installer installs MKVBatchMux **for the user who runs it only** (see the last section).

## Operating it

Needs the GitHub CLI `gh`, logged in as the gist owner (`AdkHex`). Every command starts from the
published document and changes only its own fields: `maintenance` and `ok` keep the password,
`password` keeps the status.

| Goal | Command |
|---|---|
| Stop every copy | `node scripts/mkvbatchmux-status.mjs maintenance "Updating, back soon"` |
| … with a title / faster checks | `node scripts/mkvbatchmux-status.mjs maintenance "msg" --title "Scheduled maintenance" --check-minutes 2` |
| Release them | `node scripts/mkvbatchmux-status.mjs ok` |
| Require a password | `node scripts/mkvbatchmux-status.mjs password` (asked twice, hidden) |
| Change the password (everyone enters the new one) | `node scripts/mkvbatchmux-status.mjs password` |
| No password | `node scripts/mkvbatchmux-status.mjs password --off` |
| Force an update | `node scripts/mkvbatchmux-status.mjs ok --min-version 1.80.0 --update-url https://github.com/AdkHex/MkvBatchMux/releases/latest` |
| See the current state | `node scripts/mkvbatchmux-status.mjs status` |

- `ok` drops the maintenance text and any `--min-version` / `--update-url` not given again.
- Raise the app version before using `--min-version`, or the new build locks itself out.
- Changes reach every copy within `checkMinutes` (default 5) plus up to 5 minutes of GitHub caching.
  **Check again** on the screen fetches at once.
- The password is never printed, stored or sent anywhere: the document gets a salted PBKDF2-SHA256
  hash (600 000 rounds). The hash is readable by anyone with the gist link, so use a long passphrase
  (at least 8 characters are required; a few words is better).

## The document

```json
{
  "status": "ok",
  "title": "Work is in progress",
  "message": "We're updating MKVBatchMux. Back in a few minutes.",
  "minVersion": "1.80.0",
  "updateUrl": "https://github.com/AdkHex/MkvBatchMux/releases/latest",
  "checkMinutes": 5,
  "access": {
    "alg": "pbkdf2-sha256",
    "iterations": 600000,
    "salt": "<base64, 16 random bytes>",
    "hash": "<base64, 32 bytes>",
    "id": "<first 16 hex chars of sha256(salt || hash)>"
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `status` | yes | `"ok"` or `"maintenance"` (case-insensitive) |
| `title` | no | Screen title. Default "Work is in progress". Max 200 characters. |
| `message` | no | Text under the title. Max 2000 characters. |
| `minVersion` | no | Builds older than this (numeric: `1.0.9 < 1.0.10`) show "Update required", even with `ok`. |
| `updateUrl` | no | http(s) link for "Download the new version" on that screen |
| `checkMinutes` | no | How often the apps poll, 1..60. Default 5. |
| `access` | no | Present = password required. Absent = no password. |

Unknown fields are ignored and invalid optional fields are dropped. A document that is not JSON, has
no valid `status`, is larger than 64 KB, or has an `access` block that does not check out (wrong
`alg`, fewer than 100 000 or more than 10 000 000 rounds, bad base64, a hash that is not 32 bytes, an
`id` that does not match) counts as **no information**: the app keeps its last known state. Garbage
never locks a copy, and never switches the password off.

## Where it is hosted

A secret GitHub Gist on `AdkHex`:

- gist id `0f0138ee791d85dc99e42d875600faa5`, file `mkvbatchmux-status.json`
- raw URL, baked into the app at compile time:
  `https://gist.githubusercontent.com/AdkHex/0f0138ee791d85dc99e42d875600faa5/raw/mkvbatchmux-status.json`

`src-tauri/remote-status.json` holds `{"url": "…", "requireAccess": true}` and is read with
`include_str!`, so an installed copy cannot be pointed elsewhere. An empty `url` turns the whole
feature off in that build, and a build without a URL also forgets any saved lock. Never delete or
rename the gist: copies that cannot reach it keep their last known state forever.

A secret gist is unlisted, not private: anyone with the link can read it. That is why it only holds
a status and a salted hash.

## What happens while locked

| Area | Behaviour |
|---|---|
| Muxing | Every running mkvmerge is ended at once; its job goes back to the queue (shown as Queued) and starts again from the beginning when the lock lifts. A temp file over the sources is deleted, and so is a destination file the cut-off run created; one it overwrote is replaced when the job runs again. No new job starts. A running mkvpropedit (an in-place edit of the source) is left to finish its few seconds. |
| Delay measuring and timeline scans | The analysis engine is ended. The run keeps the pairs it had not finished and measures them when the lock lifts, under the same run, so the Audio page simply carries on. |
| Refused in the Rust core | Choose folder / scans, file inspection, Validate, Start and Resume muxing, measuring, timeline scans, reference tracks, installing MKVToolNix/MediaInfo, opening the log. The error is `MKVBatchMux is paused: work is in progress` (maintenance, update) or `MKVBatchMux is locked` (password, first run). |
| Still allowed | Reading settings and app paths, Pause/Stop, cancelling, and the built-in updater (an update is the way out of "Update required"). |
| Window | A full-window screen that cannot be dismissed covers the app; the window underneath is inert, its shortcuts, menu commands and file drops do nothing. The window comes to the front when a lock starts. On Windows the screen keeps minimize, maximize and close. |

Stopped work is remembered in memory: quitting the app while locked loses the queue, as quitting
always does.

## The access password

- An unlock stores only the password's `id` in the OS credential store: **Windows Credential
  Manager** / **macOS Keychain**, service `com.ionicboy.mkvbatchmuxingtool`, account `access`. The
  store is per OS user, so every account on a shared PC (an RDP server) is asked separately, and each
  is asked only once: the unlock survives restarts, updates and offline periods.
- The check runs in Rust (PBKDF2-HMAC-SHA256, constant-time compare). After 5 wrong passwords in a
  row the screen makes you wait 30 seconds.
- A new password (`password` again) has a new salt and so a new id: everyone is asked again, also
  while the app is running. `password --off` removes the block: nobody is asked.
- **First run**: the build has `requireAccess: true`. A copy that has never fetched the document
  (fresh install, offline) shows "Connect to the internet once" with **Try again** instead of
  opening. After one good fetch the normal rules apply (a document without `access` opens the app).
- Maintenance wins over the password screen when both apply.
- To forget an unlock on one machine (testing): Windows `cmdkey /delete:access.com.ionicboy.mkvbatchmuxingtool`
  (or Credential Manager › Windows Credentials), macOS Keychain Access › search
  `com.ionicboy.mkvbatchmuxingtool`.

## Testing locally (never against the real gist)

Debug builds read two environment variables; **release builds ignore both**:

| Variable | Meaning |
|---|---|
| `MKVBATCHMUX_STATUS_URL` | Status URL instead of the baked one. `https://`, or `http://` for 127.0.0.1 / localhost only. |
| `MKVBATCHMUX_STATUS_POLL_SECS` | Poll interval in seconds instead of `checkMinutes` |

```sh
# terminal 1: a local document and a server for it (re-read on every request)
node scripts/mkvbatchmux-status.mjs ok --no-publish --out /tmp/mbm/status.json
node scripts/mkvbatchmux-status.mjs serve --serve 8817 --out /tmp/mbm/status.json

# terminal 2: the debug app against it
MKVBATCHMUX_STATUS_URL=http://127.0.0.1:8817/status.json MKVBATCHMUX_STATUS_POLL_SECS=2 npm run tauri dev

# terminal 3: flip it -- always with --no-publish
node scripts/mkvbatchmux-status.mjs maintenance "Testing the lock" --no-publish --out /tmp/mbm/status.json
node scripts/mkvbatchmux-status.mjs ok --no-publish --out /tmp/mbm/status.json
node scripts/mkvbatchmux-status.mjs password --no-publish --out /tmp/mbm/status.json
node scripts/mkvbatchmux-status.mjs password --off --no-publish --out /tmp/mbm/status.json
```

Without `--no-publish` (or `--serve`) a command publishes to the real gist. The debug app shares its
data folder and credential entry with an installed MKVBatchMux on the same account: finish a test with
`ok` and `password --off`, delete `remote-status.json` from the app data folder, and remove the
`access` credential (above).

Automated tests: `cargo test remote_status` (parsing, versions, URL rules, the PBKDF2 vectors the
CLI produces, throttling, and the lock against a local HTTP server: maintenance and back, stickiness
across restarts and outages, garbage and HTTP errors, the password flow, a changed password,
maintenance over the password, the offline first run) and `npx vitest run scripts/mkvbatchmux-status.test.mjs src/app/ServiceLock.test.tsx`.

## Offline behaviour: sticky and fail-open

- Every good fetch is saved to `remote-status.json` in the app data folder
  (`%APPDATA%\com.ionicboy.mkvbatchmuxingtool`, `~/Library/Application Support/com.ionicboy.mkvbatchmuxingtool`).
  It is applied at start before anything can run, so a lock survives restarts and offline periods
  until a good `ok` arrives.
- A failed fetch (no network, DNS, timeout, HTTP error, redirect to http) changes nothing. The
  reason shows on the screen without the URL.
- `minVersion` is compared with the running build, so installing a newer build lifts "Update
  required" at once, even offline.

## Per-user Windows install

The installer is NSIS only (`bundle.targets: ["nsis", "updater"]`, no MSI) with
`installMode: "currentUser"`:

- installs to `%LOCALAPPDATA%\MKVBatchMux`, with the Start menu entry, desktop shortcut and
  uninstall entry (HKCU) of the installing user only; no administrator rights, no UAC prompt;
- the in-app updater runs the same installer (`latest.json` points at the NSIS `.nsis.zip`), so
  updates stay per user too;
- when the installer has to end a running MKVBatchMux it only ends the installing user's copy
  (`src-tauri/nsis/installer.nsi`), never other people's sessions on the same server.

### Moving off an old all-users install (RDP server)

Releases before this one installed per machine, into `C:\Program Files\MKVBatchMux`, for every account.
A per-user installer has no rights to remove that copy, so:

1. Install (or update to) this release as the user who should have MKVBatchMux. It lands in that
   user's `%LOCALAPPDATA%\MKVBatchMux`. The first start shows once: "An all-users copy is still
   installed", with its folder.
2. An administrator uninstalls the old copy: **Settings › Apps › MKVBatchMux** (the entry installed
   for all users; publisher Ionicboy (AdkHex)), or run `C:\Program Files\MKVBatchMux\uninstall.exe`.
   Leave "Delete the application data" unticked to keep everyone's settings.
3. Other accounts then have no MKVBatchMux. Anyone who should have it runs the installer under their
   own account (and enters the access password once).

Until step 2, other accounts can still start the old copy, and its updater would install a per-user
copy for them; the access password still keeps them out.

## Limits

- Changes take up to `checkMinutes` + 5 minutes (GitHub cache); **Check again** is immediate.
- A copy that never reaches GitHub keeps its last known state; one that never reached it at all
  runs only if the build has no `requireAccess`.
- Someone with administrator rights and enough effort can get past any client-side check (edit the
  saved state, block the host). This keeps other accounts and honest users out; it is not DRM.
- macOS builds that are not signed with a stable Developer ID may show a one-time macOS Keychain
  "allow" prompt after an update, because the Keychain trusts the exact app that saved the unlock.

## Code map

| Piece | Where |
|---|---|
| Document, lock reasons, saved state, fetch, password check, credential store | `src-tauri/src/remote_status.rs` |
| Baked URL, debug overrides, poll thread, stop/resume effects, commands `service_lock`, `check_service_status`, `unlock_access` | `src-tauri/src/service.rs`, `src-tauri/remote-status.json` |
| Mux hold and requeue, command guards | `src-tauri/src/main.rs` (`wait_for_child_or_stop`, `end_interrupted_job`, `hold_job`, `run_mux_queue`) |
| Engine interrupt, paused runs, resume | `src-tauri/src/audiosync.rs` (`EngineHandle::interrupt`, `park`, `resume_paused`) |
| Old all-users copy notice | `src-tauri/src/all_users_copy.rs`, `src/app/AllUsersCopyNotice.tsx` |
| Lock screen | `src/app/ServiceLock.tsx` (mounted in `src/app/App.tsx`), styles at the end of `src/ui/ui.css` |
| Developer tool | `scripts/mkvbatchmux-status.mjs` |
| Per-user installer | `src-tauri/tauri.conf.json` (`installMode`), `src-tauri/nsis/installer.nsi`, release check in `.github/workflows/release.yml` |
