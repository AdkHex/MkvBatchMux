/** Conform and Sync subtitles end to end, with the real engine and mkvmerge:
 *  the frontend half. It builds the very requests the Audio and Subtitles
 *  pages send for the test season, then turns the engine's answers into the
 *  mux jobs the Mux page sends. The Rust half (src-tauri/src/ui_e2e.rs) runs
 *  the requests through the engine, and muxes and checks the jobs.
 *
 *  Skipped unless MBM_UI_E2E names a scratch folder. In order, with the
 *  test media from make_media.py, mkvmerge and ffmpeg on PATH and
 *  AUDIOSYNC_REPO set:
 *
 *    MBM_UI_E2E=<dir> MBM_TEST_MEDIA=<media> MBM_UI_E2E_STAGE=requests npx vitest run realEngine
 *    MBM_UI_E2E=<dir> MBM_TEST_MEDIA=<media> cargo test ui_e2e::real_engine_answers -- --ignored --nocapture
 *    MBM_UI_E2E=<dir> MBM_TEST_MEDIA=<media> MBM_UI_E2E_STAGE=mux npx vitest run realEngine
 *    MBM_UI_E2E=<dir> MBM_TEST_MEDIA=<media> cargo test ui_e2e::real_mux_jobs -- --ignored --nocapture */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ExternalFile, MeasuredDelay, MuxJob, MuxSettings, Track, VideoFile } from "@/shared/types";
import type { ConformResultEvent, SubsyncResultEvent } from "@/shared/types/engineFeatures";
import { buildConformRequest } from "@/features/workspace/hooks/useConform";

import { applyAllPendingDelays } from "./applyMeasurement";
import { applyConformResult, buildConformPlan, conformedStatus, offersConform } from "./conform";
import { buildMuxJobRequests } from "./muxJobBuilder";
import { applySubsyncResult, buildSubsyncPlan, subsyncRuns, syncRecord, syncStatus } from "./subsync";

const dir = process.env.MBM_UI_E2E;
const media = process.env.MBM_TEST_MEDIA;
const stage = process.env.MBM_UI_E2E_STAGE;

const TYPES: Record<string, Track["type"]> = { video: "video", audio: "audio", subtitles: "subtitle" };

/** A file's tracks as the app reads them (mkvmerge -J). */
function tracksOf(path: string): Track[] {
  const info = JSON.parse(execFileSync("mkvmerge", ["-J", path], { encoding: "utf8" }));
  return (info.tracks ?? []).map((track: { id: number; type: string; codec: string; properties?: { language?: string; track_name?: string; default_track?: boolean } }) => ({
    id: String(track.id),
    type: TYPES[track.type] ?? "video",
    codec: track.codec,
    language: track.properties?.language,
    name: track.properties?.track_name,
    isDefault: track.properties?.default_track,
  }));
}

function season() {
  const root = media!;
  const videos: VideoFile[] = [1, 2, 3].map((n) => {
    const path = join(root, "Show", "Season 1", `Show.S01E0${n}.mkv`);
    return { id: `v${n}`, name: `Show.S01E0${n}.mkv`, path, size: 1, status: "pending", tracks: tracksOf(path) };
  });
  // E02's dub as the Audio page holds it after measuring: a different cut.
  const measured: MeasuredDelay = {
    engineDelayMs: 840, appliedMs: -840, confidence: 0.99, driftMsPerS: null, hasSignificantDrift: false, isRateMismatch: false, isLikelyCut: true,
    cutPositionS: 100, cutMagnitudeMs: -10000, correctionRatio: null, rateSourceFps: null, rateTargetFps: null, rateExplanation: null,
    referenceTrack: 0, videoPath: videos[1].path, videoFile: videos[1].name, primaryFps: 23.976, measuredAt: new Date().toISOString(), error: null,
  };
  const dubPath = join(root, "Dubs", "Show.S01E02.Hindi.eac3");
  const dub: ExternalFile = {
    id: "dub2", name: "Show.S01E02.Hindi.eac3", path: dubPath, type: "audio", language: "hin", trackName: "Hindi", isDefault: true, muxAfter: "video",
    matchedVideoId: "v2", delay: 0, tracks: tracksOf(dubPath), includedTrackIds: [0], measuredDelay: measured,
  };
  const subtitles: ExternalFile[] = [1, 2, 3].map((n) => {
    const path = join(root, "Subs", `Show.S01E0${n}.en.srt`);
    return { id: `sub${n}`, name: `Show.S01E0${n}.en.srt`, path, type: "subtitle", language: "eng", trackName: "English", isDefault: true, muxAfter: "audio", matchedVideoId: `v${n}`, delay: 0, tracks: tracksOf(path) };
  });
  return { videos, dub, subtitles };
}

