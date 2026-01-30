import { describe, expect, it } from "vitest";
import type { VideoFile } from "@/shared/types";
import { mergeVideoFiles, normalizeVideoIdentity } from "./videoMerge";

const makeVideo = (overrides: Partial<VideoFile>): VideoFile => ({
  id: "video-1",
  name: "Scared.Rider.Xechs.S01E01.2016.1080p.BluRay.x264.FLAC.2.0-ADE.mkv",
  path: "\\\\IONICBOY\\Pending\\Scared.Rider.Xechs.S01.2016.1080p.BluRay.x264.FLAC.2.0-ADE\\Scared.Rider.Xechs.S01E01.2016.1080p.BluRay.x264.FLAC.2.0-ADE.mkv",
  size: 1589137892,
  status: "pending",
  tracks: [],
  ...overrides,
});

describe("video merge helpers", () => {
  it("normalizes extended UNC paths to the same identity as normal UNC paths", () => {
    expect(
      normalizeVideoIdentity(
        "\\\\?\\UNC\\IONICBOY\\Pending\\Show\\Episode.mkv",
      ),
    ).toBe(normalizeVideoIdentity("\\\\IONICBOY\\Pending\\Show\\Episode.mkv"));
  });

  it("merges scan placeholders with streamed media info instead of appending duplicates", () => {
    const placeholder = makeVideo({ id: "placeholder" });
    const inspected = makeVideo({
      id: "inspected",
      path: "\\\\?\\UNC\\IONICBOY\\Pending\\Scared.Rider.Xechs.S01.2016.1080p.BluRay.x264.FLAC.2.0-ADE\\Scared.Rider.Xechs.S01E01.2016.1080p.BluRay.x264.FLAC.2.0-ADE.mkv",
      status: "completed",
      duration: "00:23:57",
      fps: 23.976,
      tracks: [{ id: "0", type: "video", codec: "AVC" }],
    });

    expect(mergeVideoFiles([placeholder, inspected])).toEqual([
      {
        ...inspected,
        id: "placeholder",
      },
    ]);
  });

  it("keeps same-name videos from different folders separate when their sizes differ", () => {
    const first = makeVideo({
      id: "first",
      path: "/shows/a/Episode.mkv",
      name: "Episode.mkv",
      size: 100,
    });
    const second = makeVideo({
      id: "second",
      path: "/shows/b/Episode.mkv",
      name: "Episode.mkv",
      size: 200,
    });

    expect(mergeVideoFiles([first, second])).toHaveLength(2);
  });

  it("keeps same-name videos from different folders separate when sizes are unknown", () => {
    // A dual-audio release: identical filenames under language folders.
    // Unknown size must not be treated as "sizes agree".
    const eng = makeVideo({
      id: "eng",
      path: "/shows/eng/Episode.mkv",
      name: "Episode.mkv",
      size: undefined,
    });
    const jpn = makeVideo({
      id: "jpn",
      path: "/shows/jpn/Episode.mkv",
      name: "Episode.mkv",
      size: undefined,
    });

    const merged = mergeVideoFiles([eng, jpn]);
    expect(merged).toHaveLength(2);
    expect(merged.map((file) => file.path)).toEqual([
      "/shows/eng/Episode.mkv",
      "/shows/jpn/Episode.mkv",
    ]);
  });

  it("keeps distinct siblings in the same folder separate", () => {
    const first = makeVideo({ id: "a", path: "/shows/s1/Ep01.mkv", name: "Ep01.mkv", size: 10 });
    const second = makeVideo({ id: "b", path: "/shows/s1/Ep02.mkv", name: "Ep02.mkv", size: 20 });

    expect(mergeVideoFiles([first, second])).toHaveLength(2);
  });

  it("still merges a relative path with the absolute path of the same file", () => {
    const relative = makeVideo({
      id: "relative",
      path: "Show/Episode.mkv",
      name: "Episode.mkv",
    });
    const absolute = makeVideo({
      id: "absolute",
      path: "/mnt/media/Show/Episode.mkv",
      name: "Episode.mkv",
      status: "completed",
    });

    const merged = mergeVideoFiles([relative, absolute]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("relative");
    expect(merged[0].path).toBe("/mnt/media/Show/Episode.mkv");
  });
});
