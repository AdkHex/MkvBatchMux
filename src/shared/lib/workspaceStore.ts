/** Saved workspace data and watch folders: wrappers around the Tauri commands
 *  in `src-tauri/src/store.rs` and `src-tauri/src/watch.rs`.
 *
 *  Every reader returns an error message rather than throwing on a damaged
 *  file, so a bad `recipes.json` or session shows as a message, not a crash.
 *  The JSON shapes are checked and migrated in `features/workspace/lib/session.ts`
 *  and `recipes.ts`; this file only moves them. */

import { invoke } from "@tauri-apps/api/tauri";
import { open, save } from "@tauri-apps/api/dialog";
import { listen } from "@tauri-apps/api/event";
import type {
  Recipe,
  WatchFilesEvent,
  WatchFolderConfig,
  WatchInfo,
  WatchRequest,
  WatchStatusEvent,
} from "@/shared/types/recipes";

/** Store keys: each is `<key>.json` in the app data folder. */
export const STORE_KEYS = {
  recipes: "recipes",
  /** The workspace as it was last, saved while the app runs. */
  autosave: "last-session",
  watchFolders: "watch-folders",
} as const;

export const SESSION_EXTENSION = "mbmux";
const SESSION_FILTERS = [{ name: "MKVBatchMux session", extensions: [SESSION_EXTENSION] }];

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const message = (error: unknown) => (typeof error === "string" ? error : error instanceof Error ? error.message : String(error));

async function attempt<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// ---------------------------------------------------------------- app data store

/** `<key>.json` from the app data folder; null value when it doesn't exist. */
export function storeRead(key: string) {
  return attempt(() => invoke<unknown | null>("store_read", { key }));
}

/** Write `<key>.json` atomically. */
export function storeWrite(key: string, value: unknown) {
  return attempt(() => invoke<void>("store_write", { key, value }));
}

export function storeDelete(key: string) {
  return attempt(() => invoke<void>("store_delete", { key }));
}

/** The app data folder these files live in. */
export function storeLocation() {
  return attempt(async () => (await invoke<{ dir: string }>("store_location")).dir);
}

/** The raw `recipes.json` (null when there is none yet). Parse with `parseRecipesFile`. */
export function readRecipesRaw() {
  return storeRead(STORE_KEYS.recipes);
}

/** Save the recipe list (see `serializeRecipes` for the stored shape). */
export function writeRecipes(recipes: Recipe[], version: number) {
  return storeWrite(STORE_KEYS.recipes, { version, recipes });
}

/** The autosaved session as stored (null when none). Parse with `parseSession`. */
export function readAutosave() {
  return storeRead(STORE_KEYS.autosave);
}

/** `session` is a `SessionFile` object (`buildSessionFile`), not a string. */
export function writeAutosave(session: unknown) {
  return storeWrite(STORE_KEYS.autosave, session);
}

export function clearAutosave() {
  return storeDelete(STORE_KEYS.autosave);
}

export function readWatchFolders() {
  return storeRead(STORE_KEYS.watchFolders);
}

export function writeWatchFolders(folders: WatchFolderConfig[]) {
  return storeWrite(STORE_KEYS.watchFolders, { version: 1, folders });
}

// ---------------------------------------------------------------- session files

/** Ask where to save a session; null when cancelled. Adds the extension if the dialog didn't. */
export async function pickSessionSavePath(defaultPath?: string) {
  const path = await save({ filters: SESSION_FILTERS, defaultPath });
  if (typeof path !== "string" || !path) return null;
  return /\.mbmux$/i.test(path) ? path : `${path}.${SESSION_EXTENSION}`;
}

/** Ask for a session file to open; null when cancelled. */
export async function pickSessionOpenPath() {
  const path = await open({ multiple: false, filters: SESSION_FILTERS });
  return typeof path === "string" ? path : null;
}

/** Write a session file (atomically) where the user chose. */
export function saveSessionFile(path: string, session: unknown) {
  return attempt(() => invoke<void>("session_save", { path, value: session }));
}

/** Read a session file's JSON. Parse with `parseSession`. */
export function openSessionFile(path: string) {
  return attempt(() => invoke<unknown>("session_open", { path }));
}

/** Whether each path exists, in the same order. A failed call counts every path as present,
 *  so a backend error can't make a whole session look missing. */
export async function pathsExist(paths: string[]): Promise<boolean[]> {
  if (paths.length === 0) return [];
  try {
    return await invoke<boolean[]>("paths_exist", { paths });
  } catch {
    return paths.map(() => true);
  }
}

// ---------------------------------------------------------------- watch folders

/** Start (or restart) watching a folder. */
export function watchStart(request: WatchRequest) {
  return attempt(() => invoke<WatchInfo>("watch_start", { request }));
}

/** Stop a watcher; false when none ran with this id. */
export function watchStop(id: string) {
  return invoke<boolean>("watch_stop", { id });
}

/** Pause or resume; files that become ready while paused are sent on resume. */
export function watchSetPaused(id: string, paused: boolean) {
  return invoke<boolean>("watch_set_paused", { id, paused });
}

export function watchList() {
  return invoke<WatchInfo[]>("watch_list");
}

/** New files that appeared in a watched folder and stopped growing. */
export function listenWatchFiles(handler: (payload: WatchFilesEvent) => void) {
  return listen<WatchFilesEvent>("watch-files", (event) => handler(event.payload));
}

export function listenWatchStatus(handler: (payload: WatchStatusEvent) => void) {
  return listen<WatchStatusEvent>("watch-status", (event) => handler(event.payload));
}

/** The `watch_start` request for a configured watch folder's video folder. */
export function watchRequestFor(config: WatchFolderConfig): WatchRequest {
  return {
    id: config.id,
    folder: config.videoFolder,
    extensions: config.videoExtensions,
    recursive: config.recursive,
    intervalSeconds: config.intervalSeconds,
  };
}
