/** Sync subtitles (Subtitles page): what each row is measured against, the
 *  engine jobs for a run, and what a result does to the file. The engine
 *  side is src-tauri/src/subsync.rs.
 *
 *  The reference is chosen per row. A video that carries a text subtitle
 *  track of its own is the best there is: the subtitle engine lines the file
 *  up against it, cue for cue, and measured the planted shifts of the test
 *  season to the millisecond (E01 -2.5003 s for -2.500, E02 +1.1997 s for
 *  +1.200). Otherwise the audio engine listens to the video's speech, which
 *  on the same season was 78 ms (E01) and 720 ms (E02) off: its speech
 *  detector places the start of a line where the voice starts, not where the
 *  cue does. So its results are filled in only when the engine is sure
 *  (`AUDIO_MIN_SCORE`), and shown with Apply anyway otherwise.
 *
 *  Blu-ray picture subtitles (PGS) are synced by when their pictures are on
 *  screen, which is all the engine compares: src-tauri/src/pgs.rs reads that
 *  timing, as a subtitle and as a reference track inside the video. DVD
 *  pictures (VobSub) are not synced. */

import type { ExternalFile, SubtitleSync, Track, VideoFile } from "@/shared/types";
import type { SubsyncEngine, SubsyncJob, SubsyncRequest, SubsyncResultEvent } from "@/shared/types/engineFeatures";
import { SUBSYNC_DEFAULTS } from "@/shared/types/engineFeatures";
import { isLowScore, isPureOffset, subsyncDelaySeconds } from "@/shared/lib/engineFeatures";
import type { St } from "@/ui/kit";

import { measuredAgainstAnother } from "./measureVerdict";
import { buildStrictVideoMatcher } from "./muxJobBuilder";

/** The audio engine's result is filled in only at the engine's "high"
 *  confidence and a score of at least this. Both come from its report:
 *  "high" is a correlation peak standing 10 robust deviations clear of every
 *  other offset (`HIGH_Z`) with at least half the cue time on detected
 *  speech; the score is clarity (peak z, 3 → 10) times that fit (over 0.4),
 *  so 0.8 asks for a peak of about z 8.6 and a fit of 0.32 at the least. A
 *  subtitle of another film peaks at z 2–5 and fits 0.04–0.05, far below.
 *  It cannot catch the speech detector's lag (the test season scored 1.0 at
 *  78 and 720 ms off), which is why a sure result still says it came from
 *  speech. */
export const AUDIO_MIN_SCORE = 0.8;

/** Subtitle formats that are pictures: the engine cannot read them as text. */
const PICTURE_CODEC = /pgs|hdmv|vobsub|dvd_?sub|dvb|picture|bitmap|s_image/i;
const PICTURE_EXTENSION = /\.(sup|sub|idx)$/i;
/** Blu-ray pictures: synced by when they are on screen. */
const PGS_CODEC = /pgs|hdmv/i;
const PGS_EXTENSION = /\.sup$/i;
/** Plain subtitle files: their path is the subtitle; anything else is a container. */
const TEXT_EXTENSION = /\.(srt|ass|ssa|vtt|webvtt|sbv|ttml|dfxp|smi|sami|lrc|txt)$/i;

const isPictureTrack = (track: Pick<Track, "codec">) => Boolean(track.codec && PICTURE_CODEC.test(track.codec));
const isPgsTrack = (track: Pick<Track, "codec">) => Boolean(track.codec && PGS_CODEC.test(track.codec));

/** The subtitle track a sync works on: the file itself for a plain subtitle
 *  file, or the one subtitle track muxed from a container. `streamIndex` is
 *  the N of `0:s:N` (null for a plain file); `trackId` keys the overrides. */
