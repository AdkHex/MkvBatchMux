/** Saved sessions: the whole workspace (files in every slot, their delays and
 *  track edits, slot settings, mux options and output settings) as one JSON
 *  document. The same format is used for `.mbmux` files the user saves and
 *  for the autosave in the app data folder.
 *
 *  Reading is forgiving: a session from an older version, or with fields
 *  this version doesn't know or that are the wrong type, loads with what it
 *  can and says what it dropped. Only something that is not a session at all
 *  is refused. Files are not checked here; `sessionFileRefs` lists every path
 *  for `paths_exist`, and `missingFiles` turns the answer into a list to show,
 *  so nothing that went missing is dropped without the user seeing it. */

import type { ExternalFile, MuxSettings, OutputSettings, Track, VideoFile } from "@/shared/types";
import type { LoadedSession, MissingFile, SessionFile, SessionTabState, SlotTemplate, WorkspaceSnapshot } from "@/shared/types/recipes";

export const SESSION_FORMAT = "mkvbatchmux-session";
/** Bump when the shape changes, and add a step to `migrate`. */
export const SESSION_VERSION = 2;
/** Far above a real session (thousands of episodes with all their tracks is a few MB). */
export const MAX_SESSION_CHARS = 64 * 1024 * 1024;
export const MAX_SESSION_FILES = 50_000;

// ---------------------------------------------------------------- writing

/** The document to save. A job that was muxing when the session was saved
 *  goes back to pending: nothing is muxing when it is opened again. */
export function buildSessionFile(snapshot: WorkspaceSnapshot, now: Date = new Date()): SessionFile {
  return {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    savedAt: now.toISOString(),
    videoFiles: snapshot.videoFiles.map((video) => (video.status === "processing" ? { ...video, status: "pending" } : video)),
    audioFilesByTrack: snapshot.audioFilesByTrack,
    subtitleFilesByTrack: snapshot.subtitleFilesByTrack,
    chapterFiles: snapshot.chapterFiles,
    attachmentFiles: snapshot.attachmentFiles,
    perVideoExternal: snapshot.perVideoExternal,
    tabState: snapshot.tabState,
    muxSettings: snapshot.muxSettings,
    outputSettings: snapshot.outputSettings,
    recipeId: snapshot.recipeId ?? null,
  };
}

/** Nothing worth saving or offering to restore: no file in any slot. */
export function isEmptySnapshot(snapshot: Pick<WorkspaceSnapshot, "videoFiles" | "audioFilesByTrack" | "subtitleFilesByTrack" | "chapterFiles" | "attachmentFiles" | "perVideoExternal">): boolean {
  const anyIn = (byTrack: Record<string, ExternalFile[]>) => Object.values(byTrack).some((files) => files.length > 0);
  return (
    snapshot.videoFiles.length === 0 &&
    !anyIn(snapshot.audioFilesByTrack) &&
    !anyIn(snapshot.subtitleFilesByTrack) &&
    snapshot.chapterFiles.length === 0 &&
    snapshot.attachmentFiles.length === 0 &&
    Object.values(snapshot.perVideoExternal).every((entry) => entry.audios.length === 0 && entry.subtitles.length === 0)
  );
}

// ---------------------------------------------------------------- reading

