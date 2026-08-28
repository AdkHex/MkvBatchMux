import { describe, expect, it } from "vitest";
import type { ExternalFile, Track, VideoFile } from "@/shared/types";
import {
  buildMeasurementPlan,
  defaultReferenceTrack,
  measurementKey,
  parseMeasurementKey,
} from "./measurePairs";
import { buildMuxJobRequests } from "./muxJobBuilder";

const makeVideo = (id: string, name: string, tracks: Track[] = []): VideoFile => ({
  id,
  name,
  path: `/videos/${name}`,
  size: 100,
  status: "pending",
  tracks,
});

const makeAudio = (id: string, name: string, overrides: Partial<ExternalFile> = {}): ExternalFile => ({
  id,
  name,
  path: `/audio/${name}`,
  type: "audio",
  ...overrides,
});

const audioTrack = (id: string, isDefault = false): Track => ({
  id,
  type: "audio",
  isDefault,
});

describe("buildMeasurementPlan", () => {
  it("pairs each audio with the video the mux would give it", () => {
    // The whole point of reusing the matcher: a separate one could measure a
    // different pairing than the mux performs. See plan §4.
    const videos = [makeVideo("v1", "Show - 01.mkv"), makeVideo("v2", "Show - 02.mkv")];
    const audios = [makeAudio("a1", "Show - 02.HIN.aac"), makeAudio("a2", "Show - 01.HIN.aac")];

    const plan = buildMeasurementPlan({ videoFiles: videos, audioFiles: audios });

    expect(plan.measurements).toHaveLength(2);
    const byAudio = Object.fromEntries(
      plan.measurements.map((m) => [m.audioFileId, m.pair.primaryPath]),
    );
    expect(byAudio.a1).toBe("/videos/Show - 02.mkv");
    expect(byAudio.a2).toBe("/videos/Show - 01.mkv");
  });

  it("agrees with the pairing the mux actually performs", () => {
    // Locks the two together: if the matcher is ever changed for one caller
    // and not the other, this fails rather than silently mis-measuring.
    const videos = [makeVideo("v1", "Show - 01.mkv"), makeVideo("v2", "Show - 02.mkv")];
    const audios = [makeAudio("a1", "Show - 02.HIN.aac"), makeAudio("a2", "Show - 01.HIN.aac")];

    const plan = buildMeasurementPlan({ videoFiles: videos, audioFiles: audios });
    const jobs = buildMuxJobRequests({
      videoFiles: videos,
      jobs: videos.map((videoFile) => ({
        id: `job-${videoFile.id}`,
        videoFile,
        status: "queued" as const,
        progress: 0,
      })),
      audioFilesByTrack: { track1: audios },
      subtitleFilesByTrack: {},
      chapterFiles: [],
      attachmentFiles: [],
      perVideoExternal: {},
    });

    const muxPairs = new Set(
      jobs.flatMap((job) => job.audios.map((audio) => `${job.video.path}|${audio.path}`)),
    );
    const measuredPairs = new Set(
      plan.measurements.map((m) => `${m.pair.primaryPath}|${m.pair.secondaryPath}`),
    );
    expect(measuredPairs).toEqual(muxPairs);
  });

  it("measures the movie case with no mode switch", () => {
    // One audio explicitly assigned to one video is simply one pair; there is
    // no movie/series distinction anywhere in this path. See plan §4.
    const videos = [makeVideo("v1", "Movie.2019.1080p.mkv"), makeVideo("v2", "Movie.2019.720p.mkv")];
    const audio = makeAudio("a1", "Movie.HIN.aac", { matchedVideoId: "v2" });

    const plan = buildMeasurementPlan({ videoFiles: videos, audioFiles: [audio] });

    expect(plan.measurements).toHaveLength(1);
    expect(plan.measurements[0].pair.primaryPath).toBe("/videos/Movie.2019.720p.mkv");
    expect(plan.measurements[0].pair.secondaryPath).toBe("/audio/Movie.HIN.aac");
  });

  it("measures the same audio separately against each video it is assigned to", () => {
    // A dub's offset can differ per release, so two videos sharing one audio
    // file get two independent measurements rather than one shared delay.
    const videos = [makeVideo("v1", "Movie.2019.1080p.mkv"), makeVideo("v2", "Movie.2019.720p.mkv")];
    const audios = [
      makeAudio("a1", "Movie.HIN.aac", { matchedVideoId: "v1" }),
      makeAudio("a2", "Movie.HIN.aac", { matchedVideoId: "v2" }),
    ];

    const plan = buildMeasurementPlan({ videoFiles: videos, audioFiles: audios });

    expect(plan.measurements).toHaveLength(2);
    expect(plan.measurements.map((m) => m.pair.primaryPath).sort()).toEqual([
      "/videos/Movie.2019.1080p.mkv",
      "/videos/Movie.2019.720p.mkv",
    ]);
  });

  it("surfaces audio that matches no video instead of dropping it", () => {
    const videos = [makeVideo("v1", "Show - 01.mkv")];
    const audios = [makeAudio("a1", "Completely Different Thing.aac")];

    const plan = buildMeasurementPlan({ videoFiles: videos, audioFiles: audios });

    expect(plan.measurements).toHaveLength(0);
    expect(plan.unmatched.map((f) => f.id)).toEqual(["a1"]);
  });

  it("skips hand-typed delays, which measurement must never overwrite", () => {
    // See plan §5.6.
    const videos = [makeVideo("v1", "Show - 01.mkv")];
    const audios = [makeAudio("a1", "Show - 01.aac", { delay: -0.5, delayProvenance: "manual" })];

    const plan = buildMeasurementPlan({ videoFiles: videos, audioFiles: audios });

    expect(plan.measurements).toHaveLength(0);
    expect(plan.skipped.map((f) => f.id)).toEqual(["a1"]);
  });

  it("skips already-measured files, because re-measuring is a separate action", () => {
    const videos = [makeVideo("v1", "Show - 01.mkv")];
    const audios = [makeAudio("a1", "Show - 01.aac", { delayProvenance: "measured" })];

    expect(buildMeasurementPlan({ videoFiles: videos, audioFiles: audios }).measurements).toHaveLength(
      0,
    );
  });

  it("measures a skipped file when explicitly forced", () => {
    // The per-row re-measure ignores the skip rules for that one row.
    const videos = [makeVideo("v1", "Show - 01.mkv")];
    const audios = [makeAudio("a1", "Show - 01.aac", { delayProvenance: "manual" })];

    const plan = buildMeasurementPlan({
      videoFiles: videos,
      audioFiles: audios,
      force: true,
      onlyAudioFileIds: ["a1"],
    });

    expect(plan.measurements).toHaveLength(1);
  });

  it("measures each included track of a multi-track file separately", () => {
    const videos = [makeVideo("v1", "Show - 01.mkv")];
    const audios = [
      makeAudio("a1", "Show - 01.mka", {
        tracks: [audioTrack("0"), audioTrack("1"), audioTrack("2")],
        includedTrackIds: [0, 2],
      }),
    ];

    const plan = buildMeasurementPlan({ videoFiles: videos, audioFiles: audios });

    expect(plan.measurements).toHaveLength(2);
    expect(plan.measurements.map((m) => m.trackId)).toEqual([0, 2]);
    // secondaryTrack counts audio streams from zero, which is what the engine
    // expects -- not this app's track id.
    expect(plan.measurements.map((m) => m.pair.secondaryTrack)).toEqual([0, 2]);
  });

  it("uses the video's default audio track as the reference", () => {
    const video = makeVideo("v1", "Show - 01.mkv", [
      { id: "0", type: "video" },
      audioTrack("1"),
      audioTrack("2", true),
    ]);
    // Index among audio streams, not among all tracks: the video track must
    // not shift the count.
    expect(defaultReferenceTrack(video)).toBe(1);
  });

  it("falls back to the first audio track when none is marked default", () => {
    const video = makeVideo("v1", "Show - 01.mkv", [audioTrack("0"), audioTrack("1")]);
    expect(defaultReferenceTrack(video)).toBe(0);
  });

  it("honours an explicitly chosen reference track", () => {
    const videos = [makeVideo("v1", "Show - 01.mkv", [audioTrack("0"), audioTrack("1", true)])];
    const audios = [makeAudio("a1", "Show - 01.aac")];

    const plan = buildMeasurementPlan({
      videoFiles: videos,
      audioFiles: audios,
      referenceTrackByVideoId: { v1: 0 },
    });

    expect(plan.measurements[0].pair.primaryTrack).toBe(0);
  });
});

describe("measurement keys", () => {
  it("round-trips a file-level measurement", () => {
    expect(parseMeasurementKey(measurementKey("audio-1", null))).toEqual({
      audioFileId: "audio-1",
      trackId: null,
    });
  });

  it("round-trips a per-track measurement", () => {
    expect(parseMeasurementKey(measurementKey("audio-1", 2))).toEqual({
      audioFileId: "audio-1",
      trackId: 2,
    });
  });

  it("survives an id containing the separator", () => {
    // Ids come from elsewhere; a colon in one must not split the key wrongly.
    expect(parseMeasurementKey(measurementKey("a::b", 3))).toEqual({
      audioFileId: "a::b",
      trackId: 3,
    });
  });
});
