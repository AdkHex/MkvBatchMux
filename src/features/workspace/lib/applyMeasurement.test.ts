import { describe, expect, it } from "vitest";
import type { ExternalFile } from "@/shared/types";
import type { SyncResult } from "@/shared/types/audiosync";
import {
  applyMeasurement,
  applyMeasuredDelay,
  applyAllPendingDelays,
  hasPendingDelay,
  markDelayAsManual,
} from "./applyMeasurement";

const MEASURED_AT = "2026-08-28T12:00:00.000Z";

const makeFile = (overrides: Partial<ExternalFile> = {}): ExternalFile => ({
  id: "a1",
  name: "Episode 01.HIN.aac",
  path: "/audio/Episode 01.HIN.aac",
  type: "audio",
  ...overrides,
});

const makeResult = (overrides: Partial<SyncResult> = {}): SyncResult => ({
  videoFile: "Episode 01.mkv",
  audioFile: "Episode 01.HIN.aac",
  delayMs: 87.7,
  delayAtStartMs: null,
  confidence: 0.99,
  driftMsPerS: null,
  totalDriftMs: null,
  hasSignificantDrift: false,
  startDelayMs: null,
  endDelayMs: null,
  windowsUsed: 6,
  windowsTotal: 6,
  error: null,
  elapsedMs: 100,
  primaryFps: 23.976,
  ...overrides,
});

const apply = (file: ExternalFile, result: SyncResult, extra = {}) =>
  applyMeasurement({
    file,
    result,
    trackId: null,
    referenceTrack: 0,
    measuredAt: MEASURED_AT,
    ...extra,
  });

describe("applyMeasurement", () => {
  it("stages the negated, rounded delay rather than writing it", () => {
    // Measuring proposes; applying commits. Filling the field outright meant
    // a wrong measurement silently became the number the mux used.
    const updated = apply(makeFile(), makeResult({ delayMs: 87.7 }));
    expect(updated.pendingDelay).toBe(-0.088);
    expect(updated.delay).toBeUndefined();
    expect(updated.delayProvenance).toBeUndefined();

    const applied = applyMeasuredDelay(updated, null);
    expect(applied.delay).toBe(-0.088);
    expect(applied.delayProvenance).toBe("measured");
    expect(applied.pendingDelay).toBeUndefined();
  });

  it("prefers delayAtStartMs, because --sync applies from t=0", () => {
    const updated = apply(
      makeFile(),
      makeResult({ delayMs: 120, delayAtStartMs: 80, hasSignificantDrift: true }),
    );
    expect(updated.pendingDelay).toBe(-0.08);
  });

  it("stores the metadata the row displays", () => {
    const updated = apply(
      makeFile(),
      makeResult({ delayMs: 87.7, confidence: 0.61, primaryFps: 23.976 }),
    );
    expect(updated.measuredDelay).toMatchObject({
      engineDelayMs: 87.7,
      appliedMs: -88,
      confidence: 0.61,
      referenceTrack: 0,
      primaryFps: 23.976,
      measuredAt: MEASURED_AT,
    });
  });

  it("never auto-fills a likely-cut result", () => {
    // Different material: no single offset aligns the files. See plan §5.4.
    const updated = apply(makeFile(), makeResult({ delayMs: 87.7, isLikelyCut: true }));
    expect(updated.delay).toBeUndefined();
    expect(updated.delayProvenance).not.toBe("measured");
    // The measurement is still recorded so the row can show its warning.
    expect(updated.measuredDelay?.isLikelyCut).toBe(true);
  });

  it("stages a cut result when the user explicitly confirms it", () => {
    const updated = apply(makeFile(), makeResult({ delayMs: 87.7, isLikelyCut: true }), {
      allowCut: true,
    });
    expect(updated.pendingDelay).toBe(-0.088);
  });

  it("leaves a hand-typed delay untouched", () => {
    // See plan §5.6: measurement must never overwrite manual input.
    const file = makeFile({ delay: -0.5, delayProvenance: "manual" });
    const updated = apply(file, makeResult({ delayMs: 87.7 }));
    expect(updated.delay).toBe(-0.5);
    expect(updated.delayProvenance).toBe("manual");
  });

  it("offers to replace a hand-typed delay only on an explicit re-measure", () => {
    const file = makeFile({ delay: -0.5, delayProvenance: "manual" });
    const updated = apply(file, makeResult({ delayMs: 87.7 }), { force: true });
    // The typed value still stands until the measurement is applied.
    expect(updated.delay).toBe(-0.5);
    expect(updated.pendingDelay).toBe(-0.088);
    expect(applyMeasuredDelay(updated, null).delay).toBe(-0.088);
  });

  it("writes nothing for a failed measurement", () => {
    const updated = apply(makeFile(), makeResult({ delayMs: null, error: "ffprobe failed" }));
    expect(updated.delay).toBeUndefined();
    expect(updated.measuredDelay?.error).toBe("ffprobe failed");
  });

  it("does not stage a low-confidence result, but still records it", () => {
    // 30% means the correlator found no distinct peak. Showing it is useful;
    // queueing it for Apply-all is not, because nothing distinguishes it from
    // a real measurement once it is sitting in the field.
    const updated = apply(makeFile(), makeResult({ delayMs: 87.7, confidence: 0.3 }));
    expect(updated.pendingDelay).toBeUndefined();
    expect(updated.measuredDelay?.confidence).toBe(0.3);
    expect(updated.measuredDelay?.engineDelayMs).toBe(87.7);
  });

  it("stages a merely-medium result", () => {
    // The floor rejects noise, not imperfection.
    const updated = apply(makeFile(), makeResult({ delayMs: 87.7, confidence: 0.55 }));
    expect(updated.pendingDelay).toBe(-0.088);
  });

  it("records a rate mismatch without applying any stretch by itself", () => {
    // The stretch is opt-in per row; measuring must not silently enable it.
    const updated = apply(
      makeFile(),
      makeResult({
        delayMs: 87.7,
        isRateMismatch: true,
        rateDiagnosis: {
          driftMsPerS: 1.0,
          speedRatio: 1.0427,
          sourceFps: 23.976,
          targetFps: 25,
          isRateMismatch: true,
          isLikelyCut: false,
          explanation: "23.976 to 25 fps conversion",
          correctionRatio: 1.0427,
        },
      }),
    );
    expect(updated.measuredDelay?.isRateMismatch).toBe(true);
    expect(updated.measuredDelay?.correctionRatio).toBe(1.0427);
    expect(updated.stretch).toBeUndefined();
  });
});