export function subtitleTrack(file: ExternalFile): { trackId: number | null; streamIndex: number | null; track?: Track } | { error: string } {
  const subs = (file.tracks ?? []).filter((track) => track.type === "subtitle");
  if (TEXT_EXTENSION.test(file.path) || PICTURE_EXTENSION.test(file.path) || subs.length === 0) {
    const track = subs[0];
    return { trackId: track ? Number(track.id) : null, streamIndex: null, track };
  }
  const included = subs
    .map((track, streamIndex) => ({ track, streamIndex, trackId: Number(track.id) }))
    .filter((entry) => !file.includedTrackIds || file.includedTrackIds.includes(entry.trackId));
  if (included.length === 0) return { error: "None of this file's subtitle tracks is muxed." };
  if (included.length > 1) return { error: `Sync works on one subtitle track, and ${included.length} of this file's are muxed. Keep only one in its track list.` };
  return included[0];
}

/** A picture subtitle: Blu-ray (PGS) or DVD (VobSub, and the like). */
export function isPictureSubtitle(file: ExternalFile): boolean {
  if (PICTURE_EXTENSION.test(file.path)) return true;
  const chosen = subtitleTrack(file);
  return "track" in chosen && Boolean(chosen.track && isPictureTrack(chosen.track));
}

/** A Blu-ray picture subtitle (PGS): synced by when its pictures are shown. */
export function isPgsSubtitle(file: ExternalFile): boolean {
  if (PGS_EXTENSION.test(file.path)) return true;
  if (PICTURE_EXTENSION.test(file.path)) return false;
  const chosen = subtitleTrack(file);
  return "track" in chosen && Boolean(chosen.track && isPgsTrack(chosen.track));
}

/** A picture subtitle nothing here can sync: DVD pictures (VobSub). */
export function isUnsyncablePicture(file: ExternalFile): boolean {
  return isPictureSubtitle(file) && !isPgsSubtitle(file);
}

const language = (value: string | undefined) => (value ?? "").trim().toLowerCase();

/** A track that carries only some lines (signs, foreign dialogue): too few to line a whole subtitle up with. */
const isForcedOnly = (track: Pick<Track, "isForced" | "name">) => Boolean(track.isForced) || /forced/i.test(track.name ?? "");

/** What a row is measured against: a text subtitle track inside the video
 *  (the same language as the file when there is one, else the first), else a
 *  full Blu-ray picture track inside it (by when its pictures are shown; the
 *  same language first), else the video's first audio track. Null with the
 *  reason when there is none. `pictures`: the reference track is PGS. */
export function chooseReference(
  file: ExternalFile,
  video: VideoFile,
): { engine: SubsyncEngine; track: number; label: string; pictures?: boolean } | { engine: null; reason: string } {
  const subtitles = (video.tracks ?? []).filter((track) => track.type === "subtitle");
  const usable = subtitles.map((track, index) => ({ track, index })).filter(({ track }) => track.action !== "remove");
  const own = subtitleTrack(file);
  const wanted = language(("track" in own ? own.track?.language : undefined) || file.language);
  const sameLanguage = <T extends { track: Track }>(list: T[]) => (wanted && wanted !== "und" ? list.find(({ track }) => language(track.language) === wanted) : undefined);
  const text = usable.filter(({ track }) => !isPictureTrack(track));
  if (text.length > 0) {
    const chosen = sameLanguage(text) ?? text[0];
    return { engine: "subtitle", track: chosen.index, label: referenceLabel("subtitle", chosen.index, chosen.track) };
  }
  const pictures = usable.filter(({ track }) => isPgsTrack(track) && !isForcedOnly(track));
  if (pictures.length > 0) {
    const chosen = sameLanguage(pictures) ?? pictures[0];
    return { engine: "subtitle", track: chosen.index, label: referenceLabel("subtitle", chosen.index, chosen.track), pictures: true };
  }
  const audio = (video.tracks ?? []).filter((track) => track.type === "audio");
  // Tracks not read yet (a video added a moment ago): its first audio track.
  if (audio.length > 0 || (video.tracks ?? []).length === 0) return { engine: "audio", track: 0, label: referenceLabel("audio", 0, audio[0]) };
  return { engine: null, reason: "The video has no subtitle track to sync against and no audio." };
}

