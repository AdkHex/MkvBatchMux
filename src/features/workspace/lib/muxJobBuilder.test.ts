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

  it("never muxes an empty row, in any list", () => {
    const videos = [makeVideo("v1", "Show.S01E01.mkv"), makeVideo("v2", "Show.S01E02.mkv")];
    const gap = (type: ExternalFile["type"], videoId: string): ExternalFile => ({ id: `gap-${videoId}`, name: "", path: "", type, placeholder: true, matchedVideoId: videoId });
    const requests = buildMuxJobRequests({
      videoFiles: videos,
      jobs: videos.map(makeQueuedJob),
      audioFilesByTrack: { "1": [gap("audio", "v1"), makeAudio("a2", "Show.S01E02.mka", "v2")] },
      subtitleFilesByTrack: { "1": [makeSubtitle("s1", "Show.S01E01.srt", "v1"), gap("subtitle", "v2")] },
      chapterFiles: [gap("chapter", "v1")],
      attachmentFiles: [],
      perVideoExternal: { v1: { audios: [gap("audio", "v1")], subtitles: [] } },
    });
    expect(requests.map((request) => request.audios.map((file) => file.id))).toEqual([[], ["a2"]]);
    expect(requests.map((request) => request.subtitles.map((file) => file.id))).toEqual([["s1"], []]);
    expect(requests.map((request) => request.chapters)).toEqual([[], []]);
    expect(requests.flatMap((request) => [...request.audios, ...request.subtitles]).every((file) => file.path)).toBe(true);
  });

  it("matches an unlinked file by season and episode, not by episode alone", () => {
    const videos = [makeVideo("v1", "Show.S01E03.mkv"), makeVideo("v2", "Show.S02E03.mkv")];
    const requests = buildMuxJobRequests({
      videoFiles: videos,
      jobs: videos.map(makeQueuedJob),
      audioFilesByTrack: { "1": [makeAudio("a1", "Show.S02E03.Hindi.mka")] },
      subtitleFilesByTrack: {},
      chapterFiles: [],
      attachmentFiles: [],
      perVideoExternal: {},
    });
    expect(requests.map((request) => request.audios.map((file) => file.id))).toEqual([[], ["a1"]]);
  });
});

