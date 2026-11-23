import { describe, expect, it } from "vitest";

import type { ExternalFile, VideoFile } from "@/shared/types";
import type { SubsyncResultEvent } from "@/shared/types/engineFeatures";

import { applyAllPendingDelays } from "./applyMeasurement";
import {
  AUDIO_MIN_SCORE,
  applySubsyncResult,
  applySyncAnyway,
  buildSubsyncPlan,
  chooseReference,
  isHeld,
  isPictureSubtitle,
  syncRecord,
  syncStatus,
  undoSync,
} from "./subsync";

const video = (n: number, tracks: VideoFile["tracks"]): VideoFile => ({
  id: `v${n}`,
  name: `Show.S01E0${n}.mkv`,
  path: `/media/Show/Season 1/Show.S01E0${n}.mkv`,
  size: 1,
  status: "pending",
  tracks,
});

const withSubtitles = (n: number) =>
  video(n, [
    { id: "0", type: "video" },
    { id: "1", type: "audio", language: "eng" },
    { id: "2", type: "subtitle", codec: "HDMV PGS", language: "eng" },
    { id: "3", type: "subtitle", codec: "SubRip/SRT", language: "kor" },
    { id: "4", type: "subtitle", codec: "SubRip/SRT", language: "eng" },
  ]);
/** Only a forced picture track inside: too few lines to sync against, so its speech. */
const speechOnly = (n: number) => video(n, [{ id: "0", type: "video" }, { id: "1", type: "audio", language: "eng" }, { id: "2", type: "subtitle", codec: "HDMV PGS", isForced: true }]);
/** Blu-ray pictures only: forced English, Korean, full English. */
const picturesOnly = (n: number) =>
  video(n, [
    { id: "0", type: "video" },
    { id: "1", type: "audio", language: "eng" },
    { id: "2", type: "subtitle", codec: "HDMV PGS", language: "eng", isForced: true },
    { id: "3", type: "subtitle", codec: "HDMV PGS", language: "kor" },
    { id: "4", type: "subtitle", codec: "HDMV PGS", language: "eng" },
  ]);

const subtitle = (n: number, extra: Partial<ExternalFile> = {}): ExternalFile => ({
  id: `s${n}`,
  name: `Show.S01E0${n}.en.srt`,
  path: `/media/Subs/Show.S01E0${n}.en.srt`,
  type: "subtitle",
  language: "eng",
  matchedVideoId: `v${n}`,
  delay: 0,
  ...extra,
});

const result = (extra: Partial<SubsyncResultEvent> = {}): SubsyncResultEvent => ({
  runId: "r",
  key: "s1",
  offsetS: -2.5003,
  ratio: 1,
  splits: 0,
  score: 1,
  method: "subtitle",
  description: "Matched against the reference subtitle (high confidence, score 1.00): shifted by -2.500 s.",
  retimedPath: "/media/Subs/MKVBatchMux synced/Show.S01E01.en.srt",
  error: null,
  applied: true,
  confidence: "high",
  framerate: null,
  splitPoints: [],
  warnings: [],
  ...extra,
});

