/** Applying a recipe to the workspace (File › Apply recipe): everything it
 *  would change, worked out first and shown as a list, then committed in one
 *  go. Nothing here touches state; `planRecipe` is pure. */

import type { MuxSettings, OutputSettings, Track, VideoFile } from "@/shared/types";
import type { Recipe, RuleChange, SlotTemplate } from "@/shared/types/recipes";
import { applyRecipeSettings, applyTrackRulesToAll, resolveOutputNames, usesEpisodeTokens, type ResolvedName } from "./recipes";
import { slotIdFor } from "./watchPipeline";

export interface RecipeWorkspace {
  videoFiles: VideoFile[];
  audioTracks: string[];
  audioTrackConfigs: Record<string, SlotTemplate>;
  subtitleTracks: string[];
  subtitleTrackConfigs: Record<string, SlotTemplate>;
  /** Real files (not empty rows) per slot, to know which slots a folder fills. */
  audioFileCounts: Record<string, number>;
  subtitleFileCounts: Record<string, number>;
  muxSettings: MuxSettings;
  outputSettings: OutputSettings;
}

export interface SlotPlan {
  kind: "audio" | "subtitle";
  slot: string;
  created: boolean;
  config: SlotTemplate;
  /** The slot has no files and the recipe names a folder: it is scanned. */
  scan: boolean;
}

export interface RecipePlan {
  recipe: Recipe;
  videoFiles: VideoFile[];
  ruleChanges: RuleChange[];
  muxSettings: MuxSettings;
  outputSettings: OutputSettings;
  slots: SlotPlan[];
  /** Every change, one line each, grouped for the dialog. */
  sections: { title: string; lines: string[] }[];
  /** Output names when the pattern uses episode tokens. */
  names: Record<string, ResolvedName> | null;
  /** Videos whose output names would be the same, by video name. */
  collisions: string[][];
  /** True when applying changes nothing. */
  empty: boolean;
}

const MUX_OPTION_LABELS: Partial<Record<keyof MuxSettings, string>> = {
  addCrc: "Add a CRC to each name",
  removeOldCrc: "Remove an old CRC from the name",
  keepLogFile: "Keep the log file",
  abortOnErrors: "Stop the batch on an error",
  maxParallelJobs: "Jobs at once",
  onlyKeepAudiosEnabled: "Keep only some audio languages",
  onlyKeepSubtitlesEnabled: "Keep only some subtitle languages",
  onlyKeepAudioLanguages: "Audio languages kept",
  onlyKeepSubtitleLanguages: "Subtitle languages kept",
  discardOldChapters: "Remove the source's chapters",
  discardOldAttachments: "Remove the source's attachments",
  allowDuplicateAttachments: "Allow duplicate attachments",
  attachmentsExpertMode: "Attachments expert mode",
  removeGlobalTags: "Remove global tags",
  makeAudioDefaultLanguage: "Default audio language",
  makeSubtitleDefaultLanguage: "Default subtitle language",
  useMkvpropedit: "Fast mux (mkvpropedit)",
  verifyOutput: "Verify each output",
  verifySync: "Check the sync of added audio",
  verifySyncToleranceMs: "Sync tolerance (ms)",
};

export const shown = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return "none";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  return String(value);
};

/** "Audio 2 (Commentary, eng)" for a change line. */
function trackLabel(video: VideoFile, trackId: string): string {
  const track = video.tracks?.find((item) => item.id === trackId);
  if (!track) return "a track";
  const sameType = (video.tracks ?? []).filter((item) => item.type === track.type);
  const number = sameType.indexOf(track) + 1;
  const type = { video: "Video", audio: "Audio", subtitle: "Subtitle", chapter: "Chapters" }[track.type as Track["type"]] ?? "Track";
  const detail = [track.originalName ?? track.name, track.originalLanguage ?? track.language].filter(Boolean).join(", ");
  return `${type} ${number}${detail ? ` (${detail})` : ""}`;
}

function changeText(change: RuleChange): string {
  switch (change.field) {
    case "keep":
      return change.to ? "kept" : "removed";
    case "default":
      return change.to ? "made default" : "no longer default";
    case "forced":
      return change.to ? "made forced" : "no longer forced";
    case "name":
      return `renamed "${shown(change.from)}" → "${shown(change.to)}"`;
    case "language":
      return `language ${shown(change.from)} → ${shown(change.to)}`;
  }
}

/** Track changes as lines, one per track, grouped under their video. Long
 *  lists are cut, saying how many more there are. */