describe("applyMeasurement, per track", () => {
  it("writes into trackOverrides rather than the file-level delay", () => {
    // main.rs prefers trackOverrides[tid].delay, so per-track values win.
    const updated = applyMeasurement({
      file: makeFile(),
      result: makeResult({ delayMs: 87.7 }),
      trackId: 2,
      referenceTrack: 0,
      measuredAt: MEASURED_AT,
    });
    expect(updated.delay).toBeUndefined();
    expect(updated.trackOverrides?.[2].pendingDelay).toBe(-0.088);
    expect(updated.trackOverrides?.[2].delay).toBeUndefined();

    const applied = applyMeasuredDelay(updated, 2);
    expect(applied.trackOverrides?.[2].delay).toBe(-0.088);
    expect(applied.trackOverrides?.[2].delayProvenance).toBe("measured");
  });

  it("leaves other tracks' overrides alone", () => {
    const file = makeFile({
      trackOverrides: { 1: { delay: -0.2, language: "eng" } },
    });
    const updated = applyMeasurement({
      file,
      result: makeResult({ delayMs: 87.7 }),
      trackId: 2,
      referenceTrack: 0,
      measuredAt: MEASURED_AT,
    });
    expect(updated.trackOverrides?.[1]).toEqual({ delay: -0.2, language: "eng" });
    expect(updated.trackOverrides?.[2].pendingDelay).toBe(-0.088);
  });

  it("respects a hand-typed per-track delay", () => {
    const file = makeFile({
      trackOverrides: { 2: { delay: -0.5, delayProvenance: "manual" } },
    });
    const updated = applyMeasurement({
      file,
      result: makeResult({ delayMs: 87.7 }),
      trackId: 2,
      referenceTrack: 0,
      measuredAt: MEASURED_AT,
    });
    expect(updated.trackOverrides?.[2].delay).toBe(-0.5);
    expect(updated.trackOverrides?.[2].delayProvenance).toBe("manual");
  });
});

