import type { ExternalFile, MuxJob, VideoFile } from "@/shared/types";
import { extractEpisodeNumber } from "@/shared/lib/matchUtils";

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

const buildStrictVideoMatcher = (videoFiles: VideoFile[]) => {
  const byId = new Map(videoFiles.map((video) => [video.id, video] as const));
  const episodeMap = new Map<number, string>();

  videoFiles.forEach((video) => {
    const episode = extractEpisodeNumber(video.name);
    if (episode !== null && !episodeMap.has(episode)) {
      episodeMap.set(episode, video.id);
    }
  });

  const resolve = (file: ExternalFile) => {
    if (file.matchedVideoId && byId.has(file.matchedVideoId)) {
      return file.matchedVideoId;
    }

    const episode = extractEpisodeNumber(file.name);
    if (episode !== null) {
      const matched = episodeMap.get(episode);
      if (matched) return matched;
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

const muxAfterRank = (value?: string) => {
  if (!value || value === "video") return 0;
  if (value.startsWith("track-")) {
    const index = Number(value.replace("track-", ""));
    return Number.isFinite(index) ? index : 1;
  }
  if (value === "end") return 99;
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

  const allAudioFiles = Object.values(audioFilesByTrack).flat();
  const allSubtitleFiles = Object.values(subtitleFilesByTrack).flat();
  const audioMap = mapByResolvedVideoId(allAudioFiles, resolve);
  const subtitleMap = mapByResolvedVideoId(allSubtitleFiles, resolve);
  const chapterMap = mapByResolvedVideoId(chapterFiles, resolve);
  const attachmentMap = mapByResolvedVideoId(attachmentFiles, resolve);

  return jobs.flatMap((job) => {
    const video = byId.get(job.videoFile.id);
    if (!video) return [];

    const perVideo = perVideoExternal[video.id] || { audios: [], subtitles: [] };
    const bulkAudios = (audioMap.get(video.id) || []).map((file, index) => ({
      file: {
        ...file,
        isDefault: file.isDefault ?? true,
        source: "bulk" as const,
      },
      sourcePriority: 0,
      order: index,
    }));
    const perVideoAudios = perVideo.audios.map((file, index) => ({
      file: {
        ...file,
        isDefault: file.isDefault ?? false,
        source: "per-file" as const,
      },
      sourcePriority: 1,
      order: index,
    }));
    const bulkSubtitles = (subtitleMap.get(video.id) || []).map((file, index) => ({
      file: {
        ...file,
        source: "bulk" as const,
      },
      sourcePriority: 0,
      order: index,
    }));
    const perVideoSubtitles = perVideo.subtitles.map((file, index) => ({
      file: {
        ...file,
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
        attachments: attachmentMap.get(video.id) || [],
      },
    ];
  });
}
