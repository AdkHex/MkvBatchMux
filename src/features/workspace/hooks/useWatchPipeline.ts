/** Drives watch folders: new videos reported by the watcher are queued, and
 *  when the app is idle each watch's arrivals run through its recipe — read,
 *  paired with their dubs, subtitles and chapters, measured, dubs of another
 *  cut conformed when the recipe says so, muxed — then
 *  reported in History and a toast.
 *
 *  The state machine and the workspace steps are in `lib/watchPipeline.ts`;
 *  this file is the I/O around them. `runWatchEpisode` takes everything it
 *  touches as `WatchIO`, so a test can drive a whole run with fakes. */

import { useCallback, useEffect, useReducer, useRef } from "react";

import { applyMeasurement } from "@/features/workspace/lib/applyMeasurement";
import { applyConformResult, buildConformPlan, type PlannedConform } from "@/features/workspace/lib/conform";
import { buildMeasurementPlan, isSameTrack, parseMeasurementKey, sameTrackResult } from "@/features/workspace/lib/measurePairs";
import { applyMeasurementPolicy, applyTrackRulesToAll } from "@/features/workspace/lib/recipes";
import {
  INITIAL_PIPELINE,
  admitVideos,
  arrivalsToQueue,
  canBegin,
  conformVerdict,
  filesForNewVideos,
  fromTemplate,
  pipelineReducer,
  placeFiles,
  slotIdFor,
  slotSources,
  videosWithoutFile,
  type EpisodeNote,
  type PipelinePhase,
  type PipelineState,
  type WorkspaceLists,
} from "@/features/workspace/lib/watchPipeline";
import {
  audiosyncEngineStatus,
  inspectPaths,
  listenMeasureDelaysDone,
  listenMeasureDelaysResult,
  measureDelaysStart,
  scanMedia,
  type ScanRequest,
} from "@/shared/lib/backend";
import { conformDubsStart, listenConformDone, listenConformResult } from "@/shared/lib/engineFeatures";
import { listenWatchFiles, pathsExist } from "@/shared/lib/workspaceStore";
import type { ExternalFile, MeasurementSettings, MuxJob, VideoFile } from "@/shared/types";
import { ENGINE_DEFAULTS, engineWindowCount } from "@/shared/types/audiosync";
import type { ConformResultEvent } from "@/shared/types/engineFeatures";
import type { Recipe, WatchFolderConfig } from "@/shared/types/recipes";

import { buildConformRequest } from "./useConform";

/** What a run did, for the toast and History. */
export interface EpisodeReport {
  watchId: string;
  /** Videos added to the workspace. */
  loaded: VideoFile[];
  /** Muxed (or tried): the jobs as the batch left them. */
  muxed: MuxJob[];
  /** Left for the user, with why: no dub yet, a delay to review. */
  review: EpisodeNote[];
  /** Couldn't be read, or a step failed. */
  failed: EpisodeNote[];
  /** Already loaded; nothing done. */
  skipped: EpisodeNote[];
}

/** What conforming a slot's dubs did: the files with their conformed tracks
 *  on them, the ones that may be muxed, and why each other one may not. */
export interface WatchConformOutcome {
  files: ExternalFile[];
  /** File ids conformed and verified by the engine. */
  verified: string[];
  /** File id → why it wasn't (lower case, after "Different cut in Audio N: "). */
  holds: Record<string, string>;
}

/** Everything a run reads and changes. */
export interface WatchIO {
  /** The workspace as it is now. */
  read: () => WorkspaceLists;
  /** Change the workspace; later reads see the change at once. */
  commit: (change: (lists: WorkspaceLists) => WorkspaceLists) => void;
  inspectVideos: (paths: string[]) => Promise<VideoFile[]>;
  scanFolder: (request: ScanRequest) => Promise<ExternalFile[]>;
  /** Measure `files` against their videos; the files with the results on them. */
  measure: (videos: VideoFile[], files: ExternalFile[]) => Promise<{ files: ExternalFile[]; error: string | null }>;
  /** Conform these dubs of another cut onto their videos. Without it, they wait for the user. */
  conform?: (videos: VideoFile[], files: ExternalFile[]) => Promise<WatchConformOutcome>;
  /** Mux these videos' jobs with the recipe's settings; resolves with the jobs once the batch ends. */
  mux: (videoIds: string[], recipe: Recipe) => Promise<MuxJob[]>;
  step: (phase: Exclude<PipelinePhase, "idle">, detail: string) => void;
  log: (line: string) => void;
  /** Lets the app render between steps (the queue picks the new videos up). */
  settle?: () => Promise<void>;
}