export type ParsedSession =
  | { ok: true; session: LoadedSession; version: number; savedAt: string | null; warnings: string[] }
  | { ok: false; error: string };

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/** Read a session: the JSON text, or the value `session_open` returned. */
export function parseSession(input: unknown): ParsedSession {
  let raw = input;
  if (typeof input === "string") {
    if (input.length > MAX_SESSION_CHARS) return { ok: false, error: "This file is too large to be a session." };
    try {
      raw = JSON.parse(input);
    } catch {
      return { ok: false, error: "This file is damaged or is not a MKVBatchMux session." };
    }
  }
  if (!isObj(raw)) return { ok: false, error: "This file is not a MKVBatchMux session." };
  if (raw.format !== undefined && raw.format !== SESSION_FORMAT) return { ok: false, error: "This file is not a MKVBatchMux session." };

  const warnings: string[] = [];
  const version = typeof raw.version === "number" && Number.isFinite(raw.version) ? raw.version : 0;
  if (version > SESSION_VERSION) warnings.push("This session was saved by a newer version of MKVBatchMux. Anything this version doesn't know about is ignored.");
  const migrated = migrate(raw, version);
  if (!looksLikeSession(migrated)) return { ok: false, error: "This file is not a MKVBatchMux session." };

  const counter = { files: 0, dropped: 0 };
  const videoFiles = readVideos(migrated.videoFiles, counter);
  const videoIds = new Set(videoFiles.map((video) => video.id));
  const audioFilesByTrack = readByTrack(migrated.audioFilesByTrack, "audio", counter);
  const subtitleFilesByTrack = readByTrack(migrated.subtitleFilesByTrack, "subtitle", counter);
  const chapterFiles = readExternals(migrated.chapterFiles, "chapter", counter);
  const attachmentFiles = readExternals(migrated.attachmentFiles, "attachment", counter);

  const perVideoExternal: LoadedSession["perVideoExternal"] = {};
  let orphaned = 0;
  if (isObj(migrated.perVideoExternal)) {
    for (const [videoId, entry] of Object.entries(migrated.perVideoExternal)) {
      if (!isObj(entry)) continue;
      const audios = readExternals(entry.audios, "audio", counter);
      const subtitles = readExternals(entry.subtitles, "subtitle", counter);
      if (!videoIds.has(videoId)) {
        orphaned += audios.length + subtitles.length;
        continue;
      }
      perVideoExternal[videoId] = { audios, subtitles };
    }
  }

  if (counter.files > MAX_SESSION_FILES) return { ok: false, error: "This session lists more files than MKVBatchMux can open at once." };
  if (counter.dropped > 0) warnings.push(`${counter.dropped} ${counter.dropped === 1 ? "entry was" : "entries were"} unreadable and left out.`);
  if (orphaned > 0) warnings.push(`${orphaned} per-video ${orphaned === 1 ? "file belonged" : "files belonged"} to a video that isn't in the session and ${orphaned === 1 ? "was" : "were"} left out.`);

  const muxSettings = readSettings<MuxSettings>(migrated.muxSettings, MUX_SETTING_TYPES, warnings, "mux option");
  const outputSettings = readSettings<OutputSettings>(migrated.outputSettings, OUTPUT_SETTING_TYPES, warnings, "output setting");
  const tabState = readTabState(migrated.tabState, audioFilesByTrack, subtitleFilesByTrack);

  return {
    ok: true,
    version,
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : null,
    warnings,
    session: {
      videoFiles,
      audioFilesByTrack,
      subtitleFilesByTrack,
      chapterFiles,
      attachmentFiles,
      perVideoExternal,
      tabState,
      muxSettings,
      outputSettings,
      recipeId: typeof migrated.recipeId === "string" ? migrated.recipeId : null,
    },
  };
}

/** Older shapes to the current one. Version 0 is a bare workspace without the
 *  format header, which may carry a flat `audioFiles` / `subtitleFiles` list
 *  (one slot) instead of files by slot. Version 1 had checking every new file
 *  on by default. */
function migrate(raw: Obj, version: number): Obj {
  let out: Obj = { ...raw };
  if (version < 1) {
    if (!isObj(out.audioFilesByTrack) && Array.isArray(out.audioFiles)) out = { ...out, audioFilesByTrack: { "1": out.audioFiles } };
    if (!isObj(out.subtitleFilesByTrack) && Array.isArray(out.subtitleFiles)) out = { ...out, subtitleFilesByTrack: { "1": out.subtitleFiles } };
  }
  if (version < 2 && isObj(out.muxSettings)) out = { ...out, muxSettings: withoutOldVerify(out.muxSettings) };
  return out;
}

/** Mux options as a version before 2 saved them, without `verifyOutput: true`: checking every new file
 *  was on by default then, so it being on says nothing about what the user chose, and it now is off
 *  unless asked for. Recipes of their version 1 hold it for the same reason. */
export function withoutOldVerify<T extends object>(options: T): T {
  if ((options as { verifyOutput?: unknown }).verifyOutput !== true) return options;
  const { verifyOutput: _on, ...rest } = options as T & { verifyOutput?: unknown };
  void _on;
  return rest as T;
}

/** A session has at least one of its lists; a random JSON file has none. */
function looksLikeSession(raw: Obj): boolean {
  return ["videoFiles", "audioFilesByTrack", "subtitleFilesByTrack", "chapterFiles", "attachmentFiles", "muxSettings", "outputSettings"].some((key) => key in raw);
}

const VIDEO_STATUSES = new Set<VideoFile["status"]>(["pending", "completed", "error"]);
const TRACK_TYPES = new Set<Track["type"]>(["video", "audio", "subtitle", "chapter"]);
const EXTERNAL_TYPES = new Set<ExternalFile["type"]>(["audio", "subtitle", "chapter", "attachment"]);

