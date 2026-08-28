import { describe, expect, it } from "vitest";
import type { SyncResult } from "@/shared/types/audiosync";
import {
  confidenceLevel,
  engineMsToDelaySeconds,
  formatDelaySeconds,
  frameOffset,
  isAutoFillable,
  isImplausiblyLarge,
  playerDelayMs,
  sourceDelayMs,
  stretchRatioFor,
} from "./delayConversion";

const makeResult = (overrides: Partial<SyncResult> = {}): SyncResult => ({
  videoFile: "Episode 01.mkv",
  audioFile: "Episode 01.HIN.aac",
  primaryPath: "/videos/Episode 01.mkv",
  secondaryPath: "/audio/Episode 01.HIN.aac",
  delayMs: 0,
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
  elapsedMs: 1000,
  ...overrides,
});

/** The muxer's own arithmetic, copied from main.rs: `(delay * 1000.0) as i64`.
 *  Rust's `as i64` truncates toward zero, which is what this reproduces. */
const asMkvmergeSyncMs = (delaySeconds: number) => Math.trunc(delaySeconds * 1000);

describe("engineMsToDelaySeconds", () => {
  it("flips the sign: a positive engine delay becomes a negative field value", () => {
    // The engine reports where the audio sits; mkvmerge's --sync asks how much
    // delay to add to fix it. Piping the raw value through would leave every
    // file out of sync by exactly twice the true offset. See plan §2.1.
    const value = engineMsToDelaySeconds(100);
    expect(value).toBeLessThan(0);
    expect(value).toBe(-0.1);
  });

  it("matches the worked examples from the specification", () => {
    expect(engineMsToDelaySeconds(87.7)).toBe(-0.088);
    expect(engineMsToDelaySeconds(87.2)).toBe(-0.087);
    expect(engineMsToDelaySeconds(1890.4)).toBe(-1.89);
    expect(engineMsToDelaySeconds(-33.5)).toBe(0.034);
    expect(engineMsToDelaySeconds(0)).toBe(0);
  });

  it("formats to exactly three decimals", () => {
    expect(formatDelaySeconds(engineMsToDelaySeconds(87.7))).toBe("-0.088");
    expect(formatDelaySeconds(engineMsToDelaySeconds(1890.4))).toBe("-1.890");
    expect(formatDelaySeconds(engineMsToDelaySeconds(-33.5))).toBe("0.034");
    expect(formatDelaySeconds(engineMsToDelaySeconds(0))).toBe("0.000");
  });

  it("rounds to the nearest millisecond rather than truncating", () => {
    // Truncation would give -0.087 here; the field holds whole milliseconds so
    // the choice between them is a real one-millisecond difference.
    expect(engineMsToDelaySeconds(87.6)).toBe(-0.088);
    expect(engineMsToDelaySeconds(87.4)).toBe(-0.087);
  });
});

describe("sourceDelayMs", () => {
  it("prefers delayAtStartMs over delayMs when both are present", () => {
    // With drift, delayMs is the midpoint value but --sync applies from t=0,
    // so using it over-shoots by half the total drift. See plan §2.3.
    const result = makeResult({ delayMs: 120, delayAtStartMs: 80 });
    expect(sourceDelayMs(result)).toBe(80);
    expect(engineMsToDelaySeconds(sourceDelayMs(result)!)).toBe(-0.08);
  });

  it("falls back to delayMs when there is no start-referenced value", () => {
    expect(sourceDelayMs(makeResult({ delayMs: 120, delayAtStartMs: null }))).toBe(120);
  });

  it("returns null when the measurement produced nothing", () => {
    expect(sourceDelayMs(makeResult({ delayMs: null, delayAtStartMs: null }))).toBeNull();
  });
});

