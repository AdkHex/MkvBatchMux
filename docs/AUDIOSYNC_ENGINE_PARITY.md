# Why MkvBatchMux and AudioSyncMaster reported different delays, and what keeps them equal now

Written 2026-09-13 after the two apps disagreed on the same four Snatch (2000)
releases against the same Hindi dub. AudioSyncMaster reported −4177.9 / −25282.9 /
+20.2 / −4182.5 ms, all *High* with no flags. MkvBatchMux reported −4240.3
(*Different cut*) / −131474.7 (*Low 31 %, Implausible, Drift*) / −10.0 /
−4245.8 (*Different cut*).

## The short version

**They were not running the same engine.**

- AudioSyncMaster's installed app is its latest release, **v2.8.0** (commit
  `8e53e8b`, 2026-08-27).
- MkvBatchMux's CI checked out `AdkHex/AudioSyncMaster` at **`main`**, not at a
  release. MkvBatchMux v1.57.0 was built at 17:48 UTC on 2026-09-10, thirteen
  minutes after commit `f38ace9` ("Updated", +1747 lines) landed on
  AudioSyncMaster's main. That commit and `441eed6` before it are **unreleased**
  — AudioSyncMaster's own CI refuses to publish while `package.json` still says
  2.8.0 — so no AudioSyncMaster user has ever run them. MkvBatchMux shipped them.

Everything else in the measurement path — the request the app sends, the
windows, the correlation, the sign, the parameters — was already identical.
That was verified, not assumed:

- The same request to `python/bridge.py` produces **byte-identical** results
  from both apps' request shapes (14/14 fixture pairs), on the same engine.
- AudioSyncMaster's Movies-tab request (`mode: "movie"`, `pairs: null`, which
  pairs through `pair_movie_mode`) and MkvBatchMux's explicit-`pairs` request
  produce byte-identical results (4/4).
- The same request produces **different** results from engine v2.8.0 and
  engine `f38ace9`: the unreleased engine reports `isLikelyCut` on two fixtures
  the release calls clean, and its `delayAtStartMs` differs from `delayMs` on
  every file.

## What the unreleased engine does that produces the false flags

All references are to AudioSyncMaster at `f38ace9`. None of this exists in v2.8.0.

**"Different cut" on files 1 and 4 (−4240 vs −4178, −4246 vs −4183).**
`segments.find_step` (new) compares a one-line fit of the six window offsets
against a two-level split and accepts the split when it leaves at most half the
residual and the levels differ by `max(20 ms, 5 × noise)`. Its noise scale is
the *median* gap between neighbouring windows, so a single first or last window
21 ms or more off the others — well inside the 50 ms tolerance the outlier trim
uses — always proposes a "cut" with that window alone on one side
(`lone_group`). `_localize_cut` then spends up to six 15 s probe decodes trying
to corroborate it; two probes that happen to read the two levels confirm it.
When the lone window is the first one (5 s in — the logo/silence window
`plan_windows` itself calls the least trustworthy), the confirmed cut makes
**that window the "pre-cut level"**, and `delay_ms` becomes the outlier. v2.8.0
simply trims it: median of six, `|offset − median| ≤ max(50, 4·MAD)`, done.

**−131474.7 ms, Low 31 %, Drift on file 2 (v2.8.0: −25282.9, High 92 %).**
Three new mechanisms compound:

1. `plan_speed_compensation` decides from the two *durations* alone that the
   dub runs at a different speed (any ratio within 0.5 % of a standard
   conversion, e.g. a dub with 25 s of extra intro and a few minutes of extra
   credits lands in the PAL band) and decodes it time-stretched. A same-speed
   pair decoded at the wrong speed correlates weakly (peak ratio ≈ 15 instead
   of 34: confidence 0.62 instead of 0.92) or not at all.
2. `_search_speed` retries other speeds when fewer than three windows match —
   but its candidate list never contains 1.0, so a pair that was never
   rate-converted can never get back to being measured as it is.
3. Each window's offset is then "un-compensated" with
   `((p + a/1000)/s − p)·1000`, which adds `p·(1/s − 1)·1000` ms — up to
   ±250 s at the end of a 1:42 h film — and the always-fitted least-squares
   intercept (`441eed6`) extrapolates whatever two weak windows produced back
   to t = 0. Two windows at −10 571 and +109 837 ms give slope +99 ms/s
   (*Drift*, and `is_likely_cut` because it is above 45 ms/s), intercept
   **−131 474.7 ms**, and the >500 ms disagreement halves 0.62 to **0.31**.
   Every one of those numbers reproduces from the code.

