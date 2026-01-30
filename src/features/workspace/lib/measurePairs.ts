/** Deriving measurement pairs from the pairing the mux is about to perform.
 *
 *  There is deliberately no movie/series mode here. The mux already resolves
 *  which external audio belongs to which video, and measuring anything other
 *  than that resolved mapping would let the app measure pair A while muxing
 *  pair B. The movie case falls out of this for free: one audio bulk-applied to
 *  many videos becomes one pair per video, each measured separately, which is
 *  correct because a dub's offset can differ per release.
 *
 *  See docs/AUDIOSYNC_INTEGRATION_PLAN.md §4.
 */

import type { ExternalFile, VideoFile } from "@/shared/types";
import type { MeasurePair } from "@/shared/types/audiosync";
import { buildStrictVideoMatcher } from "./muxJobBuilder";

/** A pair plus the identifiers needed to write the result back. */
export interface PlannedMeasurement {
  pair: MeasurePair;
  audioFileId: string;
  /** Set when this measures one track of a multi-track external file; the
   *  result is written to trackOverrides[trackId] rather than the file. */
  trackId: number | null;
  videoId: string;
  videoName: string;
  audioName: string;
}

export interface MeasurementPlan {
  measurements: PlannedMeasurement[];
  /** Audio files that resolve to no video. Not measurable, and surfaced rather
   *  than dropped -- silently skipping them looks identical to success. */
  unmatched: ExternalFile[];
  /** Files skipped because their delay was typed by hand or already measured. */
  skipped: ExternalFile[];
}

/** The key encodes what to write back to, so the result never has to be
 *  re-matched against the file list. */
export function measurementKey(audioFileId: string, trackId: number | null): string {
  return trackId === null ? audioFileId : `${audioFileId}::${trackId}`;
}

export function parseMeasurementKey(key: string): { audioFileId: string; trackId: number | null } {
  const separator = key.lastIndexOf("::");
  if (separator === -1) return { audioFileId: key, trackId: null };
  const trackId = Number(key.slice(separator + 2));
  return {
    audioFileId: key.slice(0, separator),
    trackId: Number.isFinite(trackId) ? trackId : null,
  };
}

export interface BuildMeasurementPlanInput {
  videoFiles: VideoFile[];
  audioFiles: ExternalFile[];
  /** Which audio track of each video to measure against, by video id.
   *  Defaults to the first audio track, as AudioSyncMaster does. */
  referenceTrackByVideoId?: Record<string, number>;
  /** Ignore the skip rules -- used by the per-row "re-measure" action, which is
   *  an explicit request for these specific files. */
  force?: boolean;
  /** Restrict the plan to these audio file ids. */
  onlyAudioFileIds?: string[];
}


/** The video audio stream measured against when the user has not chosen one.
 *
 *  Index is *among the video's audio tracks*, not among all its tracks: the
 *  engine counts audio streams. Stream 0 regardless of default flags, because
 *  that is AudioSyncMaster's default and the two apps must agree.
 */
export const DEFAULT_REFERENCE_TRACK = 0;

/** The video audio track the next measurement of this file would use.
 *
 *  The same answer `buildMeasurementPlan` will reach, exported so a row can say
 *  whether a stored measurement is still answering the current question.
 */
export function plannedReferenceTrack(
  video: VideoFile,
  referenceTrackByVideoId: Record<string, number> = {},
): number {
  return chooseMeasurementTracks(video, [], referenceTrackByVideoId).primaryTrack;
}

/** Whether a file's delay should be left alone by a bulk measurement pass. */
function shouldSkip(file: ExternalFile): boolean {
  // A hand-typed delay always wins; measurement never overwrites one.
  if (file.delayProvenance === "manual") return true;
  // Already measured: re-measuring is an explicit, separate action.
  if (file.delayProvenance === "measured") return true;
  // Already attempted and withheld -- a failure, a cut, or a result too large
  // to be a delay. Retrying changes nothing about the files, but a correlator
  // with no true peak to find returns a different arbitrary answer each time,
  // so pressing the button again looked like the engine was unstable. The
  // per-row re-measure still forces a retry.
  if (file.measuredDelay) return true;
  return false;
}

