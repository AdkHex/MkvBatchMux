import { describe, expect, it } from "vitest";
import type { ExternalFile, MeasuredDelay, VideoFile } from "@/shared/types";
import { audioFpsFor, estimateFpsFromDurations, needsRateChange, rateChangeFor } from "./audioFps";
import { formatFps } from "./delayConversion";

const makeVideo = (overrides: Partial<VideoFile> = {}): VideoFile => ({
  id: "v1",
  name: "Episode 01.mkv",
  path: "/video/Episode 01.mkv",
  size: 1_000_000,
  durationSeconds: 1440,
  fps: 23.976,
  status: "pending",
  tracks: [],
  ...overrides,
});

const makeAudio = (overrides: Partial<ExternalFile> = {}): ExternalFile => ({
  id: "a1",
  name: "Episode 01.HIN.eac3",
  path: "/audio/Episode 01.HIN.eac3",
  type: "audio",
  durationSeconds: 1440,
  ...overrides,
});

const makeMeasured = (overrides: Partial<MeasuredDelay> = {}): MeasuredDelay => ({
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
  measuredAt: "2026-08-28T12:00:00.000Z",
  error: null,
  ...overrides,
});

describe("formatFps", () => {
  it("writes rates the way the frame-rate world does", () => {
    expect(formatFps(25)).toBe("25.000");
    expect(formatFps(23.976)).toBe("23.976");
    expect(formatFps(29.97)).toBe("29.970");
  });
});

describe("estimateFpsFromDurations", () => {
  it("names PAL-timed audio against a film-rate video", () => {
    // 23.976fps content sped to 25fps runs 4.27% short.
    const audioDuration = 1440 * (23.976 / 25);
    expect(estimateFpsFromDurations(audioDuration, 1440, 23.976)).toEqual({
      fps: 25,
      videoFps: 23.976,
      basis: "estimated",
      ambiguous: false,
    });
  });

  it("names film-rate audio against a PAL video", () => {
    const audioDuration = 1440 * (25 / 23.976);
    expect(estimateFpsFromDurations(audioDuration, 1440, 25)).toEqual({
      fps: 23.976,
      videoFps: 25,
      basis: "estimated",
      // 24 is 0.1% from 23.976 and so also fits; the two take different
      // stretch ratios against 25, so the caller has to be told.
      ambiguous: true,
    });
  });

  it("reports the video's own rate when the durations match", () => {
    expect(estimateFpsFromDurations(1440, 1440, 23.976)).toEqual({
      fps: 23.976,
      videoFps: 23.976,
      basis: "estimated",
      ambiguous: false,
    });
  });

  it("absorbs a couple of seconds of padding without inventing a conversion", () => {
    // Two seconds across a 24-minute episode is 0.14% -- larger than the gap
    // between 23.976 and 24, so this must not be read as a rate change.
    expect(estimateFpsFromDurations(1442, 1440, 23.976)?.fps).toBe(23.976);
    expect(estimateFpsFromDurations(1438, 1440, 23.976)?.fps).toBe(23.976);
  });

  it("gives up when no common rate fits, rather than guessing", () => {
    // A different cut: 10% shorter matches nothing in the table.
    expect(estimateFpsFromDurations(1296, 1440, 23.976)).toBeNull();
  });

  it("gives up when an input is missing", () => {
    expect(estimateFpsFromDurations(undefined, 1440, 23.976)).toBeNull();
    expect(estimateFpsFromDurations(1440, undefined, 23.976)).toBeNull();
    expect(estimateFpsFromDurations(1440, 1440, undefined)).toBeNull();
    expect(estimateFpsFromDurations(0, 1440, 23.976)).toBeNull();
  });
});

describe("audioFpsFor", () => {
  it("prefers the engine's diagnosed rate over the duration estimate", () => {
    const file = makeAudio({
      // Durations that on their own would say "same rate as the video".
      durationSeconds: 1440,
      measuredDelay: makeMeasured({ isRateMismatch: true, rateSourceFps: 25, rateTargetFps: 23.976 }),
    });
    expect(audioFpsFor(file, makeVideo())).toEqual({
      fps: 25,
      videoFps: 23.976,
      basis: "measured",
      ambiguous: false,
    });
  });

  it("treats a clean measurement with no mismatch as the video's rate", () => {
    const file = makeAudio({ measuredDelay: makeMeasured() });
    expect(audioFpsFor(file, makeVideo())).toEqual({
      fps: 23.976,
      videoFps: 23.976,
      basis: "measured",
      ambiguous: false,
    });
  });

  it("does not read a rate out of a likely-cut pair", () => {
    // A different cut drifts for reasons that say nothing about frame rates,
    // and its durations do not match either, so there is no answer at all.
    const file = makeAudio({
      durationSeconds: 1296,
      measuredDelay: makeMeasured({ isLikelyCut: true }),
    });
    expect(audioFpsFor(file, makeVideo())).toBeNull();
  });

  it("falls back to durations when the measurement errored", () => {
    const file = makeAudio({
      durationSeconds: 1440 * (23.976 / 25),
      measuredDelay: makeMeasured({ error: "ffprobe failed" }),
    });
    expect(audioFpsFor(file, makeVideo())).toEqual({
      fps: 25,
      videoFps: 23.976,
      basis: "estimated",
      ambiguous: false,
    });
  });

  it("has no answer for an audio file that is not matched to a video", () => {
    expect(audioFpsFor(makeAudio(), undefined)).toBeNull();
  });

  it("has no answer when neither the video nor a measurement knows the rate", () => {
    expect(audioFpsFor(makeAudio(), makeVideo({ fps: undefined }))).toBeNull();
  });

  it("falls back to the measurement's own copy of the video rate", () => {
    // A video whose fps never made it into state still has one; the engine
    // reports what it measured against, and without it the badge could only
    // say half the sentence.
    const file = makeAudio({
      measuredDelay: makeMeasured({
        isRateMismatch: true,
        rateSourceFps: 25,
        rateTargetFps: 23.976,
      }),
    });
    expect(audioFpsFor(file, makeVideo({ fps: undefined }))).toEqual({
      fps: 25,
      videoFps: 23.976,
      basis: "measured",
      ambiguous: false,
    });
  });
});

describe("needsRateChange", () => {
  it("is false for audio already at the video's rate", () => {
    expect(
      needsRateChange({ fps: 23.976, videoFps: 23.976, basis: "measured", ambiguous: false }),
    ).toBe(false);
  });

  it("is true for the 0.1% pair, which is a real conversion despite being small", () => {
    expect(
      needsRateChange({ fps: 24, videoFps: 23.976, basis: "measured", ambiguous: false }),
    ).toBe(true);
  });
});

describe("rateChangeFor", () => {
  it("gives the exact stretch between the two rates", () => {
    // 24fps-timed audio on a 23.976fps video has to be slowed by 1001/1000.
    expect(
      rateChangeFor({ fps: 24, videoFps: 23.976, basis: "measured", ambiguous: false }),
    ).toMatchObject({ num: 1001, den: 1000 });
  });

  it("has nothing to give when no change is needed", () => {
    expect(
      rateChangeFor({ fps: 25, videoFps: 25, basis: "measured", ambiguous: false }),
    ).toBeNull();
  });
});
