import type { VideoFile } from "@/shared/types";

export const normalizeVideoIdentity = (value: string) => {
  let normalized = value.trim().replace(/\\/g, "/");
  normalized = normalized.replace(/^\/\/\?\/unc\//i, "/");
  normalized = normalized.replace(/^\/\/\?\//, "");
  normalized = normalized.replace(/\/+/g, "/");
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/$/, "");
  }
  return normalized.toLowerCase();
};

export const videoIdentityKey = (file: Pick<VideoFile, "path" | "name">) =>
  normalizeVideoIdentity(file.path || file.name);

export const videoNameKey = (file: Pick<VideoFile, "name">) => normalizeVideoIdentity(file.name);

const videoPathSegments = (file: Pick<VideoFile, "path" | "name">) =>
  videoIdentityKey(file).split("/").filter(Boolean);

/**
 * True when one path is a suffix of the other, i.e. the shorter path's segments
 * all match the tail of the longer one AND the longer path has extra leading
 * segments. This identifies the same file referred to by a relative/rooted path
 * pair (e.g. "Show/Ep.mkv" vs "/mnt/media/Show/Ep.mkv").
 *
 * Two paths of equal length are NOT a suffix match unless identical, which the
 * caller already tests via videoIdentityKey, so this deliberately requires a
 * strict length difference to avoid claiming unrelated siblings are the same.
 */
const sharePathSuffix = (
  a: Pick<VideoFile, "path" | "name">,
  b: Pick<VideoFile, "path" | "name">,
) => {
  const aSegments = videoPathSegments(a);
  const bSegments = videoPathSegments(b);
  const compared = Math.min(aSegments.length, bSegments.length);
  // Need at least a folder + filename to be meaningful, and a genuine
  // length difference (equal-length paths are handled by identity equality).
  if (compared < 2) return false;
  if (aSegments.length === bSegments.length) return false;

  for (let offset = 1; offset <= compared; offset += 1) {
    if (aSegments[aSegments.length - offset] !== bSegments[bSegments.length - offset]) {
      return false;
    }
  }
  return true;
};

/**
 * Sizes only "match" when both are known and equal. An unknown size is NOT
 * evidence of sameness -- treating it as a match previously collapsed distinct
 * files that merely shared a basename (e.g. /eng/Ep01.mkv and /jpn/Ep01.mkv).
 */
const sizesMatch = (a?: number, b?: number) =>
  Number.isFinite(a) && Number.isFinite(b) && a === b;

const shouldMergeVideoFiles = (a: VideoFile, b: VideoFile) =>
  videoIdentityKey(a) === videoIdentityKey(b) ||
  sharePathSuffix(a, b) ||
  (videoNameKey(a) === videoNameKey(b) && sizesMatch(a.size, b.size));

export const mergeVideoFiles = (files: VideoFile[]) => {
  const merged: VideoFile[] = [];

  for (const file of files) {
    const existingIndex = merged.findIndex((existing) => shouldMergeVideoFiles(existing, file));
    if (existingIndex === -1) {
      merged.push(file);
    } else {
      const existing = merged[existingIndex];
      merged[existingIndex] = {
        ...existing,
        ...file,
        id: existing.id,
      };
    }
  }

  return merged;
};
