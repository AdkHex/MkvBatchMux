import { describe, expect, it } from "vitest";
import type { ExternalFile, VideoFile } from "@/shared/types";
import {
  assignExternalFileToVideo,
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
});
