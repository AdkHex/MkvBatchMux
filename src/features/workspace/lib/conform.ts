/** Conforming a dub made for another cut of the video (Audio page): which
 *  rows can be conformed, the engine pairs for a run, and what a result does
 *  to the file. The engine side is src-tauri/src/conform.rs.
 *
 *  A conformed file keeps its original path, tracks and measurement; the new
 *  track rides along in `conformed` and the mux takes it instead
 *  (muxJobBuilder). Undo drops `conformed`, and the file is as it was. */

import type { ExternalFile, VideoFile } from "@/shared/types";
import type { MeasurePair } from "@/shared/types/audiosync";
import type { ConformResultEvent } from "@/shared/types/engineFeatures";
import { toConformedTrack } from "@/shared/lib/engineFeatures";
import { isPlaceholder } from "@/shared/lib/matchUtils";
import type { St } from "@/ui/kit";

import { isBlockingCut } from "./delayConversion";
import { includedAudioTrackIndices, measurementKey, plannedReferenceTrack } from "./measurePairs";
import { buildStrictVideoMatcher } from "./muxJobBuilder";
import { isMeasuredAgainstAnother, measuredAgainstAnother, measurementsOf } from "./measureVerdict";

/** The one audio track a conform works on: the file's only muxed audio track.
 *  A bare audio file read without its tracks is its stream 0. */
export function conformTrack(file: ExternalFile): { trackId: number; streamIndex: number } | null {
  const audio = (file.tracks ?? []).filter((track) => track.type === "audio");
  if (audio.length === 0) return (file.tracks ?? []).length === 0 ? { trackId: 0, streamIndex: 0 } : null;
  const included = includedAudioTrackIndices(file);
  return included.length === 1 ? included[0] : null;
}

/** How many subtitle tracks the mux copies out of this file, as the mux
 *  reads it: only with `includeSubtitles` on, then the listed ids, or every
 *  subtitle track it has when none are listed. */
export function muxedSubtitleCount(file: ExternalFile): number {
  if (file.includeSubtitles !== true) return 0;
  if (file.includedSubtitleTrackIds !== undefined) return file.includedSubtitleTrackIds.length;
  return (file.tracks ?? []).filter((track) => track.type === "subtitle").length;
}

/** Why this file cannot be conformed whatever its video, in a sentence; null
 *  when it can. The watch pipeline's recipe policy asks this too. */
export function fileConformBlocker(file: ExternalFile | undefined): string | null {
  if (!file || file.placeholder) return "There is no file in this row.";
  const audio = (file.tracks ?? []).filter((track) => track.type === "audio");
  if ((file.tracks ?? []).length > 0 && audio.length === 0) return "This file has no audio track.";
  const included = includedAudioTrackIndices(file).length;
  if (audio.length > 0 && included === 0) return "None of this file's audio tracks is muxed.";
  if (included > 1) return `Conforming works on one audio track, and ${included} of this file's are muxed. Keep only the dub to conform in its track list.`;
  // The conformed file is that one audio track and nothing else: muxed in
  // the original's place, it would quietly leave these subtitles out.
  const subtitles = muxedSubtitleCount(file);
  if (subtitles > 0) {
    return `This file also brings ${subtitles === 1 ? "a subtitle track" : `${subtitles} subtitle tracks`} into the mux, and a conformed dub carries only its audio, so ${subtitles === 1 ? "it" : "they"} would be left out. Turn off "Copy its subtitles" in its track list to conform it.`;
  }
  return null;
}

/** Why this row cannot be conformed, in a sentence; null when it can. */
export function conformBlocker(file: ExternalFile | undefined, video: VideoFile | undefined): string | null {
  if (!file || file.placeholder) return "There is no file in this row.";
  if (!video) return "This file has no video to be laid onto.";
  if (!(video.tracks ?? []).some((track) => track.type === "audio") && (video.tracks ?? []).length > 0) return "The video has no audio track to lay the dub against.";
  return fileConformBlocker(file);
}

/** The measurement says the dub does not follow the video in one piece: the
 *  quick measurement found a cut (not a minor slip), or the timeline scan
 *  found edits. That is what Conform fixes. */
