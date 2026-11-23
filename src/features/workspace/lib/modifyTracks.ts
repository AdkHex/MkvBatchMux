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
  /** The row as the dialog first showed it. A field still equal to it was not
   *  touched, so every video keeps its own value there: a position whose
   *  videos disagree (jpn here, und there) shows one value, and writing that
   *  value back would overwrite the others. Absent: every field applies. */
  initial?: Pick<TrackRowDraft, TrackRowField>;
  /** Fields whose value differs between the videos at this position. */
  mixed?: Partial<Record<TrackRowField, boolean>>;
}

/** The fields a track row edits. */
export type TrackRowField = "copyTrack" | "setDefault" | "setForced" | "trackName" | "language";

type RowFields = Pick<TrackRowDraft, TrackRowField | "initial" | "mixed">;

/** Whether the user changed this field of the row. */
export const rowFieldTouched = (row: RowFields, field: TrackRowField) => !row.initial || row[field] !== row.initial[field];

/** Whether the row shows this field as "differs between the videos": only
 *  until the user sets it, which then applies to every video. */
export const rowFieldMixed = (row: RowFields, field: TrackRowField) => Boolean(row.mixed?.[field]) && !rowFieldTouched(row, field);

export interface AggregatedTrackRow extends TrackRowDraft {
  originalTrack: Track;
  bitrate?: number;
  /** Shown dim where the row has no name: the codec, or "Multiple". */
  namePlaceholder?: string;
}

/** Modify tracks' rows: one per track position across these videos. A value
 *  every video shares is shown as is; one they disagree on is marked mixed,
 *  and an unnamed track's name stays empty (its codec is only a placeholder),
 *  so applying the rows untouched changes nothing. */
export function aggregateTrackRows(files: VideoFile[], type: Track["type"]): AggregatedTrackRow[] {
  const trackLists = files.map((file) => (file.tracks || []).filter((track) => track.type === type));
  const maxCount = Math.max(0, ...trackLists.map((list) => list.length));
  const rows: AggregatedTrackRow[] = [];
  const allSame = <T,>(values: T[]) => values.every((value) => value === values[0]);
  for (let index = 0; index < maxCount; index += 1) {
    const tracksAtIndex = trackLists.map((list) => list[index]).filter(Boolean) as Track[];
    const names = tracksAtIndex.map((track) => track.name || "");
    const languages = tracksAtIndex.map((track) => track.language || "und");
    const copied = tracksAtIndex.map((track) => track.action !== "remove");
    const defaults = tracksAtIndex.map((track) => track.isDefault === true);
    const forced = tracksAtIndex.map((track) => track.isForced === true);
    const codecs = tracksAtIndex.map((track) => track.codec || "");
    const mixed: Partial<Record<TrackRowField, boolean>> = {
      copyTrack: !allSame(copied),
      setDefault: !allSame(defaults),
      setForced: !allSame(forced),
      trackName: !allSame(names),
      language: !allSame(languages),
    };
    const fields: Pick<TrackRowDraft, TrackRowField> = {
      copyTrack: tracksAtIndex.length > 0 && copied.every(Boolean),
      setDefault: tracksAtIndex.length > 0 && defaults.every(Boolean),
      setForced: tracksAtIndex.length > 0 && forced.every(Boolean),
      trackName: mixed.trackName ? "" : (names[0] ?? ""),
      language: mixed.language ? "" : (languages[0] ?? "und"),
    };
    const trackWithBitrate = type === "audio" ? tracksAtIndex.find((track) => track.bitrate !== undefined) || tracksAtIndex[0] : tracksAtIndex[0];
    rows.push({
      id: `${type}-${index}`,
      sourceTrackPosition: index,
      trackIndex: index + 1,
      ...fields,
      initial: fields,
      mixed,
      namePlaceholder: mixed.trackName ? "Multiple" : codecs[0] && allSame(codecs) ? codecs[0] : `Track ${index + 1}`,
      originalTrack: trackWithBitrate || { id: `${type}-${index}`, type },
      bitrate: trackWithBitrate?.bitrate,
    });
  }
  return rows;
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

  // A row missing here was deleted by the user, so it must be marked "remove" rather than
  // falling through as "keep" (mkvmerge drops a track only when present with that action).
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
      if (!rowFieldTouched(row, "setDefault")) {
        newDefault = track.isDefault;
      } else if (originalDefault === undefined && row.setDefault === false) {
        newDefault = undefined;
      } else if (originalDefault !== row.setDefault) {
        newDefault = row.setDefault;
      } else {
        newDefault = originalDefault;
      }

      let newForced: boolean | undefined;
      if (!rowFieldTouched(row, "setForced")) {
        newForced = track.isForced;
      } else if (originalForced === undefined && row.setForced === false) {
        newForced = undefined;
      } else if (originalForced !== row.setForced) {
        newForced = row.setForced;
      } else {
        newForced = originalForced;
      }

      // Rows without an initial snapshot still treat "Multiple" as "leave the name".
      const nextName = !rowFieldTouched(row, "trackName") || (!row.initial && row.trackName === "Multiple") ? track.name : row.trackName;
      const nextLanguage = rowFieldTouched(row, "language") ? row.language : track.language;
      const copy = rowFieldTouched(row, "copyTrack") ? row.copyTrack : track.action !== "remove";
      const nextAction = copy ? "keep" : "remove";
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

  // Kept tracks in their new order, then the deleted ones — exactly as long as typeTracks, so the
  // slots below line up one-for-one and an edit can never land on a neighbouring track.
  const finalTypeTracks = [...reorderedTypeTracks, ...removedTypeTracks];

  let typeIndex = 0;
  const merged = tracks.map((track) =>
    track.type === type ? finalTypeTracks[typeIndex++] || track : track,
  );

  return { ...file, tracks: merged };
}