describe("conformed dubs and re-timed subtitles", () => {
  const video = makeVideo("v2", "Show.S01E02.mkv");
  const build = (audio: ExternalFile[], subtitles: ExternalFile[] = [], videos: VideoFile[] = [video]) =>
    buildMuxJobRequests({
      videoFiles: videos,
      jobs: videos.map(makeQueuedJob),
      audioFilesByTrack: { "1": audio },
      subtitleFilesByTrack: { "1": subtitles },
      chapterFiles: [],
      attachmentFiles: [],
      perVideoExternal: {},
    });
  const conformed = (overrides: Partial<NonNullable<ExternalFile["conformed"]>> = {}): NonNullable<ExternalFile["conformed"]> => ({
    path: "/audio/MKVBatchMux conformed/Show.S01E02.Hindi.conformed.eac3",
    mode: "render",
    codec: "eac3",
    verified: true,
    verificationText: "Checked against the video.",
    residualMs: -0.15,
    sourceTrack: 0,
    createdAt: "2026-11-23T10:00:00.000Z",
    videoPath: video.path,
    ...overrides,
  });

  it("muxes a conformed dub's own track instead of the file, at delay 0", () => {
    const dub: ExternalFile = {
      ...makeAudio("a2", "Show.S01E02.Hindi.eac3", "v2"),
      language: "hin",
      trackName: "Hindi",
      isDefault: true,
      delay: -0.84,
      pendingDelay: -0.84,
      stretch: { num: 25, den: 24 },
      tracks: [{ id: "0", type: "audio", codec: "E-AC3", language: "hin" }],
      includedTrackIds: [0],
      trackOverrides: { 0: { delay: 0.5, language: "hin", trackName: "Hindi 5.1" } },
      conformed: conformed(),
    };
    const [request] = build([dub]);
    const muxed = request.audios[0];
    expect(muxed.path).toBe("/audio/MKVBatchMux conformed/Show.S01E02.Hindi.conformed.eac3");
    expect(muxed.name).toBe("Show.S01E02.Hindi.conformed.eac3");
    expect(muxed.delay).toBe(0);
    expect(muxed.trackId).toBe(0);
    expect(muxed.includedTrackIds).toEqual([0]);
    expect(muxed.tracks).toEqual([{ id: "0", type: "audio", codec: "eac3", language: "hin" }]);
    // Its name and language, never a delay or stretch: the track already sits on the video's timeline.
    expect(muxed.trackOverrides).toEqual({ 0: { language: "hin", trackName: "Hindi 5.1" } });
    expect(muxed.stretch).toBeUndefined();
    expect(muxed.pendingDelay).toBeUndefined();
    expect(muxed.conformed).toBeUndefined();
    expect([muxed.language, muxed.trackName, muxed.isDefault]).toEqual(["hin", "Hindi", true]);
  });

  it("re-keys the overrides of the one track a container's conform was made from", () => {
    const container: ExternalFile = {
      ...makeAudio("a2", "Show.S01E02.3Audio.mkv", "v2"),
      tracks: [
        { id: "0", type: "video" },
        { id: "1", type: "audio", codec: "E-AC3", language: "hin" },
        { id: "2", type: "audio", codec: "AAC", language: "tam", name: "Tamil" },
        { id: "3", type: "subtitle", codec: "SubRip/SRT", language: "eng" },
      ],
      includedTrackIds: [2],
      includeSubtitles: true,
      includedSubtitleTrackIds: [3],
      trackOverrides: { 1: { language: "hin", delay: 1 }, 2: { language: "tam", trackName: "Tamil dub", delay: 1.2, stretch: { num: 25, den: 24 } } },
      conformed: conformed({ path: "/c/Show.S01E02.3Audio.track2.conformed.m4a", codec: "aac", sourceTrack: 1 }),
    };
    const muxed = build([container])[0].audios[0];
    expect(muxed.path).toBe("/c/Show.S01E02.3Audio.track2.conformed.m4a");
    expect(muxed.tracks).toEqual([{ id: "0", type: "audio", codec: "aac", language: "tam", name: "Tamil" }]);
    expect(muxed.trackOverrides).toEqual({ 0: { language: "tam", trackName: "Tamil dub" } });
    expect(muxed.includeSubtitles).toBe(false);
    expect(muxed.includedSubtitleTrackIds).toEqual([]);
    expect(muxed.delay).toBe(0);
  });

  it("muxes the original when the conform was made for another video", () => {
    const dub: ExternalFile = { ...makeAudio("a2", "Show.S01E02.Hindi.eac3", "v2"), delay: 1.312, conformed: conformed({ videoPath: "/videos/Show.S01E05.mkv" }) };
    const muxed = build([dub])[0].audios[0];
    expect(muxed.path).toBe("/audio/Show.S01E02.Hindi.eac3");
    expect(muxed.delay).toBe(1.312);
  });

  it("muxes a re-timed subtitle copy at delay 0, keeping its language, name and flags", () => {
    const subtitle: ExternalFile = {
      ...makeSubtitle("s3", "Show.S01E03.en.srt", "v2"),
      language: "eng",
      trackName: "English",
      isForced: true,
      delay: 2.5,
      pendingDelay: 2.5,
      tracks: [{ id: "0", type: "subtitle", codec: "SubRip/SRT", language: "eng" }],
      includedTrackIds: [0],
      trackOverrides: { 0: { delay: 0.3, trackName: "English (synced)" } },
      retimed: { path: "/subtitles/MKVBatchMux synced/Show.S01E03.en.synced.srt", offsetS: -0.072, ratio: 1.0427, splits: 0, score: 1, videoPath: video.path },
    };
    const muxed = build([], [subtitle])[0].subtitles[0];
    expect(muxed.path).toBe("/subtitles/MKVBatchMux synced/Show.S01E03.en.synced.srt");
    expect(muxed.delay).toBe(0);
    expect(muxed.includedTrackIds).toEqual([0]);
    expect(muxed.tracks).toEqual([{ id: "0", type: "subtitle", codec: "SubRip/SRT", language: "eng" }]);
    expect(muxed.trackOverrides).toEqual({ 0: { trackName: "English (synced)" } });
    expect([muxed.language, muxed.trackName, muxed.isForced]).toEqual(["eng", "English", true]);
    expect(muxed.retimed).toBeUndefined();
  });

  it("muxes the original subtitle when its re-timed copy was made for another video", () => {
    const subtitle: ExternalFile = {
      ...makeSubtitle("s3", "Show.S01E03.en.srt", "v2"),
      delay: 0.25,
      retimed: { path: "/s/x.synced.srt", offsetS: 0, ratio: 1.0427, splits: 0, score: 1, videoPath: "/videos/Show.S01E09.mkv" },
    };
    const muxed = build([], [subtitle])[0].subtitles[0];
    expect(muxed.path).toBe("/subtitles/Show.S01E03.en.srt");
    expect(muxed.delay).toBe(0.25);
  });
});

