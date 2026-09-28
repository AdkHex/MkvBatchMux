import { describe, expect, it } from "vitest";
import type { ExternalFile, MeasuredDelay } from "@/shared/types";
import type { TimelinePlan, TimelineSegment } from "@/shared/types/audiosync";
import {
  applyTimelineDelay,
  attachTimelineScan,
  canUseTimelineDelay,
  describeCut,
  isRateChange,
  summarizeTimeline,
  timelineDisagreementMs,
} from "./timelineScan";

const dub = (startS: number, endS: number, offsetS: number, uncertaintyS = 0): TimelineSegment => ({
  kind: "dub",
  startS,
  endS,
  sourceStartS: startS + offsetS,
  offsetS,
  match: 0.8,
  note: "",
  uncertaintyS,
});

const fill = (startS: number, endS: number, reason: string, uncertaintyS = 0): TimelineSegment => ({
  kind: "fill",
  startS,
  endS,
  sourceStartS: startS,
  offsetS: null,
  match: null,
  note: "",
  reason,
  uncertaintyS,
});

const plan = (segments: TimelineSegment[], extra: Partial<TimelinePlan> = {}): TimelinePlan => ({
  speed: 1,
  videoDurationS: 3600,
  dubDurationS: 3500,
  videoFps: 24000 / 1001,
  dubRate: 24000 / 1001,
  rateConfirmed: true,
  segments,
  warnings: [],
  error: null,
  summary: { dubUsedShare: 0.99 },
  ...extra,
});

const AT = "2026-09-28T00:00:00.000Z";

describe("summarizeTimeline", () => {
  it("finds no cut in a dub that follows the video in one piece, silences included", () => {
    const scan = summarizeTimeline(
      plan([
        fill(0, 2.633, "head"),
        dub(2.633, 600, -2.633),
        fill(600, 601.5, "silent"),
        dub(601.5, 3600, -2.633),
      ]),
      "table",
      null,
      AT,
    );
    expect(scan.cuts).toEqual([]);
    expect(scan.startOffsetMs).toBeCloseTo(-2633);
    expect(scan.description).toBe("table");
  });

  it("places a missing scene where the dub stops, sized by the gap", () => {
    // The dub lacks 7.5 s at 20:30: the offset drops by the same amount after it.
    const scan = summarizeTimeline(
      plan([dub(0, 1230, -2.633), fill(1230, 1237.5, "cut", 0.2), dub(1237.5, 3600, -10.133)]),
      null,
      null,
      AT,
    );
    expect(scan.cuts).toHaveLength(1);
    expect(scan.cuts[0].atS).toBe(1230);
    expect(scan.cuts[0].jumpMs).toBeCloseTo(-7500);
    expect(scan.cuts[0].missingS).toBeCloseTo(7.5);
    expect(scan.cuts[0].uncertaintyS).toBe(0.2);
    expect(scan.cuts[0].offsetAfterMs).toBeCloseTo(-10133);
    expect(describeCut(scan.cuts[0])).toBe("0:20:30.000 (±0.2s): the dub lacks 7.5s of the video here");
  });

  it("reports a trim of a few frames and ignores measurement noise", () => {
    const scan = summarizeTimeline(
      plan([dub(0, 1000, -1.0), dub(1000, 2000, -1.042), dub(2000, 3600, -1.05)]),
      null,
      null,
      AT,
    );
    // 42 ms is a one-frame trim; the further 8 ms is noise.
    expect(scan.cuts).toHaveLength(1);
    expect(scan.cuts[0].atS).toBe(1000);
    expect(describeCut(scan.cuts[0])).toBe("0:16:40.000: from here the dub plays 42 ms early");
  });

  it("says when the dub carries material the video lacks", () => {
    const scan = summarizeTimeline(plan([dub(0, 100, 0), dub(100, 3600, 12)]), null, null, AT);
    expect(describeCut(scan.cuts[0])).toBe("0:01:40.000: the dub has 12.0s the video lacks");
  });

  it("collects unconfirmed spans and a dub that ends early", () => {
    const scan = summarizeTimeline(
      plan([dub(0, 1000, 0), fill(1000, 1060, "unmatched"), dub(1060, 3480, 0), fill(3480, 3600, "tail")]),
      null,
      null,
      AT,
    );
    expect(scan.cuts).toEqual([]);
    expect(scan.unverified).toEqual([{ startS: 1000, endS: 1060 }]);
    expect(scan.tailS).toBe(120);
  });

  it("recognises a frame-rate change from the speed the dub needed", () => {
    const scan = summarizeTimeline(plan([dub(0, 3600, 0)], { speed: 25 / (24000 / 1001), dubRate: 25 }), null, null, AT);
    expect(isRateChange(scan)).toBe(true);
    expect(isRateChange(summarizeTimeline(plan([dub(0, 3600, 0)]), null, null, AT))).toBe(false);
  });

  it("carries the engine's own edit list and frame-rate guide when it sends them", () => {
    const edits = [{ index: 1, kind: "missing", severity: "moderate", description: "0:10:00.000: the dub is missing 5.000 s" }];
    const rateGuide = { instruction: "Convert the dub from 25 fps to 23.976 fps" };
    const scan = summarizeTimeline(
      plan([dub(0, 600, 2.6), fill(600, 605, "cut"), dub(605, 1500, -2.4)], {
        edits, rateGuide,
      } as unknown as Partial<TimelinePlan>),
      null, null, "t",
    );
    expect(scan.edits).toEqual(edits);
    expect(scan.rateGuide).toEqual(rateGuide);
    expect(scan.cuts).toHaveLength(1);
    // An older plan without them reads exactly as before.
    expect("edits" in summarizeTimeline(plan([dub(0, 600, 2.6)]), null, null, "t")).toBe(false);
  });

  it("keeps an error from either the engine or the plan", () => {
    expect(summarizeTimeline(null, null, "ffprobe failed", AT).error).toBe("ffprobe failed");
    const failed = summarizeTimeline(plan([], { error: "the dub does not match" }), null, null, AT);
    expect(failed.error).toBe("the dub does not match");
    expect(failed.cuts).toEqual([]);
  });
});

