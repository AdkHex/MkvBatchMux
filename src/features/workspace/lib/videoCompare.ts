import type { Track, VideoFile } from "@/shared/types";

function areTracksEquivalent(a: Track[], b: Track[]) {
  if (a.length !== b.length) return false;
  return a.every((track, index) => {
    const other = b[index];
    return (
      track.id === other.id &&
      track.type === other.type &&
      track.codec === other.codec &&
      track.language === other.language &&
      track.name === other.name &&
      track.isDefault === other.isDefault &&
      track.isForced === other.isForced &&
      track.bitrate === other.bitrate &&
      track.action === other.action &&
      track.originalName === other.originalName &&
      track.originalLanguage === other.originalLanguage &&
      track.originalDefault === other.originalDefault &&
      track.originalForced === other.originalForced
    );
  });
}

export function areVideoFilesEquivalent(a: VideoFile, b: VideoFile) {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.path === b.path &&
    a.size === b.size &&
    a.duration === b.duration &&
    a.fps === b.fps &&
    a.status === b.status &&
    areTracksEquivalent(a.tracks || [], b.tracks || [])
  );
}

/**
 * Whether two lists describe the same files in the same order, ignoring `id`.
 *
 * Ids are minted per backend call, so the same file inspected twice arrives
 * with a different id each time. Comparing them would report every scan chunk
 * as a change and re-render the whole list; comparing what the row actually
 * displays does not.
 */
export function areVideoListsEquivalent(a: VideoFile[], b: VideoFile[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((file, index) => {
    const other = b[index];
    return (
      file.name === other.name &&
      file.path === other.path &&
      file.size === other.size &&
      file.duration === other.duration &&
      file.fps === other.fps &&
      file.status === other.status &&
      areTracksEquivalent(file.tracks || [], other.tracks || [])
    );
  });
}
