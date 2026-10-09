/** Which rows a Save in an audio file's popup reaches. One file can be paired
 *  with several videos, a row each, and every row keeps its own delays: each
 *  is measured against its own video (+3.998 on one, -4.997 on another). */

import type { ExternalFile } from "@/shared/types";

/** "row": this row only. "file": every row holding the same file, delays
 *  apart. "all": every row, every setting, delay too. */
export type EditScope = "row" | "file" | "all";

/** The rows holding the same file as this one, this one included, in list order. */
export function rowsWithFile(files: ExternalFile[], fileId: string): number[] {
  const path = files.find((file) => file.id === fileId)?.path;
  if (path === undefined) return [];
  return files.flatMap((file, index) => (file.path === path ? [index] : []));
}

/** Another row of the same file takes this row's settings: track and subtitle
 *  choices, language, name, flags, and each track's language and name. Never
 *  a delay, a measurement or a stretch: those belong to the row's video. */
export function shareSettings(from: ExternalFile, to: ExternalFile): ExternalFile {
  const trackOverrides = { ...(to.trackOverrides ?? {}) };
  const ids = new Set([...Object.keys(from.trackOverrides ?? {}), ...Object.keys(to.trackOverrides ?? {})].map(Number));
  for (const id of ids) {
    const source = from.trackOverrides?.[id];
    trackOverrides[id] = { ...trackOverrides[id], language: source?.language, trackName: source?.trackName };
  }
  return {
    ...to,
    language: from.language,
    trackName: from.trackName,
    isDefault: from.isDefault,
    isForced: from.isForced,
    muxAfter: from.muxAfter,
    includedTrackIds: from.includedTrackIds && [...from.includedTrackIds],
    includeSubtitles: from.includeSubtitles,
    includedSubtitleTrackIds: from.includedSubtitleTrackIds && [...from.includedSubtitleTrackIds],
    includedSubtitlesDefault: from.includedSubtitlesDefault,
    includedSubtitlesForced: from.includedSubtitlesForced,
    includedSubtitlesFirst: from.includedSubtitlesFirst,
    trackOverrides,
    isManuallyEdited: true,
  };
}
