/** Pairing dubs, subtitles and chapters with videos by episode rather than by
 *  row.
 *
 *  Rows stay the model: row n is file n and video n, which is how every page,
 *  the measurement and the mux read a list. Pairing by episode arranges the
 *  list into the videos' order instead of the folder's: a missing episode
 *  becomes an empty row (a placeholder) so the files after it stay beside
 *  their own videos, and files no video takes go after the last one, where
 *  they block the mux until someone decides. Files keep their own settings
 *  wherever they move: nothing here copies a delay from one row to another.
 *
 *  Hand links win: a file the user put beside a video (`isManuallyLinked`), or
 *  one Match by audio heard in a video (`audioMatch`), stays there. */

import { WEAK_KEY, episodeKey, formatEpisodeKey, type EpisodeKey } from "@/shared/lib/episodeKey";
import { isPlaceholder, placeholderFor, realFiles } from "@/shared/lib/matchUtils";
import type { ExternalFile, VideoFile } from "@/shared/types";

export type PairBy = "episode" | "order";
export type PairMethod = "episode" | "order" | "audio" | "hand";

/** How one file came to be beside its video. */
export interface PairInfo {
  method: PairMethod;
  /** 0–1: how sure the pairing is. 1 for a pick by hand; the engine's for audio. */
  confidence: number;
  /** Worth a look, not a reason to stop: a length that does not agree, a
   *  number read from a bare digit. */
  warnings: string[];
}

export type ConflictKind = "duplicate" | "mismatch" | "season" | "unmatched";

/** A file the mux must not take as it stands. */
export interface PairingConflict {
  kind: ConflictKind;
  fileId: string;
  /** The file's row, from 0. */
  row: number;
  /** For a duplicate: the row that has the other file of that episode. */
  otherRow?: number;
  /** A sentence that follows the file's name: "is S01E04, but its video is S01E03." */
  message: string;
  /** A word or two for the Match column. */
  short: string;
}

export interface PairingReport {
  /** By file id, for files beside a video. */
  pairs: Record<string, PairInfo>;
  conflicts: PairingConflict[];
}

export interface Arrangement extends PairingReport {
  /** The list in row order. */
  files: ExternalFile[];
}

/** Below this share of names with an episode in them, on either side, a page
 *  pairs by order: guessing the rest would pair more wrong than right. */
export const EPISODE_SHARE = 0.8;
/** Lengths further apart than this are flagged; a dub of another cut can
 *  differ, so it is a warning, not a conflict. */
export const DURATION_WARN = 0.05;
/** Match by audio only tries videos within this of the file's length. */
export const AUDIO_MATCH_DURATION = 0.1;
/** The confidence Match by audio needs to pair a file. */
export const AUDIO_MATCH_MIN = 0.6;
/** A key this sure, on both sides, makes a different episode under pairing by
 *  order a conflict rather than a warning. */
const STRONG_KEY = 0.75;

type Named = { name: string; path: string };

/** Each item's key, or null where there is none to pair by. A bare number
 *  ("Goblin 02") counts only when another item in the list has the same
 *  pattern around its number: a run of them is a numbering, a lone
 *  "Track 2" is not. */
export function usableKeys(items: Named[]): (EpisodeKey | null)[] {
  const keys = items.map((item) => episodeKey(item.path || item.name));
  const templates = new Map<string, number>();
  for (const key of keys) if (key.template) templates.set(key.template, (templates.get(key.template) ?? 0) + 1);
  return keys.map((key) => {
    if (key.episode === undefined) return null;
    if (key.confidence >= WEAK_KEY) return key;
    return key.template && (templates.get(key.template) ?? 0) >= 2 ? key : null;
  });
}

const share = (keys: (EpisodeKey | null)[]) => (keys.length ? keys.filter(Boolean).length / keys.length : 0);

/** Episode when episode numbers read for at least 80 % of the files and of
 *  the videos; otherwise order, as before this existed. */
