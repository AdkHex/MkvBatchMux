/** Watch folders as the user set them up (store key `watch-folders`) and the
 *  state of their watchers. Off by default; at launch only the ones the user
 *  left on are started again. Pausing lasts until the app quits. */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  listenWatchStatus,
  readWatchFolders,
  watchList,
  watchRequestFor,
  watchSetPaused,
  watchStart,
  watchStop,
  writeWatchFolders,
} from "@/shared/lib/workspaceStore";
import { VIDEO_EXTENSIONS } from "@/shared/lib/extensions";
import type { WatchFolderConfig, WatchState, WatchStatusEvent } from "@/shared/types/recipes";

/** A failed call's message; null when it worked. (`strict` is off here, so `ok` alone doesn't narrow.) */
const failure = (result: { ok: boolean }): string | null => ("error" in result ? String((result as { error: unknown }).error) : null);

export interface WatchStatus {
  /** "off" when no watcher runs for it. */
  state: WatchState | "off";
  error: string | null;
}

export const DEFAULT_WATCH_EXTENSIONS = ["mkv", "mp4", "m4v", "avi", "mov", "ts", "m2ts", "webm"];
export const DEFAULT_WATCH_INTERVAL = 10;

let counter = 0;
export function newWatchFolder(): WatchFolderConfig {
  return {
    id: `watch-${Date.now().toString(36)}-${(counter++).toString(36)}`,
    enabled: false,
    recipeId: null,
    videoFolder: "",
    videoExtensions: [...DEFAULT_WATCH_EXTENSIONS],
    recursive: false,
    audioFolder: "",
    subtitleFolder: "",
    chapterFolder: "",
    intervalSeconds: DEFAULT_WATCH_INTERVAL,
  };
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : "");
const KNOWN_VIDEO = new Set<string>(VIDEO_EXTENSIONS);

/** The stored list, checked field by field; entries that aren't a watch folder are left out. */
export function parseWatchFolders(raw: unknown): WatchFolderConfig[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.folders) ? raw.folders : [];
  const seen = new Set<string>();
  const out: WatchFolderConfig[] = [];
  for (const item of list) {
    if (!isObj(item) || !str(item.id) || seen.has(str(item.id))) continue;
    seen.add(str(item.id));
    const extensions = Array.isArray(item.videoExtensions) ? item.videoExtensions.filter((ext): ext is string => typeof ext === "string" && KNOWN_VIDEO.has(ext.toLowerCase())) : [];
    const interval = typeof item.intervalSeconds === "number" && Number.isFinite(item.intervalSeconds) ? Math.min(3600, Math.max(1, item.intervalSeconds)) : DEFAULT_WATCH_INTERVAL;
    out.push({
      id: str(item.id),
      enabled: item.enabled === true,
      recipeId: str(item.recipeId) || null,
      videoFolder: str(item.videoFolder),
      videoExtensions: extensions.length ? extensions : [...DEFAULT_WATCH_EXTENSIONS],
      recursive: item.recursive === true,
      audioFolder: str(item.audioFolder),
      subtitleFolder: str(item.subtitleFolder),
      chapterFolder: str(item.chapterFolder),
      intervalSeconds: interval,
    });
  }
  return out;
}

/** What stops a watch folder from being turned on; null when it can be. */
export function watchProblem(config: WatchFolderConfig, recipeIds: string[]): string | null {
  if (!config.videoFolder.trim()) return "Choose the folder new episodes arrive in.";
  if (!config.recipeId || !recipeIds.includes(config.recipeId)) return "Choose the recipe its episodes are muxed with.";
  const own = config.videoFolder.trim().toLowerCase();
  if ([config.audioFolder, config.subtitleFolder, config.chapterFolder].some((folder) => folder.trim().toLowerCase() === own)) {
    return "The dub, subtitle and chapter folders must differ from the video folder.";
  }
  return null;
}

/** How long after (re)starting a watcher a "stopped" for its id is taken for
 *  the replaced watcher's last word, when the backend can't be asked. */
export const STALE_STOP_MS = 3000;

/** What a "stopped" status means: the watcher with that id is really off,
 *  or it was the one a restart replaced (its last word arrives after the new
 *  one started). The running watchers decide; without them, a stop right
 *  after a start is taken as stale. */