describe("markDelayAsManual", () => {
  it("clears the stale measurement when the user types a delay", () => {
    // Otherwise the row advertises a confidence and frame count belonging to a
    // number the user has since replaced.
    const file = makeFile({
      delay: -0.088,
      delayProvenance: "measured",
      measuredDelay: {
        engineDelayMs: 87.7,
        appliedMs: -88,
        confidence: 0.99,
        driftMsPerS: null,
        hasSignificantDrift: false,
        isRateMismatch: false,
        isLikelyCut: false,
        correctionRatio: null,
        rateSourceFps: null,
        rateTargetFps: null,
        rateExplanation: null,
        referenceTrack: 0,
        primaryFps: 23.976,
        measuredAt: MEASURED_AT,
        error: null,
      },
    });

    const updated = markDelayAsManual(file, null);

    expect(updated.delayProvenance).toBe("manual");
    expect(updated.measuredDelay).toBeUndefined();
  });

  it("clears a stale per-track measurement", () => {
    const file = makeFile({
      trackOverrides: {
        2: {
          delay: -0.088,
          delayProvenance: "measured",
          measuredDelay: {
            engineDelayMs: 87.7,
            appliedMs: -88,
            confidence: 0.99,
            driftMsPerS: null,
            hasSignificantDrift: false,
            isRateMismatch: false,
            isLikelyCut: false,
            correctionRatio: null,
            rateSourceFps: null,
            rateTargetFps: null,
            rateExplanation: null,
            referenceTrack: 0,
            primaryFps: null,
            measuredAt: MEASURED_AT,
            error: null,
          },
        },
      },
    });

    const updated = markDelayAsManual(file, 2);

    expect(updated.trackOverrides?.[2].delayProvenance).toBe("manual");
    expect(updated.trackOverrides?.[2].measuredDelay).toBeUndefined();
    expect(updated.trackOverrides?.[2].delay).toBe(-0.088);
  });
});

describe("a measurement pass over a mixed set", () => {
  it("leaves manual delays alone while filling the rest", () => {
    const files = [
      makeFile({ id: "manual", delay: -0.5, delayProvenance: "manual" }),
      makeFile({ id: "fresh" }),
      makeFile({ id: "cut" }),
    ];
    const results: Record<string, SyncResult> = {
      manual: makeResult({ delayMs: 87.7 }),
      fresh: makeResult({ delayMs: 87.7 }),
      cut: makeResult({ delayMs: 87.7, isLikelyCut: true }),
    };

    const measured = files.map((file) => apply(file, results[file.id]));

    // Nothing is written yet: measuring only proposes.
    expect(measured[0].delay).toBe(-0.5);
    expect(measured[1].delay).toBeUndefined();
    expect(measured[1].pendingDelay).toBe(-0.088);
    // A cut has nothing to propose.
    expect(measured[2].pendingDelay).toBeUndefined();

    // Applying everything fills only what was proposed. The manual delay is
    // untouched because a measurement pass never staged one for it.
    const applied = measured.map(applyAllPendingDelays);
    expect(applied[0].delay).toBe(-0.5);
    expect(applied[0].delayProvenance).toBe("manual");
    expect(applied[1].delay).toBe(-0.088);
    expect(applied[2].delay).toBeUndefined();
  });

  it("reports which files are waiting to be accepted", () => {
    // Drives both the Apply button's count and the per-row tick.
    const staged = apply(makeFile(), makeResult({ delayMs: 87.7 }));
    const cut = apply(makeFile(), makeResult({ delayMs: 87.7, isLikelyCut: true }));

    expect(hasPendingDelay(staged)).toBe(true);
    expect(hasPendingDelay(cut)).toBe(false);
    expect(hasPendingDelay(applyAllPendingDelays(staged))).toBe(false);
  });
});
