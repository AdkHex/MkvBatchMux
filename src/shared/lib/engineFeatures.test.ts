import { describe, expect, it } from "vitest";
import type { ConformResultEvent, SubsyncResultEvent } from "@/shared/types/engineFeatures";
import {
  conformStatus,
  isLowScore,
  isPureOffset,
  subsyncAction,
  subsyncDelaySeconds,
  toConformedTrack,
} from "./engineFeatures";

function conformResult(overrides: Partial<ConformResultEvent> = {}): ConformResultEvent {
  return {
    runId: "c1",
    key: "a1",
    outputPath: "/d/MKVBatchMux conformed/Show.S01E02.Hindi.conformed.mka",
    mode: "lossless",
    codec: "eac3",
    verified: true,
    verificationText: "Checked against the video: the dub sits within one 32 ms frame throughout (-8.0 to +13.4 ms).",
    residualMs: 13.4,
    plan: null,
    description: null,
    error: null,
    fallbackReason: null,
    ...overrides,
  };
}

/** The engine's answer for the test season's E01 subtitle (planted 2.5 s late). */
function subsyncResult(overrides: Partial<SubsyncResultEvent> = {}): SubsyncResultEvent {
  return {
    runId: "s1",
    key: "sub-1",
    offsetS: -2.5003,
    ratio: 1,
    splits: 0,
    score: 1,
    method: "subtitle",
    description: "Matched against the reference subtitle (high confidence, score 1.00): shifted by -2.500 s.",
    retimedPath: "/s/MKVBatchMux synced/Show.S01E01.synced.en.srt",
    error: null,
    applied: true,
    confidence: "high",
    framerate: null,
    splitPoints: [],
    warnings: [],
    ...overrides,
  };
}

describe("conform results", () => {
  it("reads verified, unverified, unchecked and failed", () => {
    expect(conformStatus(conformResult())).toBe("verified");
    expect(conformStatus(conformResult({ verified: false }))).toBe("unverified");
    expect(conformStatus(conformResult({ verified: null }))).toBe("unchecked");
    expect(conformStatus(conformResult({ error: "mkvmerge: …", outputPath: null }))).toBe("failed");
    expect(conformStatus(conformResult({ outputPath: null }))).toBe("failed");
  });

  it("keeps what the file needs to mux the conformed track instead", () => {
    const track = toConformedTrack(conformResult({ mode: "render", fallbackReason: "speed" }), 1, "2026-11-20T00:00:00.000Z");
    expect(track).toEqual({
      path: "/d/MKVBatchMux conformed/Show.S01E02.Hindi.conformed.mka",
      mode: "render",
      codec: "eac3",
      verified: true,
      verificationText: expect.stringContaining("within one 32 ms frame"),
      residualMs: 13.4,
      sourceTrack: 1,
      createdAt: "2026-11-20T00:00:00.000Z",
    });
    expect(toConformedTrack(conformResult({ error: "failed" }), 0)).toBeNull();
  });
});

describe("subtitle delays", () => {
  it("keeps the engine's sign: a subtitle 2.5 s late needs -2.5 s", () => {
    expect(subsyncDelaySeconds({ offsetS: -2.5003 })).toBe(-2.5);
    expect(subsyncDelaySeconds({ offsetS: 1.1997 })).toBe(1.2);
    expect(Object.is(subsyncDelaySeconds({ offsetS: -0.0004 }), 0)).toBe(true);
    expect(subsyncDelaySeconds({ offsetS: null })).toBeNull();
  });

  it("calls a ratio within 1e-4 of 1 with no splits a pure offset", () => {
    expect(isPureOffset({ ratio: 1, splits: 0 })).toBe(true);
    expect(isPureOffset({ ratio: 1.00009, splits: 0 })).toBe(true);
    expect(isPureOffset({ ratio: 25 / 23.976, splits: 0 })).toBe(false);
    expect(isPureOffset({ ratio: 1, splits: 2 })).toBe(false);
    expect(isPureOffset({ ratio: null, splits: 0 })).toBe(false);
  });

  it("applies a pure offset as a delay", () => {
    expect(subsyncAction(subsyncResult())).toEqual({ kind: "delay", delaySeconds: -2.5, lowScore: false });
  });

  it("uses the re-timed copy for a frame-rate change or splits", () => {
    const pal = subsyncResult({ offsetS: -0.0723, ratio: 1.0427083333333333, framerate: "25 → 23.976" });
    expect(subsyncAction(pal)).toEqual({
      kind: "retimed",
      retimed: {
        path: "/s/MKVBatchMux synced/Show.S01E01.synced.en.srt",
        offsetS: -0.0723,
        ratio: 1.0427083333333333,
        splits: 0,
        score: 1,
      },
      lowScore: false,
    });
    const split = subsyncResult({ splits: 1, splitPoints: [{ atS: 600, offsetS: 4.1 }] });
    expect(subsyncAction(split).kind).toBe("retimed");
    expect(subsyncAction({ ...split, retimedPath: null }).kind).toBe("error");
  });

  it("shows a low score without filling it in", () => {
    expect(isLowScore({ score: 0.3, confidence: "medium" })).toBe(true);
    expect(isLowScore({ score: 0.9, confidence: "low" })).toBe(true);
    expect(isLowScore({ score: null, confidence: null })).toBe(true);
    expect(subsyncAction(subsyncResult({ score: 0.3, confidence: "medium" }))).toEqual({
      kind: "delay",
      delaySeconds: -2.5,
      lowScore: true,
    });
  });

  it("applies nothing without a clear match, and passes errors through", () => {
    const none = subsyncResult({ applied: false, offsetS: null, ratio: null, retimedPath: null, description: "No clear match…" });
    expect(subsyncAction(none)).toEqual({ kind: "noMatch", message: "No clear match…" });
    const picture = subsyncResult({ error: "Can't be synced automatically: this subtitle is pictures (PGS/VobSub), not text." });
    expect(subsyncAction(picture)).toEqual({ kind: "error", message: expect.stringContaining("Can't be synced automatically") });
  });
});
