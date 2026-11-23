import { describe, expect, it } from "vitest";
import type { VerificationReport } from "@/shared/types/verify";
import { HISTORY_KEY, MAX_HISTORY, loadHistory, muxFileLine, muxOutcome, runName, saveHistory, timeLeftText, tookText, whenText, type HistoryEntry } from "./history";

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

const report = (statuses: ("pass" | "warn" | "fail" | "skip")[]): VerificationReport => ({
  ok: !statuses.includes("fail"),
  checks: statuses.map((status, i) => ({ id: `c${i}`, label: i === 0 ? "Sync: Ep.hin.eac3" : `Check ${i}`, status, detail: status === "pass" ? "Fine" : `Detail ${i}` })),
});

describe("verification in History", () => {
  it("adds how the checks went to the run's outcome", () => {
    expect(muxOutcome([{ status: "completed", verification: report(["pass"]) }, { status: "completed", verification: report(["pass", "skip"]) }])).toEqual({
      tone: "ok",
      parts: ["2 muxed", "2 verified"],
    });
    // A warning is worth a look: the run is not plain green.
    expect(muxOutcome([{ status: "completed", verification: report(["warn", "pass"]) }, { status: "completed", verification: report(["pass"]) }])).toEqual({
      tone: "warn",
      parts: ["2 muxed", "2 verified", "1 with warnings"],
    });
  });

  it("says a failure was a failed verification only when every failure was one", () => {
    const failedCheck = { status: "error" as const, verification: report(["fail"]) };
    expect(muxOutcome([{ status: "completed", verification: report(["pass"]) }, failedCheck])).toEqual({ tone: "warn", parts: ["1 muxed", "1 failed verification", "1 verified"] });
    expect(muxOutcome([failedCheck, { status: "error" }]).parts).toEqual(["0 muxed", "2 failed"]);
  });

  it("gives each file its verification line", () => {
    expect(muxFileLine({ status: "completed", verification: report(["pass"]) })).toEqual({ tone: "ok", text: "Muxed and verified" });
    expect(muxFileLine({ status: "completed", verification: report(["warn"]) })).toEqual({ tone: "warn", text: "Muxed, verified with warnings: Sync: Ep.hin.eac3: Detail 0" });
    expect(muxFileLine({ status: "completed" })).toEqual({ tone: "ok", text: "Muxed" });
    expect(muxFileLine({ status: "error", errorMessage: "Verification failed: Ep.hin.eac3 plays 1317 ms late", verification: report(["fail"]) })).toEqual({
      tone: "bad",
      text: "Verification failed: Ep.hin.eac3 plays 1317 ms late",
    });
    expect(muxFileLine({ status: "stopped" })).toEqual({ tone: "warn", text: "Stopped" });
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
