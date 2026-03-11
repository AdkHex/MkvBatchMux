/**
 * Episode-aware filename matching utilities.
 *
 * Matches external audio/subtitle files to video files by:
 *   1. Episode number (S01E05, EP05, " - 05 ", [05], standalone numbers)
 *   2. Filename word similarity (common tokens)
 *   3. Positional fallback (index-based, same as old behaviour)
 */
import type { ExternalFile, VideoFile } from "@/types";

// Episode number patterns, tried in priority order.
// Each pattern must capture the episode number in group 1.
const EPISODE_PATTERNS: RegExp[] = [
  /[sS]\d{1,2}[eE](\d{1,4})/,                      // S01E05
  /\bep(?:isode)?[\s._#-]*(\d{1,4})/i,              // EP05, Episode 5, ep. 3
  /[第](\d{1,4})[話話回]/,                            // 第05話 (Japanese)
  / - (\d{1,4})(?:v\d+)?(?:\s|\[|$)/,               // " - 05" / " - 05v2 "
  /[[(](\d{1,4})[\])]/,                              // [05] or (05)
];

// Resolutions & codec numbers we should NOT confuse with episode numbers
const NON_EPISODE_NUMBERS = new Set([
  240, 360, 480, 540, 720, 1080, 1440, 2160, 4096, 4320,
  264, 265, 10, 23, 24, 25, 29, 30, 48, 50, 60, 120,
]);

/**
 * Extract the episode/sequence number from a filename.
 * Returns null when no reliable episode number can be found.
 */
export function extractEpisodeNumber(filename: string): number | null {
  // Strip file extension
  const name = filename.replace(/\.[^.]+$/, "");

  // Try explicit patterns first (unambiguous)
  for (const pattern of EPISODE_PATTERNS) {
    const m = name.match(pattern);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > 0 && n < 10000 && !NON_EPISODE_NUMBERS.has(n)) {
        return n;
      }
    }
  }

  // Fallback: look for a standalone 2–3 digit number that isn't a resolution/codec
  // Split on common separators and scan from the end (more likely to be ep number)
  const parts = name.split(/[\s._[\](){},-]+/).reverse();
  for (const part of parts) {
    if (/^\d{2,3}$/.test(part)) {
      const n = parseInt(part, 10);
      if (n > 0 && !NON_EPISODE_NUMBERS.has(n)) {
        return n;
      }
    }
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

  return externalFiles.map((file, index) => {
    // Preserve a valid, explicitly set match
    if (
      respectExisting &&
      file.matchedVideoId &&
      videoIdSet.has(file.matchedVideoId)
    ) {
      return file;
    }

    // 1. Episode number match
    const ep = extractEpisodeNumber(file.name);
    if (ep !== null) {
      const video = episodeMap.get(ep);
      if (video) return { ...file, matchedVideoId: video.id };
    }

    // 2. Word-overlap match
    const extNorm = normalizeName(file.name);
    let best: { id: string; score: number } | null = null;
    for (const video of videoFiles) {
      const score = wordOverlap(extNorm, normalizeName(video.name));
      if (score > 0 && (!best || score > best.score)) {
        best = { id: video.id, score };
      }
    }
    if (best) return { ...file, matchedVideoId: best.id };

    // 3. Positional fallback (clamp to last video so we always get a valid id)
    const fallback = videoFiles[Math.min(index, videoFiles.length - 1)];
    return { ...file, matchedVideoId: fallback.id };
  });
}
