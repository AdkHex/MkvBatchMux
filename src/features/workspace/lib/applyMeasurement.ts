/** Turning an engine result into an updated ExternalFile.
 *
 *  Kept separate from the UI so the rules that decide whether a delay is
 *  written at all -- cut detection, manual provenance -- are testable without
 *  rendering anything. See docs/AUDIOSYNC_INTEGRATION_PLAN.md §5.2, §5.4, §5.6.
 */

import type { ExternalFile, MeasuredDelay } from "@/shared/types";
import type { SyncResult } from "@/shared/types/audiosync";
import { engineMsToDelaySeconds, isAutoFillable, sourceDelayMs } from "./delayConversion";

/** Build the stored metadata for a result, independent of whether its delay is
 *  applied -- a cut row still displays its measurement and its warning. */
export function buildMeasuredDelay(
  result: SyncResult,
  referenceTrack: number,
  measuredAt: string,
): MeasuredDelay {
  const engineDelayMs = sourceDelayMs(result) ?? 0;
  return {
    engineDelayMs,
    appliedMs: Math.round(-engineDelayMs),
    confidence: result.confidence ?? null,
    driftMsPerS: result.driftMsPerS ?? null,
    hasSignificantDrift: Boolean(result.hasSignificantDrift),
    isRateMismatch: Boolean(result.isRateMismatch),
    isLikelyCut: Boolean(result.isLikelyCut),
    correctionRatio: result.rateDiagnosis?.correctionRatio ?? null,
    rateSourceFps: result.rateDiagnosis?.sourceFps ?? null,
    rateTargetFps: result.rateDiagnosis?.targetFps ?? null,
    rateExplanation: result.rateDiagnosis?.explanation ?? null,
    referenceTrack,
    primaryFps: result.primaryFps ?? null,
    measuredAt,
    error: result.error ?? null,
  };
}

export interface ApplyMeasurementInput {
  file: ExternalFile;
  result: SyncResult;
  /** Null for a file-level measurement; a track id for a per-track one. */
  trackId: number | null;
  referenceTrack: number;
  measuredAt: string;
  /** Apply a delay the rules would otherwise withhold (a likely-cut pair).
   *  Only ever set by an explicit user confirmation. */
  allowCut?: boolean;
  /** Override a hand-typed delay. Only set by an explicit per-row re-measure. */
  force?: boolean;
}

/** Apply one result to one file, returning the updated copy.
 *
 *  Returns the file unchanged when a rule forbids the write, so a caller can
 *  map over results without special-casing.
 */
export function applyMeasurement({
  file,
  result,
  trackId,
  referenceTrack,
  measuredAt,
  allowCut = false,
  force = false,
}: ApplyMeasurementInput): ExternalFile {
  const measured = buildMeasuredDelay(result, referenceTrack, measuredAt);

  const existingProvenance =
    trackId === null
      ? file.delayProvenance
      : file.trackOverrides?.[trackId]?.delayProvenance;

  // A hand-typed delay survives a measurement pass untouched; only an explicit
  // per-row re-measure may replace one.
  const blockedByManual = existingProvenance === "manual" && !force;

  const writable = (isAutoFillable(result) || (allowCut && sourceDelayMs(result) !== null)) &&
    !blockedByManual;

  const engineMs = sourceDelayMs(result);
  const delay = writable && engineMs !== null ? engineMsToDelaySeconds(engineMs) : undefined;

  // Measuring records what was found; it does not change the delay field.
  // Filling it in automatically meant a wrong measurement silently became the
  // number the mux used, and there was no moment at which the user agreed to
  // it. `applyMeasuredDelay` is that moment.
  const pending = writable && delay !== undefined ? delay : undefined;

  if (trackId === null) {
    return {
      ...file,
      measuredDelay: measured,
      pendingDelay: pending,
    };
  }

  const existingOverride = file.trackOverrides?.[trackId] ?? {};
  return {
    ...file,
    trackOverrides: {
      ...(file.trackOverrides ?? {}),
      [trackId]: {
        ...existingOverride,
        measuredDelay: measured,
        pendingDelay: pending,
      },
    },
  };
}

/** Commit a measured delay into the field the mux reads.
 *
 *  Separate from `applyMeasurement` so measuring and accepting are two
 *  decisions: the engine can be wrong, and a number that reaches the mux
 *  should be one the user chose.
 */
export function applyMeasuredDelay(file: ExternalFile, trackId: number | null): ExternalFile {
  if (trackId === null) {
    if (file.pendingDelay === undefined) return file;
    return {
      ...file,
      delay: file.pendingDelay,
      delayProvenance: "measured",
      pendingDelay: undefined,
    };
  }

  const existing = file.trackOverrides?.[trackId];
  if (!existing || existing.pendingDelay === undefined) return file;
  return {
    ...file,
    trackOverrides: {
      ...(file.trackOverrides ?? {}),
      [trackId]: {
        ...existing,
        delay: existing.pendingDelay,
        delayProvenance: "measured",
        pendingDelay: undefined,
      },
    },
  };
}

/** Whether this file has a measured delay waiting to be accepted. */
export function hasPendingDelay(file: ExternalFile): boolean {
  if (file.pendingDelay !== undefined) return true;
  return Object.values(file.trackOverrides ?? {}).some(
    (override) => override.pendingDelay !== undefined,
  );
}

/** Accept every pending delay on a file, including per-track ones. */
export function applyAllPendingDelays(file: ExternalFile): ExternalFile {
  let next = applyMeasuredDelay(file, null);
  for (const key of Object.keys(next.trackOverrides ?? {})) {
    const trackId = Number(key);
    if (Number.isFinite(trackId)) next = applyMeasuredDelay(next, trackId);
  }
  return next;
}

/** Mark a delay as hand-typed, clearing the measurement it replaces.
 *
 *  The stale metadata must go: leaving it would have the row advertise a
 *  confidence and frame count for a number the user overwrote.
 */
export function markDelayAsManual(file: ExternalFile, trackId: number | null): ExternalFile {
  if (trackId === null) {
    const { measuredDelay: _discarded, ...rest } = file;
    return { ...rest, delayProvenance: "manual" };
  }

  const existing = file.trackOverrides?.[trackId] ?? {};
  const { measuredDelay: _discarded, ...restOverride } = existing;
  return {
    ...file,
    trackOverrides: {
      ...(file.trackOverrides ?? {}),
      [trackId]: { ...restOverride, delayProvenance: "manual" },
    },
  };
}
