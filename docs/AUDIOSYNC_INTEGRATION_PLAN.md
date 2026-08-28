# Master prompt — Embed AudioSyncMaster's measurement engine into MkvBatchMux

> Hand this whole file to Claude Code, run from
> `/Users/santosh/Documents/MkvBatchMuxing/MkvBatchMux`.
> Read it end to end before writing any code. Every "MUST" here has a reason
> stated next to it; where a reason is given, do not substitute your own design.

---

## 0. What you are building, in one paragraph

MkvBatchMux muxes external audio into video files with MKVToolNix. It already
supports a per-track delay and already emits `--sync` from it, but the user has
to type that delay in by hand. AudioSyncMaster is a separate app whose Python
engine *measures* that delay by audio correlation. Your job is to embed that
engine into MkvBatchMux as a sidecar process, add a **Measure delays** action
that runs it over the audio files the user has loaded, and write the measured
values into the existing delay fields — so pressing **Mux** afterwards produces
a correctly synced file with no manual data entry.

**You are not changing how muxing works.** The `--sync` emission in
`src-tauri/src/main.rs` is correct and already tested. You are only filling in
the number it consumes.

---

## 1. The two codebases

| | MkvBatchMux (this repo) | AudioSyncMaster (source of the engine) |
|---|---|---|
| Path | `/Users/santosh/Documents/MkvBatchMuxing/MkvBatchMux` | `/Users/santosh/Documents/AudioSyncMaster` |
| Stack | Tauri **v1.5** + React 18 + TS + Tailwind + shadcn/ui | Tauri **v2.9** + React 18 + TS |
| Backend | `src-tauri/src/main.rs`, single 3396-line file | `src-tauri/src/{lib,bridge,csv}.rs` |
| External tools | `mkvmerge`, `mediainfo` (PATH, detected) | `ffmpeg`, `ffprobe` (PATH) |
| Engine | — | Python, `audiosync/*.py`, PyInstaller → `audiosync-cli` |

**The Tauri major-version gap is the single biggest source of wasted time in
this task.** `AudioSyncMaster/src-tauri/src/bridge.rs` is the reference
implementation for everything you need, but it is **Tauri v2 code and will not
compile in this repo**. Port it, do not copy it. Concretely:

| Tauri v2 (AudioSyncMaster) | Tauri v1.5 (here) |
|---|---|
| `use tauri::Emitter;` + `app.emit(name, payload)` | `app.emit_all(name, payload)` (`Manager` trait) |
| `app.path().resolve(.., BaseDirectory::Resource)` | `app.path_resolver().resolve_resource(..)` |
| `tauri::async_runtime::spawn_blocking` | same, available in v1 |
| `State<'_, T>` with `.manage()` | same |
| `invoke` from `@tauri-apps/api/core` | `@tauri-apps/api/tauri` |
| `listen` from `@tauri-apps/api/event` | same path |

Check `src/shared/lib/backend.ts` in this repo — it already imports from
`@tauri-apps/api/tauri`. Match that, not AudioSyncMaster's imports.

**Do not upgrade this repo to Tauri v2.** That is a large, unrelated migration
and is explicitly out of scope.

---

## 2. The three facts that will silently corrupt output if you get them wrong

Read these three times. Every one of them produces a *plausible-looking but
wrong* delay rather than an obvious crash.

### 2.1 Sign convention

The engine's internal `delayMs` means **"where the audio sits"** — negative
means the dub starts *before* the picture.

Every muxer, player and this app's UI use the **opposite** convention: **"the
delay you add to fix it."**

AudioSyncMaster converts at the display boundary via `playerDelayMs()` in
`src/lib/types.ts`, which is simply `-delayMs`. Its CSV export does the same
(`player_delay()` in `src-tauri/src/csv.rs`), and there is a Rust test named
`delays_are_exported_in_the_player_convention` locking it.

**mkvmerge's `--sync` uses the player convention.** Therefore:

```
value written into MkvBatchMux  =  -(engine delayMs)
```

The numbers the user sees in AudioSyncMaster's results table are already
negated. **Your target is that displayed number.** If you pipe the engine's raw
`delayMs` straight through, every single file will be out of sync by exactly
twice the true offset, and nothing will look wrong until playback.