const nameOf = (path: string) => path.replace(/^.*[\\/]/, "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const message = (error: unknown) => (typeof error === "string" ? error : error instanceof Error ? error.message : String(error));

/** One run: the arrivals of one watch, through its recipe. Never throws: a
 *  step that fails stops the episodes it concerns and says so in the report. */
export async function runWatchEpisode(
  { config, recipe, paths }: { config: WatchFolderConfig; recipe: Recipe | null; paths: string[] },
  io: WatchIO,
): Promise<EpisodeReport> {
  const report: EpisodeReport = { watchId: config.id, loaded: [], muxed: [], review: [], failed: [], skipped: [] };
  if (!recipe) {
    report.failed = paths.map((path) => ({ name: nameOf(path), reason: "Its watch folder has no recipe (it was deleted?)" }));
    return report;
  }

  // ---- read the videos
  let inspected: VideoFile[];
  try {
    inspected = await io.inspectVideos(paths);
  } catch (error) {
    report.failed = paths.map((path) => ({ name: nameOf(path), reason: `Couldn't be read: ${message(error)}` }));
    return report;
  }
  const admitted = admitVideos(paths, inspected, io.read().videoFiles);
  report.skipped = admitted.skipped;
  report.failed.push(...admitted.failed);
  if (admitted.videos.length === 0) return report;
  const { files: newVideos } = applyTrackRulesToAll(admitted.videos, recipe.trackRules);
  report.loaded = newVideos;
  const held = new Map<string, string>();
  const hold = (video: VideoFile, reason: string) => {
    if (!held.has(video.id)) held.set(video.id, reason);
  };

  // ---- find their files, before anything lands in the workspace, so a
  // folder that can't be read stops the episodes cleanly.
  const before = io.read();
  const allVideos = [...before.videoFiles, ...newVideos];
  type Placement = { kind: "audio" | "subtitle"; slot: string; created: boolean; template: ReturnType<typeof slotSources>[number]["template"]; folder: string; files: ExternalFile[] };
  const placements: Placement[] = [];
  for (const kind of ["audio", "subtitle"] as const) {
    const tracks = kind === "audio" ? before.audioTracks : before.subtitleTracks;
    const configs = kind === "audio" ? before.audioTrackConfigs : before.subtitleTrackConfigs;
    const byTrack = kind === "audio" ? before.audioFilesByTrack : before.subtitleFilesByTrack;
    const folder = kind === "audio" ? config.audioFolder : config.subtitleFolder;
    for (const source of slotSources(recipe, folder, tracks[0] ? configs[tracks[0]] : undefined, kind)) {
      const { id, created } = slotIdFor(source.index, tracks);
      const existing = byTrack[id] ?? [];
      // A slot with files keeps the settings they were stamped with; an empty
      // one takes the recipe's, so the page shows what the files carry.
      const template = !created && existing.some((file) => !file.placeholder) && configs[id] ? configs[id] : source.template;
      try {
        const scanned = await io.scanFolder({ folder: source.folder, extensions: template.extension === "all" ? [] : [template.extension], recursive: false, type: kind, include_tracks: true });
        const files = filesForNewVideos(scanned, newVideos, allVideos, existing).map((file) => fromTemplate(file, template, kind));
        placements.push({ kind, slot: id, created, template: { ...template, sourceFolder: source.folder }, folder: source.folder, files });
      } catch (error) {
        const reason = `Couldn't read ${source.folder}: ${message(error)}`;
        newVideos.forEach((video) => hold(video, reason));
        io.log(`Watch: ${reason}`);
      }
    }
  }
  let chapters: ExternalFile[] = [];
  if (config.chapterFolder.trim()) {
    try {
      const scanned = await io.scanFolder({ folder: config.chapterFolder.trim(), extensions: [], recursive: false, type: "chapter", include_tracks: false });
      chapters = filesForNewVideos(scanned, newVideos, allVideos, before.chapterFiles).map((file) => ({ ...file, type: "chapter" as const }));
    } catch (error) {
      io.log(`Watch: couldn't read ${config.chapterFolder}: ${message(error)}`);
    }
  }

  // ---- into the workspace: the videos at the end of the list, their files beside them.
  io.commit((lists) => {
    const previousCount = lists.videoFiles.length;
    const videos = [...lists.videoFiles, ...newVideos];
    const next: WorkspaceLists = {
      ...lists,
      videoFiles: videos,
      audioFilesByTrack: { ...lists.audioFilesByTrack },
      subtitleFilesByTrack: { ...lists.subtitleFilesByTrack },
      audioTracks: [...lists.audioTracks],
      subtitleTracks: [...lists.subtitleTracks],
      audioTrackConfigs: { ...lists.audioTrackConfigs },
      subtitleTrackConfigs: { ...lists.subtitleTrackConfigs },
    };
    for (const placement of placements) {
      const byTrack = placement.kind === "audio" ? next.audioFilesByTrack : next.subtitleFilesByTrack;
      const tracks = placement.kind === "audio" ? next.audioTracks : next.subtitleTracks;
      const configs = placement.kind === "audio" ? next.audioTrackConfigs : next.subtitleTrackConfigs;
      const list = byTrack[placement.slot] ?? [];
      if (!tracks.includes(placement.slot)) tracks.push(placement.slot);
      if (placement.created || !list.some((file) => !file.placeholder)) configs[placement.slot] = { ...placement.template };
      byTrack[placement.slot] = placeFiles(list, placement.files, videos, previousCount, placement.kind);
    }
    if (chapters.length) next.chapterFiles = placeFiles(lists.chapterFiles, chapters, videos, previousCount, "chapter");
    return next;
  });
  io.log(`Watch: added ${newVideos.map((video) => video.name).join(", ")}`);

  // Every slot that has a folder must have its file: a dub that hasn't arrived yet is waited for, not left out.
  for (const placement of placements) {
    const list = (placement.kind === "audio" ? io.read().audioFilesByTrack : io.read().subtitleFilesByTrack)[placement.slot] ?? [];
    const label = `${placement.kind === "audio" ? "Audio" : "Subtitles"} ${placement.slot}`;
    for (const video of videosWithoutFile(newVideos, list)) hold(video, `No file for it yet in ${label} (${placement.folder})`);
  }
  await io.settle?.();

  // ---- measure, and apply what the recipe's policy applies on its own.
  const policy = recipe.measurement;
  const audioPlacements = placements.filter((placement) => placement.kind === "audio" && placement.files.length > 0);
  if (policy.autoMeasure && audioPlacements.length > 0) {
    const toMeasure = audioPlacements.flatMap((placement) => placement.files.filter((file) => !held.has(file.matchedVideoId ?? "")));
    if (toMeasure.length > 0) io.step("measuring", `Measuring ${plural(toMeasure.length, "dub")}`);
    let conformedBefore = false;
    for (const placement of audioPlacements) {
      const ids = new Set(placement.files.map((file) => file.id));
      const current = () => (io.read().audioFilesByTrack[placement.slot] ?? []).filter((file) => ids.has(file.id));
      const files = current().filter((file) => !held.has(file.matchedVideoId ?? ""));
      if (files.length === 0) continue;
      // Back from conforming the slot before: the status says measuring again.
      if (conformedBefore) io.step("measuring", `Measuring ${plural(files.length, "dub")} in Audio ${placement.slot}`);
      conformedBefore = false;
      const measured = await io.measure(io.read().videoFiles, files);
      const { files: applied, plan } = applyMeasurementPolicy(measured.files, policy);
      const byId = new Map(applied.map((file) => [file.id, file] as const));
      io.commit((lists) => ({
        ...lists,
        audioFilesByTrack: { ...lists.audioFilesByTrack, [placement.slot]: (lists.audioFilesByTrack[placement.slot] ?? []).map((file) => byId.get(file.id) ?? file) },
      }));
      const videoOf = (fileId: string) => newVideos.find((video) => video.id === byId.get(fileId)?.matchedVideoId);
      if (measured.error) files.forEach((file) => { const video = videoOf(file.id); if (video) hold(video, `Not measured: ${measured.error}`); });
      for (const item of plan.review) {
        const video = videoOf(item.fileId);
        if (video) hold(video, `Delay to review in Audio ${placement.slot}: ${item.reason}`);
      }
      // Dubs of another cut the recipe conforms, unless their episode waits anyway.
      const conformIds = plan.conform.filter((fileId) => {
        const video = videoOf(fileId);
        return video !== undefined && !held.has(video.id);
      });
      if (conformIds.length > 0 && !io.conform) {
        conformIds.forEach((fileId) => hold(videoOf(fileId)!, `Different cut in Audio ${placement.slot}: conform it on the Audio page`));
      } else if (conformIds.length > 0 && io.conform) {
        io.step("conforming", `Conforming ${plural(conformIds.length, "dub")} to a different cut`);
        conformedBefore = true;
        const targets = current().filter((file) => conformIds.includes(file.id));
        let outcome: WatchConformOutcome;
        try {
          outcome = await io.conform(io.read().videoFiles, targets);
        } catch (error) {
          outcome = { files: targets, verified: [], holds: Object.fromEntries(conformIds.map((fileId) => [fileId, `not conformed: ${message(error)}`])) };
        }
        const conformed = new Map(outcome.files.map((file) => [file.id, file] as const));
        io.commit((lists) => ({
          ...lists,
          audioFilesByTrack: { ...lists.audioFilesByTrack, [placement.slot]: (lists.audioFilesByTrack[placement.slot] ?? []).map((file) => conformed.get(file.id) ?? file) },
        }));
        // Only a conformed dub the engine checked and passed is muxed.
        for (const fileId of conformIds) {
          if (outcome.verified.includes(fileId)) continue;
          hold(videoOf(fileId)!, `Different cut in Audio ${placement.slot}: ${outcome.holds[fileId] ?? "not conformed"}`);
        }
        const done = conformIds.filter((fileId) => outcome.verified.includes(fileId)).length;
        io.log(`Watch: conformed ${done} of ${plural(conformIds.length, "dub")} in Audio ${placement.slot}${done < conformIds.length ? "; the rest wait for you" : ""}`);
      }
      // A file the policy neither applied nor flagged was never measured (no
      // video to measure against): its delay is unknown.
      for (const file of applied) {
        const video = videoOf(file.id);
        if (video && !file.measuredDelay && !Object.values(file.trackOverrides ?? {}).some((override) => override.measuredDelay)) hold(video, `Not measured in Audio ${placement.slot}`);
      }
    }
  }

  // ---- mux what is ready
  for (const video of newVideos) {
    const reason = held.get(video.id);
    if (reason) report.review.push({ name: video.name, reason });
  }
  const ready = newVideos.filter((video) => !held.has(video.id));
  if (ready.length === 0) return report;
  io.step("muxing", `Muxing ${plural(ready.length, "new episode")}`);
  try {
    report.muxed = await io.mux(ready.map((video) => video.id), recipe);
  } catch (error) {
    report.failed.push(...ready.map((video) => ({ name: video.name, reason: `Couldn't start muxing: ${message(error)}` })));
  }
  return report;
}

// ---------------------------------------------------------------- engine measurement

/** One measurement pass over `files`, results written to them as the Audio
 *  page writes them (pending, for the policy to apply or leave). No wider
 *  second pass and no timeline scan: what one pass can't place is left for
 *  the user. */
export async function measureWithEngine(videos: VideoFile[], files: ExternalFile[], measurement?: MeasurementSettings): Promise<{ files: ExternalFile[]; error: string | null }> {
  try {
    const engine = await audiosyncEngineStatus();
    if (!engine.engineAvailable || !engine.ffmpegAvailable) return { files, error: engine.message ?? "the audio analysis engine isn't available" };
  } catch {
    return { files, error: "the audio analysis engine couldn't be reached" };
  }
  const plan = buildMeasurementPlan({ videoFiles: videos, audioFiles: files, referenceTrackByVideoId: {} });
  let current = files;
  const write = (key: string | null, result: Parameters<typeof applyMeasurement>[0]["result"]) => {
    const planned = plan.measurements.find((m) => m.pair.key === key);
    if (!planned) return;
    const { audioFileId, trackId } = parseMeasurementKey(planned.pair.key);
    const measuredAt = new Date().toISOString();
    current = current.map((file) => (file.id === audioFileId ? applyMeasurement({ file, result, trackId, referenceTrack: planned.pair.primaryTrack, measuredAt }) : file));
  };
  for (const m of plan.measurements.filter((m) => isSameTrack(m.pair))) write(m.pair.key, sameTrackResult(m.pair, videos.find((video) => video.id === m.videoId)?.fps));
  const pairs = plan.measurements.filter((m) => !isSameTrack(m.pair)).map((m) => m.pair);
  if (pairs.length === 0) return { files: current, error: null };

  const runId = `watch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return new Promise((resolve) => {
    const offs: Array<() => void> = [];
    let settled = false;
    const done = (error: string | null) => {
      if (settled) return;
      settled = true;
      offs.forEach((off) => off());
      resolve({ files: current, error });
    };
    void Promise.all([
      listenMeasureDelaysResult((payload) => payload.runId === runId && write(payload.key, payload.result)),
      listenMeasureDelaysDone((payload) => payload.runId === runId && done(payload.error ?? (payload.cancelled ? "the measurement was stopped" : null))),
    ])
      .then((unlisteners) => {
        offs.push(...unlisteners);
        if (settled) unlisteners.forEach((off) => off());
        return measureDelaysStart({
          runId,
          pairs,
          windowSeconds: measurement?.windowSeconds ?? ENGINE_DEFAULTS.windowSeconds,
          windowCount: engineWindowCount(measurement?.windowCount),
          maxOffsetMs: measurement?.maxOffsetMs ?? ENGINE_DEFAULTS.maxOffsetMs,
          maxWorkers: ENGINE_DEFAULTS.maxWorkers,
          findCuts: measurement?.cutCheck ?? true,
          fast: false,
          timeline: false,
        });
      })
      .catch((error) => done(message(error)));
  });
}

// ---------------------------------------------------------------- engine conforming

/** Conform `files` (dubs measured as another cut) onto their videos, as the
 *  Audio page's Conform does, with the user's settings from Preferences ›
 *  Measurement. Runs inside the watch run's own engine claim. Each result
 *  lands on its file as it comes, so a stopped run keeps what it finished;
 *  which files may be muxed is decided once the run ends (`conformVerdict`). */
export async function conformWithEngine(videos: VideoFile[], files: ExternalFile[], measurement?: MeasurementSettings): Promise<WatchConformOutcome> {
  const { planned, skipped } = buildConformPlan({ videoFiles: videos, files, fileIds: files.map((file) => file.id) });
  const holds: Record<string, string> = {};
  for (const { file, reason } of skipped) holds[file.id] = `can't be conformed. ${reason}`;
  if (planned.length === 0) return { files, verified: [], holds };

  const byKey = new Map<string, PlannedConform>(planned.map((entry) => [entry.pair.key, entry]));
  const results = new Map<string, ConformResultEvent>();
  let current = files;
  const runId = `watch-conform-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return new Promise((resolve) => {
    const offs: Array<() => void> = [];
    let settled = false;
    const done = (cancelled: boolean, error: string | null) => {
      if (settled) return;
      settled = true;
      offs.forEach((off) => off());
      const verified: string[] = [];
      for (const [key, entry] of byKey) {
        const verdict = conformVerdict(results.get(key), { cancelled, error });
        if (verdict === null) verified.push(entry.fileId);
        else holds[entry.fileId] = verdict;
      }
      resolve({ files: current, verified, holds });
    };
    void Promise.all([
      listenConformResult((payload) => {
        const entry = payload.runId === runId && payload.key ? byKey.get(payload.key) : undefined;
        if (!entry || settled) return;
        results.set(entry.pair.key, payload);
        current = current.map((file) => (file.id === entry.fileId ? applyConformResult(file, payload, entry) : file));
      }),
      listenConformDone((payload) => payload.runId === runId && done(payload.cancelled, payload.error)),
    ])
      .then((unlisteners) => {
        offs.push(...unlisteners);
        if (settled) unlisteners.forEach((off) => off());
        return conformDubsStart(buildConformRequest(planned, runId, measurement));
      })
      .catch((error) => done(false, message(error)));
  });
}

/** The backend calls a run makes, as `WatchIO` wants them. */
export const engineIO = (measurement?: MeasurementSettings): Pick<WatchIO, "inspectVideos" | "scanFolder" | "measure" | "conform"> => ({
  inspectVideos: async (paths) => (await inspectPaths({ paths, type: "video", include_tracks: true })) as VideoFile[],
  scanFolder: async (request) => (await scanMedia(request)) as ExternalFile[],
  measure: (videos, files) => measureWithEngine(videos, files, measurement),
  conform: (videos, files) => conformWithEngine(videos, files, measurement),
});

// ---------------------------------------------------------------- the hook

interface UseWatchPipelineInput {
  /** The watch folders that are on, by id. Files from any other are ignored. */
  watches: WatchFolderConfig[];
  recipes: Recipe[];
  /** Nothing else holds the engine and no batch runs. */
  idle: boolean;
  /** Take the engine for a run; false when something else got it first. */
  claim: () => boolean;
  release: () => void;
  /** The rest of the I/O; read through a ref, so it may change every render. */
  io: Omit<WatchIO, "step">;
  onReport: (report: EpisodeReport, config: WatchFolderConfig) => void;
  /** A path this app wrote as a mux output this session: never an episode. */
  isOwnOutput?: (path: string) => boolean;
}

export function useWatchPipeline({ watches, recipes, idle, claim, release, io, onReport, isOwnOutput }: UseWatchPipelineInput): PipelineState {
  const [state, dispatch] = useReducer(pipelineReducer, INITIAL_PIPELINE);
  const latest = useRef({ watches, recipes, io, onReport, claim, release, isOwnOutput });
  latest.current = { watches, recipes, io, onReport, claim, release, isOwnOutput };

  // New files from a watch that is on are queued; one turned off since takes its queue with it.
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void listenWatchFiles(async (payload) => {
      if (!latest.current.watches.some((watch) => watch.id === payload.id)) return;
      // The app's own files (a temporary output, a backup, a finished output
      // muxed into the watched folder) are not new episodes: taken for one,
      // the app would mux its own output again, and again.
      const exists = await pathsExist(payload.paths);
      const { queue, ignored } = arrivalsToQueue(payload.paths, exists, latest.current.isOwnOutput);
      const { log } = latest.current.io;
      for (const item of ignored) log(`Watch: left ${nameOf(item.path)} alone: ${item.reason}`);
      if (queue.length === 0) return;
      dispatch({ type: "arrive", watchId: payload.id, paths: queue });
      log(`Watch: ${plural(queue.length, "new file")} in ${latest.current.watches.find((watch) => watch.id === payload.id)?.videoFolder ?? payload.id}: ${queue.map(nameOf).join(", ")}`);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else off = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  const watchIds = watches.map((watch) => watch.id).join("\u0000");
  useEffect(() => {
    const live = new Set(watchIds.split("\u0000"));
    for (const item of state.queue) if (!live.has(item.watchId)) dispatch({ type: "forget", watchId: item.watchId });
  }, [watchIds, state.queue]);

  const running = useRef(false);
  const run = useCallback(async (current: NonNullable<PipelineState["current"]>) => {
    const { watches: list, recipes: all, io: base } = latest.current;
    const config = list.find((watch) => watch.id === current.watchId);
    try {
      if (!config) return;
      const recipe = all.find((item) => item.id === config.recipeId) ?? null;
      const report = await runWatchEpisode(
        { config, recipe, paths: current.paths },
        { ...latest.current.io, step: (phase, detail) => dispatch({ type: "step", phase, detail }) },
      );
      latest.current.onReport(report, config);
    } catch (error) {
      base.log(`Error: watch folder run failed: ${message(error)}`);
    } finally {
      latest.current.release();
      running.current = false;
      dispatch({ type: "finish" });
    }
  }, []);

  // Start a run when something waits and the app is idle; never over a batch or a measurement.
  useEffect(() => {
    if (running.current || !canBegin(state, idle)) return;
    if (!latest.current.claim()) return;
    running.current = true;
    const watchId = state.queue[0].watchId;
    const paths = state.queue.filter((item) => item.watchId === watchId).map((item) => item.path);
    dispatch({ type: "begin" });
    void run({ watchId, paths, detail: "" });
  }, [state, idle, run]);

  return state;
}