function readTracks(value: unknown, owner: string): Track[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((track): track is Obj => isObj(track) && TRACK_TYPES.has(track.type as Track["type"]))
    .map((track, index) => ({ ...track, id: str(track.id, `${owner}-${index}`) }) as unknown as Track);
}

function readVideos(value: unknown, counter: { files: number; dropped: number }): VideoFile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: VideoFile[] = [];
  for (const item of value) {
    counter.files += 1;
    if (!isObj(item) || typeof item.path !== "string" || !item.path) {
      counter.dropped += 1;
      continue;
    }
    let id = str(item.id, item.path);
    // Two rows with one id would share edits; the second gets its own.
    while (seen.has(id)) id = `${id}~`;
    seen.add(id);
    const status = VIDEO_STATUSES.has(item.status as VideoFile["status"]) ? (item.status as VideoFile["status"]) : "pending";
    out.push({
      ...(item as unknown as VideoFile),
      id,
      name: str(item.name, fileName(item.path)),
      path: item.path,
      size: typeof item.size === "number" && Number.isFinite(item.size) ? item.size : 0,
      status,
      tracks: readTracks(item.tracks, id),
    });
  }
  return out;
}

/** A gap (Feature 4: `placeholder: true`, no path) is kept as it is: it holds
 *  a row's place so the files after it stay paired with their videos. */
const isPlaceholder = (file: Obj) => file.placeholder === true;

function readExternals(value: unknown, type: ExternalFile["type"], counter: { files: number; dropped: number }): ExternalFile[] {
  if (!Array.isArray(value)) return [];
  const out: ExternalFile[] = [];
  value.forEach((item, index) => {
    counter.files += 1;
    if (!isObj(item) || (!isPlaceholder(item) && (typeof item.path !== "string" || !item.path))) {
      counter.dropped += 1;
      return;
    }
    const path = str(item.path);
    out.push({
      ...(item as unknown as ExternalFile),
      id: str(item.id, `${type}-${index}-${path}`),
      name: str(item.name, fileName(path)),
      path,
      type: EXTERNAL_TYPES.has(item.type as ExternalFile["type"]) ? (item.type as ExternalFile["type"]) : type,
      tracks: item.tracks === undefined ? undefined : readTracks(item.tracks, str(item.id, path)),
    });
  });
  return out;
}

function readByTrack(value: unknown, type: ExternalFile["type"], counter: { files: number; dropped: number }): Record<string, ExternalFile[]> {
  if (!isObj(value)) return {};
  const out: Record<string, ExternalFile[]> = {};
  for (const [slot, files] of Object.entries(value)) out[slot] = readExternals(files, type, counter);
  return out;
}

type FieldType = "string" | "boolean" | "number" | "string[]" | "optional-string";

/** Every mux option and its type, so a wrong-typed value from a damaged or
 *  hand-edited file is dropped (the default stays) instead of reaching mkvmerge.
 *  Fields added to `MuxSettings` later load through as long as their type is a
 *  plain JSON value; list them here to have them checked. */
const MUX_SETTING_TYPES: Record<keyof MuxSettings, FieldType> = {
  destinationDir: "string",
  outputNamingPattern: "optional-string",
  overwriteSource: "boolean",
  addCrc: "boolean",
  removeOldCrc: "boolean",
  keepLogFile: "boolean",
  abortOnErrors: "boolean",
  maxParallelJobs: "number",
  onlyKeepAudiosEnabled: "boolean",
  onlyKeepSubtitlesEnabled: "boolean",
  onlyKeepAudioLanguages: "string[]",
  onlyKeepSubtitleLanguages: "string[]",
  discardOldChapters: "boolean",
  discardOldAttachments: "boolean",
  allowDuplicateAttachments: "boolean",
  attachmentsExpertMode: "boolean",
  removeGlobalTags: "boolean",
  makeAudioDefaultLanguage: "optional-string",
  makeSubtitleDefaultLanguage: "optional-string",
  useMkvpropedit: "boolean",
  verifyOutput: "boolean",
  verifySync: "boolean",
  verifySyncToleranceMs: "number",
};

const OUTPUT_SETTING_TYPES: Record<keyof OutputSettings, FieldType> = {
  directory: "string",
  namingPattern: "string",
  overwriteExisting: "boolean",
};

function fits(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "optional-string":
      return value === null || value === undefined || typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string[]":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
}

const isPlainJson = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value) || Array.isArray(value) || isObj(value);

