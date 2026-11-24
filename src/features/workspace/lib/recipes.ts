/** Per-show recipes: what to do with every episode of a show, saved once and
 *  applied to the workspace (File menu, toolbar picker) or by a watch folder.
 *
 *  - Track rules edit each video's own tracks the way Modify tracks does
 *    (the same `applyTrackRowsToVideo`, so a rule's edit muxes exactly like a
 *    hand edit) and say what they changed, to show before the mux.
 *  - Slot templates fill the Audio / Subtitles slots.
 *  - The naming pattern resolves per video: {show} {season} {episode}
 *    {original_filename}, plus the tokens main.rs already knows.
 *  - The measurement policy decides which measured rows are applied or
 *    conformed without asking. */

import type { ExternalFile, MeasuredDelay, MuxSettings, OutputSettings, Track, VideoFile } from "@/shared/types";
import { MAX_PLAUSIBLE_OFFSET_MS } from "@/shared/types/audiosync";
import { episodeKey } from "@/shared/lib/episodeKey";
import type {
  MeasurementPolicy,
  Recipe,
  RecipesFile,
  RuleChange,
  SlotTemplate,
  TrackRule,
  TrackRuleMatch,
} from "@/shared/types/recipes";
import { applyMeasuredDelay } from "./applyMeasurement";
import { fileConformBlocker } from "./conform";
import { isBlockingCut } from "./delayConversion";
import { includedAudioTrackIndices } from "./measurePairs";
import { applyTrackRowsToVideo, type TrackRowDraft } from "./modifyTracks";
import { withoutOldVerify } from "./session";

export const RECIPES_VERSION = 2;

export const DEFAULT_MEASUREMENT_POLICY: MeasurementPolicy = {
  autoMeasure: true,
  autoApply: true,
  autoApplyMinConfidence: 0.9,
  // Conforming re-renders or re-cuts the dub, so it is asked for, not assumed.
  autoConformCuts: false,
};

export const DEFAULT_SLOT: SlotTemplate = {
  sourceFolder: "",
  extension: "all",
  language: "und",
  trackName: "",
  delay: "0.000",
  isDefault: false,
  isForced: false,
  muxAfter: "video",
};

