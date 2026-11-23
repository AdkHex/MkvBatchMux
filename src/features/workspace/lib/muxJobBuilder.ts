import type { ExternalFile, MuxJob, VideoFile } from "@/shared/types";
import { WEAK_KEY, episodeKey, type EpisodeKey } from "@/shared/lib/episodeKey";
import { realFiles } from "@/shared/lib/matchUtils";

interface PerVideoExternalFiles {
  audios: ExternalFile[];
  subtitles: ExternalFile[];
}

interface BuildMuxJobRequestsInput {
  videoFiles: VideoFile[];
  jobs: MuxJob[];
  audioFilesByTrack: Record<string, ExternalFile[]>;
  subtitleFilesByTrack: Record<string, ExternalFile[]>;
  chapterFiles: ExternalFile[];
  attachmentFiles: ExternalFile[];
  perVideoExternal: Record<string, PerVideoExternalFiles>;
}

const normalizeName = (value: string) =>
  value
    .toLowerCase()
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The same episode: season and episode both, a missing season on either
 *  side matching any. S02E03 is not S01E03. */
const sameEpisode = (a: EpisodeKey, b: EpisodeKey) =>
  a.episode !== undefined && a.episode === b.episode && (a.season === undefined || b.season === undefined || a.season === b.season);

/** Resolve which video each external file belongs to; exported so measurement reuses the same matcher instead of risking a different pairing. */
export const buildStrictVideoMatcher = (videoFiles: VideoFile[]) => {
  const byId = new Map(videoFiles.map((video) => [video.id, video] as const));
  const videoKeys = videoFiles.map((video) => ({ id: video.id, key: episodeKey(video.path || video.name) }));

  const resolve = (file: ExternalFile) => {
    // An empty row stands for no file at all.
    if (file.placeholder) return undefined;
    if (file.matchedVideoId && byId.has(file.matchedVideoId)) {
      return file.matchedVideoId;
    }

    // First video of that season and episode; a bare number is too weak to mux by.
    const key = episodeKey(file.path || file.name);
    if (key.episode !== undefined && key.confidence >= WEAK_KEY) {
      const matched = videoKeys.find((video) => video.key.confidence >= WEAK_KEY && sameEpisode(key, video.key));
      if (matched) return matched.id;
    }

    const normalizedFile = normalizeName(file.name || file.path);
    let best: { id: string; score: number } | null = null;

    videoFiles.forEach((video) => {
      const normalizedVideo = normalizeName(video.name || video.path);
      if (!normalizedFile || !normalizedVideo) return;
      let score = 0;
      if (normalizedVideo.includes(normalizedFile)) {
        score = normalizedFile.length;
      } else if (normalizedFile.includes(normalizedVideo)) {
        score = normalizedVideo.length;
      }
      if (score > 0 && (!best || score > best.score)) {
        best = { id: video.id, score };
      }
    });

    return best?.id;
  };

  return { byId, resolve };
};

/** Rank used to order external tracks by their `muxAfter` placement; lower sorts earlier.
 *  Unrecognised values are logged rather than silently ranked as "video". */
const muxAfterRank = (value?: string) => {
  if (value === "subtitle-first") return -1;
  if (!value || value === "video") return 0;
  if (value === "audio") return 1;
  if (value.startsWith("track-")) {
    const index = Number(value.replace("track-", ""));
    if (Number.isFinite(index)) return index;
    if (import.meta.env?.DEV) {
      console.warn(`muxAfterRank: malformed track placement "${value}"; treating as first track.`);
    }
    return 1;
  }
  if (value === "end") return 99;
  if (import.meta.env?.DEV) {
    console.warn(`muxAfterRank: unknown muxAfter value "${value}"; treating as "video".`);
  }
  return 0;
};

const orderByMuxAfter = (
  files: Array<{ file: ExternalFile; sourcePriority: number; order: number }>,
) =>
  [...files].sort((a, b) => {
    const rankDiff = muxAfterRank(a.file.muxAfter) - muxAfterRank(b.file.muxAfter);
    if (rankDiff !== 0) return rankDiff;
    if (a.sourcePriority !== b.sourcePriority) return a.sourcePriority - b.sourcePriority;
    return a.order - b.order;
  });

const mapByResolvedVideoId = (
  files: ExternalFile[],
  resolveVideoId: (file: ExternalFile) => string | undefined,
) => {
  const map = new Map<string, ExternalFile[]>();
  files.forEach((file) => {
    const matchedId = resolveVideoId(file);
    if (!matchedId) return;
    const current = map.get(matchedId) || [];
    current.push(file);
    map.set(matchedId, current);
  });
  return map;
};

const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
/** A copy made for `video` (or for a video not recorded, taken as this one). */
const madeFor = (videoPath: string | undefined, video: Pick<VideoFile, "path">) => !videoPath || !video.path || samePath(videoPath, video.path);
const fileName = (path: string) => path.replace(/^.*[\\/]/, "");

type Override = NonNullable<ExternalFile["trackOverrides"]>[number];
/** A track's own settings minus everything about its delay: the new file is
 *  already laid on the video's timeline, so it goes in at 0. */
const keepNamesAndLanguage = (override: Override | undefined): Override | undefined => {
  if (!override) return undefined;
  const kept: Override = {};
  if (override.language !== undefined) kept.language = override.language;
  if (override.trackName !== undefined) kept.trackName = override.trackName;
  return Object.keys(kept).length > 0 ? kept : undefined;
};

