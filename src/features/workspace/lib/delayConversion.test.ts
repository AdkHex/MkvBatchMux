import { describe, expect, it } from "vitest";
import type { SyncResult } from "@/shared/types/audiosync";
import type { MeasuredDelay } from "@/shared/types";
import {
  confidenceLevel,
  engineMsToDelaySeconds,
  formatDelaySeconds,
  frameOffset,
  isAutoFillable,
  isImplausiblyLarge,
  playerDelayMs,
  sourceDelayMs,
  conversionBetween,
  formatRateConversion,
  formatRateDrift,
  rateConversionFor,
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

  it("rejects a result whose correlation was too weak to mean anything", () => {
    expect(isAutoFillable(makeResult({ delayMs: 87.7, confidence: 0.3 }))).toBe(false);
  });

  it("accepts a medium-confidence result", () => {
    expect(isAutoFillable(makeResult({ delayMs: 87.7, confidence: 0.55 }))).toBe(true);
  });

  it("accepts a result that reports no confidence at all", () => {
    // Absent is not the same as low: an engine that reports no figure should
    // not have every result silently withheld.
    expect(isAutoFillable(makeResult({ delayMs: 87.7, confidence: null }))).toBe(true);
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

/** A measurement carrying only the fields the conversion is derived from. */
const makeMeasured = (
  overrides: Partial<
    Pick<MeasuredDelay, "correctionRatio" | "rateSourceFps" | "rateTargetFps" | "primaryFps">
  > = {},
) => ({
  correctionRatio: null,
  rateSourceFps: null,
  rateTargetFps: null,
  primaryFps: null,
  ...overrides,
});

/** The engine reports an ffmpeg atempo speed factor: video rate over audio
 *  rate. Building the fixtures through it rather than by hand keeps the tests
 *  honest about which convention they are feeding in. */
const engineCorrectionRatio = (audioFps: number, videoFps: number) => videoFps / audioFps;

describe("rateConversionFor", () => {
  it("stretches in the direction that slows fast-running audio", () => {
    // The direction, stated physically so an inversion cannot pass. Audio timed
    // at 25fps holds the same frames in less time than a 23.976fps video does,
    // so it must be SLOWED to fit -- and mkvmerge multiplies timestamps by
    // num/den, verified against the binary: muxing a 60.01s track with
    // `--sync 0:0,25025/24000` produces a 62.57s one.
    const slowingDown = rateConversionFor(
      makeMeasured({ rateSourceFps: 25, rateTargetFps: 23.976 }),
    )!;
    expect(slowingDown.num / slowingDown.den).toBeGreaterThan(1);
    expect(slowingDown.num / slowingDown.den).toBeCloseTo(25 / 23.976, 4);

    // And the converse: audio timed at 23.976 against a 25fps video runs slow,
    // so its timestamps must be compressed.
    const speedingUp = rateConversionFor(
      makeMeasured({ rateSourceFps: 23.976, rateTargetFps: 25 }),
    )!;
    expect(speedingUp.num / speedingUp.den).toBeLessThan(1);
  });

  it("does not hand mkvmerge the engine's atempo factor", () => {
    // The engine's correctionRatio is a playback-speed factor and mkvmerge's is
    // a timestamp multiplier, so they are reciprocals. Passing one straight
    // through doubles the drift instead of removing it, which is what shipped
    // before this test existed.
    const conversion = rateConversionFor(
      makeMeasured({ correctionRatio: engineCorrectionRatio(25, 23.976) }),
    )!;
    expect(conversion.num / conversion.den).toBeCloseTo(25 / 23.976, 4);
  });

  it("names the exact ratio for the conversions the engine identifies", () => {
    // mkvmerge applies these literally, so a float-derived near-miss
    // accumulates real error over an episode.
    expect(rateConversionFor(makeMeasured({ rateSourceFps: 25, rateTargetFps: 23.976 })))
      .toMatchObject({ num: 1001, den: 960, basis: "named" });
    expect(rateConversionFor(makeMeasured({ rateSourceFps: 24, rateTargetFps: 25 })))
      .toMatchObject({ num: 24, den: 25, basis: "named" });
    expect(rateConversionFor(makeMeasured({ rateSourceFps: 25, rateTargetFps: 24 })))
      .toMatchObject({ num: 25, den: 24, basis: "named" });
  });

  it("gives 1001/1000 for the NTSC pair, not the 999/1000 a decimal implies", () => {
    // 24 -> 23.976 was the case the app got wrong: with no table entry it
    // approximated the atempo factor and offered 999/1000, which is both
    // inverted and inexact. 23.976 is 24000/1001, so the true ratio is
    // 1001/1000 and the audio has to be slowed, not sped up.
    expect(rateConversionFor(makeMeasured({ rateSourceFps: 24, rateTargetFps: 23.976 })))
      .toMatchObject({ num: 1001, den: 1000, basis: "named" });
    expect(rateConversionFor(makeMeasured({ rateSourceFps: 23.976, rateTargetFps: 24 })))
      .toMatchObject({ num: 1000, den: 1001, basis: "named" });
    expect(rateConversionFor(makeMeasured({ rateSourceFps: 30, rateTargetFps: 29.97 })))
      .toMatchObject({ num: 1001, den: 1000, basis: "named" });
    expect(rateConversionFor(makeMeasured({ rateSourceFps: 60, rateTargetFps: 59.94 })))
      .toMatchObject({ num: 1001, den: 1000, basis: "named" });
  });

  it("tolerates the measured frame rate being slightly off", () => {
    // 23.976023.. is often reported rounded; that noise must still match.
    expect(rateConversionFor(makeMeasured({ rateSourceFps: 25.0, rateTargetFps: 23.976023976 })))
      .toMatchObject({ num: 1001, den: 960, basis: "named" });
  });

  it("does not confuse 23.976 with 24, which take different ratios", () => {
    // These are 0.024 fps apart and map to 1001/960 versus 25/24. A tolerance
    // wide enough to blur them would silently stretch by the wrong factor
    // across the whole file.
    expect(rateConversionFor(makeMeasured({ rateSourceFps: 23.976, rateTargetFps: 25 })))
      .toMatchObject({ num: 960, den: 1001 });
    expect(rateConversionFor(makeMeasured({ rateSourceFps: 24, rateTargetFps: 25 })))
      .toMatchObject({ num: 24, den: 25 });
  });

  it("names a standard conversion the engine did not, from the speed alone", () => {
    // The engine only names a pair when it recognises both rates; a container
    // frame rate (31.25 for AC-3) defeats that. The speed it measured is still
    // a standard conversion, and naming it is what turns an opaque ratio into
    // an instruction.
    const conversion = rateConversionFor(
      makeMeasured({
        correctionRatio: engineCorrectionRatio(25, 23.976),
        rateSourceFps: 31.25,
        rateTargetFps: 23.976,
      }),
    )!;
    expect(conversion.basis).toBe("inferred");
    expect(conversion).toMatchObject({ num: 1001, den: 960, audioFps: 25 });
  });

  it("uses the video's own rate to separate conversions of equal speed", () => {
    // 24 -> 23.976, 30 -> 29.97 and 60 -> 59.94 are all 1001/1000, so the
    // measurement cannot tell them apart. The video can: only one of them
    // converts to the rate this video actually runs at.
    const conversion = rateConversionFor(
      makeMeasured({
        correctionRatio: engineCorrectionRatio(24, 24000 / 1001),
        primaryFps: 23.976,
      }),
    )!;
    expect(conversion).toMatchObject({
      audioFps: 24,
      num: 1001,
      den: 1000,
      basis: "inferred",
    });
  });

  it("still applies the shared ratio when nothing can name the pair", () => {
    // Without the video's rate, 24 -> 23.976 and 30 -> 29.97 are the same
    // answer. Refusing the stretch would throw away a ratio that is exact for
    // all of them; naming one of them would be a guess.
    const conversion = rateConversionFor(
      makeMeasured({ correctionRatio: engineCorrectionRatio(24, 24000 / 1001) }),
    )!;
    expect(conversion).toMatchObject({ num: 1001, den: 1000, basis: "inferred" });
    expect(conversion.audioFps).toBeNull();
    expect(formatRateConversion(conversion)).toBe("×1.001000");
  });

  it("does not dress up a factor that fits nothing as a named conversion", () => {
    // Nothing in the table is this close to another entry, so the guard is
    // asserted through the tolerance rather than through a real pair: a factor
    // that fits nothing at all must not be dressed up as a named conversion.
    expect(rateConversionFor(makeMeasured({ correctionRatio: 1 / 1.5 }))).toMatchObject({
      basis: "measured",
    });
  });

  it("ignores a codec frame rate rather than converting to it", () => {
    // 31.25 is SamplingRate/SamplesPerFrame for AC-3, constant per codec and
    // unrelated to timing. Stretching by 31.25/23.976 would destroy the file.
    expect(conversionBetween(31.25, 23.976)).toBeNull();
  });

  it("falls back to an approximation, marked measured, when nothing standard fits", () => {
    const conversion = rateConversionFor(
      makeMeasured({ correctionRatio: engineCorrectionRatio(30, 29.925), primaryFps: 29.925 }),
    )!;
    expect(conversion.basis).toBe("measured");
    expect(conversion.num / conversion.den).toBeCloseTo(30 / 29.925, 6);
    // The video's rate is still known, so the implied audio rate can be named.
    expect(conversion.audioFps).toBeCloseTo(30, 2);
  });

  it("returns null when there is nothing trustworthy to apply", () => {
    expect(rateConversionFor(makeMeasured())).toBeNull();
    expect(rateConversionFor(makeMeasured({ correctionRatio: 0 }))).toBeNull();
    // Same rate on both sides is not a conversion, whatever the engine flagged.
    expect(rateConversionFor(makeMeasured({ rateSourceFps: 25, rateTargetFps: 25 }))).toBeNull();
  });
});

describe("formatRateConversion", () => {
  it("names both rates, which is the part a user can check", () => {
    const conversion = rateConversionFor(
      makeMeasured({ rateSourceFps: 24, rateTargetFps: 23.976 }),
    )!;
    expect(formatRateConversion(conversion)).toBe("24.000 → 23.976 fps");
    expect(formatRateDrift(conversion)).toContain("0.10% too fast");
    // 0.1% is 3.6 seconds across an hour -- the number that says whether it
    // matters for this file.
    expect(formatRateDrift(conversion)).toContain("3.6 s");
  });
});