describe("round trip through the muxer's own arithmetic", () => {
  // This is what actually proves the whole chain: engine value in, --sync
  // milliseconds out, through the exact cast main.rs performs.
  it.each([
    [87.7, -88],
    [87.2, -87],
    [1890.4, -1890],
    [-33.5, 34],
    [0, 0],
    [100, -100],
  ])("engine %p ms becomes --sync %p ms", (engineMs, expectedSyncMs) => {
    expect(asMkvmergeSyncMs(engineMsToDelaySeconds(engineMs))).toBe(expectedSyncMs);
  });
});

describe("against a real engine measurement", () => {
  it("pulls late audio earlier", () => {
    // Verified end to end: a synthetic pair whose audio carried 250ms of
    // leading silence measured as delayMs = +250.00007 at 99.99% confidence.
    // The audio starts late, so the fix is to pull it earlier -- a negative
    // --sync. Passing the engine value through unnegated would instead push it
    // 250ms further late, doubling the error to half a second.
    const delaySeconds = engineMsToDelaySeconds(250.00006802243297);
    expect(delaySeconds).toBe(-0.25);
    expect(asMkvmergeSyncMs(delaySeconds)).toBe(-250);
  });
});

describe("isAutoFillable", () => {
  it("refuses to auto-fill a likely-cut result", () => {
    // Different material: no single offset aligns the two files, so a number
    // here would be a confident wrong answer. See plan §5.4.
    expect(isAutoFillable(makeResult({ delayMs: 120, isLikelyCut: true }))).toBe(false);
  });

  it("refuses a failed measurement", () => {
    expect(isAutoFillable(makeResult({ delayMs: null, error: "ffprobe failed" }))).toBe(false);
    expect(isAutoFillable(makeResult({ delayMs: null, delayAtStartMs: null }))).toBe(false);
  });

  it("accepts a low-confidence result, which is filled but flagged", () => {
    // Low confidence is surfaced on the row rather than withheld -- the number
    // is still the best measurement available, unlike a cut where none exists.
    expect(isAutoFillable(makeResult({ delayMs: 120, confidence: 0.3 }))).toBe(true);
  });

  it("refuses an offset too large to be a real delay", () => {
    // Regression: a batch of already-synced episodes measured -26041 ms at
    // 100% confidence. Confidence only says the sample windows agreed with
    // each other, and a correlator locked onto a repeated musical phrase
    // agrees with itself in every window. A dub is never 26 seconds out from
    // its own episode, so the number is shown but never filled in.
    expect(isAutoFillable(makeResult({ delayMs: -26041 }))).toBe(false);
    expect(isAutoFillable(makeResult({ delayMs: -26041, confidence: 1 }))).toBe(false);
    expect(isImplausiblyLarge(makeResult({ delayMs: -26041 }))).toBe(true);
  });

  it("accepts offsets within the plausible range", () => {
    // Real container and encoder offsets live here; the guard must not eat them.
    expect(isAutoFillable(makeResult({ delayMs: 42 }))).toBe(true);
    expect(isAutoFillable(makeResult({ delayMs: -2500 }))).toBe(true);
    expect(isImplausiblyLarge(makeResult({ delayMs: -2500 }))).toBe(false);
  });

  it("judges plausibility on the value it would actually apply", () => {
    // With drift the start value is what gets written, so that is the one
    // the guard has to test.
    expect(isAutoFillable(makeResult({ delayMs: 120, delayAtStartMs: -26041 }))).toBe(false);
  });

  it("accepts an ordinary result", () => {
    expect(isAutoFillable(makeResult({ delayMs: 87.7 }))).toBe(true);
  });
});

describe("confidenceLevel", () => {
  it("uses the engine's bands", () => {
    expect(confidenceLevel(0.99)).toBe("high");
    expect(confidenceLevel(0.75)).toBe("high");
    expect(confidenceLevel(0.74)).toBe("medium");
    expect(confidenceLevel(0.5)).toBe("medium");
    expect(confidenceLevel(0.49)).toBe("low");
    expect(confidenceLevel(null)).toBe("low");
  });
});