describe("the reference each row is synced against", () => {
  it("takes the video's text subtitle track in the file's language, else its first text track", () => {
    // Stream indexes count subtitle tracks only, pictures included: eng SRT is 0:s:2.
    expect(chooseReference(subtitle(1), withSubtitles(1))).toMatchObject({ engine: "subtitle", track: 2 });
    expect(chooseReference(subtitle(1, { language: "fre" }), withSubtitles(1))).toMatchObject({ engine: "subtitle", track: 1 });
    // Only a forced picture track inside: the speech of its first audio track.
    expect(chooseReference(subtitle(1), speechOnly(1))).toMatchObject({ engine: "audio", track: 0 });
    expect(chooseReference(subtitle(1), video(1, [{ id: "0", type: "video" }]))).toEqual({ engine: null, reason: expect.stringMatching(/no subtitle track to sync against and no audio/) });
  });

  it("takes a full Blu-ray picture track when the video has no text one, the file's language first", () => {
    expect(chooseReference(subtitle(1), picturesOnly(1))).toEqual({ engine: "subtitle", track: 2, label: "Subtitle 3 · eng · HDMV PGS", pictures: true });
    expect(chooseReference(subtitle(1, { language: "kor" }), picturesOnly(1))).toMatchObject({ track: 1, pictures: true });
    // A text track still comes first, pictures or not.
    expect(chooseReference(subtitle(1), withSubtitles(1))).not.toHaveProperty("pictures");
    // A picture track being removed from the video is no reference.
    const removed = picturesOnly(1);
    removed.tracks = removed.tracks!.map((track) => (track.type === "subtitle" && !track.isForced ? { ...track, action: "remove" as const } : track));
    expect(chooseReference(subtitle(1), removed)).toMatchObject({ engine: "audio" });
  });

  it("splits a season into subtitle-engine and speech jobs, syncs Blu-ray pictures, and answers DVD pictures itself", () => {
    const files: ExternalFile[] = [
      subtitle(1),
      subtitle(2),
      subtitle(3, { name: "Show.S01E03.sup", path: "/media/Subs/Show.S01E03.sup" }),
      { id: "gap", name: "", path: "", type: "subtitle", placeholder: true, matchedVideoId: "v4" },
      subtitle(5, { matchedVideoId: undefined, name: "Unrelated.srt", path: "/x/Unrelated.srt" }),
      subtitle(6, { name: "Show.S01E06.idx", path: "/media/Subs/Show.S01E06.idx" }),
      subtitle(7),
    ];
    const videos = [withSubtitles(1), speechOnly(2), withSubtitles(3), speechOnly(4), speechOnly(6), picturesOnly(7)];
    const plan = buildSubsyncPlan({ videoFiles: videos, files });
    expect(plan.planned.map((entry) => [entry.fileId, entry.engine, entry.job.referenceTrack, entry.job.audioTrack, entry.job.subtitleTrack, entry.job.subtitlePictures, entry.job.referencePictures])).toEqual([
      ["s1", "subtitle", 2, 0, null, false, false],
      ["s2", "audio", null, 0, null, false, false],
      ["s3", "subtitle", 2, 0, null, true, false],
      ["s7", "subtitle", 2, 0, null, false, true],
    ]);
    expect(plan.planned[0].job).toMatchObject({ key: "s1", subtitlePath: "/media/Subs/Show.S01E01.en.srt", videoPath: videos[0].path });
    expect(plan.answered.map((entry) => [entry.file.id, entry.outcome, entry.message])).toEqual([["s6", "picture", expect.stringMatching(/only Blu-ray \(PGS\) pictures/)]]);
    expect(plan.skipped.map((entry) => entry.file.id)).toEqual(["s5"]);
  });

  it("syncs the one subtitle track muxed from a container, Blu-ray pictures too, and refuses DVD pictures", () => {
    const container = subtitle(1, {
      name: "Show.S01E01.subs.mks",
      path: "/media/Subs/Show.S01E01.subs.mks",
      tracks: [
        { id: "0", type: "subtitle", codec: "HDMV PGS" },
        { id: "1", type: "subtitle", codec: "SubRip/SRT", language: "eng" },
      ],
      includedTrackIds: [1],
    });
    const plan = buildSubsyncPlan({ videoFiles: [withSubtitles(1)], files: [container] });
    expect(plan.planned[0].job.subtitleTrack).toBe(1);
    expect(isPictureSubtitle({ ...container, includedTrackIds: [0] })).toBe(true);
    expect(buildSubsyncPlan({ videoFiles: [withSubtitles(1)], files: [{ ...container, includedTrackIds: [0] }] }).planned[0].job).toMatchObject({ subtitleTrack: 0, subtitlePictures: true });
    const dvd = { ...container, tracks: [{ id: "0", type: "subtitle" as const, codec: "VobSub" }], includedTrackIds: [0] };
    expect(buildSubsyncPlan({ videoFiles: [withSubtitles(1)], files: [dvd] }).answered[0].outcome).toBe("picture");
    expect(buildSubsyncPlan({ videoFiles: [withSubtitles(1)], files: [{ ...container, includedTrackIds: [0, 1] }] }).skipped[0].reason).toMatch(/one subtitle track, and 2/);
  });
});