/** "Subtitle 1 · English · SRT" / "Speech · audio 1 · Korean". */
export function referenceLabel(engine: SubsyncEngine, index: number, track?: Pick<Track, "language" | "codec" | "name">): string {
  const parts = [engine === "subtitle" ? `Subtitle ${index + 1}` : `Speech · audio ${index + 1}`, track?.language && track.language !== "und" ? track.language : null, engine === "subtitle" ? track?.codec : null, track?.name];
  return parts.filter(Boolean).join(" · ");
}

/** Where a synced delay goes: the file's delay, or its one track's when
 *  that track has a delay of its own, which the mux would take instead. */
export function syncTarget(file: ExternalFile): number | null {
  const own = subtitleTrack(file);
  if ("error" in own || own.trackId === null) return null;
  return file.trackOverrides?.[own.trackId]?.delay !== undefined || file.trackOverrides?.[own.trackId]?.pendingDelay !== undefined ? own.trackId : null;
}

export interface PlannedSync {
  job: SubsyncJob;
  engine: SubsyncEngine;
  fileId: string;
  /** The track the result is written to, for a file whose one track has a
   *  delay of its own; null writes the file's delay. */
  trackId: number | null;
  videoPath: string;
  videoName: string;
  fileName: string;
}

export interface SubsyncPlan {
  planned: PlannedSync[];
  /** Answered without the engine: DVD picture subtitles, and rows with nothing to sync against. */
  answered: Array<{ file: ExternalFile; video: VideoFile; outcome: "picture" | "error"; message: string }>;
  /** Not synced: no video, an empty row, several tracks. */
  skipped: Array<{ file: ExternalFile; reason: string }>;
}

/** The same words as `IMAGE_SUBTITLE` in src-tauri/src/subsync.rs. */
export const PICTURE_MESSAGE = "Can't be synced automatically: DVD subtitles (VobSub) are pictures, and only Blu-ray (PGS) pictures can be synced.";

/** Engine jobs for these files (all of them when `fileIds` is absent), each
 *  against the video it will be muxed with. */
export function buildSubsyncPlan({ videoFiles, files, fileIds }: { videoFiles: VideoFile[]; files: ExternalFile[]; fileIds?: string[] }): SubsyncPlan {
  const plan: SubsyncPlan = { planned: [], answered: [], skipped: [] };
  const { byId, resolve } = buildStrictVideoMatcher(videoFiles);
  for (const file of files) {
    if (file.placeholder || (fileIds && !fileIds.includes(file.id))) continue;
    const videoId = resolve(file);
    const video = videoId ? byId.get(videoId) : undefined;
    if (!video) {
      plan.skipped.push({ file, reason: "It has no video to sync against." });
      continue;
    }
    if (isUnsyncablePicture(file)) {
      plan.answered.push({ file, video, outcome: "picture", message: PICTURE_MESSAGE });
      continue;
    }
    const own = subtitleTrack(file);
    if ("error" in own) {
      plan.skipped.push({ file, reason: own.error });
      continue;
    }
    const reference = chooseReference(file, video);
    if ("reason" in reference) {
      plan.answered.push({ file, video, outcome: "error", message: reference.reason });
      continue;
    }
    const trackId = syncTarget(file);
    plan.planned.push({
      job: {
        key: file.id,
        subtitlePath: file.path,
        subtitleTrack: own.streamIndex,
        videoPath: video.path,
        audioTrack: reference.engine === "audio" ? reference.track : 0,
        referenceTrack: reference.engine === "subtitle" ? reference.track : null,
        subtitlePictures: isPgsSubtitle(file),
        referencePictures: Boolean(reference.pictures),
      },
      engine: reference.engine,
      fileId: file.id,
      trackId,
      videoPath: video.path,
      videoName: video.name,
      fileName: file.name,
    });
  }
  return plan;
}

/** The engine runs for a plan, in order: rows with a subtitle track inside
 *  their video first (exact, and the quicker), then rows synced by speech.
 *  The engine takes one reference kind per run. */
export function subsyncRuns(planned: PlannedSync[], startedAt: number): Array<{ request: SubsyncRequest; planned: PlannedSync[] }> {
  return (["subtitle", "audio"] as const)
    .map((engine) => ({ engine, entries: planned.filter((entry) => entry.engine === engine) }))
    .filter(({ entries }) => entries.length > 0)
    .map(({ engine, entries }) => ({
      request: { ...SUBSYNC_DEFAULTS, runId: `subsync-${startedAt}-${engine}`, engine, jobs: entries.map((entry) => entry.job) },
      planned: entries,
    }));
}