Write a test for this. See §8.

### 2.2 Units — milliseconds vs seconds

- The engine speaks **milliseconds** (`delayMs`, `delayAtStartMs`).
- **MkvBatchMux's `ExternalFile.delay` is in SECONDS.** The UI field is
  labelled "sec" (`AudiosTab.tsx`, the input next to `<span>sec</span>`) and
  holds a 3-decimal string; `main.rs:2449` does `(delay * 1000.0) as i64` to
  get back to milliseconds for `--sync`.

The field's 3 decimals mean **1 ms is the finest value it can represent**.

**Conversion rule (user-specified), MUST be implemented exactly:**

```
1. Take the engine value in ms and negate it        (§2.1)
2. ROUND to the nearest whole millisecond           (Math.round)
3. Divide by 1000
4. Format with exactly 3 decimals
```

Worked examples the user gave, plus the rounding case:

| Engine `delayMs` | After negation | Rounded ms | Field value |
|---|---|---|---|
| `+87.7` | `-87.7` | `-88` | `-0.088` |
| `+87.2` | `-87.2` | `-87` | `-0.087` |
| `+1890.4` | `-1890.4` | `-1890` | `-1.890` |
| `-33.5` | `+33.5` | `+34` | `0.034` |
| `0` | `0` | `0` | `0.000` |

Use `Math.round`, **not** truncation and **not** `toFixed` on the millisecond
value. Note `Math.round(-87.5)` is `-87` in JavaScript (rounds toward +∞ on
ties); that half-millisecond asymmetry is irrelevant here and you should not
add code to "fix" it.

Put this conversion in **one exported function** and use it everywhere:

```ts
// src/features/workspace/lib/delayConversion.ts
/** Engine milliseconds → the seconds value MkvBatchMux stores and mkvmerge consumes.
 *  Negation is the engine→player sign flip; rounding is because the delay field
 *  holds whole milliseconds. See docs/AUDIOSYNC_INTEGRATION_PLAN.md §2.1-2.2. */
export function engineMsToDelaySeconds(engineDelayMs: number): number {
  return Math.round(-engineDelayMs) / 1000;
}
```

Never inline this arithmetic anywhere else.

### 2.3 Drifting files use a different source value

When a pair drifts, `delayMs` is the offset at the **midpoint** of the file,
but `--sync`'s offset applies from **t = 0**. The engine returns
`delayAtStartMs` for exactly this reason.

```
source value = result.delayAtStartMs ?? result.delayMs
```

Using `delayMs` on a drifting file over-shoots the correction. There is a
comment on the `delayAtStartMs` field in AudioSyncMaster's `src/lib/types.ts`
saying so. Always prefer `delayAtStartMs` when it is non-null.

---

## 3. Engine protocol — everything you need to drive it

`AudioSyncMaster/python/bridge.py` is a **long-lived process** speaking
newline-delimited JSON on stdin/stdout. One JSON object per line, both ways.

**On startup it emits** `{"type":"ready","ffmpeg":true|false}`. Wait for this
before sending anything, and treat `ffmpeg:false` as the "ffmpeg missing"
condition (§6).

### Commands you will send

**`analyze`** — the only one that matters for this feature. Send **explicit
pairs** so the engine never re-derives its own matching (§4):

```json
{
  "command": "analyze",
  "mode": "series",
  "pairs": [
    {
      "primaryPath":   "/abs/path/Episode 01.mkv",
      "secondaryPath": "/abs/path/Episode 01.HIN.aac",
      "key":           "any stable id you choose",
      "method":        "mkvbatchmux",
      "score":         1.0,
      "primaryTrack":   0,
      "secondaryTrack": 0
    }
  ],
  "windowSeconds": 45,
  "windowCount":   6,
  "maxOffsetMs":   60000,
  "maxWorkers":    3
}
```

- `primaryTrack` — index among the **video file's** audio streams (the
  reference). `0` = first audio stream.
- `secondaryTrack` — index among the **external audio file's** streams.
- The tuning values above are AudioSyncMaster's defaults (`DEFAULT_SETTINGS` in
  its `src/lib/types.ts`). Use them; do not invent your own.

When `pairs` is present, `bridge.py` uses it verbatim and skips all folder
matching. This is what makes §4 work.