export function defaultPairBy(files: ExternalFile[], videos: VideoFile[]): PairBy {
  const real = realFiles(files);
  if (real.length === 0 || videos.length === 0) return "order";
  return share(usableKeys(real)) >= EPISODE_SHARE && share(usableKeys(videos)) >= EPISODE_SHARE ? "episode" : "order";
}

/** "exact": same season and episode (and range). "loose": same episode, with
 *  the season missing on one side or a range that differs. */
function keyMatch(file: EpisodeKey, video: EpisodeKey): "exact" | "loose" | null {
  if (file.episode === undefined || video.episode === undefined) return null;
  if (file.season !== undefined && video.season !== undefined && file.season !== video.season) return null;
  const inRange = file.episode === video.episode || (video.episodeEnd !== undefined && file.episode > video.episode && file.episode <= video.episodeEnd);
  if (!inRange) return null;
  return file.season === video.season && file.episode === video.episode && file.episodeEnd === video.episodeEnd ? "exact" : "loose";
}

const clock = (seconds: number) => {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};

/** How far apart two lengths are, as a share of the video's; null when either is unknown. */
export function durationGap(file: Pick<ExternalFile, "durationSeconds">, video: Pick<VideoFile, "durationSeconds">): number | null {
  const a = file.durationSeconds;
  const b = video.durationSeconds;
  if (!a || !b || a <= 0 || b <= 0) return null;
  return Math.abs(a - b) / b;
}

function durationWarning(file: ExternalFile, video: VideoFile): string | null {
  // Only a dub runs as long as its video. A subtitle's length is from its
  // first line to its last, a chapter file has none: compared with the
  // video's, they would be "off" on every real release.
  if (file.type !== "audio") return null;
  const gap = durationGap(file, video);
  if (gap === null || gap <= DURATION_WARN) return null;
  return `Its length is ${Math.round(gap * 100)} % off its video's (${clock(file.durationSeconds!)} against ${clock(video.durationSeconds!)}): another cut, or another episode.`;
}

/** The video a file is pinned to, among those loaded: by hand, or by audio. */
function pinOf(file: ExternalFile, videoIds: Set<string>): { videoId: string; method: "hand" | "audio" } | null {
  if (file.isManuallyLinked && file.matchedVideoId && videoIds.has(file.matchedVideoId)) return { videoId: file.matchedVideoId, method: "hand" };
  if (file.audioMatch && videoIds.has(file.audioMatch.videoId)) return { videoId: file.audioMatch.videoId, method: "audio" };
  return null;
}

/** The file beside `videoId`, linked to it, its pins kept only if they point there. */
function placed(file: ExternalFile, videoId: string | undefined): ExternalFile {
  const staleHand = Boolean(file.isManuallyLinked && file.matchedVideoId !== videoId);
  const staleAudio = Boolean(file.audioMatch && file.audioMatch.videoId !== videoId);
  if (file.matchedVideoId === videoId && !staleHand && !staleAudio) return file;
  const next: ExternalFile = { ...file, matchedVideoId: videoId };
  if (staleHand) next.isManuallyLinked = false;
  if (staleAudio) delete next.audioMatch;
  return next;
}

/** The list arranged by episode: each video's file in its row, a placeholder
 *  where a video has none, then the files no video takes. The same list in
 *  gives the same list out (objects included), so applying it converges. */