/** Whether a result is sure enough to fill in. The subtitle engine's own
 *  rule (`isLowScore`) for a reference track; for speech, `AUDIO_MIN_SCORE`. */
export function isHeld(result: Pick<SubsyncResultEvent, "score" | "confidence">, engine: SubsyncEngine): boolean {
  if (engine === "audio") return !(result.confidence === "high" && result.score !== null && result.score >= AUDIO_MIN_SCORE);
  return isLowScore(result);
}

/** What the engine said, as kept on the file. */
export function syncRecord(result: SubsyncResultEvent, planned: Pick<PlannedSync, "engine" | "videoPath" | "videoName" | "job">, measuredAt: string): SubtitleSync {
  const base = {
    engine: planned.engine,
    videoPath: planned.videoPath,
    videoName: planned.videoName,
    referenceTrack: planned.engine === "subtitle" ? (planned.job.referenceTrack ?? 0) : planned.job.audioTrack,
    offsetS: subsyncDelaySeconds(result),
    ratio: result.ratio,
    splits: result.splits,
    score: result.score,
    confidence: result.confidence,
    description: result.description,
    framerate: result.framerate,
    warnings: result.warnings ?? [],
    retimedPath: result.retimedPath,
    measuredAt,
  };
  if (result.error) {
    const picture = /^Can't be synced automatically/.test(result.error);
    return { ...base, outcome: picture ? "picture" : "error", held: false, description: result.error };
  }
  if (!result.applied || base.offsetS === null || result.ratio === null) return { ...base, outcome: "noMatch", held: false, description: result.description ?? "No clear match was found." };
  const held = isHeld(result, planned.engine);
  if (isPureOffset(result)) return { ...base, outcome: "delay", held };
  if (!result.retimedPath) {
    return { ...base, outcome: "error", held: false, description: "The engine found a frame-rate change or scene offsets but wrote no re-timed copy." };
  }
  return { ...base, outcome: "retimed", held };
}

/** Drop what an earlier sync left: its pending delay and re-timed copy. */
function withoutSync(file: ExternalFile, trackId: number | null): ExternalFile {
  const { retimed: _retimed, subsync: _subsync, pendingDelay: _pending, ...rest } = file;
  if (trackId === null || !rest.trackOverrides?.[trackId]) return rest;
  const { pendingDelay: _trackPending, ...override } = rest.trackOverrides[trackId];
  return { ...rest, trackOverrides: { ...rest.trackOverrides, [trackId]: override } };
}

/** A sync result on its file. A delay is staged as pending, for Apply (or
 *  held for Apply anyway); a re-timed copy goes in at once, with Undo; a
 *  held one waits for Apply anyway. A delay typed by hand is left alone. */
export function applySubsyncResult(file: ExternalFile, record: SubtitleSync, trackId: number | null): ExternalFile {
  const next: ExternalFile = { ...withoutSync(file, trackId), subsync: record };
  if (record.held) return next;
  if (record.outcome === "delay" && record.offsetS !== null) return stageDelay(next, record.offsetS, trackId);
  if (record.outcome === "retimed") return withRetimedCopy(next);
  return next;
}

function stageDelay(file: ExternalFile, seconds: number, trackId: number | null): ExternalFile {
  if (trackId === null) return file.delayProvenance === "manual" ? file : { ...file, pendingDelay: seconds };
  const override = file.trackOverrides?.[trackId] ?? {};
  if (override.delayProvenance === "manual") return file;
  return { ...file, trackOverrides: { ...file.trackOverrides, [trackId]: { ...override, pendingDelay: seconds } } };
}

/** Mux the engine's re-timed copy instead of the file. */
function withRetimedCopy(file: ExternalFile): ExternalFile {
  const record = file.subsync;
  if (!record?.retimedPath || record.ratio === null) return file;
  return {
    ...file,
    retimed: { path: record.retimedPath, offsetS: record.offsetS ?? 0, ratio: record.ratio, splits: record.splits, score: record.score, videoPath: record.videoPath },
  };
}