**`listTracks`** — enumerate a file's audio streams, for the reference-track
picker (§5.3). Returns `TrackListing { path, name, tracks[], fps, duration }`
where each track is `{ index, codec, language, title, channels, sampleRate,
bitRate, isDefault, label }`.

**`cancel`** — handled inline, ahead of the queue, so it interrupts a run in
flight. **`shutdown`** — ends the process. **`ping`** → `{"type":"pong"}`.

### Events you will receive

- `{"type":"ready","ffmpeg":bool}` — once at startup
- `{"type":"pairs", ...}` — the pairing it will use; echo to the log
- `{"type":"log","message":...}`
- `{"type":"progress", ...}` — per-file progress during a batch
- `{"type":"result","result":{...}}` — one finished measurement
- `{"type":"error","message":...,"fatal":bool}`
- `{"type":"done","results":[...],"summary":{...},"cancelled":bool}`

Read `AudioSyncMaster/python/bridge.py` yourself to confirm the exact progress
event shape before relying on it — do not guess field names.

### The result object

Copy the `SyncResult` interface from `AudioSyncMaster/src/lib/types.ts`. The
fields you need:

| Field | Use |
|---|---|
| `delayMs` | measurement, midpoint (ms, engine sign) |
| `delayAtStartMs` | measurement at t=0 — **prefer this** (§2.3) |
| `confidence` | 0–1; `>=0.75` High, `>=0.5` Medium, else Low |
| `driftMsPerS`, `hasSignificantDrift` | drift warning |
| `isRateMismatch`, `rateDiagnosis` | frame-rate conversion; `rateDiagnosis.correctionRatio` drives linear stretch (§5.5) |
| `isLikelyCut` | different material — **never auto-fill** (§5.4) |
| `error` | measurement failed |
| `primaryFps` | needed to render the delay in frames |
| `elapsedMs` | not displayed (user opted out) |

---

## 4. Pairing — reuse the mux's own matching. Do not write a second matcher.

**User decision:** no movie/series mode switch. It must "just behave."

**Implement this as: measure exactly the pairing the mux is about to perform.**

MkvBatchMux already decides which external audio goes with which video, in
`src/features/workspace/lib/muxJobBuilder.ts` (`buildStrictVideoMatcher` →
`matchedVideoId` → episode number via `extractEpisodeNumber` → normalised-name
similarity). That resolved mapping is the ground truth for the mux.

Therefore: **derive measurement pairs from the same function.** Refactor
`buildStrictVideoMatcher` into a reusable export if needed, and build the
`pairs` array from `(resolved video path, external audio path)`.

Why this is strictly better than inferring a mode:
- It cannot disagree with the mux. A separate matcher could measure pair A and
  mux pair B — a silent, near-undebuggable wrong-delay bug.
- Movie case falls out free: one audio matched to one video is one pair. One
  audio bulk-applied to many videos yields one pair per video, each measured
  separately — which is correct, because a movie's dub can have a different
  offset per release.
- Zero new UI.

An external audio file that resolves to **no** video is not measurable. Surface
it in the existing unlinked-files UI; do not silently drop it.

---

## 5. Feature specification

### 5.1 Trigger

A **Measure delays** button in the Audios tab toolbar. **Manual only** — never
auto-run on file add. A 16-episode batch takes ~5 minutes (~20 s/file at
`maxWorkers: 3`); that must never start by surprise.

**Scope of one press:** every audio file that does not yet have a measured or
hand-entered delay. Skip anything already measured; skip anything the user
typed (§5.6). Re-measuring is an explicit separate action.

Also provide **per-row re-measure** in the row's action menu, which ignores the
skip rules for that one row.

While running: progress (`n of m`, current filename), a working **Cancel**
(sends `cancel`), and the rest of the app stays usable.

### 5.2 Writing results back

For each successful result, write to the matching `ExternalFile`:

```ts
delay = engineMsToDelaySeconds(result.delayAtStartMs ?? result.delayMs)
```

For **multi-track** external files, write per track into
`trackOverrides[trackId].delay` instead of the file-level `delay`. Note
`main.rs:2446` prefers `trackOverrides[tid].delay` over `audio.delay`, so
per-track values already win at mux time. One `analyze` pair per track, with
`secondaryTrack` set to that track's index.

