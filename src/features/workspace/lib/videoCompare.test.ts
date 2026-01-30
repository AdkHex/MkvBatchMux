import { describe, it, expect } from "vitest";
import { areVideoFilesEquivalent, areVideoListsEquivalent } from "./videoCompare";
import { mergeVideoFiles } from "./videoMerge";
import type { VideoFile } from "@/shared/types";

const file = (over: Partial<VideoFile> = {}): VideoFile => ({
  id: "v1",
  name: "Ep01.mkv",
  path: "H:\\Media\\Show\\Ep01.mkv",
  size: 13_500_000_000,
  status: "pending",
  tracks: [],
  ...over,
});

const makeVideo = (): VideoFile => ({
  id: "video-1",
  name: "sample.mkv",
  path: "/videos/sample.mkv",
  size: 123,
  duration: "00:24:00",
  fps: 23.976,
  status: "pending",
  tracks: [
    {
      id: "track-audio",
      type: "audio",
      language: "hin",
      name: "Hindi",
      isDefault: true,
      action: "keep",
    },
  ],
});

describe("areVideoFilesEquivalent", () => {
  it("returns true for equivalent video files", () => {
    const video = makeVideo();
    expect(areVideoFilesEquivalent(video, { ...video, tracks: [...video.tracks] })).toBe(true);
  });

  it("returns false when a track changes", () => {
    const video = makeVideo();
    expect(
      areVideoFilesEquivalent(video, {
        ...video,
        tracks: [{ ...video.tracks[0], language: "tam" }],
      }),
    ).toBe(false);
  });
});

describe("areVideoListsEquivalent", () => {
  it("ignores ids, which the backend re-mints on every inspect", () => {
    // The same file scanned twice arrives with a different id each time.
    // Treating that as a change re-rendered the whole list on every chunk.
    expect(areVideoListsEquivalent([file()], [file({ id: "different" })])).toBe(true);
  });

  it("notices when inspection fills in duration and fps", () => {
    const inspected = file({ status: "completed", fps: 23.976, duration: "01:05:03" });
    expect(areVideoListsEquivalent([file()], [inspected])).toBe(false);
  });

  it("notices added and removed files", () => {
    expect(areVideoListsEquivalent([file()], [])).toBe(false);
    expect(areVideoListsEquivalent([], [file()])).toBe(false);
  });
});

describe("a scan that stubs then inspects", () => {
  it("ends with one row per file, not two", () => {
    // Regression: a scan emits each file as a pending stub and again once
    // inspected, with a fresh id. The page appended anything whose id it had
    // not seen, so sixteen files became thirty-two.
    const stub = file();
    const inspected = file({ id: "v2", status: "completed", fps: 23.976, duration: "01:05:03" });

    const merged = mergeVideoFiles([stub, inspected]);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(stub.id); // the original id survives
    expect(merged[0].fps).toBe(23.976); // the inspected detail wins
    expect(areVideoListsEquivalent([stub], merged)).toBe(false);
  });
});