function readSettings<T>(value: unknown, types: Record<string, FieldType>, warnings: string[], noun: string): Partial<T> {
  if (!isObj(value)) return {};
  const out: Obj = {};
  const dropped: string[] = [];
  for (const [key, field] of Object.entries(value)) {
    const type = types[key];
    if (type ? fits(field, type) : isPlainJson(field)) out[key] = field === null && type === "optional-string" ? undefined : field;
    else dropped.push(key);
  }
  if (dropped.length) warnings.push(`${dropped.length} ${noun}${dropped.length === 1 ? " was" : "s were"} unreadable and kept at ${dropped.length === 1 ? "its" : "their"} current value: ${dropped.join(", ")}.`);
  return out as Partial<T>;
}

function readSlot(value: unknown): SlotTemplate | null {
  if (!isObj(value)) return null;
  return {
    sourceFolder: str(value.sourceFolder),
    extension: str(value.extension, "all"),
    language: str(value.language, "und"),
    trackName: str(value.trackName),
    delay: typeof value.delay === "number" ? value.delay.toFixed(3) : str(value.delay, "0.000"),
    isDefault: value.isDefault === true,
    isForced: value.isForced === true,
    muxAfter: str(value.muxAfter, "video"),
  };
}

/** The slot lists and settings; a session without them still gets a slot for
 *  every list of files it has, so no file is left without a slot to show it. */
function readTabState(value: unknown, audio: Record<string, ExternalFile[]>, subtitles: Record<string, ExternalFile[]>): Partial<SessionTabState> {
  const raw = isObj(value) ? value : {};
  const out: Partial<SessionTabState> = {};
  const slots = (listKey: string, configKey: string, files: Record<string, ExternalFile[]>) => {
    const listed = Array.isArray(raw[listKey]) ? (raw[listKey] as unknown[]).filter((id): id is string => typeof id === "string") : [];
    const ids = [...new Set([...listed, ...Object.keys(files)])];
    const configs: Record<string, SlotTemplate> = {};
    if (isObj(raw[configKey])) {
      for (const [id, config] of Object.entries(raw[configKey] as Obj)) {
        const slot = readSlot(config);
        if (slot && ids.includes(id)) configs[id] = slot;
      }
    }
    return { ids, configs };
  };
  const a = slots("audioTracks", "audioTrackConfigs", audio);
  const s = slots("subtitleTracks", "subtitleTrackConfigs", subtitles);
  if (a.ids.length) {
    out.audioTracks = a.ids;
    out.audioTrackConfigs = a.configs;
    out.activeAudioTrack = typeof raw.activeAudioTrack === "string" && a.ids.includes(raw.activeAudioTrack) ? raw.activeAudioTrack : a.ids[0];
  }
  if (s.ids.length) {
    out.subtitleTracks = s.ids;
    out.subtitleTrackConfigs = s.configs;
    out.activeSubtitleTrack = typeof raw.activeSubtitleTrack === "string" && s.ids.includes(raw.activeSubtitleTrack) ? raw.activeSubtitleTrack : s.ids[0];
  }
  if (typeof raw.audioPresetApplied === "boolean") out.audioPresetApplied = raw.audioPresetApplied;
  if (typeof raw.subtitlePresetApplied === "boolean") out.subtitlePresetApplied = raw.subtitlePresetApplied;
  if (isObj(raw.chapterTabState)) {
    const c = raw.chapterTabState;
    out.chapterTabState = {
      chaptersEnabled: c.chaptersEnabled === true,
      sourceFolder: str(c.sourceFolder),
      extension: str(c.extension, "all"),
      discardOldChapters: c.discardOldChapters === true,
      delay: str(c.delay, "0.000"),
    };
  }
  if (isObj(raw.attachmentTabState)) {
    const t = raw.attachmentTabState;
    out.attachmentTabState = {
      attachmentsEnabled: t.attachmentsEnabled === true,
      sourceFolder: str(t.sourceFolder),
      extension: str(t.extension, "all"),
      allowDuplicate: t.allowDuplicate === true,
      discardOld: t.discardOld === true,
      expertMode: t.expertMode === true,
    };
  }
  return out;
}

// ---------------------------------------------------------------- files on disk

