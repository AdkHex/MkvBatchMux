import { describe, expect, it } from "vitest";
import type { VideoFile } from "@/shared/types";
import { areVideoFilesEquivalent } from "./videoCompare";

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
