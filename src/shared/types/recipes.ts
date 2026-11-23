/** Types for per-show recipes, saved sessions and watch folders.
 *  The JSON shapes here are what is stored on disk (`recipes.json`, `.mbmux`
 *  session files, the autosaved session) and what crosses the Tauri boundary
 *  for watch folders (`src-tauri/src/watch.rs`); field names must match. */

import type { ExternalFile, MuxSettings, OutputSettings, Track, VideoFile } from "./index";

// ---------------------------------------------------------------- recipes

export type TrackType = Track["type"];

/** Which tracks of a video a rule applies to. Every field given must match;
 *  an empty `match` matches every track. */
export interface TrackRuleMatch {
  /** Absent: any type. */
  type?: TrackType;
  /** The track's language is one of these (ISO 639-2, "hin"; "und" for none). */
  languages?: string[];
  /** The track's language is none of these: "keep only Hindi and English audio"
   *  is a remove rule with `excludeLanguages: ["hin", "eng"]`. */
  excludeLanguages?: string[];
  /** Regular expression on the codec ("E-AC-3", "AAC", "SubRip/SRT"), case-insensitive. */
  codecRegex?: string;
  /** Regular expression on the track name, case-insensitive: "commentary". */
  nameRegex?: string;
}

/** What a rule does to the tracks it matches. Absent fields leave the track alone. */
export interface TrackRuleAction {
  /** false removes the track from the output; true keeps one an earlier rule removed. */
  keep?: boolean;
  /** true makes it the default of its type and clears the flag on the other
   *  tracks of that type (only one default makes sense to a player). */
  setDefault?: boolean;
  setForced?: boolean;
  /** New name; may use {name} (current name), {language}, {codec}, {channels} ("5.1"). */
  rename?: string;
  setLanguage?: string;
}

export interface TrackRule {
  id: string;
  /** Shown in the recipe editor: "Drop commentary". */
  label?: string;
  /** Absent means enabled. */
  enabled?: boolean;
  match: TrackRuleMatch;
  action: TrackRuleAction;
}

/** One audio or subtitle slot of a recipe: the same settings as a slot on the
 *  Audio / Subtitles page (`TrackConfig` in useTabState). */
export interface SlotTemplate {
  sourceFolder: string;
  /** "all" or one extension. */
  extension: string;
  language: string;
  trackName: string;
  /** Seconds as the slot's text field holds it: "0.000". */
  delay: string;
  isDefault: boolean;
  isForced: boolean;
  muxAfter: string;
}

/** What to do with measured delays when a recipe runs (watch folders, or
 *  "Apply recipe" followed by Measure). */
export interface MeasurementPolicy {
  autoMeasure: boolean;
  /** Apply a measured delay without asking when it meets the threshold and
   *  shows no cut, drift or warning. */
  autoApply: boolean;
  /** 0..1; 0.9 by default. */
  autoApplyMinConfidence: number;
  /** Conform a dub measured as a different cut (Feature 1) instead of leaving it for review. */
  autoConformCuts: boolean;
}

/** Mux options a recipe sets. Output folder and naming are the recipe's own fields. */
export type RecipeMuxOptions = Partial<Omit<MuxSettings, "destinationDir" | "outputNamingPattern" | "overwriteSource">>;

export interface Recipe {
  id: string;
  name: string;
  /** The show's name for {show}. Empty: read from each file name (or its folder). */
  show?: string;
  trackRules: TrackRule[];
  audioSlots: SlotTemplate[];
  subtitleSlots: SlotTemplate[];
  /** Output name pattern: {show} {season} {episode} {original_filename}. Empty: keep the current one. */
  namingPattern?: string;
  /** Output folder. Absent: keep the current one; "" means beside each source. */
  destination?: string;
  overwriteExisting?: boolean;
  muxOptions?: RecipeMuxOptions;
  measurement: MeasurementPolicy;
  createdAt?: string;
  updatedAt?: string;
}

/** `recipes.json` in the app data folder. */
export interface RecipesFile {
  version: number;
  recipes: Recipe[];
}

/** One change a recipe's track rules would make, to show before the mux. */
export interface RuleChange {
  videoId: string;
  trackId: string;
  type: TrackType;
  field: "keep" | "default" | "forced" | "name" | "language";
  from: string | boolean | undefined;
  to: string | boolean | undefined;
  /** The rule that made the change; absent for a default flag cleared because another track became default. */
  ruleId?: string;
}