/** Every file the session refers to, once each, in the order the pages show them. */
export function sessionFileRefs(session: Pick<LoadedSession, "videoFiles" | "audioFilesByTrack" | "subtitleFilesByTrack" | "chapterFiles" | "attachmentFiles" | "perVideoExternal">): MissingFile[] {
  const refs: MissingFile[] = [];
  const seen = new Set<string>();
  const add = (path: string, kind: MissingFile["kind"], name: string, slot?: string) => {
    if (!path || seen.has(`${kind}\u0000${path}`)) return;
    seen.add(`${kind}\u0000${path}`);
    refs.push({ path, kind, name: name || fileName(path), ...(slot !== undefined ? { slot } : {}) });
  };
  // A conformed dub and a re-timed subtitle mux their copy, so the copy has
  // to be there as much as the original.
  const addWithCopies = (file: ExternalFile, kind: "audio" | "subtitle", slot?: string) => {
    add(file.path, kind, file.name, slot);
    if (file.conformed?.path) add(file.conformed.path, kind, `${file.name} (conformed)`, slot);
    if (file.retimed?.path) add(file.retimed.path, kind, `${file.name} (re-timed copy)`, slot);
  };
  session.videoFiles.forEach((video) => add(video.path, "video", video.name));
  for (const [slot, files] of Object.entries(session.audioFilesByTrack)) files.forEach((file) => addWithCopies(file, "audio", slot));
  for (const [slot, files] of Object.entries(session.subtitleFilesByTrack)) files.forEach((file) => addWithCopies(file, "subtitle", slot));
  session.chapterFiles.forEach((file) => add(file.path, "chapter", file.name));
  session.attachmentFiles.forEach((file) => add(file.path, "attachment", file.name));
  for (const [videoId, entry] of Object.entries(session.perVideoExternal)) {
    entry.audios.forEach((file) => addWithCopies(file, "audio", videoId));
    entry.subtitles.forEach((file) => addWithCopies(file, "subtitle", videoId));
  }
  return refs;
}

/** The refs whose `exists` answer (same order, from `paths_exist`) is false. */
export function missingFiles(refs: MissingFile[], exists: boolean[]): MissingFile[] {
  return refs.filter((_, index) => exists[index] === false);
}

/** Check a loaded session's files on disk: `pathsExist` is `workspaceStore.pathsExist`. */
export async function findMissingFiles(session: LoadedSession, pathsExist: (paths: string[]) => Promise<boolean[]>): Promise<MissingFile[]> {
  const refs = sessionFileRefs(session);
  return missingFiles(refs, await pathsExist(refs.map((ref) => ref.path)));
}

/** "3 videos and 1 dub are missing" for the open dialog's heading. */
export function describeMissing(missing: MissingFile[]): string {
  if (missing.length === 0) return "";
  const nouns: Record<MissingFile["kind"], [string, string]> = {
    video: ["video", "videos"],
    audio: ["audio file", "audio files"],
    subtitle: ["subtitle", "subtitles"],
    chapter: ["chapter file", "chapter files"],
    attachment: ["attachment", "attachments"],
  };
  const counts = new Map<MissingFile["kind"], number>();
  missing.forEach((file) => counts.set(file.kind, (counts.get(file.kind) ?? 0) + 1));
  const parts = [...counts].map(([kind, count]) => `${count} ${nouns[kind][count === 1 ? 0 : 1]}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `${list} ${missing.length === 1 ? "is" : "are"} missing`;
}

// ---------------------------------------------------------------- autosave

export interface DebouncedSaver<T> {
  /** Save `value` once nothing new has come in for the delay. */
  schedule(value: T): void;
  /** Save what is waiting now (on close, before opening another session). */
  flush(): Promise<void>;
  cancel(): void;
}

/** Debounced saving for the autosave. `fingerprint` decides whether a value
 *  differs from the last one written; an unchanged workspace isn't written again. */
export function createDebouncedSaver<T>(
  write: (value: T) => Promise<unknown>,
  { delayMs = 2000, fingerprint = (value: T) => JSON.stringify(value) }: { delayMs?: number; fingerprint?: (value: T) => string } = {},
): DebouncedSaver<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiting: { value: T } | null = null;
  let lastWritten: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const run = () => {
    timer = null;
    if (!waiting) return chain;
    const { value } = waiting;
    waiting = null;
    const print = fingerprint(value);
    if (print === lastWritten) return chain;
    lastWritten = print;
    // Writes go one after another, so an older snapshot never lands last.
    chain = chain.then(() => write(value)).catch(() => {
      lastWritten = null;
    });
    return chain;
  };

  return {
    schedule(value) {
      waiting = { value };
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, delayMs);
    },
    async flush() {
      if (timer) clearTimeout(timer);
      await run();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      waiting = null;
    },
  };
}

/** What the autosave compares: the workspace without the save time. */
export const snapshotFingerprint = (snapshot: WorkspaceSnapshot) => JSON.stringify(snapshot);
