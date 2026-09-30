/* Sample data in the app's real formats: delays in seconds with the player's
 * sign (positive plays later), confidence bands High ≥ 75 / Medium ≥ 50 / Low,
 * ISO 639-2 language codes, and MKVToolNix's own output lines. Titles and
 * numbers are invented. */

export const SHOW_DIR = "D:\\Shows\\Goblin (2016)\\Season 1";
export const DUB_DIR = "D:\\Dubs\\Goblin Hindi";
export const SUB_DIR = "D:\\Subs\\Goblin";
export const CHAP_DIR = "D:\\Shows\\Goblin (2016)\\Chapters";
export const FONT_DIR = "D:\\Shows\\Goblin (2016)\\Fonts";
export const OUT_DIR = "D:\\Muxed\\Goblin (2016)";

const ep = (i: number) => String(i + 1).padStart(2, "0");

export interface Trk {
  type: "video" | "audio" | "subtitle";
  codec: string;
  lang: string;
  name?: string;
  def?: boolean;
  forced?: boolean;
  off?: boolean;
  kbps?: number;
}

export const TRACKS: Trk[] = [
  { type: "video", codec: "AVC", lang: "und", name: "1920×1080" },
  { type: "audio", codec: "FLAC", lang: "Korean", name: "Stereo", def: true, kbps: 1024 },
  { type: "audio", codec: "AC-3", lang: "Korean", name: "Surround 5.1", kbps: 640 },
  { type: "subtitle", codec: "SRT", lang: "English", name: "Full", def: true },
  { type: "subtitle", codec: "SRT", lang: "English", name: "SDH", off: true },
  { type: "subtitle", codec: "ASS", lang: "Korean" },
];

export interface Video {
  name: string;
  dur: string;
  fps: string;
  size: string;
  gb: number;
}

export const VIDEOS: Video[] = Array.from({ length: 16 }, (_, i) => ({
  name: `Goblin.S01E${ep(i)}.1080p.BluRay.x264-HDEX.mkv`,
  dur: ["1:07:12", "1:05:48", "1:04:31", "1:06:02", "1:03:57", "1:08:40", "1:05:13", "1:02:44", "1:06:19", "1:07:55", "1:04:08", "1:05:36", "1:06:47", "1:03:22", "1:09:10", "1:12:03"][i],
  fps: "23.976",
  size: `${(3.6 + ((i * 37) % 11) / 10).toFixed(2)} GB`,
  gb: 3.6 + ((i * 37) % 11) / 10,
}));

export type Measure =
  | { kind: "ok"; delay: string; conf: number; frames: number; applied?: boolean }
  | { kind: "cut"; delay: string; conf: number; at: string }
  | { kind: "rate"; delay: string; conf: number; from: string; to: string }
  | { kind: "weak"; delay: string; conf: number }
  | { kind: "fail"; err: string };

export interface Dub {
  name: string;
  size: string;
  m: Measure;
}

const OK = (delay: string, conf: number, frames: number): Measure => ({ kind: "ok", delay, conf, frames });

export const DUBS: Dub[] = Array.from({ length: 16 }, (_, i) => ({
  name: `Goblin.S01E${ep(i)}.Hindi.DDP5.1.eac3`,
  size: `${(255 + ((i * 13) % 40)).toFixed(0)} MB`,
  m: ([
    OK("+1.312", 96, 31),
    OK("+1.312", 95, 31),
    OK("+1.296", 94, 31),
    OK("+1.312", 96, 31),
    { kind: "cut", delay: "+1.312", conf: 58, at: "0:41:07" },
    OK("+0.021", 97, 1),
    OK("+1.312", 95, 31),
    OK("+1.304", 93, 31),
    { kind: "rate", delay: "+0.840", conf: 91, from: "25", to: "23.976" },
    OK("+1.312", 96, 31),
    { kind: "weak", delay: "−4.176", conf: 43 },
    OK("+1.312", 94, 31),
    { kind: "fail", err: "The dub has no audio stream" },
    OK("+1.288", 92, 31),
    OK("+1.312", 96, 31),
    OK("+1.312", 95, 31),
  ] as Measure[])[i],
}));

export const SUBS = Array.from({ length: 16 }, (_, i) => ({ name: `Goblin.S01E${ep(i)}.en.srt`, size: `${38 + ((i * 7) % 9)} KB` }));

export const CHAPTERS = Array.from({ length: 16 }, (_, i) => ({ name: `Goblin.S01E${ep(i)}.chapters.xml`, size: "2 KB" }));

export const FONTS = [
  { name: "NotoSansKR-Bold.otf", type: "OTF", size: "4.1 MB" },
  { name: "NotoSansKR-Regular.otf", type: "OTF", size: "4.0 MB" },
  { name: "Arial Rounded MT Bold.ttf", type: "TTF", size: "64 KB" },
  { name: "Goblin-cover.jpg", type: "JPG", size: "312 KB" },
];

export const OUTPUT: [string, string][] = [
  ["14:02:11", "Scanned 16 videos in D:\\Shows\\Goblin (2016)\\Season 1"],
  ["14:03:40", "Audio 1: 16 files from D:\\Dubs\\Goblin Hindi, paired by row"],
  ["14:05:02", "Measuring 16 pairs against the first audio track (6 × 45 s, 60 s)"],
  ["14:06:48", "E05: different cut, a scene is missing near 0:41:07"],
  ["14:06:51", "E13: failed: the dub has no audio stream"],
  ["14:07:30", "Measured 15 of 16 pairs in 2m 28s"],
  ["14:12:04", "Muxing 16 jobs, 4 at a time, into D:\\Muxed\\Goblin (2016)"],
  ["14:12:04", "mkvmerge v88.0 ('All I Know') 64-bit"],
  ["14:12:05", "'Goblin.S01E01.1080p.BluRay.x264-HDEX.mkv': Using the demultiplexer for the format 'Matroska'."],
  ["14:12:05", "'Goblin.S01E01.Hindi.DDP5.1.eac3': Using the demultiplexer for the format 'AC-3'."],
  ["14:12:05", "The file 'D:\\Muxed\\Goblin (2016)\\Goblin.S01E01.1080p.BluRay.x264-HDEX.mkv' has been opened for writing."],
  ["14:12:41", "Multiplexing took 36 seconds."],
  ["14:13:02", "Warning: 'Goblin.S01E04.en.srt': the subtitle ends after the video."],
  ["14:13:18", "Error: 'Goblin.S01E07.1080p.BluRay.x264-HDEX.mkv' could not be opened for reading: permission denied."],
];

export const HISTORY = [
  { page: "Mux", name: "Goblin.S01E01 and 15 more", res: "15 muxed, 1 failed", tone: "warn", when: "Today 14:18" },
  { page: "Audio", name: "Goblin.S01E01 and 15 more", res: "13 measured, 1 different cut, 1 weak match, 1 failed", tone: "warn", when: "Today 14:07" },
  { page: "Mux", name: "Mr. Sunshine.S01E01 and 23 more", res: "24 muxed", tone: "ok", when: "Yesterday 22:40" },
  { page: "Audio", name: "Mr. Sunshine.S01E01 and 23 more", res: "24 measured", tone: "ok", when: "Yesterday 22:12" },
  { page: "Mux", name: "Crash Landing on You.S01E01 and 15 more", res: "Stopped, 6 muxed", tone: "warn", when: "Sep 26 09:30" },
  { page: "Mux", name: "Vincenzo.S01E01 and 19 more", res: "20 muxed", tone: "ok", when: "Sep 21 18:02" },
];