export function pairByEpisode(files: ExternalFile[], videos: VideoFile[]): Arrangement {
  const real = realFiles(files);
  const type = real[0]?.type ?? files[0]?.type ?? "audio";
  const videoIds = new Set(videos.map((video) => video.id));
  const rowOf = new Map(videos.map((video, index) => [video.id, index] as const));
  const slots: (ExternalFile | null)[] = videos.map(() => null);
  const placedIds = new Set<string>();

  // Pinned files first; a second pin on the same video falls through to its name.
  for (const file of real) {
    const pin = pinOf(file, videoIds);
    if (!pin) continue;
    const row = rowOf.get(pin.videoId)!;
    if (slots[row]) continue;
    slots[row] = file;
    placedIds.add(file.id);
  }

  // Then by key: every possible (file, video) match, the surest first, so a
  // file that names its season beats one that does not, and of two files for
  // one episode the one whose length agrees takes it.
  const videoKeys = usableKeys(videos);
  const fileKeys = usableKeys(real);
  const candidates: { index: number; row: number; exact: boolean; confidence: number; gap: number }[] = [];
  real.forEach((file, index) => {
    const key = fileKeys[index];
    if (!key || placedIds.has(file.id)) return;
    videoKeys.forEach((videoKey, row) => {
      const match = videoKey ? keyMatch(key, videoKey) : null;
      if (!match) return;
      candidates.push({ index, row, exact: match === "exact", confidence: Math.min(key.confidence, videoKey!.confidence), gap: durationGap(file, videos[row]) ?? 0 });
    });
  });
  candidates.sort((a, b) => Number(b.exact) - Number(a.exact) || b.confidence - a.confidence || a.gap - b.gap || a.index - b.index || a.row - b.row);
  for (const candidate of candidates) {
    const file = real[candidate.index];
    if (placedIds.has(file.id) || slots[candidate.row]) continue;
    slots[candidate.row] = file;
    placedIds.add(file.id);
  }

  // Placeholders already in the list are reused, so an unchanged arrangement
  // is the same objects and the page's effect has nothing to write.
  const existingGaps = new Map(files.filter(isPlaceholder).map((file) => [file.id, file] as const));
  const gapFor = (video: VideoFile) => {
    const fresh = placeholderFor(video, type);
    const old = existingGaps.get(fresh.id);
    return old && old.matchedVideoId === video.id && old.type === type ? old : fresh;
  };
  const rows = slots.map((file, row) => (file ? placed(file, videos[row].id) : gapFor(videos[row])));
  const extras = real.filter((file) => !placedIds.has(file.id)).map((file) => placed(file, undefined));
  // Empty rows after the last file pair nothing with nothing; past the last
  // video they would be needed only to push extras down, and extras already go there.
  if (extras.length === 0) while (rows.length > 0 && isPlaceholder(rows[rows.length - 1])) rows.pop();
  const arranged = [...rows, ...extras];
  const same = arranged.length === files.length && arranged.every((file, index) => file === files[index]);
  const out = same ? files : arranged;
  return { files: out, ...describePairing(out, videos, "episode") };
}

/** Whether a file sits beside a video other than the one its name says. */
function mismatch(fileKey: EpisodeKey | null, videoKey: EpisodeKey | null): "season" | "episode" | null {
  if (!fileKey || !videoKey || keyMatch(fileKey, videoKey)) return null;
  // Absolute numbering against seasons ("13" against S02E01) cannot be told
  // apart from a wrong pairing, so only like is compared with like.
  if ((fileKey.season === undefined) !== (videoKey.season === undefined)) return null;
  if (fileKey.season !== undefined && fileKey.season !== videoKey.season && fileKey.episode === videoKey.episode) return "season";
  return "episode";
}

/** What each file's pairing rests on, and what must be settled before a mux.
 *  Reads the links the mux will use (`matchedVideoId`), not the rows, so it
 *  holds for any list -- arranged by episode, in row order, or chapters linked
 *  by hand -- and the mux can check every slot without knowing how its page
 *  pairs. `pairBy` only names the method shown for files paired by name or by
 *  row. */