export function measuredAsDifferentCut(file: ExternalFile): boolean {
  return measurementsOf(file).some((m) => {
    if (m.error) return false;
    const scan = m.timeline && !m.timeline.error ? m.timeline : null;
    if (scan) return scan.cuts.length > 0 || (scan.edits?.length ?? 0) > 0;
    return isBlockingCut(m);
  });
}

/** Whether the conformed copy is the one in use with `video`. A copy made
 *  for another video is not: the mux takes the original instead. */
export function conformedFor(file: ExternalFile, video: Pick<VideoFile, "path" | "name"> | undefined): boolean {
  if (!file.conformed) return false;
  if (!video || !file.conformed.videoPath) return true;
  return !measuredAgainstAnother({ videoPath: file.conformed.videoPath }, video);
}

/** Offered Conform in the row and in the bulk "Conform N dubs": measured as
 *  a different cut against the video it is paired with now, conformable,
 *  and not conformed yet. */
export function offersConform(file: ExternalFile | undefined, video: VideoFile | undefined): boolean {
  if (!file || file.placeholder || !video) return false;
  if (file.conformed && conformedFor(file, video)) return false;
  if (isMeasuredAgainstAnother(file, video)) return false;
  return measuredAsDifferentCut(file) && conformBlocker(file, video) === null;
}

/** Any measured row can be conformed from its popup, as long as it is one
 *  audio track and the measurement is this video's. */
export function canConform(file: ExternalFile | undefined, video: VideoFile | undefined): boolean {
  if (!file || file.placeholder || !video || conformBlocker(file, video) !== null) return false;
  return measurementsOf(file).some((m) => !m.error) && !isMeasuredAgainstAnother(file, video);
}

/** Why a measured row that Conform would otherwise be offered for can't be
 *  conformed, for the row, the bulk button and the popup to say; null when
 *  it can, or when Conform isn't on the table for it at all (not measured,
 *  measured against another video, already conformed for this one). */
export function conformRefusal(file: ExternalFile | undefined, video: VideoFile | undefined): string | null {
  if (!file || file.placeholder || !video) return null;
  if (file.conformed && conformedFor(file, video)) return null;
  if (!measurementsOf(file).some((m) => !m.error) || isMeasuredAgainstAnother(file, video)) return null;
  return conformBlocker(file, video);
}

export interface PlannedConform {
  pair: MeasurePair;
  fileId: string;
  /** The audio-stream index the track is made from. */
  sourceTrack: number;
  videoPath: string;
  videoName: string;
  fileName: string;
}

/** The engine pairs for conforming these files, each against the video in its
 *  row, through the same reference track its measurement used. Files that
 *  cannot be conformed come back with the reason. */
export function buildConformPlan({
  videoFiles,
  files,
  fileIds,
  referenceTrackByVideoId = {},
}: {
  videoFiles: VideoFile[];
  /** The page's list: row n is video n. */
  files: ExternalFile[];
  fileIds: string[];
  referenceTrackByVideoId?: Record<string, number>;
}): { planned: PlannedConform[]; skipped: Array<{ file: ExternalFile; reason: string }> } {
  const planned: PlannedConform[] = [];
  const skipped: Array<{ file: ExternalFile; reason: string }> = [];
  // The mux's own matcher: conforming against any other video than the one
  // the file will be muxed with would lay it onto the wrong cut.
  const { byId, resolve } = buildStrictVideoMatcher(videoFiles);
  files.forEach((file) => {
    if (!fileIds.includes(file.id) || file.placeholder) return;
    const videoId = resolve(file);
    const video = videoId ? byId.get(videoId) : undefined;
    const blocker = conformBlocker(file, video);
    const track = conformTrack(file);
    if (blocker || !track || !video) {
      skipped.push({ file, reason: blocker ?? "This file cannot be conformed." });
      return;
    }
    // The plan the measurement showed is the one to lay the dub by.
    const measured = measurementsOf(file).find((m) => !m.error);
    planned.push({
      pair: {
        primaryPath: video.path,
        secondaryPath: file.path,
        key: measurementKey(file.id, null),
        method: "mkvbatchmux",
        score: 1,
        primaryTrack: measured?.referenceTrack ?? plannedReferenceTrack(video, referenceTrackByVideoId),
        secondaryTrack: track.streamIndex,
      },
      fileId: file.id,
      sourceTrack: track.streamIndex,
      videoPath: video.path,
      videoName: video.name,
      fileName: file.name,
    });
  });
  return { planned, skipped };
}

