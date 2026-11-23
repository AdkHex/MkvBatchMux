import { describe, expect, it } from "vitest";

import type { ExternalFile, MeasuredDelay, VideoFile } from "@/shared/types";
import type { ConformResultEvent } from "@/shared/types/engineFeatures";

import {
  applyConformResult,
  buildConformPlan,
  canConform,
  conformBlocker,
  conformTrack,
  conformedStatus,
  conformedSubtitleIssues,
  conformRefusal,
  fileConformBlocker,
  muxedSubtitleCount,
  offersConform,
  undoConform,
} from "./conform";
import { measureOutcome } from "./measureVerdict";

const video = (n: number): VideoFile => ({
  id: `v${n}`,
  name: `Show.S01E0${n}.mkv`,
  path: `/media/Show/Season 1/Show.S01E0${n}.mkv`,
  size: 1,
  status: "pending",
  tracks: [
    { id: "0", type: "video" },
    { id: "1", type: "audio", language: "eng" },
    { id: "2", type: "audio", language: "eng", name: "Commentary" },
  ],
});

const measured = (extra: Partial<MeasuredDelay> = {}): MeasuredDelay => ({
  engineDelayMs: 840,
  appliedMs: -840,
  confidence: 0.97,
  driftMsPerS: null,
  hasSignificantDrift: false,
  isRateMismatch: false,
  isLikelyCut: false,
  correctionRatio: null,
  rateSourceFps: null,
  rateTargetFps: null,
  rateExplanation: null,
  referenceTrack: 1,
  primaryFps: 23.976,
  measuredAt: "2026-11-23T10:00:00.000Z",
  error: null,
  videoPath: "/media/Show/Season 1/Show.S01E02.mkv",
  videoFile: "Show.S01E02.mkv",
  ...extra,
});

const dub = (extra: Partial<ExternalFile> = {}): ExternalFile => ({
  id: "a2",
  name: "Show.S01E02.Hindi.eac3",
  path: "/media/Dubs/Show.S01E02.Hindi.eac3",
  type: "audio",
  matchedVideoId: "v2",
  tracks: [{ id: "0", type: "audio", codec: "E-AC3", language: "hin" }],
  includedTrackIds: [0],
  measuredDelay: measured({ isLikelyCut: true, cutPositionS: 100, cutMagnitudeMs: -10000 }),
  ...extra,
});

const result = (extra: Partial<ConformResultEvent> = {}): ConformResultEvent => ({
  runId: "conform-1",
  key: "a2",
  outputPath: "/media/Dubs/MKVBatchMux conformed/Show.S01E02.Hindi.conformed.mka",
  mode: "lossless",
  codec: "eac3",
  verified: true,
  verificationText: "Checked against the video: the dub sits within one 32 ms frame throughout (-8.0 to +13.4 ms).",
  residualMs: 13.4,
  plan: null,
  description: null,
  error: null,
  fallbackReason: null,
  ...extra,
});

