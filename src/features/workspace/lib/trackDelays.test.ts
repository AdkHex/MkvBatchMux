import { describe, expect, it } from "vitest";
import type { ExternalFile, Track } from "@/shared/types";
import { shownTrackDelay, trackDelays } from "./trackDelays";

const audio = (id: string, language: string): Track => ({ id, type: "audio", language, codec: "E-AC3" });

const threeDubs = (overrides: Partial<ExternalFile> = {}): ExternalFile => ({
  id: "a1",
  name: "Iron Giant.3Audio.mkv",
  path: "/a/Iron Giant.3Audio.mkv",
  type: "audio",
  delay: 0.05,
  tracks: [{ id: "0", type: "video" }, audio("1", "hin"), audio("2", "tam"), audio("3", "tel")],
  ...overrides,
});

describe("trackDelays", () => {
  it("gives each muxed track the delay the mux will use", () => {
    const file = threeDubs({
      includedTrackIds: [1, 3],
      trackOverrides: { 1: { delay: -0.12, delayProvenance: "measured" }, 3: { pendingDelay: 0.3 } },
    });

    const entries = trackDelays(file);

    // Tamil (2) is not muxed, so it is not listed.
    expect(entries.map((entry) => [entry.trackId, entry.index, entry.track.language])).toEqual([
      [1, 0, "hin"],
      [3, 2, "tel"],
    ]);
    // Hindi has its own; Telugu still falls back to the file's, as main.rs does.
    expect(entries.map((entry) => [entry.delay, entry.own])).toEqual([
      [-0.12, true],
      [0.05, false],
    ]);
    // A measurement waiting to be applied is what the list shows.
    expect(entries.map(shownTrackDelay)).toEqual([-0.12, 0.3]);
  });

  it("lists every audio track when the file has no inclusion list", () => {
    expect(trackDelays(threeDubs()).map((entry) => entry.trackId)).toEqual([1, 2, 3]);
  });
});
