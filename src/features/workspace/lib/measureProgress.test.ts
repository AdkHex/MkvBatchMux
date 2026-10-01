import { describe, expect, it } from "vitest";

import { pairDone, pairMoved, runFraction, type RunProgress } from "./measureProgress";

const start: RunProgress = { processed: 0, total: 5, active: {} };

describe("measure progress", () => {
  it("tracks every pair in flight, not only the last one named", () => {
    let progress = pairMoved(start, "E01.mkv", 0, new Set());
    progress = pairMoved(progress, "E02.mkv", 0, new Set());
    progress = pairMoved(progress, "E01.mkv", 50, new Set());
    expect(progress.active).toEqual({ "E01.mkv": 50, "E02.mkv": 0 });
  });

  it("drops a pair once it is done, and ignores its late events", () => {
    let progress = pairMoved(start, "E01.mkv", 80, new Set());
    progress = pairDone(progress, "E01.mkv", 1, 5);
    expect(progress.active).toEqual({});
    expect(pairMoved(progress, "E01.mkv", 100, new Set(["E01.mkv"])).active).toEqual({});
  });

  it("counts the pairs in flight by how far along they are", () => {
    const progress: RunProgress = { processed: 2, total: 5, active: { "E03.mkv": 50, "E04.mkv": 50 } };
    expect(runFraction(progress)).toBeCloseTo(0.6);
    expect(runFraction({ processed: 0, total: 0, active: {} })).toBe(0);
  });
});
