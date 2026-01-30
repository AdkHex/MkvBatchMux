import type { Track, VideoFile } from "@/shared/types";

export interface TrackRowDraft {
  id: string;
  trackIndex: number;
  sourceTrackPosition: number;
  copyTrack: boolean;
  setDefault: boolean;
  setForced: boolean;
  trackName: string;
  language: string;
}

export function moveTrackRow<T>(rows: T[], fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return rows;
  if (fromIndex >= rows.length || toIndex >= rows.length) return rows;
  const next = [...rows];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function applyTrackRowsToVideo(
  file: VideoFile,
  rows: TrackRowDraft[],
  type: Track["type"],
) {
  const tracks = file.tracks || [];
  const typeTracks = tracks.filter((track) => track.type === type);

  // Which source tracks survived as rows. A row removed in the dialog simply
  // stops appearing here, so anything missing from this set was deleted by the
  // user and has to be marked "remove" rather than quietly falling through as
  // "keep" (mkvmerge drops a track only when it is present with that action).
  const keptPositions = new Set<number>();
  rows.forEach((row) => {
    if (typeTracks[row.sourceTrackPosition]) keptPositions.add(row.sourceTrackPosition);
  });

  const reorderedTypeTracks = rows
    .map((row) => {
      const track = typeTracks[row.sourceTrackPosition];
      if (!track) return null;

      const originalDefault =
        track.originalDefault !== undefined ? track.originalDefault : track.isDefault;
      const originalForced =
        track.originalForced !== undefined ? track.originalForced : track.isForced;
      const existingOriginalName = track.originalName ?? track.name ?? track.codec ?? "";
      const existingOriginalLanguage = track.originalLanguage ?? track.language ?? "";

      let newDefault: boolean | undefined;
      if (originalDefault === undefined && row.setDefault === false) {
        newDefault = undefined;
      } else if (originalDefault !== row.setDefault) {
        newDefault = row.setDefault;
      } else {
        newDefault = originalDefault;
      }

      let newForced: boolean | undefined;
      if (originalForced === undefined && row.setForced === false) {
        newForced = undefined;
      } else if (originalForced !== row.setForced) {
        newForced = row.setForced;
      } else {
        newForced = originalForced;
      }

      const nextName = row.trackName === "Multiple" ? track.name : row.trackName;
      const nextLanguage = row.language;
      const nextAction = row.copyTrack ? "keep" : "remove";
      const hasChanged =
        nextAction !== "remove" &&
        ((nextName || "") !== (track.name || "") ||
          (nextLanguage || "") !== (track.language || "") ||
          newDefault !== track.isDefault ||
          newForced !== track.isForced);

      return {
        ...track,
        name: nextName,
        language: nextLanguage,
        isDefault: newDefault,
        isForced: newForced,
        action: nextAction === "remove" ? "remove" : hasChanged ? "modify" : "keep",
        originalName: existingOriginalName,
        originalLanguage: existingOriginalLanguage,
        originalDefault,
        originalForced,
      };
    })
    .filter(Boolean) as Track[];

  // Tracks the user deleted, kept in the list so the backend can exclude them.
  const removedTypeTracks = typeTracks
    .filter((_, position) => !keptPositions.has(position))
    .map((track) => ({
      ...track,
      action: "remove" as const,
      originalName: track.originalName ?? track.name ?? track.codec ?? "",
      originalLanguage: track.originalLanguage ?? track.language ?? "",
      originalDefault: track.originalDefault !== undefined ? track.originalDefault : track.isDefault,
      originalForced: track.originalForced !== undefined ? track.originalForced : track.isForced,
    }));

  // Kept tracks in their new order, then the deleted ones. This is exactly as
  // long as typeTracks, so the slots below line up one-for-one and an edit can
  // never land on a neighbouring track.
  const finalTypeTracks = [...reorderedTypeTracks, ...removedTypeTracks];

  let typeIndex = 0;
  const merged = tracks.map((track) =>
    track.type === type ? finalTypeTracks[typeIndex++] || track : track,
  );

  return { ...file, tracks: merged };
}
