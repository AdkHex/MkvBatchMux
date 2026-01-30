import { describe, expect, it } from "vitest";
import type { ExternalFile, VideoFile } from "@/shared/types";
import {
  assignExternalFileToVideo,
  extractEpisodeNumber,
  getUnlinkedExternalFiles,
  linkExternalFilesByOrder,
  matchExternalToVideos,
} from "./matchUtils";

const makeVideo = (id: string, name: string): VideoFile => ({
  id,
  name,
  path: `/videos/${name}`,
  size: 100,
  status: "pending",
  tracks: [],
});

const makeAudio = (id: string, name: string): ExternalFile => ({
  id,
  name,
  path: `/audio/${name}`,
  type: "audio",
});

const makeSubtitle = (id: string, name: string): ExternalFile => ({
  id,
  name,
  path: `/subtitles/${name}`,
  type: "subtitle",
});

describe("matchExternalToVideos", () => {
  it("keeps one-to-one positional pairing when scanned audio names are highly similar", () => {
    const videos = [
      makeVideo("v1", "Flower.of.Evil.E01.2020.1080p.Blu-ray.x265.mkv"),
      makeVideo("v2", "Flower.of.Evil.E02.2020.1080p.Blu-ray.x265.mkv"),
      makeVideo("v3", "Flower.of.Evil.E03.2020.1080p.Blu-ray.x265.mkv"),
    ];

    const audios = [
      makeAudio("a1", "Flower.of.Evil.E01.2020.1080p.Blu-ray.AC3.mka"),
      makeAudio("a2", "Flower.of.Evil.E01.2020.1080p.Blu-ray.AC3 - Copy.mka"),
      makeAudio("a3", "Flower.of.Evil.E01.2020.1080p.Blu-ray.AC3 - Copy (2).mka"),
    ];

    const matched = matchExternalToVideos(audios, videos);
    expect(matched.map((file) => file.matchedVideoId)).toEqual(["v1", "v2", "v3"]);
  });

  it("preserves valid existing explicit matches when requested", () => {
    const videos = [
      makeVideo("v1", "Episode01.mkv"),
      makeVideo("v2", "Episode02.mkv"),
    ];

    const matched = matchExternalToVideos(
      [
        { ...makeAudio("a1", "audio-1.mka"), matchedVideoId: "v2" },
        { ...makeAudio("a2", "audio-2.mka"), matchedVideoId: "v1" },
      ],
      videos,
      true,
    );

    expect(matched.map((file) => file.matchedVideoId)).toEqual(["v2", "v1"]);
  });

  it("keeps one-to-one positional pairing for highly similar subtitle names too", () => {
    const videos = [
      makeVideo("v1", "Flower.of.Evil.E01.2020.1080p.Blu-ray.x265.mkv"),
      makeVideo("v2", "Flower.of.Evil.E02.2020.1080p.Blu-ray.x265.mkv"),
      makeVideo("v3", "Flower.of.Evil.E03.2020.1080p.Blu-ray.x265.mkv"),
    ];

    const subtitles = [
      makeSubtitle("s1", "Flower.of.Evil.E01.2020.1080p.Blu-ray.zh.srt"),
      makeSubtitle("s2", "Flower.of.Evil.E01.2020.1080p.Blu-ray.zh - Copy.srt"),
      makeSubtitle("s3", "Flower.of.Evil.E01.2020.1080p.Blu-ray.zh - Copy (2).srt"),
    ];

    const matched = matchExternalToVideos(subtitles, videos);
    expect(matched.map((file) => file.matchedVideoId)).toEqual(["v1", "v2", "v3"]);
  });

  it("links files by order", () => {
    const videos = [
      makeVideo("v1", "Episode01.mkv"),
      makeVideo("v2", "Episode02.mkv"),
    ];

    const linked = linkExternalFilesByOrder(
      [makeAudio("a1", "Audio01.mka"), makeAudio("a2", "Audio02.mka")],
      videos,
    );

    expect(linked.map((file) => file.matchedVideoId)).toEqual(["v1", "v2"]);
  });

  it("swaps assignments on manual relink", () => {
    const linked = assignExternalFileToVideo(
      [
        { ...makeAudio("a1", "Audio01.mka"), matchedVideoId: "v1" },
        { ...makeAudio("a2", "Audio02.mka"), matchedVideoId: "v2" },
      ],
      "a2",
      "v1",
    );

    expect(linked.map((file) => file.matchedVideoId)).toEqual(["v2", "v1"]);
  });

  it("reports unlinked files", () => {
    const videos = [makeVideo("v1", "Episode01.mkv")];
    const unlinked = getUnlinkedExternalFiles(
      [
        { ...makeAudio("a1", "Audio01.mka"), matchedVideoId: "v1" },
        makeAudio("a2", "Audio02.mka"),
      ],
      videos,
    );

    expect(unlinked.map((file) => file.id)).toEqual(["a2"]);
  });

  it("never assigns the same video to two external files", () => {
    const videos = [makeVideo("v1", "Show.S01E01.mkv"), makeVideo("v2", "Show.S01E02.mkv")];

    // Three externals, only two videos: the third must stay unmatched rather
    // than duplicating a video already claimed.
    const matched = matchExternalToVideos(
      [
        makeAudio("a1", "Show.S01E01.mka"),
        makeAudio("a2", "Show.S01E02.mka"),
        makeAudio("a3", "Show.S01E03.mka"),
      ],
      videos,
    );

    const assigned = matched.map((file) => file.matchedVideoId);
    expect(assigned).toEqual(["v1", "v2", undefined]);

    const claimed = assigned.filter(Boolean);
    expect(new Set(claimed).size).toBe(claimed.length);
  });
});

