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

const makeSubtitle = (
  id: string,
  name: string,
  matchedVideoId?: string,
  muxAfter?: string,
): ExternalFile => ({
  id,
  name,
  path: `/subtitles/${name}`,
  type: "subtitle",
  matchedVideoId,
  muxAfter,
});

const makeAttachment = (id: string, name: string): ExternalFile => ({
  id,
  name,
  path: `/attachments/${name}`,
  type: "attachment",
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

  it("adds attachment files globally to every queued video", () => {
    const videos = [
      makeVideo("v1", "Show.S01E01.mkv"),
      makeVideo("v2", "Show.S01E02.mkv"),
    ];
    const attachments = [
      makeAttachment("att1", "Font-Regular.ttf"),
      makeAttachment("att2", "Signs.otf"),
    ];

    const requests = buildMuxJobRequests({
      videoFiles: videos,
      jobs: [makeQueuedJob(videos[0]), makeQueuedJob(videos[1])],
      audioFilesByTrack: {},
      subtitleFilesByTrack: {},
      chapterFiles: [],
      attachmentFiles: attachments,
      perVideoExternal: {},
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].attachments.map((file) => file.id)).toEqual(["att1", "att2"]);
    expect(requests[1].attachments.map((file) => file.id)).toEqual(["att1", "att2"]);
    expect(requests[0].attachments.every((file) => file.source === "bulk")).toBe(true);
  });

  it("orders subtitle-first files before regular subtitle files", () => {
    const video = makeVideo("v1", "Show.S01E01.mkv");

    const requests = buildMuxJobRequests({
      videoFiles: [video],
      jobs: [makeQueuedJob(video)],
      audioFilesByTrack: {},
      subtitleFilesByTrack: {
        "1": [
          makeSubtitle("regular", "Show.S01E01.Regular.ass", "v1", "audio"),
          makeSubtitle("first", "Show.S01E01.Signs.ass", "v1", "subtitle-first"),
        ],
      },
      chapterFiles: [],
      attachmentFiles: [],
      perVideoExternal: {},
    });

    expect(requests[0].subtitles.map((subtitle) => subtitle.id)).toEqual(["first", "regular"]);
  });
});
