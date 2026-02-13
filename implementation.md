# MKV Batch Muxing Tool — Definitive Performance Implementation Plan

## Objective
Deliver **native-feeling responsiveness** across scanning, loading, tab interaction, and queue operations in the existing Tauri + React architecture, without changing mux business logic.

This replaces all previous plans.

---

## 1) Non-Negotiable Targets

## Interaction targets
- Button visual feedback: `< 16ms`
- Tab switch visual response: `< 50ms`
- No UI freeze during scan/mux progress updates

## Scan targets
- First files visible after scan start: `< 100ms` (typical local SSD)
- 100 files fully enriched: `< 500ms` target
- 1000 files fully enriched: `< 2s` target (disk/probe dependent)

## Render targets
- 1000-row lists: stable `60fps` scroll
- No large jank spikes during streamed updates

---

## 2) Architecture Constraints

1. Keep frontend React (no framework rewrite now).
2. Keep heavy I/O and metadata probing in Rust.
3. Frontend does batched, progressive rendering only.
4. Preserve all existing feature behavior (imports, queue, mux flow).

---

## 3) Current State (Already in Place)

1. Two-phase video scan exists:
- quick file list
- streamed metadata enrichment

2. Backend optimizations already added:
- parallel file processing (`rayon`)
- tool availability caching (`OnceLock`)
- in-memory metadata cache keying by file metadata

3. Video list virtualization exists for large sets.

---

## 4) Implementation Phases

## Phase A — Stabilize Core Scan Pipeline (Priority: Critical)

### A1. Stream reliability and correctness
- Ensure `inspect_paths_stream` emits deterministic chunk order and completion semantics.
- Add explicit stream done/error events per scan id.
- Guarantee cancel safety: ignored late chunks must never overwrite newer scans.

### A2. Frontend merge correctness
- Use immutable map-by-path merge for metadata patches.
- Batch state commits on `requestAnimationFrame` only.
- Throttle progress text updates to avoid render pressure.

### A3. Failure visibility
- Every early return path (import/scan actions) must show explicit reason toast.
- No silent no-op actions.

Deliverables:
- stable streamed scan behavior
- no race regressions
- no silent failures

---

## Phase B — Virtualization Everywhere (Priority: Critical)

Apply virtualization + memoized rows to:
- Audio files panel
- Subtitle files panel
- Chapter files panel
- Attachment files panel
- Any long queue/details list in mux settings

Rules:
1. Fixed row height model.
2. Overscan 5–10 rows.
3. Stable keys.
4. Memoized row components with minimal props.
5. No expensive formatting in render loop.

Deliverables:
- all heavy lists virtualized
- consistent 60fps scrolling in large datasets

---

## Phase C — State Update Optimization (Priority: High)

### C1. Update batching
- Remove all per-item `setState` loops.
- Use chunk reducers and single commits per frame.

### C2. Selector hygiene
- Ensure components subscribe to smallest needed state slices.
- Memoize derived collections (`useMemo`) and handlers (`useCallback`).

### C3. Event pressure control
- Coalesce rapid backend events into frame-aligned UI flushes.

Deliverables:
- fewer re-renders
- smoother scan and queue updates

---

## Phase D — Startup and Bundle Performance (Priority: High)

### D1. Lazy loading
- Lazy-load non-initial tabs/dialogs.
- Keep initial route payload minimal.

### D2. Intent preloading
- Preload likely-next tabs on sidebar hover/focus.

### D3. Startup work deferral
- Defer non-critical setup until after first interactive paint.

Deliverables:
- faster first paint
- reduced initial JS work

---

## Phase E — Persistent Metadata Cache (Priority: Medium)

### E1. Add L2 disk cache
- Use lightweight persistent store (SQLite or sled) in app data dir.
- Key: `path + mtime + size + type + include_tracks`.

### E2. Cache lifecycle
- TTL/versioning strategy.
- Manual clear-cache command.
- Capacity pruning.

### E3. Background warmup
- Optional warmup of last-used folders only.
- Low priority, cancellable.

Deliverables:
- significantly faster repeat scans

---

## Phase F — UI Interaction Polish for “Instant Feel” (Priority: Medium)

1. Enforce CSS-only instant active states for buttons/toggles.
2. Keep transitions short (`50–120ms`).
3. Animate only `transform` and `opacity`.
4. Remove layout-thrashing animation patterns.

Deliverables:
- immediate visual response everywhere

---

## 5) Mux Status & Import Reliability Hardening

## Status model
- Keep `stopped` as separate status from `completed/error`.
- Prevent late backend progress from overriding stopped jobs.

## Import flows (Audio/Subtitle)
- Import must always:
  - validate source/selection/target
  - apply deterministic mapping
  - show success/failure feedback
- Support multi-track selection correctly for same target video.

---

## 6) Instrumentation & Perf Gates

## Metrics to capture
1. Scan start → first file visible
2. Scan total duration
3. Metadata chunks/sec
4. Main-thread long tasks during scan
5. Scroll FPS for large lists
6. Tab switch interaction latency

## Enforcement
- Add dev-only perf logging hooks.
- Maintain baseline JSON snapshot.
- Reject regressions beyond threshold in CI/perf check.

---

## 7) Validation Matrix

Run all phases against:
1. 100 local files (single folder)
2. 1000 files (nested folders)
3. Mixed formats with many non-video files
4. Re-scan same folder (cache hit path)
5. Scan cancel + immediate rescan
6. Import audio/subtitle multi-track + mux execution
7. Stop mux mid-run and verify status consistency

---

## 8) Execution Order

1. Phase A
2. Phase B
3. Phase C
4. Phase D
5. Phase E
6. Phase F
7. Validation + perf gate finalization

---

## 9) Done Criteria

Plan is complete only when:
1. All target interactions feel instant on normal hardware.
2. Large-folder scans stay responsive with progressive visibility.
3. No regressions in mux/import behavior.
4. Performance metrics show measurable gains vs baseline.
5. Builds and runtime checks pass cleanly.