let idCounter = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export function createRecipe(name: string, now: Date = new Date()): Recipe {
  const stamp = now.toISOString();
  return {
    id: newId("recipe"),
    name,
    trackRules: [],
    audioSlots: [],
    subtitleSlots: [],
    measurement: { ...DEFAULT_MEASUREMENT_POLICY },
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export function createRule(rule: Omit<TrackRule, "id"> & { id?: string }): TrackRule {
  return { ...rule, id: rule.id ?? newId("rule") };
}

// ---------------------------------------------------------------- validation and storage

/** Compile a rule's regular expression; null when it isn't one. Case-insensitive. */
export function compilePattern(source: string | undefined): RegExp | null | undefined {
  if (source === undefined || source === "") return undefined;
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

/** What is wrong with a recipe, one line each; empty when it can be saved. */
export function validateRecipe(recipe: Recipe): string[] {
  const problems: string[] = [];
  if (!recipe.name.trim()) problems.push("Give the recipe a name.");
  recipe.trackRules.forEach((rule, index) => {
    const label = rule.label?.trim() || `Rule ${index + 1}`;
    if (compilePattern(rule.match.nameRegex) === null) problems.push(`${label}: the name pattern isn't a valid regular expression.`);
    if (compilePattern(rule.match.codecRegex) === null) problems.push(`${label}: the codec pattern isn't a valid regular expression.`);
    const a = rule.action;
    if (a.keep === undefined && a.setDefault === undefined && a.setForced === undefined && a.rename === undefined && a.setLanguage === undefined) {
      problems.push(`${label}: choose what the rule does.`);
    }
    if (a.setLanguage !== undefined && !/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(a.setLanguage)) problems.push(`${label}: "${a.setLanguage}" isn't a language code.`);
  });
  const policy = recipe.measurement;
  if (!(policy.autoApplyMinConfidence >= 0 && policy.autoApplyMinConfidence <= 1)) problems.push("The confidence to apply at must be between 0 and 100%.");
  if (recipe.namingPattern !== undefined && recipe.namingPattern.trim() && /[\\/]/.test(recipe.namingPattern)) {
    problems.push("The output name can't contain a folder; set the destination instead.");
  }
  return problems;
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const optStr = (value: unknown) => (typeof value === "string" ? value : undefined);
const optBool = (value: unknown) => (typeof value === "boolean" ? value : undefined);
const strList = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);

function readSlot(value: unknown): SlotTemplate | null {
  if (!isObj(value)) return null;
  return {
    sourceFolder: optStr(value.sourceFolder) ?? DEFAULT_SLOT.sourceFolder,
    extension: optStr(value.extension) ?? DEFAULT_SLOT.extension,
    language: optStr(value.language) ?? DEFAULT_SLOT.language,
    trackName: optStr(value.trackName) ?? DEFAULT_SLOT.trackName,
    delay: typeof value.delay === "number" ? value.delay.toFixed(3) : (optStr(value.delay) ?? DEFAULT_SLOT.delay),
    isDefault: value.isDefault === true,
    isForced: value.isForced === true,
    muxAfter: optStr(value.muxAfter) ?? DEFAULT_SLOT.muxAfter,
  };
}

const TRACK_TYPES = new Set<Track["type"]>(["video", "audio", "subtitle", "chapter"]);

function readRule(value: unknown, index: number): TrackRule | null {
  if (!isObj(value) || !isObj(value.action)) return null;
  const m = isObj(value.match) ? value.match : {};
  const a = value.action;
  const match: TrackRuleMatch = {};
  if (TRACK_TYPES.has(m.type as Track["type"])) match.type = m.type as Track["type"];
  const languages = strList(m.languages);
  const exclude = strList(m.excludeLanguages);
  if (languages?.length) match.languages = languages;
  if (exclude?.length) match.excludeLanguages = exclude;
  if (optStr(m.codecRegex)) match.codecRegex = m.codecRegex as string;
  if (optStr(m.nameRegex)) match.nameRegex = m.nameRegex as string;
  const action: TrackRule["action"] = {};
  if (optBool(a.keep) !== undefined) action.keep = a.keep as boolean;
  if (optBool(a.setDefault) !== undefined) action.setDefault = a.setDefault as boolean;
  if (optBool(a.setForced) !== undefined) action.setForced = a.setForced as boolean;
  if (optStr(a.rename) !== undefined) action.rename = a.rename as string;
  if (optStr(a.setLanguage)) action.setLanguage = a.setLanguage as string;
  return {
    id: optStr(value.id) || `rule-${index}`,
    ...(optStr(value.label) !== undefined ? { label: value.label as string } : {}),
    ...(optBool(value.enabled) !== undefined ? { enabled: value.enabled as boolean } : {}),
    match,
    action,
  };
}

function readRecipe(value: unknown, index: number): Recipe | null {
  if (!isObj(value) || typeof value.name !== "string") return null;
  const policy = isObj(value.measurement) ? value.measurement : {};
  const confidence = typeof policy.autoApplyMinConfidence === "number" && policy.autoApplyMinConfidence >= 0 && policy.autoApplyMinConfidence <= 1 ? policy.autoApplyMinConfidence : DEFAULT_MEASUREMENT_POLICY.autoApplyMinConfidence;
  const list = <T,>(raw: unknown, read: (item: unknown, index: number) => T | null) => (Array.isArray(raw) ? raw.map(read).filter((item): item is T => item !== null) : []);
  return {
    id: optStr(value.id) || `recipe-${index}`,
    name: value.name,
    ...(optStr(value.show) !== undefined ? { show: value.show as string } : {}),
    trackRules: list(value.trackRules, readRule),
    audioSlots: list(value.audioSlots, readSlot),
    subtitleSlots: list(value.subtitleSlots, readSlot),
    ...(optStr(value.namingPattern) !== undefined ? { namingPattern: value.namingPattern as string } : {}),
    ...(optStr(value.destination) !== undefined ? { destination: value.destination as string } : {}),
    ...(optBool(value.overwriteExisting) !== undefined ? { overwriteExisting: value.overwriteExisting as boolean } : {}),
    ...(isObj(value.muxOptions) ? { muxOptions: value.muxOptions as Recipe["muxOptions"] } : {}),
    measurement: {
      autoMeasure: optBool(policy.autoMeasure) ?? DEFAULT_MEASUREMENT_POLICY.autoMeasure,
      autoApply: optBool(policy.autoApply) ?? DEFAULT_MEASUREMENT_POLICY.autoApply,
      autoApplyMinConfidence: confidence,
      autoConformCuts: optBool(policy.autoConformCuts) ?? DEFAULT_MEASUREMENT_POLICY.autoConformCuts,
    },
    ...(optStr(value.createdAt) ? { createdAt: value.createdAt as string } : {}),
    ...(optStr(value.updatedAt) ? { updatedAt: value.updatedAt as string } : {}),
  };
}

/** Read `recipes.json` as `store_read` returned it (null: none saved yet).
 *  Broken entries are skipped and counted, never fatal. */
export function parseRecipesFile(raw: unknown): { recipes: Recipe[]; skipped: number; error: string | null } {
  if (raw === null || raw === undefined) return { recipes: [], skipped: 0, error: null };
  // Version 0: a bare list.
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.recipes) ? raw.recipes : null;
  if (!list) return { recipes: [], skipped: 0, error: "The saved recipes are damaged and couldn't be read." };
  const version = isObj(raw) && typeof raw.version === "number" ? raw.version : 0;
  const recipes: Recipe[] = [];
  const ids = new Set<string>();
  let skipped = 0;
  list.forEach((item, index) => {
    const recipe = readRecipe(item, index);
    // Saved while checking every new file was on by default.
    if (recipe?.muxOptions && version < 2) recipe.muxOptions = withoutOldVerify(recipe.muxOptions);
    if (!recipe) {
      skipped += 1;
      return;
    }
    while (ids.has(recipe.id)) recipe.id = `${recipe.id}~`;
    ids.add(recipe.id);
    recipes.push(recipe);
  });
  return { recipes, skipped, error: null };
}

export function serializeRecipes(recipes: Recipe[]): RecipesFile {
  return { version: RECIPES_VERSION, recipes };
}

// ---------------------------------------------------------------- track rules

/** Two-letter codes for the languages most dubs and subtitles come in, so a
 *  rule written "hi" matches a track tagged "hin" and the other way round. */
const LANGUAGE_ALIASES: Record<string, string> = {
  en: "eng", hi: "hin", ja: "jpn", es: "spa", fr: "fre", de: "ger", it: "ita", pt: "por", ru: "rus", ko: "kor",
  zh: "chi", ta: "tam", te: "tel", ml: "mal", kn: "kan", bn: "ben", mr: "mar", ar: "ara", tr: "tur", pl: "pol",
  nl: "dut", sv: "swe", th: "tha", id: "ind", vi: "vie", uk: "ukr", he: "heb", fa: "per", ur: "urd",
};
/** ISO 639-2 has two codes for some languages (bibliographic and terminology). */
const LANGUAGE_SYNONYMS: Record<string, string> = { fra: "fre", deu: "ger", zho: "chi", nld: "dut", fas: "per" };

/** One spelling per language: "hi", "HIN", "hi-IN" → "hin"; empty → "und". */
export function normalizeLanguage(language: string | undefined | null): string {
  const base = (language || "und").trim().toLowerCase().split(/[-_]/)[0] || "und";
  const long = LANGUAGE_ALIASES[base] ?? base;
  return LANGUAGE_SYNONYMS[long] ?? long;
}

interface TrackView {
  type: Track["type"];
  language: string;
  name: string;
  codec: string;
}

/** Whether a rule's match fits a track (as earlier rules left it). */
export function ruleMatches(match: TrackRuleMatch, track: TrackView): boolean {
  if (match.type && match.type !== track.type) return false;
  const language = normalizeLanguage(track.language);
  if (match.languages?.length && !match.languages.some((wanted) => normalizeLanguage(wanted) === language)) return false;
  if (match.excludeLanguages?.length && match.excludeLanguages.some((unwanted) => normalizeLanguage(unwanted) === language)) return false;
  for (const [source, value] of [
    [match.codecRegex, track.codec],
    [match.nameRegex, track.name],
  ] as const) {
    const pattern = compilePattern(source);
    // An invalid pattern matches nothing; validateRecipe reports it.
    if (pattern === null) return false;
    if (pattern && !pattern.test(value)) return false;
  }
  return true;
}

/** "5.1" for six channels: what a track name usually says. */
export function channelLayout(channels: number | undefined): string {
  if (!channels || channels < 1) return "";
  const known: Record<number, string> = { 1: "1.0", 2: "2.0", 3: "2.1", 6: "5.1", 7: "6.1", 8: "7.1" };
  return known[channels] ?? `${channels}ch`;
}

/** A rename template for one track: {name} {language} {codec} {channels}. */
export function renderTrackName(template: string, track: Track, current: TrackView): string {
  return template
    .replace(/\{name\}/gi, current.name)
    .replace(/\{language\}/gi, current.language === "und" ? "" : current.language)
    .replace(/\{codec\}/gi, track.codec ?? "")
    .replace(/\{channels\}/gi, channelLayout(track.channels))
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–|·,]+|[\s\-–|·,]+$/g, "")
    .trim();
}

