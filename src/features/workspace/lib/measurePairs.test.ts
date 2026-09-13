import { describe, expect, it } from "vitest";
import type { ExternalFile, Track, VideoFile } from "@/shared/types";
import {
  buildMeasurementPlan,
  DEFAULT_REFERENCE_TRACK,
  measurementKey,
  parseMeasurementKey,
  plannedReferenceTrack,
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
    // A separate matcher could measure a different pairing than the mux performs.
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
    // One audio explicitly assigned to one video is simply one pair; no movie/series distinction here.
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
    // Every track in one file shares that container's timeline, so they share an offset,
    // and the mux falls back to the file-level delay for any track without its own.
    const videos = [makeVideo("v1", "Show - 01.mkv")];
    const audios = [
      makeAudio("a1", "Show - 01.mka", {
        tracks: [audioTrack("0"), audioTrack("1"), audioTrack("2")],
        includedTrackIds: [0, 2],
      }),
    ];

    const plan = buildMeasurementPlan({ videoFiles: videos, audioFiles: audios });

    // Every result writes back to the file itself, never to a per-track
    // override -- one delay covers the whole container.
    expect(plan.measurements.every((m) => m.trackId === null)).toBe(true);
    expect(plan.measurements).toHaveLength(1);
    // The first muxed track. Track 1 is excluded from the mux, so it is not a
    // candidate: it is not the track the delay will be applied to.
    expect(plan.measurements[0].pair.secondaryTrack).toBe(0);
  });

  it("measures against the video's first audio track, not its default-flagged one", () => {
    // AudioSyncMaster measures audio stream 0 unless told otherwise; tracks in one container
    // need not share an offset, so following the default flag instead would diverge from it.
    const video = makeVideo("v1", "Show - 01.mkv", [
      { id: "0", type: "video" },
      audioTrack("1"),
      audioTrack("2", true),
    ]);
    const audio = makeAudio("a1", "Show - 01.hin.mkv", {
      matchedVideoId: "v1",
      tracks: [audioTrack("0")],
      includedTrackIds: [0],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    // Index among audio streams, not among all tracks: the video track must
    // not shift the count.
    expect(plan.measurements[0].pair.primaryTrack).toBe(0);
    expect(DEFAULT_REFERENCE_TRACK).toBe(0);
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

  it("does not pick the video track by language", () => {
    // AudioSyncMaster measures stream 0 by default even when another track would correlate
    // better; that choice is the user's via the reference picker, not automatic.
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
    expect(plan.measurements[0].pair.primaryTrack).toBe(0);
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

  it("measures the first muxed track of the file against the video's first", () => {
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
    expect(plan.measurements[0].pair.primaryTrack).toBe(0);
    expect(plan.measurements[0].pair.secondaryTrack).toBe(0);
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
    // A withheld result leaves delayProvenance at "none"; without also checking measuredDelay,
    // a bulk pass would re-measure it, and a correlator with no true peak answers differently each time.
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

  it("measures a lone track even when no language matches", () => {
    // The dub is cut from the same master and shares music, effects and room tone with the
    // original, so it's still measurable; the confidence figure reports whether it locked on.
    const video = makeVideo("v1", "Ep01.mkv", [langTrack("1", "kor")]);
    const audio = makeAudio("a1", "Ep01.hin.ec3", {
      matchedVideoId: "v1",
      language: "hin",
      tracks: [langTrack("0", "hin")],
      includedTrackIds: [0],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    expect(plan.measurements.length).toBeGreaterThan(0);
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

  it("picks one pairing deterministically when nothing identifies a track", () => {
    // Picks one pairing the same way every time, rather than by confidence, so results
    // don't vary per file and diverge from AudioSyncMaster's fixed stream 0.
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

    expect(plan.measurements).toHaveLength(1);
    expect(plan.measurements[0].pair.primaryTrack).toBe(0);
    expect(plan.measurements[0].trackId).toBeNull();
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

  it("does not multiply work when the languages agree", () => {
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
    expect(plan.measurements[0].pair.primaryTrack).toBe(0);
  });
});

describe("bounding how much extra work an ambiguous pair can cause", () => {
  it("caps the candidate sweep", () => {
    // Candidates multiply across both sides — a six-track REMUX against a six-track dub would
    // otherwise be 36 full window passes; the list is ordered best-prior-first before truncating.
    const audioTracks = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: String(i), type: "audio" as const }));

    const video = makeVideo("v1", "Ep01.mkv", audioTracks(6));
    const audio = makeAudio("a1", "Ep01.mkv", {
      matchedVideoId: "v1",
      tracks: audioTracks(6),
      includedTrackIds: [0, 1, 2, 3, 4, 5],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    expect(plan.measurements.length).toBeLessThanOrEqual(6);
    // The best prior is still measured first.
    expect(plan.measurements[0].pair).toMatchObject({ primaryTrack: 0, secondaryTrack: 0 });
  });
});

describe("which external track is measured", () => {
  const langTrack = (id: string, language?: string) => ({
    id,
    type: "audio" as const,
    language,
  });

  it("measures the muxed track against an explicit reference, not a shared one", () => {
    const video = makeVideo("v1", "Underworld.Evolution.Remux.mkv", [
      langTrack("1", "eng"),
    ]);
    const audio = makeAudio("a1", "Underworld.Evolution.2160p.mkv", {
      matchedVideoId: "v1",
      tracks: [langTrack("0", "hin"), langTrack("1", "eng")],
      includedTrackIds: [0],
    });

    const plan = buildMeasurementPlan({
      videoFiles: [video],
      audioFiles: [audio],
      referenceTrackByVideoId: { v1: 0 },
    });

    expect(plan.measurements).toHaveLength(1);
    expect(plan.measurements[0].pair).toMatchObject({
      primaryTrack: 0,
      // Hindi: the track being muxed, not the better-correlating English one.
      secondaryTrack: 0,
    });
  });

  it("never measures a track that is not being muxed", () => {
    // The English track would correlate more sharply, but its offset isn't necessarily the
    // Hindi track's once codec delays differ, and Hindi is the one receiving the delay.
    const video = makeVideo("v1", "Underworld.mkv", [langTrack("1", "eng")]);
    const audio = makeAudio("a1", "Underworld.dub.mkv", {
      matchedVideoId: "v1",
      tracks: [langTrack("0", "hin"), langTrack("1", "eng")],
      includedTrackIds: [0],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    expect(plan.measurements).toHaveLength(1);
    expect(plan.measurements[0].pair.secondaryTrack).toBe(0);
  });

  it("measures the first muxed track when several are muxed", () => {
    // Both tracks are muxed, so one delay covers both and either may be
    // measured. The first is AudioSyncMaster's choice, so it is this one's.
    const video = makeVideo("v1", "Ep01.mkv", [
      langTrack("1", "jpn"),
      langTrack("2", "eng"),
    ]);
    const audio = makeAudio("a1", "Ep01.mkv", {
      matchedVideoId: "v1",
      tracks: [langTrack("0", "hin"), langTrack("1", "eng")],
      includedTrackIds: [0, 1],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    expect(plan.measurements[0].pair).toMatchObject({
      primaryTrack: 0,
      secondaryTrack: 0,
    });
  });

  it("measures a lone track even when no language matches", () => {
    // The dub shares music, effects and room tone with the original even without a language
    // match; the confidence figure reports whether it locked on.
    const video = makeVideo("v1", "Ep01.mkv", [langTrack("1", "eng")]);
    const audio = makeAudio("a1", "Ep01.hin.ec3", {
      matchedVideoId: "v1",
      language: "hin",
      tracks: [langTrack("0", "hin")],
      includedTrackIds: [0],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    expect(plan.measurements).toHaveLength(1);
    expect(plan.measurements[0].pair).toMatchObject({
      primaryTrack: 0,
      secondaryTrack: 0,
    });
  });

  it("does not spread a file-level language across several tracks", () => {
    // file.language describes one track, so it must not stand in for all of
    // them and invent a match that decides the reference.
    const video = makeVideo("v1", "Ep01.mkv", [
      langTrack("1", "jpn"),
      langTrack("2", "eng"),
    ]);
    const audio = makeAudio("a1", "Ep01.dual.mkv", {
      matchedVideoId: "v1",
      language: "eng",
      tracks: [
        { id: "0", type: "audio" as const },
        { id: "1", type: "audio" as const },
      ],
      includedTrackIds: [0, 1],
    });

    const plan = buildMeasurementPlan({ videoFiles: [video], audioFiles: [audio] });

    // Falls back to the video's default track rather than matching on eng.
    expect(plan.measurements[0].pair.primaryTrack).toBe(0);
  });
});

describe("the reference track a row should compare itself against", () => {
  // A row flags "Reference changed" when the track a measurement used differs
  // from the one in force now, so the row must derive it the way the plan does.
  const video = (): VideoFile =>
    makeVideo("v1", "Show - 01.mkv", [
      { id: "0", type: "audio", isDefault: false, language: "eng" },
      { id: "1", type: "audio", isDefault: true, language: "hin" },
    ]);

  it("reports the track the next measurement would actually use", () => {
    const plan = buildMeasurementPlan({
      videoFiles: [video()],
      audioFiles: [
        makeAudio("a1", "Show - 01.mkv", {
          language: "hin",
          tracks: [{ id: "0", type: "audio", isDefault: true, language: "hin" }],
        }),
      ],
    });

    expect(plan.measurements[0].pair.primaryTrack).toBe(0);
    expect(plannedReferenceTrack(video(), {})).toBe(0);
    // And an explicit choice is honoured as-is, by both.
    expect(plannedReferenceTrack(video(), { v1: 1 })).toBe(1);
  });
});