export function describePairing(files: ExternalFile[], videos: VideoFile[], pairBy: PairBy = "order"): PairingReport {
  const pairs: Record<string, PairInfo> = {};
  const conflicts: PairingConflict[] = [];
  const videoKeys = usableKeys(videos);
  const videoRow = new Map(videos.map((video, index) => [video.id, index] as const));
  // Keys by row, so a row and the list line up; placeholders have none.
  const keyByRow: (EpisodeKey | null)[] = files.map(() => null);
  const realRows = files.flatMap((file, row) => (isPlaceholder(file) ? [] : [row]));
  usableKeys(realRows.map((row) => files[row])).forEach((key, i) => (keyByRow[realRows[i]] = key));
  const linkedRow = (row: number) => {
    const id = files[row].matchedVideoId;
    return id === undefined ? undefined : videoRow.get(id);
  };

  // The row of the file each video has, by video row.
  const holders = new Map<number, number>();
  for (const row of realRows) {
    const at = linkedRow(row);
    if (at !== undefined && !holders.has(at)) holders.set(at, row);
  }

  for (const row of realRows) {
    const at = linkedRow(row);
    if (at === undefined) continue;
    const file = files[row];
    const key = keyByRow[row];
    const video = videos[at];
    const videoKey = videoKeys[at];
    const warnings: string[] = [];
    const length = durationWarning(file, video);
    if (length) warnings.push(length);

    if (file.isManuallyLinked) {
      pairs[file.id] = { method: "hand", confidence: 1, warnings };
      continue;
    }
    if (file.audioMatch && file.audioMatch.videoId === video.id) {
      pairs[file.id] = { method: "audio", confidence: file.audioMatch.confidence, warnings };
      continue;
    }

    const match = key && videoKey ? keyMatch(key, videoKey) : null;
    const wrong = mismatch(key, videoKey);
    if (wrong && key!.confidence >= STRONG_KEY && videoKey!.confidence >= STRONG_KEY) {
      conflicts.push({
        kind: wrong === "season" ? "season" : "mismatch",
        fileId: file.id,
        row,
        message: `is ${formatEpisodeKey(key!)}, but its video ${video.name} is ${formatEpisodeKey(videoKey!)}.`,
        short: wrong === "season" ? "Other season" : "Other episode",
      });
    } else if (wrong || (key && videoKey && !match)) {
      warnings.push(`Its name reads as ${formatEpisodeKey(key!)}, its video's as ${formatEpisodeKey(videoKey!)}.`);
    }
    if (match === "loose" && key!.episodeEnd !== videoKey!.episodeEnd)
      warnings.push(`It covers ${formatEpisodeKey(key!)}, its video ${formatEpisodeKey(videoKey!)}.`);
    if (match && Math.min(key!.confidence, videoKey!.confidence) < WEAK_KEY)
      warnings.push("Paired on a bare number in the names; check it is the episode.");

    if (pairBy === "episode" && match) {
      pairs[file.id] = { method: "episode", confidence: Math.min(key!.confidence, videoKey!.confidence), warnings };
    } else {
      // By position: as sure as the names agree, unknown when they say nothing.
      pairs[file.id] = { method: "order", confidence: match ? 1 : wrong ? 0.2 : 0.5, warnings };
    }
  }

  // Files without a video: say why none takes them.
  const seasons = [...new Set(videoKeys.flatMap((key) => (key?.season !== undefined ? [key.season] : [])))].sort((a, b) => a - b);
  for (const row of realRows) {
    if (linkedRow(row) !== undefined) continue;
    const file = files[row];
    const key = keyByRow[row];
    const base = { fileId: file.id, row };
    if (!key) {
      conflicts.push({ ...base, kind: "unmatched", message: pairBy === "episode" ? "has no episode number in its name, so no video takes it." : "has no video to go into.", short: pairBy === "episode" ? "No episode" : "No video" });
      continue;
    }
    const label = formatEpisodeKey(key);
    const taken = videoKeys.findIndex((videoKey, at) => videoKey && keyMatch(key, videoKey) && holders.has(at));
    if (taken >= 0) {
      const other = holders.get(taken)!;
      conflicts.push({ ...base, kind: "duplicate", otherRow: other, message: `is a second ${label}: row ${other + 1} has ${files[other].name}.`, short: `Second ${label}` });
      continue;
    }
    const free = videoKeys.findIndex((videoKey) => videoKey && keyMatch(key, videoKey));
    if (free >= 0) {
      conflicts.push({ ...base, kind: "unmatched", message: `has no video to go into, though ${videos[free].name} has no file.`, short: "No video" });
      continue;
    }
    if (key.season !== undefined && seasons.length > 0 && !seasons.includes(key.season)) {
      conflicts.push({ ...base, kind: "season", message: `is ${label}, but the videos are season ${seasons.join(", ")}.`, short: `Season ${key.season}` });
      continue;
    }
    conflicts.push({ ...base, kind: "unmatched", message: `is ${label}, and no video is.`, short: `No ${label}` });
  }

  return { pairs, conflicts };
}

