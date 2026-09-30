/** Demo fixtures: one season of a show (Goblin S01, 16 episodes), its Hindi
 *  dubs, English subtitles, chapter files and fonts, in the shapes the
 *  backend returns. The same titles and numbers as design/mockup/data.ts, so
 *  a demo screen and its mockup screen can be compared side by side. */

import type { ExternalFile, OptionsData, Track, VideoFile } from "@/shared/types";
import type { SyncResult } from "@/shared/types/audiosync";

export const SHOW_DIR = "D:\\Shows\\Goblin (2016)\\Season 1";
export const DUB_DIR = "D:\\Dubs\\Goblin Hindi";
export const SUB_DIR = "D:\\Subs\\Goblin";
export const CHAP_DIR = "D:\\Shows\\Goblin (2016)\\Chapters";
export const FONT_DIR = "D:\\Shows\\Goblin (2016)\\Fonts";
export const OUT_DIR = "D:\\Muxed\\Goblin (2016)";

const ep = (i: number) => String(i + 1).padStart(2, "0");
const DURATIONS = ["1:07:12", "1:05:48", "1:04:31", "1:06:02", "1:03:57", "1:08:40", "1:05:13", "1:02:44", "1:06:19", "1:07:55", "1:04:08", "1:05:36", "1:06:47", "1:03:22", "1:09:10", "1:12:03"];
const seconds = (clock: string) => clock.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
const GB = 1073741824;

export const EPISODES = 16;

function videoTracks(i: number): Track[] {
  const tracks: Track[] = [
    { id: "0", type: "video", codec: "AVC", language: "und", name: "1920×1080", isDefault: true },
    { id: "1", type: "audio", codec: "FLAC", language: "kor", name: "Stereo", isDefault: true, bitrate: 1_024_000 },
    { id: "2", type: "audio", codec: "AC-3", language: "kor", name: "Surround 5.1", bitrate: 640_000 },
    { id: "3", type: "subtitle", codec: "SRT", language: "eng", name: "Full", isDefault: true },
    { id: "4", type: "subtitle", codec: "SRT", language: "eng", name: "SDH" },
    { id: "5", type: "subtitle", codec: "ASS", language: "kor" },
  ];
  // E08 lost its second audio track and the SDH subtitles in its release.
  return i === 7 ? tracks.filter((t) => t.id !== "2" && t.id !== "4") : tracks;
}

export function videoFile(i: number, withTracks: boolean): VideoFile {
  const name = `Goblin.S01E${ep(i)}.1080p.BluRay.x264-HDEX.mkv`;
  return {
    id: `video-${ep(i)}`,
    name,
    path: `${SHOW_DIR}\\${name}`,
    size: Math.round((3.6 + ((i * 37) % 11) / 10) * GB),
    duration: withTracks ? DURATIONS[i] : undefined,
    durationSeconds: withTracks ? seconds(DURATIONS[i]) : undefined,
    fps: withTracks ? 23.976 : undefined,
    status: "pending",
    tracks: withTracks ? videoTracks(i).map((t) => ({ ...t, action: "keep" as const, originalName: t.name, originalLanguage: t.language, originalDefault: t.isDefault, originalForced: t.isForced })) : [],
  };
}

export const videoPaths = () => Array.from({ length: EPISODES }, (_, i) => videoFile(i, false).path);

export function dubFile(i: number, extra = false): ExternalFile {
  const name = extra ? "Goblin.S01E16.5.Special.Hindi.DDP5.1.eac3" : `Goblin.S01E${ep(i)}.Hindi.DDP5.1.eac3`;
  return {
    id: `dub-${extra ? "extra" : ep(i)}`,
    name,
    path: `${DUB_DIR}\\${name}`,
    type: "audio",
    size: (255 + ((i * 13) % 40)) * 1048576,
    duration: DURATIONS[i % EPISODES],
    durationSeconds: seconds(DURATIONS[i % EPISODES]) + (i === 8 ? 168 : 0),
    // E13's dub is a broken file with no audio stream in it.
    tracks: i === 12 ? [] : [{ id: "0", type: "audio", codec: "E-AC3", language: "hin", name: "Surround 5.1", bitrate: 640_000, isDefault: true }],
  };
}

export function subFile(i: number): ExternalFile {
  const name = `Goblin.S01E${ep(i)}.en.srt`;
  return { id: `sub-${ep(i)}`, name, path: `${SUB_DIR}\\${name}`, type: "subtitle", size: (38 + ((i * 7) % 9)) * 1024 };
}

export function chapterFile(i: number): ExternalFile {
  const name = `Goblin.S01E${ep(i)}.chapters.xml`;
  return { id: `chap-${ep(i)}`, name, path: `${CHAP_DIR}\\${name}`, type: "chapter", size: 2048 };
}

export const FONTS: ExternalFile[] = [
  { id: "font-1", name: "NotoSansKR-Bold.otf", path: `${FONT_DIR}\\NotoSansKR-Bold.otf`, type: "attachment", size: 4.1 * 1048576 },
  { id: "font-2", name: "NotoSansKR-Regular.otf", path: `${FONT_DIR}\\NotoSansKR-Regular.otf`, type: "attachment", size: 4.0 * 1048576 },
  { id: "font-3", name: "Arial Rounded MT Bold.ttf", path: `${FONT_DIR}\\Arial Rounded MT Bold.ttf`, type: "attachment", size: 64 * 1024 },
  { id: "font-4", name: "Goblin-cover.jpg", path: `${FONT_DIR}\\Goblin-cover.jpg`, type: "attachment", size: 312 * 1024 },
];

