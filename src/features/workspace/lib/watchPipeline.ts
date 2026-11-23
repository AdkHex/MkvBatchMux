/** Watch folders, the frontend half: what happens to new episodes once the
 *  watcher (src-tauri/src/watch.rs) reports them.
 *
 *  Kept small on purpose: a queue of arrived videos and one run at a time.
 *  The reducer here is the whole state machine (idle → loading → measuring →
 *  conforming → muxing → idle, any step skipped when there is nothing for it); the steps of a run are plain functions over the workspace
 *  lists, so both can be tested without a backend. The hook that drives them
 *  is `hooks/useWatchPipeline.ts`.
 *
 *  A run never starts while anything else holds the engine (a batch, a
 *  measurement, a validation), and nothing is muxed that would need a look
 *  first: an episode whose dub hasn't arrived yet, whose measured delay the
 *  recipe doesn't apply on its own, whose different-cut dub wasn't conformed
 *  and verified, or that couldn't be read stays in the queue for the user and
 *  is named in the report. */

import { buildStrictVideoMatcher } from "@/features/workspace/lib/muxJobBuilder";
import { defaultPairBy, pairByEpisode } from "@/features/workspace/lib/smartPairing";
import { delaySecondsOrZero } from "@/shared/lib/delayInput";
import { linkExternalFilesByOrder, placeholderFor, realFiles } from "@/shared/lib/matchUtils";
import type { ExternalFile, VideoFile } from "@/shared/types";
import type { ConformResultEvent } from "@/shared/types/engineFeatures";
import type { Recipe, SlotTemplate, WatchFolderConfig } from "@/shared/types/recipes";
import { checkSummary } from "./conform";
import { DEFAULT_SLOT } from "./recipes";

// ---------------------------------------------------------------- state machine

export type PipelinePhase = "idle" | "loading" | "measuring" | "conforming" | "muxing";

export interface QueuedVideo {
  watchId: string;
  path: string;
}

export interface PipelineState {
  phase: PipelinePhase;
  /** Videos waiting for their run, in arrival order. */
  queue: QueuedVideo[];
  /** The run in progress. */
  current: { watchId: string; paths: string[]; detail: string } | null;
}

export type PipelineAction =
  | { type: "arrive"; watchId: string; paths: string[] }
  /** Take every queued video of the first watch in the queue. */
  | { type: "begin" }
  | { type: "step"; phase: Exclude<PipelinePhase, "idle">; detail: string }
  | { type: "finish" }
  /** A watch stopped or removed: what it queued goes too. */
  | { type: "forget"; watchId: string };

export const INITIAL_PIPELINE: PipelineState = { phase: "idle", queue: [], current: null };

/** Paths compare as Windows does: case doesn't matter, nor the separator. */
export const samePath = (a: string, b: string) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

export function pipelineReducer(state: PipelineState, action: PipelineAction): PipelineState {
  switch (action.type) {
    case "arrive": {
      const known = [...state.queue.map((item) => item.path), ...(state.current?.paths ?? [])];
      const fresh = action.paths.filter((path, index) => path && !known.some((other) => samePath(other, path)) && action.paths.findIndex((other) => samePath(other, path)) === index);
      if (fresh.length === 0) return state;
      return { ...state, queue: [...state.queue, ...fresh.map((path) => ({ watchId: action.watchId, path }))] };
    }
    case "begin": {
      if (state.phase !== "idle" || state.queue.length === 0) return state;
      const watchId = state.queue[0].watchId;
      const paths = state.queue.filter((item) => item.watchId === watchId).map((item) => item.path);
      return {
        phase: "loading",
        queue: state.queue.filter((item) => item.watchId !== watchId),
        current: { watchId, paths, detail: `Reading ${paths.length} new video${paths.length === 1 ? "" : "s"}` },
      };
    }
    case "step":
      return state.current ? { ...state, phase: action.phase, current: { ...state.current, detail: action.detail } } : state;
    case "finish":
      return { ...state, phase: "idle", current: null };
    case "forget": {
      const queue = state.queue.filter((item) => item.watchId !== action.watchId);
      return queue.length === state.queue.length ? state : { ...state, queue };
    }
  }
}

/** Whether a run can start now: something waits, nothing runs, and the app is idle. */
export const canBegin = (state: PipelineState, idle: boolean) => idle && state.phase === "idle" && state.queue.length > 0;

// ---------------------------------------------------------------- the app's own files

/** Files the app itself writes, which a watch folder must never take for a
 *  new episode: an output kept because it failed verification, mkvmerge's
 *  temporary file while muxing in place (`<stem>#<nanos>-<n>.mkv`), and the
 *  backup of a source being replaced. */