describe("playerDelayMs", () => {
  it("shows the unrounded value in the convention the user reads elsewhere", () => {
    expect(playerDelayMs(87.7)).toBeCloseTo(-87.7, 5);
    expect(playerDelayMs(-33.5)).toBeCloseTo(33.5, 5);
  });

  it("keeps zero positive so it does not render as -0.0 ms", () => {
    expect(Object.is(playerDelayMs(0), 0)).toBe(true);
  });
});

describe("frameOffset", () => {
  it("expresses a delay in whole frames", () => {
    expect(frameOffset(-88, 23.976)).toBe(-2);
    expect(frameOffset(125, 24)).toBe(3);
  });

  it("returns null below half a frame, where there is nothing to say", () => {
    expect(frameOffset(10, 23.976)).toBeNull();
    expect(frameOffset(-88, null)).toBeNull();
    expect(frameOffset(null, 24)).toBeNull();
  });
});

describe("stretchRatioFor", () => {
  it("uses the exact integer ratio for known broadcast conversions", () => {
    // A float-derived approximation lands near these but not on them, and
    // mkvmerge applies the ratio literally. See plan §5.5.
    expect(stretchRatioFor(0.95904, 25, 23.976)).toEqual({ num: 24000, den: 25025, exact: true });
    expect(stretchRatioFor(1.0427, 23.976, 25)).toEqual({ num: 25025, den: 24000, exact: true });
    expect(stretchRatioFor(1.0417, 24, 25)).toEqual({ num: 25, den: 24, exact: true });
    expect(stretchRatioFor(0.96, 25, 24)).toEqual({ num: 24, den: 25, exact: true });
  });

  it("tolerates the measured frame rate being slightly off", () => {
    // 23.976023.. is often reported rounded; that noise must still match.
    expect(stretchRatioFor(0.959, 25.0, 23.976023976)).toEqual({
      num: 24000,
      den: 25025,
      exact: true,
    });
  });

  it("does not confuse 23.976 with 24, which take different ratios", () => {
    // These are 0.024 fps apart and map to 25025/24000 versus 25/24. A
    // tolerance wide enough to blur them would silently stretch by the wrong
    // factor across the whole file.
    expect(stretchRatioFor(1.0427, 23.976, 25)).toEqual({ num: 25025, den: 24000, exact: true });
    expect(stretchRatioFor(1.0417, 24, 25)).toEqual({ num: 25, den: 24, exact: true });
  });

  it("falls back to an approximation, marked inexact, when no conversion matches", () => {
    const ratio = stretchRatioFor(1.0025, 30, 29.925);
    expect(ratio).not.toBeNull();
    expect(ratio!.exact).toBe(false);
    expect(ratio!.num / ratio!.den).toBeCloseTo(1.0025, 6);
  });

  it("stretches in the direction that slows fast-running audio", () => {
    // Direction check, stated physically so an inversion cannot pass:
    // sourceFps is the rate the AUDIO was timed at, targetFps the VIDEO's.
    // Audio timed at 25 fps against a 23.976 fps video runs fast, so its
    // timestamps must be stretched -- the factor must exceed 1.
    const slowingDown = stretchRatioFor(null, 25, 23.976)!;
    expect(slowingDown.den / slowingDown.num).toBeGreaterThan(1);
    // 25/23.976 = 1.0427, i.e. the audio must be slowed by ~4.3%.
    expect(slowingDown.den / slowingDown.num).toBeCloseTo(25 / 23.976, 4);

    // And the converse: audio timed at 23.976 against a 25 fps video runs
    // slow, so its timestamps must be compressed.
    const speedingUp = stretchRatioFor(null, 23.976, 25)!;
    expect(speedingUp.den / speedingUp.num).toBeLessThan(1);
  });

  it("returns null when there is nothing trustworthy to apply", () => {
    expect(stretchRatioFor(null, null, null)).toBeNull();
    expect(stretchRatioFor(undefined, null, null)).toBeNull();
    expect(stretchRatioFor(0, null, null)).toBeNull();
  });
});