export function buildMeasurementPlan({
  videoFiles,
  audioFiles,
  referenceTrackByVideoId = {},
  force = false,
  onlyAudioFileIds,
}: BuildMeasurementPlanInput): MeasurementPlan {
  const { byId, resolve } = buildStrictVideoMatcher(videoFiles);

  const measurements: PlannedMeasurement[] = [];
  const unmatched: ExternalFile[] = [];
  const skipped: ExternalFile[] = [];

  const candidates = onlyAudioFileIds
    ? audioFiles.filter((file) => onlyAudioFileIds.includes(file.id))
    : audioFiles;

  candidates.forEach((file) => {
    if (!force && shouldSkip(file)) {
      skipped.push(file);
      return;
    }

    const videoId = resolve(file);
    const video = videoId ? byId.get(videoId) : undefined;
    if (!video) {
      unmatched.push(file);
      return;
    }

    const includedTracks = includedAudioTrackIndices(file);

    // One measurement per file, not per track.
    //
    // Every audio track inside an external file was muxed into that container
    // on one timeline, so they all sit at the same offset from the video --
    // and main.rs falls back to the file-level delay for any track without its
    // own, so a single answer already covers them all.
    //
    // Measuring each track separately asked a much harder question than
    // necessary: a Korean dub against a *different encode* of the same Korean
    // audio shares no waveform detail, and produced "no distinct correlation
    // peak" or a confident wrong answer, while the easy Hindi-against-Hindi
    // comparison that answers the question was never surfaced.
    const chosen = chooseMeasurementTracks(video, includedTracks, referenceTrackByVideoId);

    measurements.push({
      pair: {
        primaryPath: video.path,
        secondaryPath: file.path,
        key: measurementKey(file.id, null),
        method: "mkvbatchmux",
        score: 1,
        primaryTrack: chosen.primaryTrack,
        secondaryTrack: chosen.secondaryTrack,
      },
      audioFileId: file.id,
      trackId: null,
      videoId: video.id,
      videoName: video.name,
      audioName: file.name,
    });
  });

  return { measurements, unmatched, skipped };
}

/** Pick the one track pair a file's measurement should be taken from.
 *
 *  Identical to AudioSyncMaster's choice, on purpose: it measures audio stream
 *  0 of the video unless the user picks otherwise (`Index.tsx`:
 *  `trackChoicesRef.current[path] ?? 0`). Two tracks in one container do not
 *  necessarily sit at the same offset, so any smarter default here -- the
 *  default-flagged track, or one sharing the dub's language -- produced a
 *  different delay from AudioSyncMaster on the same files, by tens of
 *  milliseconds, on every multi-track release. A track that correlates more
 *  sharply is still the user's to choose, in both apps, through the reference
 *  picker.
 *
 *  The external side is not a choice at all: the delay is applied to the track
 *  being muxed, so that is the track to measure.
 */
function chooseMeasurementTracks(
  video: VideoFile,
  includedTracks: Array<{ trackId: number; streamIndex: number }>,
  referenceTrackByVideoId: Record<string, number>,
): { primaryTrack: number; secondaryTrack: number } {
  const videoAudioCount = (video.tracks ?? []).filter((track) => track.type === "audio").length;
  const secondaryTrack = includedTracks[0]?.streamIndex ?? 0;

  const explicitReference = referenceTrackByVideoId[video.id];
  const primaryTrack =
    explicitReference !== undefined &&
    explicitReference >= 0 &&
    explicitReference < Math.max(videoAudioCount, 1)
      ? explicitReference
      : DEFAULT_REFERENCE_TRACK;

  return { primaryTrack, secondaryTrack };
}

/** The audio tracks of an external file that will actually be muxed.
 *
 *  `trackId` is this app's own identifier, used for trackOverrides; the engine
 *  instead counts audio streams from zero, so both are carried.
 */
function includedAudioTrackIndices(
  file: ExternalFile,
): Array<{ trackId: number; streamIndex: number }> {
  const audioTracks = (file.tracks ?? []).filter((track) => track.type === "audio");
  if (audioTracks.length === 0) return [];

  return audioTracks
    .map((track, streamIndex) => ({ trackId: Number(track.id), streamIndex }))
    .filter((entry) => Number.isFinite(entry.trackId))
    .filter(
      (entry) =>
        // An explicit inclusion list means the others are not being muxed, so
        // measuring them would be wasted work on a long batch.
        !file.includedTrackIds || file.includedTrackIds.includes(entry.trackId),
    );
}
