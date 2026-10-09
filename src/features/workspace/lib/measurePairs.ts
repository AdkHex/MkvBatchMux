/** Deriving measurement pairs from the pairing the mux is about to perform.
 *  No movie/series mode: measuring anything other than the mux's resolved mapping risks measuring pair A while muxing pair B. */

import type { ExternalFile, VideoFile } from "@/shared/types";
import type { MeasurePair, SyncResult } from "@/shared/types/audiosync";
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
 *  Index is among the video's audio tracks, not all tracks — the engine counts audio streams from zero, same as AudioSyncMaster's default. */
export const DEFAULT_REFERENCE_TRACK = 0;

const slashes = (path: string) => path.replace(/\\/g, "/");
const baseName = (path: string) => slashes(path).replace(/^.*\//, "");

/** A pair whose dub is the video's own track: the same file, the same audio
 *  stream. Its delay is zero by definition, so it is not worth an engine run
 *  -- which on a 4K remux is minutes of decoding to confirm it. */
export function isSameTrack(pair: Pick<MeasurePair, "primaryPath" | "secondaryPath" | "primaryTrack" | "secondaryTrack">): boolean {
  return pair.primaryTrack === pair.secondaryTrack && slashes(pair.primaryPath) === slashes(pair.secondaryPath);
}

/** The result a same-track pair would measure, given without measuring. */
export function sameTrackResult(pair: MeasurePair, fps?: number | null): SyncResult {
  return {
    videoFile: baseName(pair.primaryPath),
    audioFile: baseName(pair.secondaryPath),
    primaryPath: pair.primaryPath,
    secondaryPath: pair.secondaryPath,
    delayMs: 0,
    delayAtStartMs: 0,
    confidence: 1,
    driftMsPerS: 0,
    totalDriftMs: 0,
    hasSignificantDrift: false,
    startDelayMs: 0,
    endDelayMs: 0,
    windowsUsed: null,
    windowsTotal: null,
    error: null,
    elapsedMs: 0,
    primaryTrack: pair.primaryTrack,
    secondaryTrack: pair.secondaryTrack,
    primaryFps: fps ?? null,
    secondaryFps: fps ?? null,
    method: "survey",
    warnings: ["The audio file is the video itself, the same track, so its delay is 0. Check the pairing."],
  };
}

/** The same reference track for every video: the one at `index` among its
 *  audio tracks, or its last one when it has fewer. Videos with no audio
 *  track are left out. */
export function referenceForEveryVideo(videos: VideoFile[], index: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const video of videos) {
    const count = (video.tracks ?? []).filter((track) => track.type === "audio").length;
    if (count > 0) out[video.id] = Math.max(0, Math.min(index, count - 1));
  }
  return out;
}

/** The position that, given to `referenceForEveryVideo`, yields the choices in
 *  force; null when videos were set apart one by one. */
export function sharedReferenceIndex(videos: VideoFile[], referenceTrackByVideoId: Record<string, number>): number | null {
  const counts = videos
    .map((video) => ({ id: video.id, count: (video.tracks ?? []).filter((track) => track.type === "audio").length }))
    .filter(({ count }) => count > 0);
  if (counts.length === 0) return DEFAULT_REFERENCE_TRACK;
  const chosen = counts.map(({ id, count }) => Math.min(referenceTrackByVideoId[id] ?? DEFAULT_REFERENCE_TRACK, count - 1));
  const index = Math.max(...chosen);
  // A video with fewer tracks takes its last, so "track 3 for all" still agrees.
  return counts.every(({ count }, i) => chosen[i] === Math.min(index, count - 1)) ? index : null;
}

/** The video audio track the next measurement of this file would use; matches what `buildMeasurementPlan` will reach. */
export function plannedReferenceTrack(
  video: VideoFile,
  referenceTrackByVideoId: Record<string, number> = {},
): number {
  return chooseMeasurementTracks(video, [], referenceTrackByVideoId).primaryTrack;
}

/** Whether a delay should be left alone by a bulk measurement pass: the
 *  file's own, or one track's. */
function shouldSkip(entry: Pick<ExternalFile, "delayProvenance" | "measuredDelay"> | undefined): boolean {
  if (!entry) return false;
  // A hand-typed delay always wins; measurement never overwrites one.
  if (entry.delayProvenance === "manual") return true;
  // Already measured: re-measuring is an explicit, separate action.
  if (entry.delayProvenance === "measured") return true;
  // Already attempted and withheld (failure, cut, or too-large result). A correlator with no true
  // peak returns a different arbitrary answer each retry, so leave it be; per-row re-measure still forces one.
  if (entry.measuredDelay) return true;
  return false;
}

/** A file with more than one audio track going into the mux is measured
 *  track by track: one container often carries dubs from different sources
 *  (Hindi, Tamil, Telugu), each with its own offset to the video. */
export function measuresEachTrack(file: ExternalFile): boolean {
  return includedAudioTrackIndices(file).length > 1;
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
    const chosen = chooseMeasurementTracks(video, includedTracks, referenceTrackByVideoId);
    const planned = (trackId: number | null, secondaryTrack: number): PlannedMeasurement => ({
      pair: {
        primaryPath: video.path,
        secondaryPath: file.path,
        key: measurementKey(file.id, trackId),
        method: "mkvbatchmux",
        score: 1,
        primaryTrack: chosen.primaryTrack,
        secondaryTrack,
      },
      audioFileId: file.id,
      trackId,
      videoId: video.id,
      videoName: video.name,
      audioName: file.name,
    });

    if (includedTracks.length <= 1) {
      measurements.push(planned(null, chosen.secondaryTrack));
      return;
    }

    // Each muxed track against the same reference, its result written to that
    // track's own override, which main.rs prefers to the file's delay.
    const tracks = includedTracks.filter((entry) => force || !shouldSkip(file.trackOverrides?.[entry.trackId]));
    if (tracks.length === 0) {
      skipped.push(file);
      return;
    }
    for (const entry of tracks) measurements.push(planned(entry.trackId, entry.streamIndex));
  });

  return { measurements, unmatched, skipped };
}

/** Pick the reference track, and the dub track a file-level measurement is taken from.
 *  Defaults to audio stream 0, matching AudioSyncMaster, since a smarter per-track default would silently diverge from it. */
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
export function includedAudioTrackIndices(
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