type Fields = Pick<TrackRowDraft, "copyTrack" | "setDefault" | "setForced" | "trackName" | "language">;

/** Apply a recipe's track rules to one video. Rules run in order, each
 *  seeing what the earlier ones did; a later rule wins a field both set. A
 *  rule that makes a track default clears the flag on the other tracks of
 *  its type (the first track it matches, if several). Removed tracks
 *  take no flag or rename. Returns the video unchanged (same object) when no
 *  rule changes anything. */
export function applyTrackRules(file: VideoFile, rules: TrackRule[]): { file: VideoFile; changes: RuleChange[] } {
  const active = rules.filter((rule) => rule.enabled !== false);
  if (active.length === 0 || !file.tracks?.length) return { file, changes: [] };
  const changes: RuleChange[] = [];
  let next = file;

  for (const type of ["video", "audio", "subtitle"] as const) {
    const tracks = file.tracks.filter((track) => track.type === type);
    if (tracks.length === 0) continue;
    const initial: Fields[] = tracks.map((track) => ({
      copyTrack: track.action !== "remove",
      setDefault: track.isDefault === true,
      setForced: track.isForced === true,
      trackName: track.name ?? "",
      language: track.language || "und",
    }));
    const fields = initial.map((row) => ({ ...row }));
    const byRule: Array<Partial<Record<RuleChange["field"], string>>> = tracks.map(() => ({}));
    let defaultBy: { position: number; ruleId: string } | null = null;

    for (const rule of active) {
      let ruleDefault: number | null = null;
      tracks.forEach((track, position) => {
        const row = fields[position];
        const view: TrackView = { type, language: row.language, name: row.trackName, codec: track.codec ?? "" };
        if (!ruleMatches(rule.match, view)) return;
        const a = rule.action;
        if (a.keep !== undefined) {
          row.copyTrack = a.keep;
          byRule[position].keep = rule.id;
        }
        if (!row.copyTrack) return;
        if (a.setLanguage) {
          row.language = a.setLanguage;
          byRule[position].language = rule.id;
        }
        if (a.rename !== undefined) {
          row.trackName = renderTrackName(a.rename, track, { ...view, language: row.language });
          byRule[position].name = rule.id;
        }
        if (a.setForced !== undefined) {
          row.setForced = a.setForced;
          byRule[position].forced = rule.id;
        }
        if (a.setDefault !== undefined) {
          row.setDefault = a.setDefault;
          byRule[position].default = rule.id;
          if (a.setDefault && ruleDefault === null) ruleDefault = position;
        }
      });
      if (ruleDefault !== null) defaultBy = { position: ruleDefault, ruleId: rule.id };
    }

    // One default per type: the track the last such rule made default (the
    // first it matched), unless a later rule removed it.
    const chosen = defaultBy as { position: number; ruleId: string } | null;
    if (chosen && fields[chosen.position].copyTrack && fields[chosen.position].setDefault) {
      fields.forEach((row, position) => {
        if (position !== chosen.position && row.setDefault) row.setDefault = false;
      });
    }

    const rows: TrackRowDraft[] = fields.map((row, position) => ({
      id: `${type}-${position}`,
      trackIndex: position + 1,
      sourceTrackPosition: position,
      ...row,
      initial: initial[position],
    }));
    let touched = false;
    rows.forEach((row, position) => {
      const before = initial[position];
      const track = tracks[position];
      const record = (field: RuleChange["field"], from: string | boolean, to: string | boolean) => {
        if (from === to) return;
        touched = true;
        changes.push({ videoId: file.id, trackId: track.id, type, field, from, to, ...(byRule[position][field] ? { ruleId: byRule[position][field] } : {}) });
      };
      record("keep", before.copyTrack, row.copyTrack);
      if (!row.copyTrack) return;
      record("language", before.language, row.language);
      record("name", before.trackName, row.trackName);
      record("default", before.setDefault, row.setDefault);
      record("forced", before.setForced, row.setForced);
    });
    if (touched) next = applyTrackRowsToVideo(next, rows, type);
  }
  return { file: next, changes };
}

