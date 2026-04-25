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