Store the measurement metadata alongside — it drives the display in §5.3 and
must survive the value being reused:

```ts
// added to ExternalFile in src/shared/types/index.ts
measuredDelay?: {
  engineDelayMs: number;      // raw engine value, before negation
  appliedMs: number;          // the rounded ms actually written
  confidence: number | null;
  driftMsPerS: number | null;
  hasSignificantDrift: boolean;
  isRateMismatch: boolean;
  isLikelyCut: boolean;
  correctionRatio: number | null;
  referenceTrack: number;     // which video audio track it measured against
  primaryFps: number | null;
  measuredAt: string;         // ISO 8601 — a string, not a Date (JSON has no Date)
  error: string | null;
};
```

Per-track measurements need one of these per track; key it by track id
alongside `trackOverrides`.

### 5.3 What each row shows

All four are required by the user:

1. **Confidence** — `High · 99%` / `Medium · 61%` / `Low · 30%`, colour-coded.
   Bands from `confidenceLevel()` in AudioSyncMaster's `types.ts`: `>=0.75`
   High, `>=0.5` Medium, else Low.
2. **Frames** — `-1 frames`, `+2 frames`, from the applied ms and
   `result.primaryFps`. Port `frameOffset()`; it returns `null` under half a
   frame, and you render nothing in that case.
3. **Drift / frame-rate badge** — visible warning when `hasSignificantDrift` or
   `isRateMismatch`, with the `rateDiagnosis.explanation` in a tooltip. A
   `isLikelyCut` row gets a distinct, stronger warning (§5.4).
4. **Original milliseconds** — show `-87.7 ms` next to the `-0.088` field so
   the rounding is visible rather than silent. Use the **negated** value, i.e.
   what the user would read in AudioSyncMaster.

Do **not** add an elapsed-time column — the user explicitly did not want it.

**Reference track picker (§5.3b).** Auto-pick the video's default audio track,
falling back to its first. Always let the user change it: a dropdown per video
listing its audio tracks (populate with `listTracks`, or from the track data
`mediainfo`/`mkvmerge` already gives this app — prefer the existing data and
avoid a second probe if the labels are good enough), plus an "apply to all
videos" affordance for batches. Changing it enables re-measure for the affected
rows; it does not silently invalidate existing results.

### 5.4 Cut detection — never auto-fill

When `isLikelyCut` is true, the two files contain **different material**. No
single offset can align them.

- Do **not** write a delay.
- Show a prominent warning on the row explaining the pair looks like a
  different cut.
- Let the user apply the measured number anyway via an explicit confirm — their
  call, not yours, but it must be a deliberate act.

### 5.5 Frame-rate drift — linear stretch

When `isRateMismatch` is true and `rateDiagnosis.correctionRatio` is non-null, a
plain offset cannot fix the file. mkvmerge supports linear stretch:

```
--sync <tid>:<offset_ms>,<num>/<den>
```

Implement this as an **opt-in per row**, defaulting to off, clearly labelled as
a rate correction. Extend `ExternalFileInfo`/`TrackOverride` in `main.rs` with
an optional stretch ratio and emit the extended `--sync` form only when set.

Derive `num/den` from `correctionRatio`. Prefer exact integer ratios for the
common broadcast conversions rather than a float-derived approximation:

| Conversion | Ratio |
|---|---|
| 25 → 23.976 fps | `24000/25025` |
| 23.976 → 25 fps | `25025/24000` |
| 24 → 25 fps | `25/24` |
| 25 → 24 fps | `24/25` |

Match `rateDiagnosis.sourceFps`/`targetFps` against these with a small
tolerance; fall back to a rational approximation of `correctionRatio` only when
no known conversion matches.

**Keep the offset and the stretch separate and both correct** — the offset is
still `delayAtStartMs`, because the stretch is applied about t=0.

**This sub-feature is the most likely thing to be wrong.** If you cannot verify
it, ship it disabled behind a flag and say so, rather than shipping a plausible
guess. A wrong stretch ratio is worse than no stretch.

### 5.6 Manual edits always win

A hand-typed delay must never be overwritten by a measurement.