/** Track rules over every video; `changes` lists every edit, to show before the mux. */
export function applyTrackRulesToAll(files: VideoFile[], rules: TrackRule[]): { files: VideoFile[]; changes: RuleChange[] } {
  const changes: RuleChange[] = [];
  const next = files.map((file) => {
    const result = applyTrackRules(file, rules);
    changes.push(...result.changes);
    return result.file;
  });
  return { files: next, changes };
}

// ---------------------------------------------------------------- slots and settings

/** A recipe's slot templates as the Audio / Subtitles page's slot state
 *  (`useTabState`): slots "1", "2", … with these settings. None: one empty slot. */
export function slotsToTabState(templates: SlotTemplate[], fallback: SlotTemplate = DEFAULT_SLOT) {
  const list = templates.length ? templates : [fallback];
  const tracks = list.map((_, index) => String(index + 1));
  const configs: Record<string, SlotTemplate> = {};
  list.forEach((template, index) => {
    configs[tracks[index]] = { ...template };
  });
  return { tracks, configs, active: tracks[0] };
}

/** The current slots as templates, to save into a recipe. */
export function slotsFromTabState(tracks: string[], configs: Record<string, SlotTemplate | undefined>): SlotTemplate[] {
  return tracks.map((id) => ({ ...DEFAULT_SLOT, ...(configs[id] ?? {}) }));
}