describe.skipIf(!dir || !media || stage !== "requests")("real engine, frontend half: the requests", () => {
  it("builds what the pages send", () => {
    const { videos, dub, subtitles } = season();
    expect(offersConform(dub, videos[1])).toBe(true);
    const { planned } = buildConformPlan({ videoFiles: videos, files: [dub], fileIds: ["dub2"] });
    const render = buildConformRequest(planned, "ui-render", undefined);
    const lossless = buildConformRequest(planned, "ui-lossless", { windowSeconds: 45, windowCount: 6, maxOffsetMs: 60000, conformMode: "lossless", conformOutputDir: join(dir!, "lossless") });
    // The default puts the copy beside the dub; here it goes to the scratch folder, as Preferences can.
    render.outputDir = join(dir!, "render");
    const sync = buildSubsyncPlan({ videoFiles: videos, files: subtitles });
    const runs = subsyncRuns(sync.planned, 1).map(({ request }) => ({ ...request, outputDir: join(dir!, "synced") }));
    expect(runs.map((run) => [run.engine, run.jobs.map((job) => job.key)])).toEqual([
      ["subtitle", ["sub1", "sub2"]],
      ["audio", ["sub3"]],
    ]);
    mkdirSync(dir!, { recursive: true });
    writeFileSync(join(dir!, "requests.json"), JSON.stringify({ conform: [render, lossless], subsync: runs }, null, 1));
  });
});

describe.skipIf(!dir || !media || stage !== "mux")("real engine, frontend half: the mux jobs", () => {
  it("turns the engine's answers into what the Mux page sends", () => {
    const { videos, dub, subtitles } = season();
    const events = JSON.parse(readFileSync(join(dir!, "events.json"), "utf8")) as { conform: ConformResultEvent[]; subsync: SubsyncResultEvent[] };
    const { planned } = buildConformPlan({ videoFiles: videos, files: [dub], fileIds: ["dub2"] });
    const report: Record<string, unknown> = {};

    // Conform, as the Audio page keeps it: the render by default; the lossless one checked as well.
    const byRun = (prefix: string) => events.conform.find((event) => event.runId === prefix)!;
    const lossless = applyConformResult(dub, byRun("ui-lossless"), planned[0]);
    const conformed = applyConformResult(dub, byRun("ui-render"), planned[0]);
    report.conform = [conformed, lossless].map((file) => ({ ...conformedStatus(file, videos[1]), path: file.conformed?.path, mode: file.conformed?.mode, residualMs: file.conformed?.residualMs }));
    expect(conformedStatus(conformed, videos[1])?.text).toBe("Conformed");
    expect(conformedStatus(lossless, videos[1])?.text).toBe("Conformed");

    // Sync, as the Subtitles page keeps it, then Apply.
    const plan = buildSubsyncPlan({ videoFiles: videos, files: subtitles });
    const synced = subtitles.map((file) => {
      const entry = plan.planned.find((p) => p.fileId === file.id)!;
      const result = events.subsync.find((event) => event.key === file.id)!;
      const kept = applySubsyncResult(file, syncRecord(result, entry, new Date().toISOString()), entry.trackId);
      return applyAllPendingDelays(kept);
    });
    report.subsync = synced.map((file, i) => ({ file: file.name, status: syncStatus(file, videos[i]).text, delay: file.delay, retimed: file.retimed?.path ?? null, engine: file.subsync?.engine, score: file.subsync?.score, confidence: file.subsync?.confidence }));

    const jobs: MuxJob[] = videos.map((video) => ({ id: `job-${video.id}`, videoFile: video, status: "queued", progress: 0 }));
    const requests = buildMuxJobRequests({ videoFiles: videos, jobs, audioFilesByTrack: { "1": [conformed] }, subtitleFilesByTrack: { "1": synced }, chapterFiles: [], attachmentFiles: [], perVideoExternal: {} });
    const settings: MuxSettings = {
      destinationDir: join(dir!, "muxed"), outputNamingPattern: "{original_filename}", overwriteSource: false, addCrc: false, removeOldCrc: false, keepLogFile: false,
      abortOnErrors: false, maxParallelJobs: 1, onlyKeepAudiosEnabled: false, onlyKeepSubtitlesEnabled: false, onlyKeepAudioLanguages: [], onlyKeepSubtitleLanguages: [],
      discardOldChapters: false, discardOldAttachments: false, allowDuplicateAttachments: false, attachmentsExpertMode: false, removeGlobalTags: false, useMkvpropedit: false,
      verifyOutput: true, verifySync: true, verifySyncToleranceMs: 40,
    };
    mkdirSync(settings.destinationDir, { recursive: true });
    writeFileSync(join(dir!, "muxjobs.json"), JSON.stringify({ settings, jobs: requests.map(({ id, video, audios, subtitles: subs, chapters, attachments }) => ({ id, video, audios, subtitles: subs, chapters, attachments })) }, null, 1));
    // E02 again with the lossless conform (a Matroska file of the dub's own frames).
    const losslessJob = buildMuxJobRequests({ videoFiles: videos, jobs: [jobs[1]], audioFilesByTrack: { "1": [lossless] }, subtitleFilesByTrack: {}, chapterFiles: [], attachmentFiles: [], perVideoExternal: {} });
    const losslessSettings = { ...settings, destinationDir: join(dir!, "muxed-lossless") };
    mkdirSync(losslessSettings.destinationDir, { recursive: true });
    writeFileSync(join(dir!, "muxjobs-lossless.json"), JSON.stringify({ settings: losslessSettings, jobs: losslessJob.map(({ id, video, audios, subtitles: subs, chapters, attachments }) => ({ id, video, audios, subtitles: subs, chapters, attachments })) }, null, 1));
    writeFileSync(join(dir!, "frontend-report.json"), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report, null, 1));
  });
});
