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

  it("measures a multi-track file once, not once per track", () => {
    // Every track inside one external file shares that container's timeline,
    // so they share an offset -- and the mux falls back to the file-level
    // delay for any track without its own. Measuring each separately asked
    // the correlator to match a dub against a different encode of the same
    // language, which routinely found no peak at all.
    const videos = [makeVideo("v1", "Show - 01.mkv")];
    const audios = [
      makeAudio("a1", "Show - 01.mka", {
        tracks: [audioTrack("0"), audioTrack("1"), audioTrack("2")],
        includedTrackIds: [0, 2],
      }),
    ];

    const plan = buildMeasurementPlan({ videoFiles: videos, audioFiles: audios });

    expect(plan.measurements).toHaveLength(1);
    // Written to the file, not to a per-track override.
    expect(plan.measurements[0].trackId).toBeNull();
    // secondaryTrack counts audio streams from zero, which is what the engine
    // expects -- not this app's track id.
    expect(plan.measurements[0].pair.secondaryTrack).toBe(0);
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

describe("choosing the reference track per external track", () => {
  const langTrack = (id: string, language: string): Track => ({
    id,
    type: "audio",
    language,
  });

  it("compares a shared language rather than whatever is first", () => {
    // Regression: a Korean track was measured against the video's Hindi.
    // Two languages share no waveform, so the correlator had no true peak to
    // find and returned whatever fit best -- at high confidence, because every
    // sample window agreed on the same wrong answer.
    const video = makeVideo("v1", "Ep01.mkv", [
      langTrack("0", "jpn"),
      langTrack("1", "kor"),
    ]);
    const audio = makeAudio("a1", "Ep01.mkv", {
      matchedVideoId: "v1",
      tracks: [langTrack("0", "kor")],
      includedTrackIds: [0],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    expect(plan.measurements).toHaveLength(1);
    // Korean against Korean, not against the video's first track.
    expect(plan.measurements[0].pair.primaryTrack).toBe(1);
    expect(plan.measurements[0].pair.secondaryTrack).toBe(0);
  });

  it("falls back to the reference when the video has no matching language", () => {
    // Measuring against something beats not measuring; an implausible result
    // is caught downstream rather than by refusing to try.
    const video = makeVideo("v1", "Ep01.mkv", [langTrack("0", "jpn")]);
    const audio = makeAudio("a1", "Ep01.mkv", {
      matchedVideoId: "v1",
      tracks: [langTrack("0", "hin"), langTrack("1", "kor")],
      includedTrackIds: [0, 1],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    expect(plan.measurements.every((m) => m.pair.primaryTrack === 0)).toBe(true);
  });

  it("respects an explicit reference choice for a single-track file", () => {
    const video = makeVideo("v1", "Ep01.mkv", [
      langTrack("0", "hin"),
      langTrack("1", "kor"),
    ]);
    const audio = makeAudio("a1", "Ep01.mkv", {
      matchedVideoId: "v1",
      tracks: [langTrack("0", "kor")],
      includedTrackIds: [0],
    });

    const plan = buildMeasurementPlan({
      videoFiles: [video],
      audioFiles: [audio],
      referenceTrackByVideoId: { v1: 0 },
    });

    expect(plan.measurements[0].pair.primaryTrack).toBe(0);
  });

  it("ignores und, which says nothing about the language", () => {
    // und on both sides is not a match; the kor pair is.
    const video = makeVideo("v1", "Ep01.mkv", [
      langTrack("0", "und"),
      langTrack("1", "kor"),
    ]);
    const audio = makeAudio("a1", "Ep01.mkv", {
      matchedVideoId: "v1",
      tracks: [langTrack("0", "und"), langTrack("1", "kor")],
      includedTrackIds: [0, 1],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    expect(plan.measurements).toHaveLength(1);
    expect(plan.measurements[0].pair.primaryTrack).toBe(1);
    expect(plan.measurements[0].pair.secondaryTrack).toBe(1);
  });
});

describe("re-running a bulk measurement", () => {
  const measured = {
    engineDelayMs: 8695.9,
    appliedMs: -8696,
    confidence: 0.9,
    driftMsPerS: null,
    hasSignificantDrift: false,
    isRateMismatch: false,
    isLikelyCut: true,
    correctionRatio: null,
    rateSourceFps: null,
    rateTargetFps: null,
    rateExplanation: null,
    referenceTrack: 0,
    primaryFps: 23.976,
    measuredAt: "2026-08-28T00:00:00.000Z",
    error: null,
  };

  it("does not retry a file whose measurement was withheld", () => {
    // Regression: a withheld result leaves delayProvenance at "none", so the
    // next bulk pass measured it again -- and a correlator with no true peak
    // returns a different arbitrary answer each time. One episode read
    // +8695.9 ms at 90% and then -96.2 ms at 46% on identical files, which
    // looked like the engine was unstable.
    const video = makeVideo("v1", "Ep01.mkv");
    const audio = makeAudio("a1", "Ep01.mka", {
      matchedVideoId: "v1",
      delayProvenance: "none",
      measuredDelay: measured,
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    expect(plan.measurements).toHaveLength(0);
    expect(plan.skipped.map((file) => file.id)).toEqual(["a1"]);
  });

  it("still retries when the row explicitly asks for it", () => {
    const video = makeVideo("v1", "Ep01.mkv");
    const audio = makeAudio("a1", "Ep01.mka", {
      matchedVideoId: "v1",
      delayProvenance: "none",
      measuredDelay: measured,
    });

    const plan = buildMeasurementPlan({
      videoFiles: [video],
      audioFiles: [audio],
      force: true,
    });

    expect(plan.measurements).toHaveLength(1);
  });
});

describe("when the video carries no audio in the file's language", () => {
  const langTrack = (id: string, language: string): Track => ({
    id,
    type: "audio",
    language,
  });

  it("refuses to measure rather than comparing two languages", () => {
    // Regression: a Hindi .ec3 against an x264 rip carrying only Korean fell
    // back to the video's first track, so every episode came back with a
    // confident, wrong delay -- clustered around +15840 ms because the
    // correlator kept locking onto the same repeated passage.
    const video = makeVideo("v1", "Ep01.mkv", [langTrack("1", "kor")]);
    const audio = makeAudio("a1", "Ep01.hin.ec3", {
      matchedVideoId: "v1",
      language: "hin",
      tracks: [langTrack("0", "hin")],
      includedTrackIds: [0],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    expect(plan.measurements).toHaveLength(0);
    expect(plan.languageMismatch.map((file) => file.id)).toEqual(["a1"]);
  });

  it("still measures when the languages agree", () => {
    const video = makeVideo("v1", "Ep01.mkv", [langTrack("1", "hin")]);
    const audio = makeAudio("a1", "Ep01.hin.ec3", {
      matchedVideoId: "v1",
      language: "hin",
      tracks: [langTrack("0", "hin")],
      includedTrackIds: [0],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    expect(plan.measurements).toHaveLength(1);
    expect(plan.languageMismatch).toHaveLength(0);
  });

  it("measures when either side's language is unknown", () => {
    // Refusing needs evidence. Without a language on one side there is no
    // mismatch to prove, and first-against-first is the reasonable guess.
    const video = makeVideo("v1", "Ep01.mkv", [{ id: "1", type: "audio" }]);
    const audio = makeAudio("a1", "Ep01.hin.ec3", {
      matchedVideoId: "v1",
      language: "hin",
      tracks: [langTrack("0", "hin")],
      includedTrackIds: [0],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    expect(plan.measurements).toHaveLength(1);
  });
});

describe("when nothing identifies which video track matches the dub", () => {
  const langTrack = (id: string, language: string): Track => ({
    id,
    type: "audio",
    language,
  });

  it("measures every candidate so the best correlation can win", () => {
    // Regression: MkvBatchMux and AudioSyncMaster disagreed on ten of sixteen
    // episodes because each guessed a different video track -- the default
    // track here, track 0 there. Neither guess is knowable in advance, so try
    // both and let the engine's confidence decide.
    const video = makeVideo("v1", "Ep01.mkv", [
      { id: "1", type: "audio" },
      { id: "2", type: "audio", isDefault: true },
    ]);
    const audio = makeAudio("a1", "Ep01.mkv", {
      matchedVideoId: "v1",
      tracks: [{ id: "0", type: "audio" }],
      includedTrackIds: [0],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    expect(plan.measurements).toHaveLength(2);
    // The default track is tried first, since it is the better prior.
    expect(plan.measurements.map((m) => m.pair.primaryTrack)).toEqual([1, 0]);
    // Every result writes back to the same file.
    expect(plan.measurements.every((m) => m.trackId === null)).toBe(true);
  });

  it("keys candidates apart but resolves them to the same file", () => {
    const video = makeVideo("v1", "Ep01.mkv", [
      { id: "1", type: "audio" },
      { id: "2", type: "audio" },
    ]);
    const audio = makeAudio("a1", "Ep01.mkv", {
      matchedVideoId: "v1",
      tracks: [{ id: "0", type: "audio" }],
      includedTrackIds: [0],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });
    const keys = plan.measurements.map((m) => m.pair.key);

    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(parseMeasurementKey(key)).toEqual({ audioFileId: "a1", trackId: null });
    }
  });

  it("does not multiply work when the languages already agree", () => {
    const video = makeVideo("v1", "Ep01.mkv", [
      langTrack("1", "kor"),
      langTrack("2", "hin"),
    ]);
    const audio = makeAudio("a1", "Ep01.mkv", {
      matchedVideoId: "v1",
      tracks: [langTrack("0", "hin")],
      includedTrackIds: [0],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    expect(plan.measurements).toHaveLength(1);
    expect(plan.measurements[0].pair.primaryTrack).toBe(1);
  });
});