/** Apply anyway: a held delay straight into the delay field, a held copy in use. */
export function applySyncAnyway(file: ExternalFile, trackId: number | null): ExternalFile {
  const record = file.subsync;
  if (!record) return file;
  const released: ExternalFile = { ...file, subsync: { ...record, held: false } };
  if (record.outcome === "retimed") return withRetimedCopy(released);
  if (record.outcome !== "delay" || record.offsetS === null) return file;
  if (trackId === null) return { ...released, delay: record.offsetS, delayProvenance: "measured", pendingDelay: undefined };
  const override = released.trackOverrides?.[trackId] ?? {};
  return { ...released, trackOverrides: { ...released.trackOverrides, [trackId]: { ...override, delay: record.offsetS, delayProvenance: "measured", pendingDelay: undefined } } };
}

/** Undo: back to the original file, without the re-timed copy or the delay
 *  the sync staged. A delay already applied stays: it is the file's delay now. */
export function undoSync(file: ExternalFile): ExternalFile {
  if (!file.retimed && !file.subsync) return file;
  return withoutSync(file, syncTarget(file));
}

/** Whether Undo has something to take back: a re-timed copy in use, or a
 *  result not filled in yet. */
export function canUndoSync(file: ExternalFile): boolean {
  return Boolean(file.retimed || (file.subsync && (file.subsync.held || pendingSyncDelay(file))));
}

/** The subtitle's sync was measured against another video than its own now. */
export function syncedAgainstAnother(file: ExternalFile, video: Pick<VideoFile, "path" | "name"> | undefined): boolean {
  return Boolean(file.subsync && video && measuredAgainstAnother({ videoPath: file.subsync.videoPath }, video));
}

/** The pending sync delay of a file, its own or its one track's. */
export function pendingSyncDelay(file: ExternalFile): { trackId: number | null; seconds: number } | null {
  if (file.pendingDelay !== undefined) return { trackId: null, seconds: file.pendingDelay };
  for (const [id, override] of Object.entries(file.trackOverrides ?? {})) {
    if (override.pendingDelay !== undefined) return { trackId: Number(id), seconds: override.pendingDelay };
  }
  return null;
}

/** The Status column of a subtitle row. */
export function syncStatus(file: ExternalFile, video: Pick<VideoFile, "path" | "name"> | undefined): { s: St; text: string } {
  const record = file.subsync;
  if (!record) return { s: "ready", text: "Ready" };
  if (syncedAgainstAnother(file, video)) return { s: "warn", text: "Measured against another video" };
  switch (record.outcome) {
    case "picture":
      return { s: "warn", text: "Can't be synced automatically" };
    case "error":
      return { s: "bad", text: "Failed" };
    case "noMatch":
      return { s: "warn", text: "No clear match" };
    case "retimed":
      return record.held ? { s: "warn", text: "Low confidence" } : file.retimed ? { s: "ok", text: "Re-timed copy" } : { s: "ready", text: "Ready" };
    case "delay":
      if (record.held) return { s: "warn", text: "Low confidence" };
      return pendingSyncDelay(file) ? { s: "ok", text: "Measured" } : { s: "ok", text: "Applied" };
  }
}

/** "−2.500 s" / "+1.200 s, 25 → 23.976 fps, 2 scene changes". */
export function describeSync(record: SubtitleSync): string {
  if (record.offsetS === null) return record.description ?? "Nothing measured.";
  const offset = `${record.offsetS > 0 ? "+" : record.offsetS < 0 ? "−" : ""}${Math.abs(record.offsetS).toFixed(3)} s`;
  const parts = [offset];
  if (record.framerate) parts.push(`${record.framerate} fps`);
  else if (record.ratio !== null && Math.abs(record.ratio - 1) > 1e-4) parts.push(`× ${record.ratio.toFixed(6)}`);
  if (record.splits > 0) parts.push(`${record.splits} scene change${record.splits === 1 ? "" : "s"}`);
  return parts.join(", ");
}
