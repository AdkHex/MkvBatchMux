import { describe, expect, it } from "vitest";
import type { ExternalFile, MeasuredDelay } from "@/shared/types";
import { isWithheld, measureFindings, measureOutcome, measureStatus } from "./measureVerdict";

const m = (overrides: Partial<MeasuredDelay> = {}): MeasuredDelay => ({
  engineDelayMs: -1312,
  appliedMs: 1312,
  confidence: 0.96,
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
  measuredAt: "2026-09-30T12:00:00.000Z",
  error: null,
  ...overrides,
});

const file = (measuredDelay?: MeasuredDelay, extra: Partial<ExternalFile> = {}): ExternalFile => ({
  id: "a",
  name: "Goblin.S01E01.Hindi.eac3",
  path: "/d/Goblin.S01E01.Hindi.eac3",
  type: "audio",
  measuredDelay,
  ...extra,
});

describe("measureStatus", () => {
  it("says Ready before a measurement, Measured while it waits, Applied after", () => {
    expect(measureStatus(undefined, { pending: false })).toEqual({ s: "ready", text: "Ready" });
    expect(measureStatus(m(), { pending: true })).toEqual({ s: "ok", text: "Measured" });
    expect(measureStatus(m(), { pending: false })).toEqual({ s: "ok", text: "Applied" });
  });

  it("puts a failure above everything", () => {
    expect(measureStatus(m({ error: "No audio stream", isLikelyCut: true }), { pending: false })).toEqual({ s: "bad", text: "Failed" });
  });

  it("ranks a cut above a weak match, as the old badges did", () => {
    expect(measureStatus(m({ isLikelyCut: true, confidence: 0.3 }), { pending: false }).text).toBe("Different cut");
    expect(measureStatus(m({ confidence: 0.43 }), { pending: false }).text).toBe("Weak match");
  });

  it("calls a delay over five minutes implausible, not a cut", () => {
    expect(measureStatus(m({ engineDelayMs: 400_000, isLikelyCut: true }), { pending: false }).text).toBe("Implausible");
  });

  it("names a frame-rate conversion by its two rates", () => {
    expect(measureStatus(m({ isRateMismatch: true, rateSourceFps: 25, rateTargetFps: 23.976 }), { pending: true }).text).toBe("25 → 23.976 fps");
  });

  it("flags a measurement taken against another reference track", () => {
    expect(measureStatus(m(), { pending: true, currentReferenceTrack: 1 }).text).toBe("Reference changed");
  });
});

describe("measureFindings", () => {
  it("places a cut on the timeline when the engine found where", () => {
    const [cut] = measureFindings(m({ isLikelyCut: true, cutPositionS: 2467, cutMagnitudeMs: 12480 }));
    expect(cut.word).toBe("Different cut");
    expect(cut.line).toContain("12.480 s");
    expect(cut.line).toContain("41:07");
  });

  it("says a clean timeline scan found no cuts", () => {
    const scan = {
      scannedAt: "x", error: null, startOffsetMs: -1312, cuts: [], unverified: [], tailS: 0,
      videoFps: 23.976, dubRate: 23.976, speed: 1, rateConfirmed: true, dubUsedShare: 1, videoDurationS: 4000, description: null,
    };
    expect(measureFindings(m({ timeline: scan }))).toMatchObject([{ tone: "ok", word: "No cuts", line: "The dub follows the video in one piece." }]);
  });
});

describe("isWithheld", () => {
  it("holds back cuts, weak matches and implausible offsets, never failures", () => {
    expect(isWithheld(m({ isLikelyCut: true }))).toBe(true);
    expect(isWithheld(m({ confidence: 0.2 }))).toBe(true);
    expect(isWithheld(m({ engineDelayMs: 301_000 }))).toBe(true);
    expect(isWithheld(m({ error: "x" }))).toBe(false);
    expect(isWithheld(m())).toBe(false);
  });
});

describe("measureOutcome", () => {
  it("counts each file once, by its most serious finding", () => {
    const outcome = measureOutcome([
      file(m()),
      file(m()),
      file(m({ isLikelyCut: true, confidence: 0.3 })),
      file(m({ error: "No audio stream" })),
      file(undefined),
    ]);
    expect(outcome.parts).toEqual(["2 measured", "1 different cut", "1 failed"]);
    expect(outcome.tone).toBe("warn");
    expect(outcome.problems).toBe(2);
  });

  it("reads per-track measurements of a multi-track file", () => {
    const outcome = measureOutcome([file(undefined, { trackOverrides: { 1: { measuredDelay: m() }, 2: { measuredDelay: m() } } })]);
    expect(outcome.parts).toEqual(["2 measured"]);
    expect(outcome.tone).toBe("ok");
  });
});
