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
  /** Files whose language exists in neither of the video's audio tracks.
   *  Measuring these compares two different languages, which shares no
   *  waveform and produces a confident wrong number rather than a failure. */
  languageMismatch: ExternalFile[];
}

/** The key encodes what to write back to, so the result never has to be
 *  re-matched against the file list. */
export function measurementKey(audioFileId: string, trackId: number | null): string {
  return trackId === null ? audioFileId : `${audioFileId}::${trackId}`;
}

export function parseMeasurementKey(key: string): { audioFileId: string; trackId: number | null } {
  // Strip the candidate suffix: which of several tried tracks a result came
  // from does not change where it is written back to.
  const candidate = key.lastIndexOf("##");
  if (candidate !== -1) key = key.slice(0, candidate);
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
  const languageMismatch: ExternalFile[] = [];

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
    const chosen = chooseMeasurementTracks(video, file, includedTracks, referenceTrackByVideoId);
    if (!chosen) {
      languageMismatch.push(file);
      return;
    }

    // More than one candidate means nothing identified the right video track,
    // so each is measured and the best-correlating result wins. The key
    // carries the candidate index so results can be told apart.
    chosen.forEach((candidate, index) => {
      measurements.push({
        pair: {
          primaryPath: video.path,
          secondaryPath: file.path,
          key:
            chosen.length === 1
              ? measurementKey(file.id, null)
              : `${measurementKey(file.id, null)}##${index}`,
          method: "mkvbatchmux",
          score: 1,
          primaryTrack: candidate.primaryTrack,
          secondaryTrack: candidate.secondaryTrack,
        },
        audioFileId: file.id,
        trackId: null,
        videoId: video.id,
        videoName: video.name,
        audioName: file.name,
      });
    });
  });

  return { measurements, unmatched, skipped, languageMismatch };
}

/** Pick the one track pair a file's measurement should be taken from.
 *
 *  Correlation compares waveforms, so the pair most likely to succeed is the
 *  one carrying the same language -- ideally the same recording. Preference
 *  order, best first:
 *
 *  1. An explicit reference choice, paired with the external track in that
 *     same language. The user's choice is a statement about the video; the
 *     language link picks the external side that can actually match it.
 *  2. Any language shared by both files, first match wins.
 *  3. First audio of each, which is what AudioSyncMaster itself uses and what
 *     works for the common single-dub case.
 */
function chooseMeasurementTracks(
  video: VideoFile,
  file: ExternalFile,
  includedTracks: Array<{ trackId: number; streamIndex: number }>,
  referenceTrackByVideoId: Record<string, number>,
): Array<{ primaryTrack: number; secondaryTrack: number }> | null {
  const secondary = includedTracks[0]?.streamIndex ?? 0;
  const explicitReference = referenceTrackByVideoId[video.id];

  // When nothing identifies the right video track, every audio track is a
  // candidate and the engine's confidence decides. Guessing one produced a
  // confident answer from the wrong pair, which is indistinguishable from a
  // right one until you compare against another tool.
  const ambiguousCandidates = (): Array<{ primaryTrack: number; secondaryTrack: number }> => {
    const audioCount = (video.tracks ?? []).filter((t) => t.type === "audio").length;
    const preferred = explicitReference ?? defaultReferenceTrack(video);
    const order = [preferred, ...Array.from({ length: audioCount }, (_, i) => i)];
    const seen = new Set<number>();
    return order
      .filter((index) => index < Math.max(audioCount, 1) && !seen.has(index) && seen.add(index))
      .map((primaryTrack) => ({ primaryTrack, secondaryTrack: secondary }));
  };

  const videoAudio = (video.tracks ?? []).filter((track) => track.type === "audio");
  const externalLanguage = (trackId: number) =>
    normalizeLanguage(
      // A per-track override wins: it is what the user says this track is.
      file.trackOverrides?.[trackId]?.language ??
        (file.tracks ?? []).find(
          (track) => track.type === "audio" && Number(track.id) === trackId,
        )?.language ??
        // A single-track file often carries the language on the file itself.
        (includedTracks.length === 1 ? file.language : undefined),
    );

  if (explicitReference !== undefined) {
    const wanted = normalizeLanguage(videoAudio[explicitReference]?.language);
    if (wanted) {
      const match = includedTracks.find((track) => externalLanguage(track.trackId) === wanted);
      if (match) {
        // An explicit choice plus a language that confirms it: no ambiguity.
        return [{ primaryTrack: explicitReference, secondaryTrack: match.streamIndex }];
      }
    }
    return ambiguousCandidates();
  }

  const externalLanguages = includedTracks
    .map((track) => externalLanguage(track.trackId))
    .filter((language): language is string => Boolean(language));

  for (const track of includedTracks) {
    const language = externalLanguage(track.trackId);
    if (!language) continue;
    const index = videoAudio.findIndex(
      (candidate) => normalizeLanguage(candidate.language) === language,
    );
    if (index >= 0) {
      return [{ primaryTrack: index, secondaryTrack: track.streamIndex }];
    }
  }

  // Both sides declare a language and they have none in common. Falling back
  // here would compare, say, a Hindi dub against the video's Korean -- two
  // recordings that share no waveform, so the correlator finds no true peak
  // and returns whatever fit best. That reads as a confident delay rather
  // than as the failure it is, so refuse instead and say why.
  const videoLanguages = videoAudio
    .map((track) => normalizeLanguage(track.language))
    .filter((language): language is string => Boolean(language));
  if (
    externalLanguages.length > 0 &&
    videoLanguages.length > 0 &&
    !externalLanguages.some((language) => videoLanguages.includes(language))
  ) {
    return null;
  }

  return ambiguousCandidates();
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