// ---------------------------------------------------------------- sessions

/** The saved part of `useTabState`: slot lists and each slot's settings. */
export interface SessionTabState {
  audioTracks: string[];
  activeAudioTrack: string;
  audioTrackConfigs: Record<string, SlotTemplate>;
  audioPresetApplied: boolean;
  subtitleTracks: string[];
  activeSubtitleTrack: string;
  subtitleTrackConfigs: Record<string, SlotTemplate>;
  subtitlePresetApplied: boolean;
  chapterTabState: {
    chaptersEnabled: boolean;
    sourceFolder: string;
    extension: string;
    discardOldChapters: boolean;
    delay: string;
  };
  attachmentTabState: {
    attachmentsEnabled: boolean;
    sourceFolder: string;
    extension: string;
    allowDuplicate: boolean;
    discardOld: boolean;
    expertMode: boolean;
  };
}

/** Everything a session restores: the workspace as Index.tsx holds it. */
export interface WorkspaceSnapshot {
  videoFiles: VideoFile[];
  audioFilesByTrack: Record<string, ExternalFile[]>;
  subtitleFilesByTrack: Record<string, ExternalFile[]>;
  chapterFiles: ExternalFile[];
  attachmentFiles: ExternalFile[];
  perVideoExternal: Record<string, { audios: ExternalFile[]; subtitles: ExternalFile[] }>;
  tabState: SessionTabState;
  muxSettings: MuxSettings;
  outputSettings: OutputSettings;
  /** The recipe applied to this workspace, if any. */
  recipeId?: string | null;
}

/** A session as read back: settings may be partial (older files, other
 *  versions), to be laid over the app's current defaults. */
export interface LoadedSession extends Omit<WorkspaceSnapshot, "muxSettings" | "outputSettings" | "tabState"> {
  muxSettings: Partial<MuxSettings>;
  outputSettings: Partial<OutputSettings>;
  tabState: Partial<SessionTabState>;
}

/** The file format (`.mbmux`, and the autosave). */
export interface SessionFile extends WorkspaceSnapshot {
  format: "mkvbatchmux-session";
  version: number;
  /** ISO 8601. */
  savedAt: string;
}

/** A file a session refers to that isn't there any more. */
export interface MissingFile {
  path: string;
  kind: "video" | "audio" | "subtitle" | "chapter" | "attachment";
  /** Audio/subtitle slot id, or the video's id for per-video files. */
  slot?: string;
  name: string;
}

// ---------------------------------------------------------------- watch folders

/** `watch_start`'s request. */
export interface WatchRequest {
  /** The frontend's id; starting one that runs replaces it. */
  id: string;
  folder: string;
  /** Without the dot; empty for every file. */
  extensions?: string[];
  recursive?: boolean;
  /** 10 when absent, never under 0.5. */
  intervalSeconds?: number;
  /** Polls in a row a file's size must stay the same: 2 when absent. */
  stablePolls?: number;
  paused?: boolean;
}

export type WatchState = "watching" | "paused" | "unavailable" | "stopped";

/** `watch_list` / `watch_start` result. */
export interface WatchInfo {
  id: string;
  folder: string;
  extensions: string[];
  recursive: boolean;
  intervalSeconds: number;
  stablePolls: number;
  state: WatchState;
  error: string | null;
  paused: boolean;
  /** New files whose size is still changing. */
  settling: number;
  /** Files reported since watching started. */
  reported: number;
  /** Ready files held back while paused. */
  held: number;
}

/** `watch-files`: files that appeared and stopped growing. */
export interface WatchFilesEvent {
  id: string;
  paths: string[];
}

/** `watch-status`. */
export interface WatchStatusEvent {
  id: string;
  state: WatchState;
  error: string | null;
}

/** A watch folder as the user set it up (saved under the store key `watch-folders`). */
export interface WatchFolderConfig {
  id: string;
  enabled: boolean;
  recipeId: string | null;
  videoFolder: string;
  videoExtensions: string[];
  recursive: boolean;
  /** Folders the matching dubs, subtitles and chapters arrive in; "" for none. */
  audioFolder: string;
  subtitleFolder: string;
  chapterFolder: string;
  intervalSeconds: number;
}
