import { describe, expect, it } from "vitest";
import type { ExternalFile } from "@/shared/types";
import { rowsWithFile, shareSettings } from "./editScope";

const PATH = "/a/The.Butchers.Blade.2026.AMZN.WEB-DL.Multi.DDP5.1-4kHdHub.Com.mkv";

/** The same three-dub file on a row of its own, measured against that row's video. */
const row = (id: string, delays: [number, number, number], overrides: Partial<ExternalFile> = {}): ExternalFile => ({
  id,
  name: "The.Butchers.Blade.2026.AMZN.WEB-DL.Multi.DDP5.1-4kHdHub.Com.mkv",
  path: PATH,
  type: "audio",
  delay: 0,
  tracks: [
    { id: "1", type: "audio", language: "hin", codec: "E-AC-3" },
    { id: "2", type: "audio", language: "tam", codec: "E-AC-3" },
    { id: "3", type: "audio", language: "tel", codec: "E-AC-3" },
    { id: "4", type: "subtitle", language: "eng", codec: "SubRip/SRT", name: "SDH" },
  ],
  includedTrackIds: [1, 2, 3],
  includeSubtitles: true,
  includedSubtitleTrackIds: [4],
  trackOverrides: {
    1: { delay: delays[0], delayProvenance: "measured" },
    2: { delay: delays[1], delayProvenance: "measured" },
    3: { delay: delays[2], delayProvenance: "measured", stretch: { num: 25025, den: 24000 } },
  },
  ...overrides,
});

describe("rowsWithFile", () => {
  it("finds every row holding the same file, in list order", () => {
    const files = [row("r1", [3.998, 3.998, 3.998]), { ...row("x", [0, 0, 0]), path: "/a/other.mka" }, row("r3", [-4.997, -4.997, -4.997])];
    expect(rowsWithFile(files, "r3")).toEqual([0, 2]);
    expect(rowsWithFile(files, "x")).toEqual([1]);
    expect(rowsWithFile(files, "missing")).toEqual([]);
  });
});

describe("shareSettings", () => {
  it("passes the subtitle and track choices on, and keeps the other row's delays", () => {
    const edited = row("r1", [3.998, 3.997, 3.996], {
      includeSubtitles: false,
      includedSubtitleTrackIds: [],
      includedTrackIds: [1, 3],
      trackOverrides: {
        1: { delay: 3.998, delayProvenance: "measured" },
        3: { delay: 3.996, delayProvenance: "measured", language: "tel", trackName: "Telugu DD+ 5.1" },
      },
    });
    const other = row("r3", [-4.997, -4.996, -4.995]);

    const shared = shareSettings(edited, other);

    expect(shared.includeSubtitles).toBe(false);
    expect(shared.includedSubtitleTrackIds).toEqual([]);
    expect(shared.includedTrackIds).toEqual([1, 3]);
    expect(shared.trackOverrides?.[3]).toMatchObject({ trackName: "Telugu DD+ 5.1", language: "tel" });
    // Each row is paired with its own video: its delays, provenance and stretch stay its own.
    expect([1, 2, 3].map((id) => shared.trackOverrides?.[id].delay)).toEqual([-4.997, -4.996, -4.995]);
    expect(shared.trackOverrides?.[3].stretch).toEqual({ num: 25025, den: 24000 });
    expect(shared.trackOverrides?.[2].delayProvenance).toBe("measured");
    expect(shared.id).toBe("r3");
    expect(shared.isManuallyEdited).toBe(true);
  });

  it("clears a track name the edited row no longer has", () => {
    const edited = row("r1", [0, 0, 0]);
    const other = row("r3", [1, 1, 1], { trackOverrides: { 2: { delay: 1, trackName: "Old name" } } });
    expect(shareSettings(edited, other).trackOverrides?.[2]).toEqual({ delay: 1, language: undefined, trackName: undefined });
  });
});