/** Lines for the mux's "pair every file first" notice, naming the rows.
 *  `label` is the slot: "Audio 1", "Subtitle 2", "Chapters". */
export function conflictMessages(report: PairingReport, files: ExternalFile[], label: string, max = 3): string[] {
  const { conflicts } = report;
  if (conflicts.length === 0) return [];
  const line = (conflict: PairingConflict) => `${label}, row ${conflict.row + 1}: ${files[conflict.row]?.name ?? "a file"} ${conflict.message}`;
  if (conflicts.length <= max) return conflicts.map(line);
  const rest = conflicts.length - (max - 1);
  return [...conflicts.slice(0, max - 1).map(line), `${label}: ${rest} more file${rest === 1 ? "" : "s"} to pair, rows ${conflicts.slice(max - 1).map((c) => c.row + 1).join(", ")}.`];
}

/** The list with a file moved to `row`, a video row. The file there trades
 *  places with it when it came from a video row; otherwise that file goes
 *  after the last video. The moved file's old video row becomes an empty row,
 *  so no other file shifts to another video. */
export function moveToRow(files: ExternalFile[], fileId: string, row: number, videos: VideoFile[]): ExternalFile[] {
  const from = files.findIndex((file) => file.id === fileId);
  if (from < 0 || row < 0 || row >= videos.length || from === row) return files;
  const file = files[from];
  const out = [...files];
  if (from < videos.length) out[from] = placeholderFor(videos[from], file.type);
  else out.splice(from, 1);
  while (out.length <= row) out.push(placeholderFor(videos[out.length], file.type));
  const displaced = out[row];
  out[row] = file;
  if (displaced && !isPlaceholder(displaced)) {
    if (from < videos.length) out[from] = displaced;
    else out.push(displaced);
  }
  return out;
}

/** A row moved by hand while pairing by episode: the file goes to that video
 *  and stays (a hand link), and the file it displaces takes its old video,
 *  pinned there too. Rows past the last video cannot be moved to. */
export function moveByHand(files: ExternalFile[], from: number, to: number, videos: VideoFile[]): ExternalFile[] {
  const file = files[from];
  if (!file || isPlaceholder(file) || to < 0 || to >= videos.length || from === to) return files;
  const displaced = files[to] && !isPlaceholder(files[to]) ? files[to] : undefined;
  const moved = moveToRow(files, file.id, to, videos);
  return moved.map((entry, row) => {
    if (entry.id === file.id) return { ...entry, matchedVideoId: videos[to].id, isManuallyLinked: true };
    if (displaced && entry.id === displaced.id && row < videos.length) return { ...entry, matchedVideoId: videos[row].id, isManuallyLinked: true };
    if (displaced && entry.id === displaced.id) return { ...entry, matchedVideoId: undefined, isManuallyLinked: false };
    return entry;
  });
}

/** Back to pairing by row: the empty rows go, every file keeps its place
 *  relative to the others. */
export function dropPlaceholders(files: ExternalFile[]): ExternalFile[] {
  return realFiles(files);
}

