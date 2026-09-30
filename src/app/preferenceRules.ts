/** The rules behind Preferences, apart from its drawing so they can be
 *  tested: the measurement limits, how a preset is written back, and the
 *  file-type choices. They are the old Options dialog's, unchanged. */

import type { MeasurementSettings, Preset } from "@/shared/types";
import { ENGINE_DEFAULTS, ENGINE_LIMITS } from "@/shared/types/audiosync";

export function clampInt(raw: string | number, min: number, max: number, fallback: number): number {
  const value = Math.round(Number(raw));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export const clampWindowCount = (raw: string | number) =>
  clampInt(raw, ENGINE_LIMITS.windowCount.min, ENGINE_LIMITS.windowCount.max, ENGINE_DEFAULTS.windowCount);
export const clampWindowSeconds = (raw: string | number) =>
  clampInt(raw, ENGINE_LIMITS.windowSeconds.min, ENGINE_LIMITS.windowSeconds.max, ENGINE_DEFAULTS.windowSeconds);
export const clampMaxOffsetSeconds = (raw: string | number) =>
  clampInt(raw, ENGINE_LIMITS.maxOffsetSeconds.min, ENGINE_LIMITS.maxOffsetSeconds.max, ENGINE_DEFAULTS.maxOffsetMs / 1000);

/** Measurement as it is saved: every value inside the engine's limits. */
export function clampMeasurement(measurement: MeasurementSettings): MeasurementSettings {
  return {
    windowCount: clampWindowCount(measurement.windowCount),
    windowSeconds: clampWindowSeconds(measurement.windowSeconds),
    maxOffsetMs: clampMaxOffsetSeconds(measurement.maxOffsetMs / 1000) * 1000,
    fullTimeline: measurement.fullTimeline ?? false,
  };
}

/** Whether measurement differs from AudioSyncMaster's defaults, in which case
 *  the two apps only agree if AudioSyncMaster uses the same values. */
export const differsFromEngine = (m: MeasurementSettings) =>
  m.windowCount !== ENGINE_DEFAULTS.windowCount || m.windowSeconds !== ENGINE_DEFAULTS.windowSeconds || m.maxOffsetMs !== ENGINE_DEFAULTS.maxOffsetMs;

/** The file types a scan looks for, per kind: the choices the old dialog offered. */
export const FILE_TYPE_CHOICES = {
  video: ["mkv,avi,mp4,m4v,mov", "mkv,mp4", "mkv"],
  subtitle: ["ass,srt,ssa,sup,pgs", "ass,srt", "srt"],
  audio: ["aac,ac3,flac,eac3,mka", "aac,ac3", "flac"],
  chapter: ["xml", "txt", "ogm"],
} as const;

/** "mkv,avi" → "MKV, AVI", for a choice's label. */
export const fileTypeLabel = (value: string) => value.toUpperCase().split(",").join(", ");

/** "mkv, AVI ," → ["MKV", "AVI"]: how a choice is saved. */
export const toExtensions = (value: string) =>
  value
    .split(",")
    .map((ext) => ext.trim().toUpperCase())
    .filter(Boolean);

/** What the Presets tab edits. */
export interface PresetForm {
  videosDir: string;
  subtitlesDir: string;
  audiosDir: string;
  chaptersDir: string;
  attachmentsDir: string;
  destinationDir: string;
  videoExtensions: string;
  subtitleExtensions: string;
  audioExtensions: string;
  chapterExtensions: string;
  subtitleLanguage: string;
  audioLanguage: string;
}

export function formFromPreset(preset: Preset): PresetForm {
  return {
    videosDir: preset.Default_Video_Directory || "",
    subtitlesDir: preset.Default_Subtitle_Directory || "",
    audiosDir: preset.Default_Audio_Directory || "",
    chaptersDir: preset.Default_Chapter_Directory || "",
    attachmentsDir: preset.Default_Attachment_Directory || "",
    destinationDir: preset.Default_Destination_Directory || "",
    videoExtensions: (preset.Default_Video_Extensions || []).join(",").toLowerCase(),
    subtitleExtensions: (preset.Default_Subtitle_Extensions || []).join(",").toLowerCase(),
    audioExtensions: (preset.Default_Audio_Extensions || []).join(",").toLowerCase(),
    chapterExtensions: (preset.Default_Chapter_Extensions || []).join(",").toLowerCase(),
    subtitleLanguage: preset.Default_Subtitle_Language || "eng",
    audioLanguage: preset.Default_Audio_Language || "hin",
  };
}

/** A language moves to the front of its favourites when it becomes the default. */
export const withFavoriteFirst = (value: string, list: string[]) => [value, ...list.filter((item) => item !== value)];

export function presetFromForm(existing: Preset, form: PresetForm): Preset {
  return {
    ...existing,
    Default_Video_Directory: form.videosDir,
    Default_Subtitle_Directory: form.subtitlesDir,
    Default_Audio_Directory: form.audiosDir,
    Default_Chapter_Directory: form.chaptersDir,
    Default_Attachment_Directory: form.attachmentsDir,
    Default_Destination_Directory: form.destinationDir,
    Default_Video_Extensions: toExtensions(form.videoExtensions),
    Default_Subtitle_Extensions: toExtensions(form.subtitleExtensions),
    Default_Audio_Extensions: toExtensions(form.audioExtensions),
    Default_Chapter_Extensions: toExtensions(form.chapterExtensions),
    Default_Subtitle_Language: form.subtitleLanguage,
    Default_Audio_Language: form.audioLanguage,
    Default_Favorite_Subtitle_Languages: withFavoriteFirst(form.subtitleLanguage, existing.Default_Favorite_Subtitle_Languages || []),
    Default_Favorite_Audio_Languages: withFavoriteFirst(form.audioLanguage, existing.Default_Favorite_Audio_Languages || []),
  };
}