/** The mux options and output settings with the recipe's laid over them. */
export function applyRecipeSettings(recipe: Recipe, muxSettings: MuxSettings, outputSettings: OutputSettings) {
  return {
    muxSettings: { ...muxSettings, ...(recipe.muxOptions ?? {}) } as MuxSettings,
    outputSettings: {
      ...outputSettings,
      ...(recipe.namingPattern?.trim() ? { namingPattern: recipe.namingPattern.trim() } : {}),
      ...(recipe.destination !== undefined ? { directory: recipe.destination } : {}),
      ...(recipe.overwriteExisting !== undefined ? { overwriteExisting: recipe.overwriteExisting } : {}),
    },
  };
}

// ---------------------------------------------------------------- episode names

/** Season and episode read from a name: `episodeKey`'s shape, plus where the marker sits. */
export interface EpisodeKey {
  season?: number;
  episode?: number;
  episodeEnd?: number;
  confidence: number;
  /** Where in the file's stem the episode marker starts; the show name is before it. */
  index?: number;
}

export type EpisodeParser = (path: string) => EpisodeKey;

const SEASON_FOLDER = /^(?:season|series|staffel|saison|temporada|stagione)[\s._-]*(\d{1,3})$|^s(\d{1,3})$/i;

const splitPath = (path: string) => path.split(/[\\/]/).filter(Boolean);
const stemOf = (name: string) => name.replace(/\.[^.\\/]+$/, "");

/** A small season/episode reader. Naming takes season and episode from the
 *  app's `episodeKey` (the same reading pairing uses) and only asks this one
 *  where the episode marker sits, which `episodeKey` doesn't say, to find the
 *  show name before it. It also stands in when `episodeKey` finds nothing. */