Track provenance per delay value: `'manual' | 'measured' | 'none'`. "Measure
delays" skips `manual`. Editing a delay by hand sets `manual` and clears the
measured metadata. A per-row explicit re-measure may override `manual` — but
only that explicit action.

### 5.7 Preset/session persistence

Follow whatever this repo already does for `ExternalFile` persistence. New
fields must be optional so existing saved sessions and presets still load.
Never let a missing `measuredDelay` throw on load.

---

## 6. Shipping the engine

**Primary platform: Windows.** Get Windows working first and correct; keep
macOS/Linux compiling and structurally supported (path/extension handling,
`.exe` suffix only on Windows). Do not hardcode Windows paths.

### 6.1 Where the binary comes from

**Decision: build it from the AudioSyncMaster repo, do not vendor a copy of the
Python source.** The engine is under active development in that repo and a
duplicated copy would silently diverge from the fixes that make it accurate.

Add `scripts/fetch-engine.mjs` (match the existing `scripts/` conventions) that:

1. Takes the AudioSyncMaster repo path (env var, e.g. `AUDIOSYNC_REPO`, with
   the sibling path as default) or a prebuilt artifact directory.
2. Runs the PyInstaller build using AudioSyncMaster's existing
   `audiosync-cli.spec`, or copies an already-built `audiosync-cli` tree.
3. Copies the result to `src-tauri/resources/engine/` in this repo.
4. Fails loudly with an actionable message if the source is missing. **It must
   never produce a silently engine-less build.**

Add `src-tauri/resources/engine/` to `.gitignore` — it is a 37 MB build
artifact, not source. Document the build step in `README.md` under Requirements.

