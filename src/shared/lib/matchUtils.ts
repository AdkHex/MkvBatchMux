/**
 * Episode-aware filename matching utilities.
 *
 * Matches external audio/subtitle files to video files by:
 *   1. Episode number (S01E05, EP05, " - 05 ", [05], standalone numbers)
 *   2. Filename word similarity (common tokens)
 *   3. Positional fallback (index-based, same as old behaviour)
 */
import type { ExternalFile, VideoFile } from "@/shared/types";

// Episode number patterns, tried in priority order.
// Each pattern must capture the episode number in group 1.
const EPISODE_PATTERNS: RegExp[] = [
  /[sS]\d{1,2}[eE](\d{1,4})/,                      // S01E05
  /\bep(?:isode)?[\s._#-]*(\d{1,4})/i,              // EP05, Episode 5, ep. 3
  /[第](\d{1,4})[話話回]/,                            // 第05話 (Japanese)
  / - (\d{1,4})(?:v\d+)?(?:\s|\[|$)/,               // " - 05" / " - 05v2 "
  /[[(](\d{1,4})[\])]/,                              // [05] or (05)
];

/**
 * Numbers that are never a plausible episode number on their own.
 * Deliberately limited to resolutions and codec identifiers.
 *
 * Frame rates and small values (10, 24, 25, 30, 50, 60...) are NOT listed:
 * they are extremely common episode numbers, and excluding them made episodes
 * 10/24/25/30/50/60 unmatchable. Frame-rate and resolution tokens are instead
 * rejected contextually by TECHNICAL_TOKEN below, which looks at the suffix
 * attached to the number (1080p, x264, 23.976fps, 5.1ch ...).
 */
const NON_EPISODE_NUMBERS = new Set([
  240, 360, 480, 540, 720, 1080, 1440, 2160, 4096, 4320, 264, 265,
]);

/**
 * Matches a number that is part of a technical tag rather than an episode
 * number, e.g. "1080p", "x264", "H.265", "23.976fps", "10bit", "5.1ch",
 * "AAC2.0", "8bit". Applied to the raw filename around a candidate number.
 */
const TECHNICAL_TOKEN =
  /(?:^|[^a-z0-9])(?:x|h|hevc|avc)[\s._-]?\d{3,4}|\d+(?:\.\d+)?\s*(?:p|i|fps|hz|bit|ch|khz|kbps|mbps)(?:$|[^a-z0-9])/i;

/**
 * True when the number at `matchIndex` in `name` is glued to a technical
 * suffix/prefix (resolution, codec, frame rate, channel count).
 */
function isTechnicalContext(name: string, matchIndex: number, raw: string): boolean {
  // Look at a small window around the match so "1080p"/"x264"/"23.976fps" are
  // recognised while a bare " - 24 " episode marker is not.
  const start = Math.max(0, matchIndex - 6);
  const window = name.slice(start, matchIndex + raw.length + 5);
  return TECHNICAL_TOKEN.test(window);
}

/**
 * Extract the episode/sequence number from a filename.
 * Returns null when no reliable episode number can be found.
 */
export function extractEpisodeNumber(filename: string): number | null {
  // Strip file extension
  const name = filename.replace(/\.[^.]+$/, "");

  // Try explicit patterns first (unambiguous). These carry their own episode
  // marker (S01E24, "EP24", "第24話"), so a technical-context check is not
  // needed and would wrongly reject e.g. "S01E24.1080p".
  for (const pattern of EPISODE_PATTERNS) {
    const m = name.match(pattern);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > 0 && n < 10000) {
        return n;
      }
    }
  }

  // Fallback: a standalone 2–3 digit number that is not a resolution/codec and
  // is not glued to a technical suffix (1080p, x264, 23.976fps, 10bit, 5.1ch).
  // Scan from the end -- trailing numbers are more likely to be episode numbers.
  const separator = /[\s._[\](){},-]+/;
  const parts = name.split(separator);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (!/^\d{2,3}$/.test(part)) continue;
    const n = parseInt(part, 10);
    if (n <= 0 || NON_EPISODE_NUMBERS.has(n)) continue;

    const matchIndex = name.indexOf(part);
    if (matchIndex >= 0 && isTechnicalContext(name, matchIndex, part)) continue;

    return n;
  }

  return null;
}

/** Normalize a filename for word-overlap comparison. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[^.]+$/, "")          // strip extension
    .replace(/[._[\](){}]/g, " ")    // separators → spaces
    .replace(/[^a-z0-9 ]+/g, "")     // drop punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/** Count shared "meaningful" words (length ≥ 3) between two normalized names. */
function wordOverlap(a: string, b: string): number {
  const setA = new Set(a.split(" ").filter((w) => w.length >= 3));
  return b.split(" ").filter((w) => w.length >= 3 && setA.has(w)).length;
}