export function localEpisodeKey(path: string): EpisodeKey {
  const parts = splitPath(path);
  const stem = stemOf(parts[parts.length - 1] ?? "");
  const folderSeason = (() => {
    const parent = parts[parts.length - 2];
    const match = parent?.match(SEASON_FOLDER);
    return match ? Number(match[1] ?? match[2]) : undefined;
  })();

  const sxe = /(?:^|[^a-z0-9])s(\d{1,3})[\s._-]?e(\d{1,4})(?:[\s._-]?-?[\s._-]?e(\d{1,4}))?(?![0-9])/i.exec(stem);
  if (sxe) {
    const end = sxe[3] ? Number(sxe[3]) : undefined;
    return { season: Number(sxe[1]), episode: Number(sxe[2]), ...(end && end > Number(sxe[2]) ? { episodeEnd: end } : {}), confidence: 1, index: sxe.index + (sxe[0].match(/^[^a-z0-9]/i) ? 1 : 0) };
  }
  const nx = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9a-z])/i.exec(stem);
  if (nx) return { season: Number(nx[1]), episode: Number(nx[2]), confidence: 0.9, index: nx.index + (nx[0].match(/^[^a-z0-9]/i) ? 1 : 0) };

  const episodeOnly: RegExp[] = [
    /(?:^|[^a-z0-9])(?:episode|ep|e)[\s._-]?(\d{1,4})(?![0-9])/i,
    /第\s*(\d{1,4})\s*[話话集回]/,
    /\s-\s(\d{1,4})(?:v\d)?(?=$|[\s.[(])/i,
    /\[(\d{1,4})(?:v\d)?\]/,
  ];
  for (const pattern of episodeOnly) {
    const match = pattern.exec(stem);
    if (match) {
      return { ...(folderSeason !== undefined ? { season: folderSeason } : {}), episode: Number(match[1]), confidence: 0.7, index: match.index + (match[0].match(/^[^a-z0-9[第\s]/i) ? 1 : 0) };
    }
  }
  return { ...(folderSeason !== undefined ? { season: folderSeason } : {}), confidence: 0 };
}

/** The episode key naming uses: `episodeKey`'s season and episode, and where
 *  the marker sits in the name from `localEpisodeKey`. */
export function namingEpisodeKey(path: string): EpisodeKey {
  const local = localEpisodeKey(path);
  const shared = episodeKey(path);
  if (shared.episode === undefined) return local;
  return {
    ...(shared.season !== undefined ? { season: shared.season } : {}),
    episode: shared.episode,
    ...(shared.episodeEnd !== undefined ? { episodeEnd: shared.episodeEnd } : {}),
    confidence: shared.confidence,
    ...(local.index !== undefined ? { index: local.index } : {}),
  };
}

/** Release-group tags at the front: "[SubsPlease] ", "[Erai-raws] ". */
const LEADING_TAGS = /^(?:\s*\[[^\]]*\]\s*)+/;

function tidyShow(raw: string): string {
  return raw
    .replace(LEADING_TAGS, "")
    .replace(/[._]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s\-–[(]+$/g, "")
    .trim();
}

/** The show's name from a file: the words before the episode marker, else
 *  the folder (the one above "Season 1" when the file is in a season folder). */
export function showNameFrom(path: string, key: EpisodeKey = namingEpisodeKey(path)): string {
  const parts = splitPath(path);
  const stem = stemOf(parts[parts.length - 1] ?? "");
  if (key.index !== undefined && key.index > 0) {
    const show = tidyShow(stem.slice(0, key.index));
    if (show) return show;
  }
  const folders = parts.slice(0, -1);
  let folder = folders[folders.length - 1];
  if (folder && SEASON_FOLDER.test(folder)) folder = folders[folders.length - 2];
  // A drive ("C:") is not a show.
  return folder && !/^[a-z]:$/i.test(folder) ? tidyShow(folder) : "";
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** "S01E02", "S01E01-E02"; "E12" without a season; "" without an episode. */
export function formatEpisode(key: EpisodeKey): string {
  if (key.episode === undefined) return "";
  const end = key.episodeEnd !== undefined ? `-E${pad2(key.episodeEnd)}` : "";
  return key.season !== undefined ? `S${pad2(key.season)}E${pad2(key.episode)}${end}` : `E${pad2(key.episode)}${end}`;
}

export type NamingToken = "show" | "season" | "episode" | "original_filename";

const KNOWN_TOKENS = /\{(show|season|episode|original_filename|filename|name|extension|id)\}/gi;

/** Whether a pattern needs resolving in the frontend: main.rs only knows
 *  {original_filename} {filename} {name} {extension} {id}. */
export function usesEpisodeTokens(pattern: string | undefined): boolean {
  return /\{(show|season|episode)\}/i.test(pattern ?? "");
}

/** The same clean-up main.rs applies to a rendered name (`sanitize_file_stem`). */
export function sanitizeFileStem(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/^\.+|\.+$/g, "");
  return cleaned || "output";
}

export interface ResolvedName {
  /** The output file name without ".mkv". */
  stem: string;
  /** Tokens that couldn't be filled. When any is missing the stem falls back
   *  to the original file name, so two episodes never collapse into one name. */
  missing: NamingToken[];
}

/** One video's output name from a pattern. `show` overrides the name read from the file. */
export function resolveOutputName(
  pattern: string | undefined,
  video: Pick<VideoFile, "id" | "name" | "path">,
  { show, parseEpisode = namingEpisodeKey }: { show?: string; parseEpisode?: EpisodeParser } = {},
): ResolvedName {
  const raw = pattern?.trim() || "{original_filename}";
  const original = stemOf(video.name || splitPath(video.path).pop() || "");
  const extension = (/\.([^.]+)$/.exec(video.name)?.[1] ?? "mkv");
  const key = parseEpisode(video.path || video.name);
  const values: Record<string, string> = {
    show: show?.trim() || showNameFrom(video.path || video.name, key),
    season: key.season !== undefined ? pad2(key.season) : "",
    episode: formatEpisode(key),
    original_filename: original,
    filename: original,
    name: original,
    extension,
    id: video.id,
  };
  const missing = new Set<NamingToken>();
  const rendered = raw.replace(KNOWN_TOKENS, (_, token: string) => {
    const name = token.toLowerCase();
    if (!values[name] && (name === "show" || name === "season" || name === "episode")) missing.add(name);
    return values[name];
  });
  if (missing.size) return { stem: sanitizeFileStem(original), missing: [...missing] };
  return { stem: sanitizeFileStem(rendered.replace(/\s{2,}/g, " ")), missing: [] };
}

/** Every video's output name, with the ones that would collide. Names
 *  compare case-insensitively, as on Windows. */
export function resolveOutputNames(
  videos: Array<Pick<VideoFile, "id" | "name" | "path">>,
  pattern: string | undefined,
  options: { show?: string; parseEpisode?: EpisodeParser } = {},
): { names: Record<string, ResolvedName>; collisions: string[][] } {
  const names: Record<string, ResolvedName> = {};
  const byStem = new Map<string, string[]>();
  for (const video of videos) {
    const resolved = resolveOutputName(pattern, video, options);
    names[video.id] = resolved;
    const key = resolved.stem.toLowerCase();
    byStem.set(key, [...(byStem.get(key) ?? []), video.id]);
  }
  return { names, collisions: [...byStem.values()].filter((ids) => ids.length > 1) };
}

// ---------------------------------------------------------------- measurement policy

export type PolicyDecision =
  | { kind: "apply" }
  | { kind: "conform" }
  | { kind: "review"; reason: string }
  | { kind: "skip"; reason: string };

const hasTimelineCuts = (m: MeasuredDelay) => Boolean(m.timeline && !m.timeline.error && m.timeline.cuts.length > 0);

/** What the policy does with one measured delay (a file's, or one track's).
 *  Only a clean result is applied unasked: no error, confidence at or over the
 *  threshold, no cut, no drift or frame-rate change (a delay alone can't fix
 *  those), no engine warning, a plausible size. A cut is conformed when the
 *  policy says so; everything else is left for the user. */
export function decideMeasured(measured: MeasuredDelay | undefined, pending: number | undefined, policy: MeasurementPolicy): PolicyDecision {
  if (!measured) return { kind: "skip", reason: "Not measured" };
  if (measured.error) return { kind: "review", reason: "Measurement failed" };
  if (isBlockingCut(measured) || hasTimelineCuts(measured)) {
    return policy.autoConformCuts ? { kind: "conform" } : { kind: "review", reason: "Different cut" };
  }
  const confidence = measured.confidence ?? 0;
  if (confidence < policy.autoApplyMinConfidence) return { kind: "review", reason: `Confidence under ${Math.round(policy.autoApplyMinConfidence * 100)}%` };
  if (measured.isRateMismatch || measured.hasSignificantDrift) return { kind: "review", reason: "Drifts" };
  if (Math.abs(measured.engineDelayMs) > MAX_PLAUSIBLE_OFFSET_MS) return { kind: "review", reason: "Implausible delay" };
  if (measured.warnings?.length) return { kind: "review", reason: measured.warnings[0] };
  if (pending === undefined) return { kind: "skip", reason: "Already applied" };
  if (!policy.autoApply) return { kind: "review", reason: "Waiting for Apply" };
  return { kind: "apply" };
}

export interface PolicyTarget {
  fileId: string;
  /** null: the file's own delay; a number: that track's. */
  trackId: number | null;
}

export interface PolicyPlan {
  apply: PolicyTarget[];
  /** Files to conform, once each (conforming works on the whole file). */
  conform: string[];
  review: Array<PolicyTarget & { reason: string }>;
}

/** Why a file measured as a different cut can't be conformed (null: it can):
 *  more than one audio track muxed from it, or subtitles it brings along
 *  that the conformed file, one audio track, would leave out of the mux. */
function conformRefused(file: ExternalFile): string | null {
  if (includedAudioTrackIndices(file).length > 1) return "Different cut in a file with several audio tracks";
  const blocker = fileConformBlocker(file);
  return blocker ? `Different cut. ${blocker}` : null;
}
const isGap = (file: ExternalFile) => (file as ExternalFile & { placeholder?: boolean }).placeholder === true || !file.path;

/** Sort every measured row of these files by what the policy does with it. */
export function planMeasurementPolicy(files: ExternalFile[], policy: MeasurementPolicy): PolicyPlan {
  const plan: PolicyPlan = { apply: [], conform: [], review: [] };
  for (const file of files) {
    if (isGap(file)) continue;
    const entries: Array<{ trackId: number | null; measured?: MeasuredDelay; pending?: number }> = [
      { trackId: null, measured: file.measuredDelay, pending: file.pendingDelay },
      ...Object.entries(file.trackOverrides ?? {}).map(([id, override]) => ({ trackId: Number(id), measured: override.measuredDelay, pending: override.pendingDelay })),
    ];
    for (const entry of entries) {
      if (entry.trackId !== null && !Number.isFinite(entry.trackId)) continue;
      const decision = decideMeasured(entry.measured, entry.pending, policy);
      const target = { fileId: file.id, trackId: entry.trackId };
      if (decision.kind === "apply") plan.apply.push(target);
      else if (decision.kind === "review") plan.review.push({ ...target, reason: decision.reason });
      else if (decision.kind === "conform") {
        const refused = conformRefused(file);
        if (refused) plan.review.push({ ...target, reason: refused });
        else if (!plan.conform.includes(file.id)) plan.conform.push(file.id);
      }
    }
  }
  return plan;
}

/** Apply what the policy applies; returns the files (unchanged ones keep their identity) and the plan. */
export function applyMeasurementPolicy(files: ExternalFile[], policy: MeasurementPolicy): { files: ExternalFile[]; plan: PolicyPlan } {
  const plan = planMeasurementPolicy(files, policy);
  if (plan.apply.length === 0) return { files, plan };
  const byFile = new Map<string, Array<number | null>>();
  plan.apply.forEach(({ fileId, trackId }) => byFile.set(fileId, [...(byFile.get(fileId) ?? []), trackId]));
  return {
    plan,
    files: files.map((file) => (byFile.get(file.id) ?? []).reduce<ExternalFile>((next, trackId) => applyMeasuredDelay(next, trackId), file)),
  };
}
