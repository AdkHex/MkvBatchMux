import { describe, expect, it } from "vitest";
import { HISTORY_KEY, MAX_HISTORY, loadHistory, muxOutcome, runName, saveHistory, timeLeftText, tookText, whenText, type HistoryEntry } from "./history";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

const entry = (id: string): HistoryEntry => ({ id, page: "mux", name: "x", outcome: { tone: "ok", text: "1 muxed" }, date: "2026-09-30T10:00:00.000Z" });

describe("history storage", () => {
  it("keeps the newest runs and drops what does not parse", () => {
    const store = memory();
    const kept = saveHistory(Array.from({ length: MAX_HISTORY + 5 }, (_, i) => entry(String(i))), store);
    expect(kept).toHaveLength(MAX_HISTORY);
    expect(loadHistory(store)[0].id).toBe("0");
    store.setItem(HISTORY_KEY, JSON.stringify([entry("a"), { id: 1 }, null, "x"]));
    expect(loadHistory(store).map((e) => e.id)).toEqual(["a"]);
    store.setItem(HISTORY_KEY, "{not json");
    expect(loadHistory(store)).toEqual([]);
  });
});

describe("muxOutcome", () => {
  it("says how many muxed and failed", () => {
    expect(muxOutcome([{ status: "completed" }, { status: "completed" }])).toEqual({ tone: "ok", parts: ["2 muxed"] });
    expect(muxOutcome([{ status: "completed" }, { status: "error" }])).toEqual({ tone: "warn", parts: ["1 muxed", "1 failed"] });
    expect(muxOutcome([{ status: "error" }])).toEqual({ tone: "bad", parts: ["0 muxed", "1 failed"] });
  });

  it("leads with Stopped when the user stopped the batch", () => {
    expect(muxOutcome([{ status: "completed" }, { status: "stopped" }, { status: "stopped" }])).toEqual({ tone: "warn", parts: ["Stopped", "1 muxed"] });
  });
});

describe("text helpers", () => {
  it("names a run by its first file", () => {
    expect(runName(["Goblin.S01E01.mkv", "b", "c"])).toBe("Goblin.S01E01 and 2 more");
    expect(runName(["Goblin.S01E01.mkv"])).toBe("Goblin.S01E01");
    expect(runName([])).toBe("Run");
  });

  it("writes when a run finished relative to today", () => {
    const now = new Date(2026, 8, 30, 15, 0);
    expect(whenText(new Date(2026, 8, 30, 11, 5).toISOString(), now)).toBe("Today 11:05");
    expect(whenText(new Date(2026, 8, 29, 22, 40).toISOString(), now)).toBe("Yesterday 22:40");
    expect(whenText(new Date(2026, 8, 26, 9, 30).toISOString(), now)).toBe("Sep 26 09:30");
    expect(whenText(new Date(2025, 8, 26, 9, 30).toISOString(), now)).toBe("Sep 26 2025");
    expect(whenText("nope", now)).toBe("Unknown date");
  });

  it("writes durations and time left", () => {
    expect(tookText(42_000)).toBe("42 s");
    expect(tookText(118_000)).toBe("1m 58s");
    expect(timeLeftText(60_000, 0.5)).toBe("1 min left");
    expect(timeLeftText(10_000, 0.5)).toBe("Under a minute left");
    expect(timeLeftText(1000, 0.5)).toBeNull();
    expect(timeLeftText(60_000, 0)).toBeNull();
  });
});