export function isWorkFile(path: string): boolean {
  const name = path.replace(/^.*[\\/]/, "").toLowerCase();
  return name.endsWith(".unverified.mkv") || /#\d+-\d+\.mkv$/i.test(name) || name.includes(".mkvbatchmux-backup-");
}

/** Where a path is kept in `OutputRegistry`: its folder and stem, any case,
 *  either separator, without ".mkv" and without a CRC the mux added ("Name [1A2B3C4D]"). */
export function outputKey(path: string): string {
  return path
    .replace(/\//g, "\\")
    .toLowerCase()
    .replace(/\.mkv$/, "")
    .replace(/ \[[0-9a-f]{8}\]$/, "");
}

/** The outputs this app wrote (or is writing) this session. Muxing in place,
 *  or into the watched folder itself, puts a "new" file there; it must not
 *  come back as an episode, or the app would mux its own output again, and
 *  again. */
export class OutputRegistry {
  private keys = new Set<string>();
  /** A job's output, from where it goes and what it is called. */
  add(folder: string, stem: string) {
    const dir = folder.replace(/[\\/]+$/, "");
    this.keys.add(outputKey(`${dir}\\${stem}.mkv`));
  }
  has(path: string) {
    return this.keys.has(outputKey(path));
  }
  get size() {
    return this.keys.size;
  }
}

/** The reported paths worth queueing: not the app's own work files or
 *  outputs, and still there (`exists` in the same order; a file gone between
 *  the report and now was a temporary one). */
export function arrivalsToQueue(paths: string[], exists: boolean[], isOwnOutput: (path: string) => boolean = () => false): { queue: string[]; ignored: { path: string; reason: string }[] } {
  const queue: string[] = [];
  const ignored: { path: string; reason: string }[] = [];
  paths.forEach((path, index) => {
    if (isWorkFile(path)) ignored.push({ path, reason: "a file the mux writes while working" });
    else if (isOwnOutput(path)) ignored.push({ path, reason: "an output of this app" });
    else if (exists[index] === false) ignored.push({ path, reason: "gone again" });
    else queue.push(path);
  });
  return { queue, ignored };
}

// ---------------------------------------------------------------- the workspace lists

/** The parts of the workspace a run reads and changes. */
export interface WorkspaceLists {
  videoFiles: VideoFile[];
  audioFilesByTrack: Record<string, ExternalFile[]>;
  subtitleFilesByTrack: Record<string, ExternalFile[]>;
  chapterFiles: ExternalFile[];
  audioTracks: string[];
  audioTrackConfigs: Record<string, SlotTemplate>;
  subtitleTracks: string[];
  subtitleTrackConfigs: Record<string, SlotTemplate>;
}

/** Why an episode wasn't muxed. */
export interface EpisodeNote {
  /** The video's file name. */
  name: string;
  reason: string;
}

const fileName = (path: string) => path.replace(/^.*[\\/]/, "");

/** New videos as read, minus those already loaded and those that couldn't be
 *  read; ids made unique against the loaded ones. */
export function admitVideos(paths: string[], inspected: VideoFile[], loaded: VideoFile[]) {
  const skipped: EpisodeNote[] = [];
  const failed: EpisodeNote[] = [];
  const videos: VideoFile[] = [];
  const ids = new Set(loaded.map((video) => video.id));
  for (const path of paths) {
    const name = fileName(path);
    if (loaded.some((video) => samePath(video.path, path))) {
      skipped.push({ name, reason: "Already in the queue" });
      continue;
    }
    const video = inspected.find((item) => samePath(item.path, path));
    if (!video || video.status === "error") {
      failed.push({ name, reason: "Couldn't be read" });
      continue;
    }
    let id = video.id || path;
    while (ids.has(id)) id = `${id}~`;
    ids.add(id);
    videos.push({ ...video, id, status: "pending" });
  }
  return { videos, skipped, failed };
}

/** The slot templates a run fills, each with the folder its files come from:
 *  the recipe's slots, the watch's own folder standing in for the first
 *  one's. Slots without a folder are left out. */
export function slotSources(recipe: Recipe | null, watchFolder: string, fallback: SlotTemplate | undefined, kind: "audio" | "subtitle") {
  const templates = recipe ? (kind === "audio" ? recipe.audioSlots : recipe.subtitleSlots) : [];
  const list = templates.length ? templates : watchFolder ? [fallback ?? DEFAULT_SLOT] : [];
  return list
    .map((template, index) => ({ index, template, folder: (index === 0 && watchFolder.trim()) || template.sourceFolder.trim() }))
    .filter((source) => source.folder);
}

const trackIds = (file: ExternalFile, type: "audio" | "subtitle") =>
  (file.tracks ?? []).filter((track) => track.type === type).map((track) => Number(track.id)).filter((id) => Number.isFinite(id));

/** A scanned file as a slot's row, with the slot's settings, as the Audio and
 *  Subtitles pages stamp them. */
export function fromTemplate(file: ExternalFile, template: SlotTemplate, type: ExternalFile["type"]): ExternalFile {
  const base: ExternalFile = {
    ...file,
    type,
    language: template.language,
    trackName: template.trackName,
    delay: delaySecondsOrZero(template.delay),
    isDefault: template.isDefault,
    isForced: template.isForced,
    muxAfter: template.muxAfter,
    trackOverrides: file.trackOverrides ?? {},
  };
  if (type === "audio") {
    const subtitles = trackIds(file, "subtitle");
    return {
      ...base,
      includedTrackIds: file.tracks?.length ? trackIds(file, "audio") : file.includedTrackIds,
      includeSubtitles: subtitles.length > 0,
      includedSubtitleTrackIds: file.includedSubtitleTrackIds?.length ? file.includedSubtitleTrackIds : subtitles,
    };
  }
  return base;
}

/** The scanned files that belong to one of the new videos (by episode, or by
 *  name), leaving out any already in the list. */
export function filesForNewVideos(scanned: ExternalFile[], newVideos: VideoFile[], allVideos: VideoFile[], existing: ExternalFile[]): ExternalFile[] {
  const newIds = new Set(newVideos.map((video) => video.id));
  const { resolve } = buildStrictVideoMatcher(allVideos);
  return scanned.filter((file) => {
    if (existing.some((other) => !other.placeholder && samePath(other.path, file.path))) return false;
    const videoId = resolve({ ...file, matchedVideoId: undefined });
    return videoId !== undefined && newIds.has(videoId);
  });
}

/** A slot's list with new files placed beside their videos, the way the page
 *  would pair it: by episode when names read, otherwise by row, with empty
 *  rows padding the list out to the videos that came before. */
export function placeFiles(list: ExternalFile[], added: ExternalFile[], videos: VideoFile[], previousVideoCount: number, type: ExternalFile["type"]): ExternalFile[] {
  if (added.length === 0) return list;
  const merged = [...list, ...added];
  if (defaultPairBy(merged, videos) === "episode") return pairByEpisode(merged, videos).files;
  // By row: everything up to the old videos keeps its place; the new files
  // follow in the new videos' order.
  const head = list.slice(0, previousVideoCount);
  while (head.length < previousVideoCount && head.length < videos.length) head.push(placeholderFor(videos[head.length], type));
  const { resolve } = buildStrictVideoMatcher(videos);
  const rows = videos.slice(previousVideoCount).map((video) => added.find((file) => resolve({ ...file, matchedVideoId: undefined }) === video.id) ?? placeholderFor(video, type));
  const extras = [...list.slice(previousVideoCount), ...added.filter((file) => !rows.includes(file))];
  return linkExternalFilesByOrder([...head, ...rows, ...extras], videos);
}

/** The slot id a recipe's nth slot fills: the workspace's nth, or a new one. */
export function slotIdFor(index: number, tracks: string[]): { id: string; created: boolean } {
  if (index < tracks.length) return { id: tracks[index], created: false };
  const next = Math.max(0, ...tracks.map((id) => Number(id)).filter(Number.isFinite)) + 1 + (index - tracks.length);
  return { id: String(next), created: true };
}

/** Which of the new videos have no file in a slot that should hold one. */
export function videosWithoutFile(newVideos: VideoFile[], list: ExternalFile[]): VideoFile[] {
  const real = realFiles(list);
  return newVideos.filter((video) => !real.some((file) => file.matchedVideoId === video.id));
}

/** The watch's video extensions as the watcher wants them: none means every video type. */
export function watchExtensions(config: Pick<WatchFolderConfig, "videoExtensions">, all: readonly string[]): string[] {
  return config.videoExtensions.length ? config.videoExtensions : [...all];
}

// ---------------------------------------------------------------- conforming

/** Why a dub the recipe conforms keeps its episode from the mux, after the
 *  run: null only for a conformed dub the engine checked and passed. Anything
 *  less (failed, checked and out, not checkable, stopped, no result) is the
 *  user's call, so the episode waits. Lower case: it follows "Different cut
 *  in Audio N: ". */
export function conformVerdict(result: ConformResultEvent | undefined, run: { cancelled: boolean; error: string | null }): string | null {
  if (!result) {
    if (run.cancelled) return "conforming was stopped";
    if (run.error) return `not conformed: ${run.error}`;
    return "the engine sent no conform result for it";
  }
  if (result.error || !result.outputPath) return `conforming failed: ${result.error ?? "nothing was written"}`;
  if (result.verified === true) return null;
  const check = result.verificationText?.trim() ? ` ${checkSummary(result.verificationText)}` : "";
  return result.verified === false ? `conformed, but the check failed.${check}` : `conformed, but it couldn't be checked.${check}`;
}