/** What the engine measures for each episode's dub: mostly the same 1.312 s
 *  offset, with one different cut, one frame-rate conversion, one weak match
 *  and one broken file, as the mockup shows. */
export function measureResult(i: number, videoName: string, audioName: string): SyncResult {
  const base: SyncResult = {
    videoFile: videoName,
    audioFile: audioName,
    delayMs: -1312,
    delayAtStartMs: null,
    confidence: 0.96 - (i % 4) * 0.01,
    driftMsPerS: null,
    totalDriftMs: null,
    hasSignificantDrift: false,
    startDelayMs: -1312,
    endDelayMs: -1312,
    windowsUsed: 6,
    windowsTotal: 6,
    error: null,
    elapsedMs: 9000 + i * 311,
    primaryFps: 23.976,
    method: "survey",
  };
  const special: Record<number, Partial<SyncResult>> = {
    2: { delayMs: -1296 },
    4: {
      isLikelyCut: true,
      confidence: 0.58,
      windowsUsed: 4,
      cutPositionS: 2467,
      cutMagnitudeMs: 12480,
      cutUncertaintyS: 2,
      hasSignificantDrift: true,
      driftMsPerS: 3.2,
    },
    5: { delayMs: -21 },
    7: { delayMs: -1304 },
    8: {
      delayMs: -840,
      isRateMismatch: true,
      hasSignificantDrift: true,
      driftMsPerS: 41.7,
      rateDiagnosis: {
        driftMsPerS: 41.7,
        speedRatio: 0.959,
        sourceFps: 25,
        targetFps: 23.976,
        isRateMismatch: true,
        isLikelyCut: false,
        cutPositionS: null,
        cutMagnitudeMs: null,
        explanation: "The dub was mastered at 25 fps (PAL) and the video plays at 23.976.",
        correctionRatio: 1.0427,
      },
    },
    10: { delayMs: 4176, confidence: 0.43, windowsUsed: 2 },
    12: { delayMs: null, confidence: null, windowsUsed: 0, error: "The dub has no audio stream" },
    13: { delayMs: -1288 },
  };
  return { ...base, ...(special[i] ?? {}) };
}

export const DEMO_OPTIONS: OptionsData = {
  Presets: [
    {
      Preset_Name: "Default",
      Default_Video_Directory: "D:\\Shows",
      Default_Video_Extensions: ["MKV", "AVI", "MP4", "M4V", "MOV"],
      Default_Subtitle_Directory: "D:\\Subs",
      Default_Subtitle_Extensions: ["ASS", "SRT", "SSA", "SUP", "PGS"],
      Default_Subtitle_Language: "eng",
      Default_Audio_Directory: "D:\\Dubs",
      Default_Audio_Extensions: ["AAC", "AC3", "FLAC", "EAC3", "MKA"],
      Default_Audio_Language: "hin",
      Default_Chapter_Directory: "",
      Default_Chapter_Extensions: ["XML"],
      Default_Attachment_Directory: "D:\\Fonts",
      Default_Destination_Directory: OUT_DIR,
      Default_Favorite_Subtitle_Languages: ["eng"],
      Default_Favorite_Audio_Languages: ["hin"],
    },
    {
      Preset_Name: "Anime",
      Default_Video_Directory: "D:\\Anime",
      Default_Video_Extensions: ["MKV"],
      Default_Subtitle_Directory: "D:\\Anime\\Subs",
      Default_Subtitle_Extensions: ["ASS", "SRT"],
      Default_Subtitle_Language: "eng",
      Default_Audio_Directory: "D:\\Anime\\Dubs",
      Default_Audio_Extensions: ["FLAC"],
      Default_Audio_Language: "jpn",
      Default_Chapter_Directory: "",
      Default_Chapter_Extensions: ["XML"],
      Default_Attachment_Directory: "D:\\Anime\\Fonts",
      Default_Destination_Directory: "D:\\Muxed\\Anime",
      Default_Favorite_Subtitle_Languages: ["eng"],
      Default_Favorite_Audio_Languages: ["jpn"],
    },
  ],
  Measurement: { windowSeconds: 45, windowCount: 6, maxOffsetMs: 60000, fullTimeline: false },
  FavoritePresetId: 0,
  Dark_Mode: true,
  Attachment_Expert_Mode_Info_Message_Show: true,
  Choose_Preset_On_Startup: false,
};

/** mkvmerge's own lines for a job, for the Output dock. */
export function muxLines(video: string, audio: string | null, out: string): string[] {
  return [
    "mkvmerge v88.0 ('All I Know') 64-bit",
    `'${video}': Using the demultiplexer for the format 'Matroska'.`,
    ...(audio ? [`'${audio}': Using the demultiplexer for the format 'AC-3'.`] : []),
    `The file '${out}' has been opened for writing.`,
  ];
}