Register the resource in `src-tauri/tauri.conf.json` under
`tauri.bundle.resources` (**v1 schema** — check the existing file's shape; it
differs from AudioSyncMaster's v2 `bundle.resources`).

### 6.2 Locating it at runtime

Resolve via `app.path_resolver().resolve_resource("resources/engine/audiosync-cli")`
(+`.exe` on Windows). In dev, fall back to running
`python AudioSyncMaster/python/bridge.py` so the feature is workable without a
PyInstaller build — mirror how `AudioSyncMaster/src-tauri/src/bridge.rs`
`build_command()` does exactly this. Read that function.

On Windows, spawn with `CREATE_NO_WINDOW` (`0x0800_0000`) or a console window
flashes on every run. `bridge.rs` shows the pattern; this repo already has a
`hidden_command` helper in `main.rs` — **reuse it** rather than adding a second
mechanism.

### 6.3 ffmpeg

The engine needs `ffmpeg` and `ffprobe` on PATH. **Detect, do not bundle.**

Mirror the existing `mkvmerge_available()` / `mediainfo_available()` pattern in
`main.rs` (a `OnceLock` + a `--version` probe) — add `ffmpeg_available()` in
exactly that style. The `ready` event's `ffmpeg` field is a second confirmation.

When missing: disable **Measure delays**, and explain in the same voice the app
already uses for a missing mkvmerge — say what to install and that it must be
on PATH. Never fail mid-batch with a raw engine error.

---

## 7. Process lifecycle

Port the design from `AudioSyncMaster/src-tauri/src/bridge.rs` — its header
comment explains why each choice exists. The essentials:

- **One long-lived process**, not one per run. Spawn lazily on first use.
- **Drain stdout on a dedicated thread from the moment it starts.** Writing a
  large request into a pipe whose reader is not draining will deadlock.
- **Drain stderr on its own thread too**, forwarding lines to the app log.
- **Cancel is a message, not a kill.** Killing the process orphans the ffmpeg
  children it spawned. `bridge.py` handles `cancel` ahead of its queue.
- Kill the child on app exit so nothing is left behind.
- If the process dies mid-run, surface a clear error and let the next run
  respawn it — do not wedge permanently.

Emit progress to the frontend with `app.emit_all` (**v1**), following the
existing `mux-progress` / `inspect-paths-stream-chunk` conventions in this repo:
snake_case Rust fields with `#[serde(rename_all = "camelCase")]` where the
existing events do, and a matching `listenX` helper in
`src/shared/lib/backend.ts`.

Suggested Tauri commands, named to match this repo's style:
`measure_delays_start`, `measure_delays_cancel`, `audiosync_engine_status`,
`list_reference_tracks`.

---

## 8. Tests — required, not optional

This repo uses **vitest** (`npm test`) and has `cargo test` on the Rust side.
Both apps already test exactly the class of bug this feature risks; match that
standard.

**TypeScript — `src/features/workspace/lib/delayConversion.test.ts`:**

1. **Sign flip.** An engine `delayMs` of `+100` produces a **negative** field
   value. Assert the sign explicitly with a comment explaining §2.1. This is
   the single most valuable test in the feature.
2. **The user's worked examples**, verbatim: `87.7 → -0.088`,
   `1890.4 → -1.890`, `-33.5 → 0.034`, `0 → 0.000`.
3. **`delayAtStartMs` wins over `delayMs`** when both are present (§2.3).
4. **Round-trip through the muxer's own arithmetic**: the value written,
   multiplied by 1000 and cast to i64 as `main.rs:2449` does, equals the
   expected `--sync` milliseconds. This is what actually proves the whole chain.
5. Cut results produce no delay; low-confidence results do not auto-fill.
6. A manual delay survives a measurement pass unchanged.

**Rust — in `main.rs`'s test module:**

7. `--sync` argument generation for a plain offset (guard the existing
   behaviour against regression).
8. `--sync` with linear stretch emits `tid:offset,num/den` in the right shape,
   only when a ratio is set.

**Also confirm** `npm run lint`, `npm test`, and `cargo build` all pass before
reporting done.

---

## 9. Order of work

Do these in order. Each step should leave the app building and usable.

1. **Read first, write nothing.** `AudioSyncMaster/python/bridge.py`,
   `AudioSyncMaster/src-tauri/src/bridge.rs`, `AudioSyncMaster/src/lib/types.ts`;
   in this repo `main.rs` around lines 120–240 (structs) and 2380–2560 (mux args),
   `muxJobBuilder.ts`, `AudiosTab.tsx`'s delay handling, `backend.ts`.
2. **`delayConversion.ts` + its tests.** Pure functions, no I/O. Get the sign
   and units provably right before anything can depend on them.
3. **Engine plumbing in Rust.** Spawn, protocol, events, cancel, ffmpeg
   detection. Verify with a `ping` → `pong` round-trip before going further.
4. **`scripts/fetch-engine.mjs`** + `tauri.conf.json` resource + `.gitignore`
   + README note.
5. **Pair derivation** from `muxJobBuilder`'s matcher (§4).
6. **Measure delays** button, progress, cancel, write-back, provenance.
7. **Row display**: confidence, frames, drift badge, original ms.
8. **Reference-track picker.**
9. **Multi-track per-track measurement** into `trackOverrides`.
10. **Cut / low-confidence handling.**
11. **Linear stretch** (§5.5) — last, and behind a flag if unverified.
12. Full test + lint + build pass.

---

## 10. Hard constraints

- **Do not change the existing mux command generation** except to *add* the
  optional linear-stretch form. The `--sync` path is correct and tested.
- **Do not upgrade this repo to Tauri v2.**
- **Do not copy `bridge.rs` verbatim** — it is v2 code. Port it.
- **Do not vendor AudioSyncMaster's Python source** into this repo.
- **Do not auto-run measurement** on file add.
- **Do not overwrite a hand-typed delay** outside an explicit per-row re-measure.
- **Do not invent tuning defaults** — use AudioSyncMaster's
  (`windowSeconds: 45`, `windowCount: 6`, `maxOffsetMs: 60000`, `maxWorkers: 3`).
- **Do not add an elapsed-time column.**
- **Do not write the raw engine `delayMs` into the delay field.** Negate it.
- Match this repo's existing code style: shadcn/ui components, the
  `src/features/workspace` layout, `backend.ts` for every `invoke`, and the
  comment density already present in `muxJobBuilder.ts` and `matchUtils.ts` —
  comments explain *why*, not *what*.

---

## 11. Report honestly when done

State plainly: what works, what was verified how, what was left out and why.
If §5.5 (linear stretch) is unverified, say so — do not describe it as working.
If any test fails, show the output. A working feature with two stated gaps is
far more useful than a complete-sounding report that hides one.