**The ~62 ms shift on the clean files, and −10.0 vs +20.2 on file 3.**
Commit `441eed6` makes `delay_at_start_ms` the least-squares intercept even when
the slope is below the 0.05 ms/s reporting threshold. The intercept is
`ȳ − slope·x̄`, and on a 1:42 h film the windows' mean position x̄ is ≈ 3037 s,
so a slope of 0.02 ms/s — flagged as *no drift* by both apps — moves it by
61 ms. MkvBatchMux shows and applies `delayAtStartMs`; AudioSyncMaster's
headline is `delayMs` (the median), which does not move. One window 40 ms off
(kept by the trim) moves the intercept by up to 21 ms and the median by 0.
Under v2.8.0 the two fields are equal unless drift is significant, so this
disagreement did not exist before the unreleased commit.

## What now keeps them equal

1. **The engine is pinned to a release.** `package.json` names it:
   `"audiosyncEngine": { "repository": "AdkHex/AudioSyncMaster", "ref": "v2.8.0" }`.
   CI checks that tag out. `scripts/fetch-engine.mjs` refuses a checkout that
   is at any other commit or has uncommitted engine changes (override for local
   experiments: `AUDIOSYNC_ALLOW_UNPINNED=1`, which is written into the stamp).
   The PyInstaller flags are now AudioSyncMaster's own, verbatim.
2. **The build is stamped and checked.** `fetch-engine` writes
   `resources/engine/ENGINE_VERSION` (`AudioSyncMaster v2.8.0 (8e53e8b)`) and
   pings the built binary; CI asserts the stamp is the pinned release and
   measures a 500 ms fixture with the bundled engine before building the
   installer.
3. **The app says which engine it has.** Settings → *Audio analysis engine*
   shows the stamp; the Measure button's tooltip warns when the engine found —
   bundled or a development checkout — is not the pinned release. The pin is
   compiled in from `package.json` by `build.rs`.
4. **CI warns when the pin lags** AudioSyncMaster's latest release, so moving
   both apps forward is a deliberate one-line commit, never a silent side
   effect of the next push.

Verified end to end on this machine: the frozen, pinned engine that
`fetch-engine` now builds, fed MkvBatchMux's request, matches AudioSyncMaster
v2.8.0 fed its own request **byte for byte** on all 14 fixture pairs.

## Divergences that remain, on purpose

| What | MkvBatchMux | AudioSyncMaster | Why it stays |
|---|---|---|---|
| Headline field | `delayAtStartMs` (t = 0) | `delayMs` (mid-file) | MkvBatchMux's number is what `--sync` puts in the file, and it is the same field AudioSyncMaster's own *Fix* applies. With the v2.8.0 engine the two fields are equal unless the file is flagged *Drift*, where AudioSyncMaster's detail panel shows this value as *Applied from t=0*. |
| Rounding | whole ms (the delay field holds three decimals of a second) | 0.1 ms shown, µs applied | mkvmerge takes integer ms. |
| Gates on applying | withholds *Different cut*, `|delay| > 10 s`, confidence < 0.5 | disables only *Different cut* | Muxing is irreversible in place; a withheld value is still shown and can be applied deliberately. |
| Reference track | explicit choice → same-language video track → video's default | stream 0 unless chosen | Same-language material correlates far more sharply; with an original-language dub against an original-language video it is stream 0 anyway. |
| FFmpeg | bundled 7.1 | whatever is on PATH | Whether E-AC3/AC-3 decoder priming inside a container is trimmed is a property of the ffmpeg build, so two builds can differ by a constant 5.3 ms (¼ frame) on such a track. Raw `.eac3`/`.ac3` is corrected by the engine on every build. AudioSyncMaster would have to bundle the same ffmpeg for this to close. |
| `maxWorkers` | 4 | 3 | Thread-pool size; each pair is analysed independently. |

## For AudioSyncMaster, before `f38ace9` is released

Not changed here — it is the reference implementation and the work is in its
own repository — but these are what MkvBatchMux would inherit on the next pin
bump:

- `_search_speed` should include speed 1.0 among its candidates, so a pair the
  durations mis-predicted can return to being measured as it is.
- `find_step` should not propose a cut on the strength of a single first or
  last window inside the outlier-trim tolerance, and a confirmed cut whose
  pre-cut side is one window should not make that window the headline.
- The always-fitted intercept gives the 5 s window (leverage 0.52) more say
  over the reported delay than any other; a robust intercept, or the median
  when the slope is below threshold, would keep the headline where v2.8.0 has it.