export function describeRuleChanges(changes: RuleChange[], videos: VideoFile[], max = 40): string[] {
  const byTrack = new Map<string, RuleChange[]>();
  for (const change of changes) {
    const key = `${change.videoId}\u0000${change.trackId}`;
    byTrack.set(key, [...(byTrack.get(key) ?? []), change]);
  }
  const lines: string[] = [];
  for (const group of byTrack.values()) {
    const video = videos.find((item) => item.id === group[0].videoId);
    if (!video) continue;
    lines.push(`${video.name.replace(/\.[^.]+$/, "")} · ${trackLabel(video, group[0].trackId)}: ${group.map(changeText).join(", ")}`);
  }
  return lines.length > max ? [...lines.slice(0, max), `…and ${lines.length - max} more`] : lines;
}

const slotSummary = (config: SlotTemplate) => [config.language && config.language !== "und" ? config.language : null, config.trackName || null, config.isDefault ? "default" : null, config.sourceFolder || null].filter(Boolean).join(", ");

/** Everything applying `recipe` would change. Slots are filled, never taken
 *  away: a workspace slot the recipe doesn't name keeps its files. */
export function planRecipe(recipe: Recipe, ws: RecipeWorkspace): RecipePlan {
  const { files: videoFiles, changes: ruleChanges } = applyTrackRulesToAll(ws.videoFiles, recipe.trackRules);
  const { muxSettings, outputSettings } = applyRecipeSettings(recipe, ws.muxSettings, ws.outputSettings);

  const settingLines: string[] = [];
  for (const [key, value] of Object.entries(recipe.muxOptions ?? {}) as [keyof MuxSettings, unknown][]) {
    const before = ws.muxSettings[key];
    if (JSON.stringify(before) === JSON.stringify(value)) continue;
    settingLines.push(`${MUX_OPTION_LABELS[key] ?? key}: ${shown(before)} → ${shown(value)}`);
  }
  if (outputSettings.namingPattern !== ws.outputSettings.namingPattern) settingLines.push(`Output name: ${ws.outputSettings.namingPattern} → ${outputSettings.namingPattern}`);
  if (outputSettings.directory !== ws.outputSettings.directory) {
    const folder = (value: string) => value.trim() || "beside each source";
    settingLines.push(`Output folder: ${folder(ws.outputSettings.directory)} → ${folder(outputSettings.directory)}`);
  }
  if (outputSettings.overwriteExisting !== ws.outputSettings.overwriteExisting) settingLines.push(`Replace existing files: ${shown(ws.outputSettings.overwriteExisting)} → ${shown(outputSettings.overwriteExisting)}`);

  const slots: SlotPlan[] = [];
  const slotLines: string[] = [];
  for (const kind of ["audio", "subtitle"] as const) {
    const templates = kind === "audio" ? recipe.audioSlots : recipe.subtitleSlots;
    const tracks = kind === "audio" ? ws.audioTracks : ws.subtitleTracks;
    const configs = kind === "audio" ? ws.audioTrackConfigs : ws.subtitleTrackConfigs;
    const counts = kind === "audio" ? ws.audioFileCounts : ws.subtitleFileCounts;
    const label = kind === "audio" ? "Audio" : "Subtitles";
    templates.forEach((template, index) => {
      const { id, created } = slotIdFor(index, tracks);
      const before = configs[id];
      const scan = Boolean(template.sourceFolder.trim()) && !(counts[id] > 0) && ws.videoFiles.length > 0;
      if (!created && before && JSON.stringify({ ...before }) === JSON.stringify({ ...before, ...template }) && !scan) return;
      slots.push({ kind, slot: id, created, config: { ...template }, scan });
      const what = slotSummary(template) || "default settings";
      slotLines.push(`${label} ${id}${created ? " is added" : ""}: ${what}${scan ? " (its files are loaded from the folder)" : ""}`);
    });
  }

  const pattern = outputSettings.namingPattern;
  const resolved = usesEpisodeTokens(pattern) ? resolveOutputNames(videoFiles, pattern, { show: recipe.show }) : null;
  const nameOf = (id: string) => videoFiles.find((video) => video.id === id)?.name ?? id;
  const collisions = resolved ? resolved.collisions.map((ids) => ids.map(nameOf)) : [];
  const nameLines = resolved
    ? videoFiles.slice(0, 5).map((video) => `${video.name} → ${resolved.names[video.id].stem}.mkv${resolved.names[video.id].missing.length ? ` (no ${resolved.names[video.id].missing.join(", ")} in the name: kept as it was)` : ""}`)
    : [];
  if (resolved && videoFiles.length > 5) nameLines.push(`…and ${videoFiles.length - 5} more`);

  const sections = [
    { title: "Tracks", lines: describeRuleChanges(ruleChanges, ws.videoFiles) },
    { title: "Slots", lines: slotLines },
    { title: "Mux options and output", lines: settingLines },
    { title: "Output names", lines: nameLines },
  ].filter((section) => section.lines.length > 0);

  return {
    recipe,
    videoFiles,
    ruleChanges,
    muxSettings,
    outputSettings,
    slots,
    sections,
    names: resolved?.names ?? null,
    collisions,
    empty: ruleChanges.length === 0 && slots.length === 0 && settingLines.length === 0,
  };
}