describe("which rows can be conformed", () => {
  it("offers a different cut, measured against this video, with one audio track", () => {
    expect(offersConform(dub(), video(2))).toBe(true);
    expect(canConform(dub(), video(2))).toBe(true);
    // A minor slip is not a different cut; a clean one is not either, but can be conformed by hand.
    expect(offersConform(dub({ measuredDelay: measured({ isLikelyCut: true, isMinorSlip: true }) }), video(2))).toBe(false);
    expect(offersConform(dub({ measuredDelay: measured() }), video(2))).toBe(false);
    expect(canConform(dub({ measuredDelay: measured() }), video(2))).toBe(true);
    // Not measured at all: nothing to say it is another cut.
    expect(canConform(dub({ measuredDelay: undefined }), video(2))).toBe(false);
  });

  it("offers a row whose timeline scan found edits, and not one it found clean", () => {
    const scan = { scannedAt: "", error: null, startOffsetMs: 840, unverified: [], tailS: 0, videoFps: 23.976, dubRate: 23.976, speed: 1, rateConfirmed: true, dubUsedShare: 0.99, videoDurationS: 300, description: null };
    const cut = { atS: 100, jumpMs: -10000, missingS: 10, uncertaintyS: 0.1, offsetAfterMs: -9160 };
    expect(offersConform(dub({ measuredDelay: measured({ timeline: { ...scan, cuts: [cut] } }) }), video(2))).toBe(true);
    // The scan overrules the quick measurement's guess.
    expect(offersConform(dub({ measuredDelay: measured({ isLikelyCut: true, timeline: { ...scan, cuts: [] } }) }), video(2))).toBe(false);
  });

  it("explains why a file of several dubs cannot be conformed", () => {
    const container = dub({
      tracks: [
        { id: "1", type: "audio", language: "hin" },
        { id: "2", type: "audio", language: "tam" },
      ],
      includedTrackIds: [1, 2],
    });
    expect(conformBlocker(container, video(2))).toMatch(/one audio track, and 2 of this file's are muxed/);
    expect(offersConform(container, video(2))).toBe(false);
    // Keep only one, and it can.
    const one = { ...container, includedTrackIds: [2] };
    expect(conformBlocker(one, video(2))).toBeNull();
    expect(conformTrack(one)).toEqual({ trackId: 2, streamIndex: 1 });
    expect(conformBlocker({ ...container, includedTrackIds: [] }, video(2))).toMatch(/None of this file's audio tracks/);
    expect(conformBlocker(dub(), undefined)).toMatch(/no video/);
    expect(conformBlocker({ ...dub(), placeholder: true }, video(2))).toMatch(/no file/);
  });

  it("refuses a dub that also brings subtitles into the mux, and says why", () => {
    const withSubs = dub({
      tracks: [
        { id: "0", type: "audio", codec: "E-AC3", language: "hin" },
        { id: "1", type: "subtitle", codec: "SubRip/SRT", language: "hin" },
        { id: "2", type: "subtitle", codec: "SubRip/SRT", language: "eng" },
      ],
      includeSubtitles: true,
      includedSubtitleTrackIds: [1, 2],
    });
    expect(muxedSubtitleCount(withSubs)).toBe(2);
    expect(conformBlocker(withSubs, video(2))).toMatch(/also brings 2 subtitle tracks into the mux.*they would be left out/);
    expect(fileConformBlocker(withSubs)).toBe(conformBlocker(withSubs, video(2)));
    // Not in the row, not in the bulk count, not from the popup; the reason is there for all three.
    expect(offersConform(withSubs, video(2))).toBe(false);
    expect(canConform(withSubs, video(2))).toBe(false);
    expect(conformRefusal(withSubs, video(2))).toMatch(/Copy its subtitles/);
    const { planned, skipped } = buildConformPlan({ videoFiles: [video(2)], files: [withSubs], fileIds: [withSubs.id] });
    expect(planned).toEqual([]);
    expect(skipped[0].reason).toMatch(/subtitle tracks/);

    // One listed: "a subtitle track ... it".
    expect(conformBlocker({ ...withSubs, includedSubtitleTrackIds: [2] }, video(2))).toMatch(/brings a subtitle track into the mux.*so it would/);
    // None listed: the mux takes every subtitle track the file has.
    expect(muxedSubtitleCount({ ...withSubs, includedSubtitleTrackIds: undefined })).toBe(2);
    // Subtitles off (or an empty list) and it can be conformed again, as the mux copies none.
    expect(muxedSubtitleCount({ ...withSubs, includeSubtitles: false })).toBe(0);
    expect(offersConform({ ...withSubs, includeSubtitles: false }, video(2))).toBe(true);
    expect(offersConform({ ...withSubs, includedSubtitleTrackIds: [] }, video(2))).toBe(true);
    expect(conformRefusal({ ...withSubs, includeSubtitles: false }, video(2))).toBeNull();
    // Nothing to refuse where Conform isn't on the table: unmeasured, or measured against another video.
    expect(conformRefusal({ ...withSubs, measuredDelay: undefined }, video(2))).toBeNull();
    expect(conformRefusal({ ...withSubs, matchedVideoId: "v3" }, video(3))).toBeNull();
  });

  it("does not offer a row measured against another video", () => {
    const moved = dub({ matchedVideoId: "v3" });
    expect(offersConform(moved, video(3))).toBe(false);
    expect(canConform(moved, video(3))).toBe(false);
  });
});

describe("the engine pairs", () => {
  it("lays each dub against its own video through the reference its measurement used", () => {
    const gap: ExternalFile = { id: "gap-v1", name: "", path: "", type: "audio", placeholder: true, matchedVideoId: "v1" };
    const many = dub({ id: "a3", matchedVideoId: "v3", tracks: [{ id: "1", type: "audio" }, { id: "2", type: "audio" }], includedTrackIds: [1, 2] });
    const { planned, skipped } = buildConformPlan({ videoFiles: [video(1), video(2), video(3)], files: [gap, dub(), many], fileIds: ["gap-v1", "a2", "a3"] });
    expect(planned.map((entry) => entry.pair)).toEqual([
      { primaryPath: video(2).path, secondaryPath: dub().path, key: "a2", method: "mkvbatchmux", score: 1, primaryTrack: 1, secondaryTrack: 0 },
    ]);
    expect(planned[0]).toMatchObject({ fileId: "a2", sourceTrack: 0, videoPath: video(2).path });
    expect(skipped.map(({ file, reason }) => [file.id, reason.slice(0, 32)])).toEqual([["a3", "Conforming works on one audio tr"]]);
  });
});

describe("a result on its file", () => {
  it("keeps the new track beside the original, and Undo takes it away", () => {
    const file = dub({ delay: 0.25 });
    const done = applyConformResult(file, result(), { sourceTrack: 0, videoPath: video(2).path }, "2026-11-23T11:00:00.000Z");
    expect(done.conformed).toEqual({
      path: "/media/Dubs/MKVBatchMux conformed/Show.S01E02.Hindi.conformed.mka",
      mode: "lossless",
      codec: "eac3",
      verified: true,
      verificationText: result().verificationText,
      residualMs: 13.4,
      sourceTrack: 0,
      createdAt: "2026-11-23T11:00:00.000Z",
      videoPath: video(2).path,
      fallbackReason: null,
    });
    // The original is untouched: path, delay and measurement.
    expect([done.path, done.delay, done.measuredDelay]).toEqual([file.path, 0.25, file.measuredDelay]);
    expect(undoConform(done)).toEqual(file);
    expect(applyConformResult(file, result({ outputPath: null, error: "The engine could not plan this pair." }), { sourceTrack: 0, videoPath: "" })).toBe(file);
  });

  it("says Conformed with the check, and when it is not the one in use", () => {
    const done = applyConformResult(dub(), result(), { sourceTrack: 0, videoPath: video(2).path });
    expect(conformedStatus(done, video(2))).toEqual({ s: "ok", text: "Conformed", detail: `${result().verificationText} Largest offset left: +13.4 ms.` });
    const fallback = applyConformResult(dub(), result({ mode: "render", verified: null, residualMs: null, verificationText: "Re-encoded instead of cut: the dub runs at another speed." }), { sourceTrack: 0, videoPath: video(2).path });
    expect(conformedStatus(fallback, video(2))).toMatchObject({ s: "warn", text: "Conformed, unchecked" });
    expect(conformedStatus({ ...done, matchedVideoId: "v3" }, video(3))).toMatchObject({ s: "warn", text: "Conformed for another video" });
    expect(conformedStatus(dub(), video(2))).toBeNull();
  });

  it("warns when subtitles were turned on after conforming, since the conformed track goes in alone", () => {
    const done = applyConformResult(dub({ tracks: [{ id: "0", type: "audio" }, { id: "1", type: "subtitle" }] }), result(), { sourceTrack: 0, videoPath: video(2).path });
    expect(conformedStatus(done, video(2))).toMatchObject({ s: "ok", text: "Conformed" });
    expect(conformedStatus({ ...done, includeSubtitles: true, includedSubtitleTrackIds: [1] }, video(2))).toMatchObject({ s: "warn", text: "Conformed, subtitles left out" });
  });

  it("counts conformed files as conformed, not as different cuts", () => {
    const done = applyConformResult(dub(), result(), { sourceTrack: 0, videoPath: video(2).path });
    expect(measureOutcome([done, dub({ id: "a9" })]).parts).toEqual(["0 measured", "1 conformed", "1 different cut"]);
  });
});

describe("a conformed dub whose subtitles are turned on", () => {
  const video = { id: "v1", name: "Show.S01E02.mkv", path: "D:\\Show\\Show.S01E02.mkv" } as VideoFile;
  const conformed = {
    path: "D:\\Dubs\\MKVBatchMux conformed\\Show.S01E02.Hindi.conformed.eac3",
    mode: "render",
    codec: "eac3",
    verified: true,
    verificationText: null,
    residualMs: 0.2,
    sourceTrack: 0,
    createdAt: "2026-11-23T00:00:00Z",
    videoPath: video.path,
  } as unknown as NonNullable<ExternalFile["conformed"]>;
  const dub = (extra: Partial<ExternalFile>): ExternalFile =>
    ({ id: "d1", name: "Show.S01E02.Hindi.mka", path: "D:\\Dubs\\Show.S01E02.Hindi.mka", type: "audio", matchedVideoId: "v1", conformed, ...extra }) as ExternalFile;

  it("stops the mux, naming the slot and row", () => {
    const issues = conformedSubtitleIssues({ "1": [dub({ includeSubtitles: true, includedSubtitleTrackIds: [2] })] }, [video]);
    expect(issues).toEqual([expect.stringMatching(/^Audio 1, row 1: Show\.S01E02\.Hindi\.mka is conformed, so its subtitles would be left out/)]);
  });

  it("says nothing when the subtitles are off, the file is not conformed, or the row is a gap", () => {
    expect(conformedSubtitleIssues({ "1": [dub({ includeSubtitles: false, includedSubtitleTrackIds: [2] })] }, [video])).toEqual([]);
    expect(conformedSubtitleIssues({ "1": [dub({ includeSubtitles: true, includedSubtitleTrackIds: [2], conformed: undefined })] }, [video])).toEqual([]);
    expect(conformedSubtitleIssues({ "1": [{ id: "gap-v1", name: "", path: "", type: "audio", placeholder: true } as ExternalFile] }, [video])).toEqual([]);
  });
});