/**
 * Match each external file to a video file.
 *
 * Strategy (per file):
 *   1. Extract episode number from the external filename.
 *      If found, look for a video with the same episode number.
 *   2. Word-overlap similarity against all video filenames.
 *      Pick the video with the most shared words (ties → first match).
 *   3. Positional fallback: use the video at the same list index.
 *
 * Already-manually-assigned `matchedVideoId` values are preserved
 * as long as they still point to a valid video (opt-in via `respectExisting`).
 */
export function matchExternalToVideos(
  externalFiles: ExternalFile[],
  videoFiles: VideoFile[],
  respectExisting = false,
): ExternalFile[] {
  if (videoFiles.length === 0) {
    return externalFiles.map((f) => ({ ...f, matchedVideoId: undefined }));
  }

  // Pre-build episode→video map (first video wins per episode number)
  const episodeMap = new Map<number, VideoFile>();
  for (const video of videoFiles) {
    const ep = extractEpisodeNumber(video.name);
    if (ep !== null && !episodeMap.has(ep)) {
      episodeMap.set(ep, video);
    }
  }

  const videoIdSet = new Set(videoFiles.map((v) => v.id));
  const assignedVideoIds = new Set<string>();

  const pickBestUnassignedVideo = (file: ExternalFile) => {
    const ep = extractEpisodeNumber(file.name);
    if (ep !== null) {
      const video = episodeMap.get(ep);
      if (video && !assignedVideoIds.has(video.id)) {
        return video.id;
      }
    }

    const extNorm = normalizeName(file.name);
    let best: { id: string; score: number } | null = null;
    for (const video of videoFiles) {
      if (assignedVideoIds.has(video.id)) continue;
      const score = wordOverlap(extNorm, normalizeName(video.name));
      if (score > 0 && (!best || score > best.score)) {
        best = { id: video.id, score };
      }
    }
    return best?.id;
  };

  const pickPositionalFallback = (index: number) => {
    const preferred = videoFiles[Math.min(index, videoFiles.length - 1)];
    if (preferred && !assignedVideoIds.has(preferred.id)) {
      return preferred.id;
    }
    for (let offset = 1; offset < videoFiles.length; offset += 1) {
      const forwardIndex = index + offset;
      if (forwardIndex < videoFiles.length) {
        const forward = videoFiles[forwardIndex];
        if (!assignedVideoIds.has(forward.id)) return forward.id;
      }
      const backwardIndex = index - offset;
      if (backwardIndex >= 0) {
        const backward = videoFiles[backwardIndex];
        if (!assignedVideoIds.has(backward.id)) return backward.id;
      }
    }
    // Every video is already claimed. Returning `preferred` here would hand the
    // same video to two external files, so the extra file stays unmatched and
    // surfaces in the UI as unlinked rather than silently muxing into the wrong
    // episode.
    return undefined;
  };

  return externalFiles.map((file, index) => {
    // Preserve a valid, explicitly set match
    if (
      respectExisting &&
      file.matchedVideoId &&
      videoIdSet.has(file.matchedVideoId)
    ) {
      assignedVideoIds.add(file.matchedVideoId);
      return file;
    }

    const matchedVideoId = pickBestUnassignedVideo(file) || pickPositionalFallback(index);
    if (matchedVideoId) {
      assignedVideoIds.add(matchedVideoId);
    }
    return { ...file, matchedVideoId };
  });
}

/**
 * Pair the nth external file with the nth video.
 *
 * Files past the end of the video list keep whatever link they already had.
 * Overwriting them with `undefined` silently unlinked every extra file -- and
 * because the relink runs whenever the lists differ, a batch with more audio
 * than video dropped those files from the mux with nothing on screen to say so.
 */
export function linkExternalFilesByOrder(
  externalFiles: ExternalFile[],
  videoFiles: VideoFile[],
): ExternalFile[] {
  const videoIds = videoFiles.map((video) => video.id);
  return externalFiles.map((file, index) =>
    index < videoIds.length ? { ...file, matchedVideoId: videoIds[index] } : file,
  );
}

export function assignExternalFileToVideo(
  externalFiles: ExternalFile[],
  fileId: string,
  videoId: string,
): ExternalFile[] {
  const target = externalFiles.find((file) => file.id === fileId);
  if (!target) return externalFiles;

  const previousVideoId = target.matchedVideoId;

  return externalFiles.map((file) => {
    if (file.id === fileId) {
      return { ...file, matchedVideoId: videoId };
    }
    if (file.matchedVideoId !== videoId) {
      return file;
    }
    return {
      ...file,
      matchedVideoId: previousVideoId && previousVideoId !== videoId ? previousVideoId : undefined,
    };
  });
}

export function getUnlinkedExternalFiles(
  externalFiles: ExternalFile[],
  videoFiles: VideoFile[],
): ExternalFile[] {
  const videoIds = new Set(videoFiles.map((video) => video.id));
  return externalFiles.filter((file) => !file.matchedVideoId || !videoIds.has(file.matchedVideoId));
}