describe("extractEpisodeNumber", () => {
  it("extracts episode numbers that collide with common frame rates", () => {
    // These were previously unmatchable because 10/24/25/30/50/60 were
    // blanket-listed as "not an episode number".
    expect(extractEpisodeNumber("Show.S01E10.1080p.mkv")).toBe(10);
    expect(extractEpisodeNumber("Show.S01E24.1080p.x264.mkv")).toBe(24);
    expect(extractEpisodeNumber("Show.S01E25.mkv")).toBe(25);
    expect(extractEpisodeNumber("Show.S01E30.mkv")).toBe(30);
    expect(extractEpisodeNumber("Show.S01E50.mkv")).toBe(50);
    expect(extractEpisodeNumber("Show.S01E60.mkv")).toBe(60);
  });

  it("extracts bare episode numbers that collide with frame rates", () => {
    expect(extractEpisodeNumber("Show - 24 [BluRay].mkv")).toBe(24);
    expect(extractEpisodeNumber("Show - 60 (1080p).mkv")).toBe(60);
  });

  it("still rejects resolutions and codec tags", () => {
    expect(extractEpisodeNumber("Movie.1080p.x264.mkv")).toBeNull();
    expect(extractEpisodeNumber("Movie.720p.HEVC.mkv")).toBeNull();
    expect(extractEpisodeNumber("Movie.2160p.mkv")).toBeNull();
  });

  it("does not treat frame rate or channel tags as episode numbers", () => {
    expect(extractEpisodeNumber("Movie.1080p.23.976fps.10bit.mkv")).toBeNull();
    expect(extractEpisodeNumber("Movie.1080p.x265.10bit.mkv")).toBeNull();
  });

  it("prefers an explicit episode marker over technical tokens", () => {
    expect(extractEpisodeNumber("Show.S02E07.2160p.x265.10bit.mkv")).toBe(7);
    expect(extractEpisodeNumber("Show.EP12.1080p.mkv")).toBe(12);
  });
});

describe("linkExternalFilesByOrder", () => {
  it("pairs the nth file with the nth video", () => {
    const videos = [makeVideo("v1", "Episode01.mkv"), makeVideo("v2", "Episode02.mkv")];
    const audios = [makeAudio("a1", "Episode01.eac3"), makeAudio("a2", "Episode02.eac3")];

    const linked = linkExternalFilesByOrder(audios, videos);

    expect(linked.map((file) => file.matchedVideoId)).toEqual(["v1", "v2"]);
  });

  it("leaves files past the end of the video list alone", () => {
    // Regression: these were overwritten with `undefined`, so a batch with
    // more audio than video silently dropped the extras from the mux -- and
    // the relink ran again on every render, never converging.
    const videos = [makeVideo("v1", "Episode01.mkv")];
    const audios = [
      makeAudio("a1", "Episode01.eac3"),
      { ...makeAudio("a2", "Episode02.eac3"), matchedVideoId: "v9" },
    ];

    const linked = linkExternalFilesByOrder(audios, videos);

    expect(linked[0].matchedVideoId).toBe("v1");
    expect(linked[1].matchedVideoId).toBe("v9");
  });
});