// ------------------------------------------------------------ match by audio

/** One file to listen for, and the videos it may be. */
export interface AudioMatchJob {
  file: ExternalFile;
  videos: VideoFile[];
}

/** The files Match by audio listens to -- past the last video, or in a
 *  conflict -- each with the videos it might belong to: the ones with no
 *  file, its own row's when it is in one, and for a second file of an
 *  episode that episode's video (the name may be right and the other file's
 *  wrong, so the file holding it is listened to as well). Only videos within
 *  10 % of the file's length are tried. */
export function audioMatchJobs(files: ExternalFile[], videos: VideoFile[], report: PairingReport): AudioMatchJob[] {
  const conflictByFile = new Map(report.conflicts.map((conflict) => [conflict.fileId, conflict] as const));
  const free = videos.filter((_, row) => !files[row] || isPlaceholder(files[row]));
  const candidates = new Map<string, Set<VideoFile>>();
  const add = (file: ExternalFile, list: VideoFile[]) => {
    const set = candidates.get(file.id) ?? new Set<VideoFile>();
    list.forEach((video) => set.add(video));
    candidates.set(file.id, set);
  };
  files.forEach((file, row) => {
    if (isPlaceholder(file) || !file.path) return;
    const conflict = conflictByFile.get(file.id);
    if (row < videos.length && !conflict) return;
    const own = row < videos.length ? [videos[row]] : [];
    const contested = conflict?.otherRow !== undefined && videos[conflict.otherRow] ? [videos[conflict.otherRow]] : [];
    add(file, [...own, ...contested, ...free]);
    const holder = conflict?.otherRow !== undefined ? files[conflict.otherRow] : undefined;
    if (holder && !isPlaceholder(holder) && holder.path) add(holder, [...contested, ...free]);
  });
  const jobs: AudioMatchJob[] = [];
  for (const file of files) {
    const set = candidates.get(file.id);
    if (!set) continue;
    const near = [...set].filter((video) => {
      const gap = durationGap(file, video);
      return gap === null || gap <= AUDIO_MATCH_DURATION;
    });
    if (near.length > 0) jobs.push({ file, videos: near });
  }
  return jobs;
}

export interface AudioMatchResult {
  fileId: string;
  videoId: string;
  confidence: number;
}

/** Best confidence first, each file and each video used once, nothing under
 *  the minimum. */
export function assignByAudio(results: AudioMatchResult[], min = AUDIO_MATCH_MIN): AudioMatchResult[] {
  const usedFiles = new Set<string>();
  const usedVideos = new Set<string>();
  const out: AudioMatchResult[] = [];
  for (const result of [...results].sort((a, b) => b.confidence - a.confidence)) {
    if (!(result.confidence >= min) || usedFiles.has(result.fileId) || usedVideos.has(result.videoId)) continue;
    usedFiles.add(result.fileId);
    usedVideos.add(result.videoId);
    out.push(result);
  }
  return out;
}

/** The list with each heard file beside its video, pinned there by its match. */
export function applyAudioMatches(files: ExternalFile[], videos: VideoFile[], matches: AudioMatchResult[]): ExternalFile[] {
  let out = files;
  for (const match of matches) {
    const row = videos.findIndex((video) => video.id === match.videoId);
    if (row < 0) continue;
    out = moveToRow(out, match.fileId, row, videos).map((file) =>
      file.id === match.fileId ? { ...file, matchedVideoId: match.videoId, isManuallyLinked: false, audioMatch: { videoId: match.videoId, confidence: match.confidence } } : file,
    );
  }
  return out;
}

/** The method and confidence in a word or two, for the Match column. */
export function pairLabel(info: PairInfo): string {
  switch (info.method) {
    case "hand":
      return "By hand";
    case "audio":
      return `Audio ${Math.round(info.confidence * 100)}%`;
    case "episode":
      return "Episode";
    default:
      return "Order";
  }
}