const measured = (overrides: Partial<MeasuredDelay> = {}): MeasuredDelay => ({
  engineDelayMs: -2633,
  appliedMs: 2633,
  confidence: 0.9,
  driftMsPerS: 0,
  hasSignificantDrift: false,
  isRateMismatch: false,
  isLikelyCut: false,
  correctionRatio: null,
  rateSourceFps: null,
  rateTargetFps: null,
  rateExplanation: null,
  referenceTrack: 0,
  primaryFps: 23.976,
  measuredAt: AT,
  error: null,
  ...overrides,
});

describe("the lip-sync cross-check", () => {
  const scanAt = (offsetS: number, extra: Partial<TimelinePlan> = {}) =>
    summarizeTimeline(plan([dub(0, 3600, offsetS)], extra), null, null, AT);

  it("agrees within the visibility threshold and offers nothing", () => {
    const record = measured({ timeline: scanAt(-2.61) });
    expect(timelineDisagreementMs(record)).toBeCloseTo(23);
    expect(canUseTimelineDelay(record)).toBe(false);
  });

  it("offers the timeline's delay when the two are visibly apart", () => {
    const record = measured({ engineDelayMs: -21567, timeline: scanAt(-2.633) });
    expect(timelineDisagreementMs(record)).toBeCloseTo(18934);
    expect(canUseTimelineDelay(record)).toBe(true);
  });

  it("offers the timeline's delay when the measurement itself failed", () => {
    expect(canUseTimelineDelay(measured({ error: "no match", timeline: scanAt(-92) }))).toBe(true);
  });

  it("never compares against a dub on a stretched clock", () => {
    const record = measured({ timeline: scanAt(-5, { speed: 1.042708 }) });
    expect(timelineDisagreementMs(record)).toBeNull();
    expect(canUseTimelineDelay(record)).toBe(false);
  });
});

describe("storing and applying a scan", () => {
  const file = (extra: Partial<ExternalFile> = {}): ExternalFile =>
    ({ id: "a1", name: "Hindi.m4a", path: "/a/Hindi.m4a", ...extra }) as ExternalFile;

  it("attaches to the file-level measurement and to a track's", () => {
    const scan = summarizeTimeline(plan([dub(0, 3600, -1)]), null, null, AT);
    expect(attachTimelineScan(file({ measuredDelay: measured() }), null, scan).measuredDelay?.timeline).toBe(scan);
    const tracked = attachTimelineScan(
      file({ trackOverrides: { 2: { measuredDelay: measured(), language: "hin" } } }),
      2,
      scan,
    );
    expect(tracked.trackOverrides?.[2]?.measuredDelay?.timeline).toBe(scan);
    expect(tracked.trackOverrides?.[2]?.language).toBe("hin");
  });

  it("leaves a row alone whose measurement was typed over", () => {
    const scan = summarizeTimeline(plan([dub(0, 3600, -1)]), null, null, AT);
    const manual = file({ delay: 1.5, delayProvenance: "manual" });
    expect(attachTimelineScan(manual, null, scan)).toBe(manual);
  });

  it("writes the opening offset into the delay field as a measured value", () => {
    const scan = summarizeTimeline(plan([dub(0, 3600, -92.4)]), null, null, AT);
    const applied = applyTimelineDelay(file({ measuredDelay: measured({ timeline: scan }) }), null);
    expect(applied.delay).toBe(92.4);
    expect(applied.delayProvenance).toBe("measured");
    expect(applied.pendingDelay).toBeUndefined();
  });
});