describe("filling a result in", () => {
  const planned = { engine: "subtitle" as const, videoPath: withSubtitles(1).path, videoName: withSubtitles(1).name, job: { key: "s1", subtitlePath: "", videoPath: "", audioTrack: 0, referenceTrack: 2 } };
  const at = "2026-11-23T10:00:00.000Z";

  it("stages a pure offset as the delay to add, unnegated, for Apply", () => {
    const record = syncRecord(result(), planned, at);
    expect(record).toMatchObject({ outcome: "delay", offsetS: -2.5, held: false, referenceTrack: 2 });
    const file = applySubsyncResult(subtitle(1), record, null);
    expect(file.pendingDelay).toBe(-2.5);
    expect(file.delay).toBe(0);
    expect(syncStatus(file, withSubtitles(1))).toEqual({ s: "ok", text: "Measured" });
    const applied = applyAllPendingDelays(file);
    expect([applied.delay, applied.delayProvenance, applied.pendingDelay]).toEqual([-2.5, "measured", undefined]);
    expect(syncStatus(applied, withSubtitles(1))).toEqual({ s: "ok", text: "Applied" });
    // A delay typed by hand stays.
    expect(applySubsyncResult(subtitle(1, { delay: 1, delayProvenance: "manual" }), record, null).pendingDelay).toBeUndefined();
  });

  it("writes to the track whose own delay would otherwise win", () => {
    const own = subtitle(1, { tracks: [{ id: "0", type: "subtitle" }], trackOverrides: { 0: { delay: 0.4 } } });
    const plan = buildSubsyncPlan({ videoFiles: [withSubtitles(1)], files: [own] });
    expect(plan.planned[0].trackId).toBe(0);
    const file = applySubsyncResult(own, syncRecord(result(), planned, at), 0);
    expect(file.trackOverrides?.[0]).toEqual({ delay: 0.4, pendingDelay: -2.5 });
    expect(applyAllPendingDelays(file).trackOverrides?.[0]).toMatchObject({ delay: -2.5, delayProvenance: "measured" });
  });

  it("uses the engine's re-timed copy for a frame-rate change, and Undo goes back", () => {
    const record = syncRecord(result({ ratio: 1.0427083333, offsetS: -0.0722, framerate: "25 → 23.976", retimedPath: "/s/MKVBatchMux synced/Show.S01E03.en.srt" }), planned, at);
    expect(record.outcome).toBe("retimed");
    const original = subtitle(3, { delay: 0.5 });
    const file = applySubsyncResult(original, record, null);
    expect(file.retimed).toEqual({ path: "/s/MKVBatchMux synced/Show.S01E03.en.srt", offsetS: -0.072, ratio: 1.0427083333, splits: 0, score: 1, videoPath: planned.videoPath });
    expect(file.pendingDelay).toBeUndefined();
    expect(syncStatus(file, withSubtitles(1))).toEqual({ s: "ok", text: "Re-timed copy" });
    expect(undoSync(file)).toEqual(original);
  });

  it("holds a speech result the engine is not sure of, until Apply anyway", () => {
    const speech = { ...planned, engine: "audio" as const };
    expect(isHeld({ score: 1, confidence: "high" }, "audio")).toBe(false);
    expect(isHeld({ score: AUDIO_MIN_SCORE - 0.01, confidence: "high" }, "audio")).toBe(true);
    expect(isHeld({ score: 0.95, confidence: "medium" }, "audio")).toBe(true);
    // The subtitle engine keeps its own, lower bar.
    expect(isHeld({ score: 0.6, confidence: "medium" }, "subtitle")).toBe(false);
    const record = syncRecord(result({ score: 0.42, confidence: "medium", offsetS: 0.48 }), speech, at);
    const file = applySubsyncResult(subtitle(2), record, null);
    expect(file.pendingDelay).toBeUndefined();
    expect(syncStatus(file, withSubtitles(1))).toEqual({ s: "warn", text: "Low confidence" });
    const anyway = applySyncAnyway(file, null);
    expect([anyway.delay, anyway.delayProvenance, anyway.subsync?.held]).toEqual([0.48, "measured", false]);
  });

  it("says when a subtitle cannot be synced, found nothing, or was measured against another video", () => {
    const picture = syncRecord(result({ error: "Can't be synced automatically: this subtitle is pictures (PGS/VobSub), not text.", applied: false, offsetS: null }), planned, at);
    expect(syncStatus(applySubsyncResult(subtitle(1), picture, null), withSubtitles(1))).toEqual({ s: "warn", text: "Can't be synced automatically" });
    const none = syncRecord(result({ applied: false, offsetS: null, ratio: null, score: 0.04, confidence: "low" }), planned, at);
    expect(syncStatus(applySubsyncResult(subtitle(1), none, null), withSubtitles(1))).toEqual({ s: "warn", text: "No clear match" });
    const measured = applySubsyncResult(subtitle(1), syncRecord(result(), planned, at), null);
    expect(syncStatus({ ...measured, matchedVideoId: "v2" }, speechOnly(2))).toEqual({ s: "warn", text: "Measured against another video" });
  });
});