/** The file reduced to one track of another file: that file's only track
 *  (id 0), at delay 0, keeping the language, name and flags of the track it
 *  was made from (its overrides re-keyed to 0). Nothing else of the original
 *  comes along: not its other tracks, not subtitles carried inside it. */
function oneTrackOf(file: ExternalFile, path: string, type: "audio" | "subtitle", sourceId: number | null, codec?: string | null): ExternalFile {
  const source = (file.tracks ?? []).find((track) => track.type === type && Number(track.id) === sourceId);
  const override = keepNamesAndLanguage(sourceId === null ? undefined : file.trackOverrides?.[sourceId]);
  const {
    conformed: _conformed,
    retimed: _retimed,
    subsync: _subsync,
    measuredDelay: _measured,
    pendingDelay: _pending,
    stretch: _stretch,
    trackOverrides: _overrides,
    ...rest
  } = file;
  return {
    ...rest,
    path,
    name: fileName(path),
    delay: 0,
    trackId: 0,
    tracks: [{ ...(source ?? {}), id: "0", type, ...(codec ? { codec } : {}) }],
    includedTrackIds: [0],
    includeSubtitles: false,
    includedSubtitleTrackIds: [],
    trackOverrides: override ? { 0: override } : {},
  };
}

/** The file as the mux takes it. A dub conformed to this video's cut muxes
 *  its conformed track instead of the original; a subtitle with a re-timed
 *  copy for this video muxes that copy. A copy made for another video (the
 *  pairing changed since) is not used: the original goes in, as the page
 *  shows it. */
export function fileForMux(file: ExternalFile, video: Pick<VideoFile, "path">): ExternalFile {
  if (file.conformed && madeFor(file.conformed.videoPath, video)) {
    const audio = (file.tracks ?? []).filter((track) => track.type === "audio");
    const source = audio[file.conformed.sourceTrack];
    return oneTrackOf(file, file.conformed.path, "audio", source ? Number(source.id) : null, file.conformed.codec);
  }
  if (file.retimed && madeFor(file.retimed.videoPath, video)) {
    const subtitles = (file.tracks ?? []).filter((track) => track.type === "subtitle");
    const source = subtitles.find((track) => !file.includedTrackIds || file.includedTrackIds.includes(Number(track.id))) ?? subtitles[0];
    return oneTrackOf(file, file.retimed.path, "subtitle", source ? Number(source.id) : null);
  }
  return file;
}

export function buildMuxJobRequests({
  videoFiles,
  jobs,
  audioFilesByTrack,
  subtitleFilesByTrack,
  chapterFiles,
  attachmentFiles,
  perVideoExternal,
}: BuildMuxJobRequestsInput) {
  const { byId, resolve } = buildStrictVideoMatcher(videoFiles);

  // Empty rows (placeholders) hold a video's place in a list; they are never muxed.
  const allAudioFiles = realFiles(Object.values(audioFilesByTrack).flat());
  const allSubtitleFiles = realFiles(Object.values(subtitleFilesByTrack).flat());
  const audioMap = mapByResolvedVideoId(allAudioFiles, resolve);
  const subtitleMap = mapByResolvedVideoId(allSubtitleFiles, resolve);
  const chapterMap = mapByResolvedVideoId(realFiles(chapterFiles), resolve);
  const globalAttachments = realFiles(attachmentFiles).map((file) => ({
    ...file,
    source: "bulk" as const,
    matchedVideoId: undefined,
  }));

  return jobs.flatMap((job) => {
    const video = byId.get(job.videoFile.id);
    if (!video) return [];

    const ownLists = perVideoExternal[video.id] || { audios: [], subtitles: [] };
    const perVideo = { audios: realFiles(ownLists.audios), subtitles: realFiles(ownLists.subtitles) };
    const bulkAudios = (audioMap.get(video.id) || []).map((file, index) => ({
      file: {
        ...fileForMux(file, video),
        isDefault: file.isDefault ?? true,
        source: "bulk" as const,
      },
      sourcePriority: 0,
      order: index,
    }));
    const perVideoAudios = perVideo.audios.map((file, index) => ({
      file: {
        ...fileForMux(file, video),
        isDefault: file.isDefault ?? false,
        source: "per-file" as const,
      },
      sourcePriority: 1,
      order: index,
    }));
    const bulkSubtitles = (subtitleMap.get(video.id) || []).map((file, index) => ({
      file: {
        ...fileForMux(file, video),
        source: "bulk" as const,
      },
      sourcePriority: 0,
      order: index,
    }));
    const perVideoSubtitles = perVideo.subtitles.map((file, index) => ({
      file: {
        ...fileForMux(file, video),
        source: "per-file" as const,
      },
      sourcePriority: 1,
      order: index,
    }));

    return [
      {
        id: job.id,
        video,
        audios: orderByMuxAfter([...bulkAudios, ...perVideoAudios]).map((entry) => entry.file),
        subtitles: orderByMuxAfter([...bulkSubtitles, ...perVideoSubtitles]).map(
          (entry) => entry.file,
        ),
        chapters: chapterMap.get(video.id) || [],
        attachments: globalAttachments,
      },
    ];
  });
}
