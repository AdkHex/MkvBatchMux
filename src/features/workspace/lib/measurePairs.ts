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
   *  Defaults to the video's default audio track, else its first. */
  referenceTrackByVideoId?: Record<string, number>;
  /** Ignore the skip rules -- used by the per-row "re-measure" action, which is
   *  an explicit request for these specific files. */
  force?: boolean;
  /** Restrict the plan to these audio file ids. */
  onlyAudioFileIds?: string[];
}

/** The audio stream index to measure the video against.
 *
 *  Index is *among the video's audio tracks*, not among all its tracks: the
 *  engine counts audio streams, so passing a global track index would compare
 *  against the wrong stream on any file with subtitles ordered before audio.
 */
export function defaultReferenceTrack(video: VideoFile): number {
  const audioTracks = (video.tracks ?? []).filter((track) => track.type === "audio");
  const defaultIndex = audioTracks.findIndex((track) => track.isDefault);
  return defaultIndex >= 0 ? defaultIndex : 0;
}

/** Whether a file's delay should be left alone by a bulk measurement pass. */
function shouldSkip(file: ExternalFile): boolean {
  // A hand-typed delay always wins; measurement never overwrites one.
  if (file.delayProvenance === "manual") return true;
  // Already measured: re-measuring is an explicit, separate action.
  if (file.delayProvenance === "measured") return true;
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

    const primaryTrack = referenceTrackByVideoId[video.id] ?? defaultReferenceTrack(video);

    // A multi-track external file needs one measurement per included track:
    // each track can carry its own offset, and main.rs already prefers a
    // per-track delay over the file-level one.
    const includedTracks = includedAudioTrackIndices(file);

    if (includedTracks.length <= 1) {
      measurements.push({
        pair: {
          primaryPath: video.path,
          secondaryPath: file.path,
          key: measurementKey(file.id, null),
          method: "mkvbatchmux",
          score: 1,
          // An explicit reference choice wins here: with a single track the
          // user's selection is unambiguous, and language matching is only a
          // fallback for when they have not chosen one.
          primaryTrack:
            referenceTrackByVideoId[video.id] ??
            (includedTracks[0]
              ? matchingReferenceTrack(video, file, includedTracks[0].trackId)
              : null) ??
            primaryTrack,
          secondaryTrack: includedTracks[0]?.streamIndex ?? 0,
        },
        audioFileId: file.id,
        trackId: null,
        videoId: video.id,
        videoName: video.name,
        audioName: file.name,
      });
      return;
    }

    includedTracks.forEach((track) => {
      measurements.push({
        pair: {
          primaryPath: video.path,
          secondaryPath: file.path,
          key: measurementKey(file.id, track.trackId),
          method: "mkvbatchmux",
          score: 1,
          // Each track is compared against the video track that carries the
          // same language where one exists, rather than all of them against
          // one reference. Correlation works by matching waveforms, so a
          // Korean track measured against the video's Hindi has no true peak
          // to find -- and the correlator returns whatever fit best, with the
          // windows agreeing on it and reporting high confidence.
          primaryTrack: matchingReferenceTrack(video, file, track.trackId) ?? primaryTrack,
          secondaryTrack: track.streamIndex,
        },
        audioFileId: file.id,
        trackId: track.trackId,
        videoId: video.id,
        videoName: video.name,
        audioName: file.name,
      });
    });
  });

  return { measurements, unmatched, skipped };
}

/** The video audio stream that speaks the same language as an external track.
 *
 *  Returns an audio-relative index for the engine, or null when the video has
 *  no track in that language -- in which case the caller falls back to the
 *  chosen reference, since measuring against something is better than not
 *  measuring at all, and the magnitude guard catches a nonsense result.
 *
 *  Only used when the external file has several tracks. With one track the
 *  user's reference choice is unambiguous and is respected as-is.
 */
export function matchingReferenceTrack(
  video: VideoFile,
  file: ExternalFile,
  trackId: number,
): number | null {
  const externalTrack = (file.tracks ?? []).find(
    (track) => track.type === "audio" && Number(track.id) === trackId,
  );
  const language = normalizeLanguage(
    // A per-track override wins: it is what the user says this track is.
    file.trackOverrides?.[trackId]?.language ?? externalTrack?.language,
  );
  if (!language) return null;

  const videoAudio = (video.tracks ?? []).filter((track) => track.type === "audio");
  const index = videoAudio.findIndex(
    (track) => normalizeLanguage(track.language) === language,
  );
  return index >= 0 ? index : null;
}

/** Language codes vary in case and in the 2- vs 3-letter form between tools. */
function normalizeLanguage(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "und" || trimmed === "mul") return null;
  return trimmed;
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