export async function resolveStopped(
  payload: WatchStatusEvent,
  { launchedAt, now = Date.now(), list = watchList }: { launchedAt?: number; now?: number; list?: typeof watchList },
): Promise<WatchStatus | null> {
  try {
    const running = (await list()).find((info) => info.id === payload.id);
    return running ? { state: running.state === "stopped" ? "off" : running.state, error: running.error } : { state: "off", error: payload.error };
  } catch {
    return launchedAt !== undefined && now - launchedAt < STALE_STOP_MS ? null : { state: "off", error: payload.error };
  }
}

export interface WatchFoldersState {
  folders: WatchFolderConfig[];
  status: Record<string, WatchStatus>;
  loaded: boolean;
  error: string | null;
  /** Add or replace one; a watch that is on restarts with its new settings. */
  save: (config: WatchFolderConfig) => Promise<string | null>;
  remove: (id: string) => Promise<string | null>;
  /** Turn on (and remember it is on). */
  start: (id: string) => Promise<string | null>;
  /** Turn off (and remember it is off). */
  stop: (id: string) => Promise<string | null>;
  setPaused: (id: string, paused: boolean) => Promise<void>;
}

export function useWatchFolders(enabled = true): WatchFoldersState {
  const [folders, setFolders] = useState<WatchFolderConfig[]>([]);
  const [status, setStatus] = useState<Record<string, WatchStatus>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<WatchFolderConfig[]>([]);
  /** When each id's watcher was last (re)started. */
  const launchedAt = useRef<Record<string, number>>({});

  const setState = useCallback((id: string, next: WatchStatus) => setStatus((prev) => (prev[id]?.state === next.state && prev[id]?.error === next.error ? prev : { ...prev, [id]: next })), []);

  const launch = useCallback(
    async (config: WatchFolderConfig) => {
      launchedAt.current[config.id] = Date.now();
      const result = await watchStart(watchRequestFor(config));
      if (result.ok) setState(config.id, { state: result.value.state, error: result.value.error });
      else setState(config.id, { state: "off", error: failure(result) });
      return failure(result);
    },
    [setState],
  );

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let off: (() => void) | undefined;
    void listenWatchStatus((payload) => {
      if (payload.state !== "stopped") {
        setState(payload.id, { state: payload.state, error: payload.error });
        return;
      }
      // A restart replaces the watcher under the same id, and the old one's
      // last word ("stopped") can arrive after the new one is running.
      void resolveStopped(payload, { launchedAt: launchedAt.current[payload.id] }).then((status) => status && !disposed && setState(payload.id, status));
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else off = unlisten;
      })
      .catch(() => undefined);
    void readWatchFolders().then(async (result) => {
      if (disposed) return;
      const list = result.ok ? parseWatchFolders(result.value) : [];
      if (!result.ok) setError(failure(result));
      current.current = list;
      setFolders(list);
      setLoaded(true);
      // Only what the user left on comes back on.
      for (const config of list) if (config.enabled && config.videoFolder) await launch(config);
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [enabled, launch, setState]);

  const write = useCallback(async (next: WatchFolderConfig[]) => {
    current.current = next;
    setFolders(next);
    const result = await writeWatchFolders(next);
    setError(failure(result));
    return failure(result);
  }, []);

  const save = useCallback(
    async (config: WatchFolderConfig) => {
      const list = current.current;
      const previous = list.find((item) => item.id === config.id);
      const next = previous ? list.map((item) => (item.id === config.id ? config : item)) : [...list, config];
      const saved = await write(next);
      if (config.enabled && JSON.stringify(previous) !== JSON.stringify(config)) return (await launch(config)) ?? saved;
      return saved;
    },
    [write, launch],
  );

  const stop = useCallback(
    async (id: string) => {
      await watchStop(id).catch(() => false);
      setState(id, { state: "off", error: null });
      return write(current.current.map((item) => (item.id === id ? { ...item, enabled: false } : item)));
    },
    [write, setState],
  );

  const remove = useCallback(
    async (id: string) => {
      await watchStop(id).catch(() => false);
      setStatus((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return write(current.current.filter((item) => item.id !== id));
    },
    [write],
  );

  const start = useCallback(
    async (id: string) => {
      const config = current.current.find((item) => item.id === id);
      if (!config) return "That watch folder no longer exists.";
      const failed = await launch(config);
      if (failed) return failed;
      return write(current.current.map((item) => (item.id === id ? { ...item, enabled: true } : item)));
    },
    [launch, write],
  );

  const setPaused = useCallback(
    async (id: string, paused: boolean) => {
      const ok = await watchSetPaused(id, paused).catch(() => false);
      if (ok) setState(id, { state: paused ? "paused" : "watching", error: null });
    },
    [setState],
  );

  return { folders, status, loaded, error, save, remove, start, stop, setPaused };
}