/** A conform result on its file: the new track in `conformed`, or the file
 *  unchanged when nothing was written (the caller reports the error). */
export function applyConformResult(file: ExternalFile, result: ConformResultEvent, planned: Pick<PlannedConform, "sourceTrack" | "videoPath">, createdAt?: string): ExternalFile {
  const track = toConformedTrack(result, planned.sourceTrack, createdAt);
  if (!track) return file;
  return { ...file, conformed: { ...track, videoPath: planned.videoPath, fallbackReason: result.fallbackReason ?? null } };
}

/** Back to the original file. */
export function undoConform(file: ExternalFile): ExternalFile {
  if (!file.conformed) return file;
  const { conformed: _dropped, ...rest } = file;
  return rest;
}

const formatResidual = (ms: number) => `${ms > 0 ? "+" : ""}${ms.toFixed(1)} ms`;

/** The check's first line, as a sentence: the engine follows it with one
 *  line per spot it measured, which the popup shows on request. */
export function checkSummary(text: string | null): string {
  const first = (text ?? "").split("\n")[0].trim();
  if (!first) return "Not checked.";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** The Status column for a conformed file, and the sentence behind it. */
export function conformedStatus(file: ExternalFile, video: Pick<VideoFile, "path" | "name"> | undefined): { s: St; text: string; detail: string } | null {
  const conformed = file.conformed;
  if (!conformed) return null;
  if (!conformedFor(file, video)) {
    return {
      s: "warn",
      text: "Conformed for another video",
      detail: "This dub was conformed to another video's cut, so the original file is muxed. Undo, then measure and conform it again for this video.",
    };
  }
  // Subtitles turned on after conforming: the mux takes the conformed track
  // alone (muxJobBuilder.fileForMux), so say they stay out.
  const subtitles = muxedSubtitleCount(file);
  if (subtitles > 0) {
    return {
      s: "warn",
      text: "Conformed, subtitles left out",
      detail: `The conformed track is muxed on its own, so this file's ${subtitles === 1 ? "subtitle track is" : `${subtitles} subtitle tracks are`} not. Turn off "Copy its subtitles", or Undo to mux the original with them.`,
    };
  }
  const residual = conformed.residualMs !== null ? ` Largest offset left: ${formatResidual(conformed.residualMs)}.` : "";
  const detail = `${checkSummary(conformed.verificationText)}${residual}`;
  if (conformed.verified === true) return { s: "ok", text: "Conformed", detail };
  if (conformed.verified === false) return { s: "warn", text: "Conformed, check it", detail };
  return { s: "warn", text: "Conformed, unchecked", detail };
}

/** "Lossless, E-AC-3" / "Re-encoded, FLAC". */
export function conformedHow(conformed: NonNullable<ExternalFile["conformed"]>): string {
  const codec = conformed.codec ? conformed.codec.toUpperCase().replace(/^EAC3$/, "E-AC-3").replace(/^AC3$/, "AC-3") : null;
  return [conformed.mode === "lossless" ? "Cut on its own frames, not re-encoded" : "Re-encoded to the sample", codec].filter(Boolean).join(" · ");
}

/** Mux-stopping messages for conformed dubs whose own subtitles are turned on:
 *  the conformed track is muxed alone (muxJobBuilder), so those subtitles
 *  would silently go missing from the new file. Named by slot and row. */
export function conformedSubtitleIssues(filesBySlot: Record<string, ExternalFile[]>, videoFiles: VideoFile[]): string[] {
  return Object.entries(filesBySlot).flatMap(([slot, files]) =>
    files.flatMap((file, index) => {
      if (isPlaceholder(file) || !file.conformed || muxedSubtitleCount(file) === 0) return [];
      if (!conformedFor(file, videoFiles.find((video) => video.id === file.matchedVideoId))) return [];
      return [`Audio ${slot}, row ${index + 1}: ${file.name} is conformed, so its subtitles would be left out. Turn off "Copy its subtitles", or undo the conform.`];
    }),
  );
}
