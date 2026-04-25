import { describe, expect, it } from "vitest";
import type { ExternalFile, MuxJob, VideoFile } from "@/shared/types";
import { buildMuxJobRequests } from "./muxJobBuilder";

const makeVideo = (id: string, name: string): VideoFile => ({
  id,
  name,
  path: `/videos/${name}`,
  size: 100,
  status: "pending",
  tracks: [],
});

const makeQueuedJob = (videoFile: VideoFile): MuxJob => ({
  id: `job-${videoFile.id}`,
  videoFile,
  status: "queued",
  progress: 0,
  sizeBefore: videoFile.size,
});

const makeAudio = (id: string, name: string, matchedVideoId?: string): ExternalFile => ({
  id,
  name,
  path: `/audio/${name}`,
  type: "audio",
  matchedVideoId,
});

describe("buildMuxJobRequests", () => {
  it("builds requests only for queued jobs and keeps each matched audio with its video", () => {
    const videos = [
      makeVideo("v1", "Show.S01E01.mkv"),
      makeVideo("v2", "Show.S01E02.mkv"),
      makeVideo("v3", "Show.S01E03.mkv"),
    ];

    const requests = buildMuxJobRequests({
      videoFiles: videos,
      jobs: [makeQueuedJob(videos[1]), makeQueuedJob(videos[2])],
      audioFilesByTrack: {
        "1": [
          makeAudio("a1", "Show.S01E01 Hindi.mka", "v1"),
          makeAudio("a2", "Show.S01E02 Tamil.mka", "v2"),
          makeAudio("a3", "Show.S01E03 Telugu.mka", "v3"),
        ],
      },
      subtitleFilesByTrack: {},
      chapterFiles: [],
      attachmentFiles: [],
      perVideoExternal: {},
    });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.video.id)).toEqual(["v2", "v3"]);
    expect(requests[0].audios.map((audio) => audio.id)).toEqual(["a2"]);
    expect(requests[1].audios.map((audio) => audio.id)).toEqual(["a3"]);
  });

  it("does not assign unmatched bulk audio by queue position when no valid video match exists", () => {
    const videos = [
      makeVideo("v1", "Movie.One.mkv"),
      makeVideo("v2", "Movie.Two.mkv"),
    ];

    const requests = buildMuxJobRequests({
      videoFiles: videos,
      jobs: [makeQueuedJob(videos[0]), makeQueuedJob(videos[1])],
      audioFilesByTrack: {
        "1": [makeAudio("a1", "Completely.Unrelated.Audio.mka")],
      },
      subtitleFilesByTrack: {},
      chapterFiles: [],
      attachmentFiles: [],
      perVideoExternal: {},
    });

    expect(requests[0].audios).toEqual([]);
    expect(requests[1].audios).toEqual([]);
  });
});
