/** Types crossing the engine boundary for conforming dubs to another cut and for measuring
 *  subtitle delays (src-tauri/src/conform.rs, src-tauri/src/subsync.rs).
 *  Field names match the Rust structs exactly — renaming one silently turns a value into `undefined`. */

import type { MeasurePair, TimelinePlan } from "./audiosync";

// ------------------------------------------------------------------ conform

/** render: the engine writes the dub laid on the video's cut, to the sample, re-encoded and checked
 *  by the engine itself. lossless: MKVBatchMux cuts the dub's own frames (mkvmerge) and fills what
 *  the dub lacks with silence in its codec; each stretch lands within half a codec frame (16 ms for
 *  AC-3/E-AC-3, 11 ms for AAC), and the result is planned against the video again. */
export type ConformMode = "render" | "lossless";

/** same: the dub's own codec at its own bitrate (FLAC when there is no encoder for it, e.g. TrueHD,
 *  DTS). flac: always FLAC. Only render mode re-encodes; lossless keeps the dub's frames. */
export type ConformCodec = "same" | "flac";

/** Where conformed files go when `outputDir` is null: this folder beside each dub. */
export const CONFORMED_FOLDER = "MKVBatchMux conformed";

export const CONFORM_DEFAULTS = {
  mode: "render",
  codec: "same",
  outputDir: null,
  maxWorkers: 2,
} as const satisfies { mode: ConformMode; codec: ConformCodec; outputDir: string | null; maxWorkers: number };

export interface ConformRequest {
  runId: string;
  /** Video as primary, dub as secondary, exactly as measurement builds them: `primaryTrack` and
   *  `secondaryTrack` are audio-stream indexes (the N of `0:a:N`), and `key` comes back on every event. */
  pairs: MeasurePair[];
  mode: ConformMode;
  codec: ConformCodec;
  /** Null: `CONFORMED_FOLDER` beside each dub. The source dub is never written to. */
  outputDir: string | null;
  maxWorkers: number;
}

/** `percent` is of the current stage for render; lossless spreads its stages over 0–100
 *  (planning 0–50, cutting 50–70, checking 70–100). `processed` counts pairs with a result. */
export interface ConformProgressEvent {
  runId: string;
  key: string | null;
  percent: number;
  stage: string | null;
  processed: number;
  total: number;
}

export interface ConformResultEvent {
  runId: string;
  key: string | null;
  /** The new file: `<dub stem>[.trackN].conformed.mka` (lossless) or `.conformed.<codec ext>` (render,
   *  e.g. `.eac3`, `.m4a`, `.flac`). Null when nothing was written. */
  outputPath: string | null;
  /** How it was actually written: a lossless request the dub could not take comes back "render",
   *  with `fallbackReason`. */
  mode: ConformMode;
  /** ffprobe's codec name of the written track ("eac3", "aac", "flac"…). */
  codec: string | null;
  /** True: checked and within tolerance (render: every measured spot within 45 ms; lossless: every
   *  stretch within one codec frame). False: checked and out. Null: could not be checked. */
  verified: boolean | null;
  /** The check, in words, ready to show. */
  verificationText: string | null;
  /** The check's largest offset left, engine convention (positive = the dub plays late), in ms. */
  residualMs: number | null;
  /** The engine's Dub sync plan the dub was conformed from: what the timeline scan shows. */
  plan: TimelinePlan | null;
  /** The plan as the engine's own text table. */
  description: string | null;
  error: string | null;
  /** Why a lossless request was rendered instead ("The dub runs at another speed…", "FLAC is
   *  lossless, so the engine writes it to the sample instead"…). */
  fallbackReason: string | null;
}

/** The terminal event of a conform or subtitle-sync run. A run the remote lock stopped ends with an
 *  `error` saying so; what it finished keeps its result. */
export interface EngineRunDoneEvent {
  runId: string;
  cancelled: boolean;
  error: string | null;
}

/** What an `ExternalFile` keeps once conformed (contract: `ExternalFile.conformed`). A conformed
 *  file muxes `path` (one track, id 0) with delay 0 instead of its own path, track and delay. */
export interface ConformedTrack {
  path: string;
  mode: ConformMode;
  codec: string | null;
  verified: boolean | null;
  verificationText: string | null;
  residualMs: number | null;
  /** The audio-stream index of the original file the track was made from. */
  sourceTrack: number;
  /** ISO 8601. */
  createdAt: string;
}

// ------------------------------------------------------------------ subtitle sync

/** audio: speech in the video's audio track (any language; the default). subtitle: a correctly
 *  timed subtitle track inside the video, as the reference. */
export type SubsyncEngine = "audio" | "subtitle";

/** Where re-timed copies go when `outputDir` is null: this folder beside each subtitle. */
export const SYNCED_FOLDER = "MKVBatchMux synced";

export const SUBSYNC_DEFAULTS = {
  engine: "audio",
  maxOffsetS: 60,
  detectFramerate: true,
  allowSplits: true,
  outputDir: null,
  maxWorkers: 2,
} as const satisfies Omit<SubsyncRequest, "runId" | "jobs">;

export interface SubsyncJob {
  /** Comes back on every event for this subtitle. */
  key: string;
  subtitlePath: string;
  /** For a subtitle inside a container (.mks/.mkv): its subtitle-stream index (the N of `0:s:N`). */
  subtitleTrack?: number | null;
  videoPath: string;
  /** The video's audio stream to listen to (the N of `0:a:N`), for the audio engine. */
  audioTrack: number;
  /** For the subtitle engine: the video's subtitle stream to sync against, as a subtitle-stream index
   *  (the N of `0:s:N`, counting subtitle tracks only). Null takes the first. */
  referenceTrack: number | null;
  /** The subtitle is Blu-ray pictures (PGS): synced by when they are shown. */
  subtitlePictures?: boolean;
  /** The reference track inside the video is PGS. */
  referencePictures?: boolean;
}

export interface SubsyncRequest {
  runId: string;
  jobs: SubsyncJob[];
  engine: SubsyncEngine;
  /** Largest shift searched, in seconds. */
  maxOffsetS: number;
  /** Also try 23.976/24/25/29.97/30 conversions and keep the best. */
  detectFramerate: boolean;
  /** Allow different offsets for different scenes (cut or extended edits). */
  allowSplits: boolean;
  /** Null: `SYNCED_FOLDER` beside each subtitle. */
  outputDir: string | null;
  maxWorkers: number;
}

export interface SubsyncProgressEvent {
  runId: string;
  key: string | null;
  percent: number;
  stage: string | null;
  processed: number;
  total: number;
}

/** Where the offset changes, for a subtitle timed for a release with other edits. */
export interface SubsyncSplitPoint {
  /** Position on the video. */
  atS: number;
  /** The delay from there on, same convention as `offsetS`. */
  offsetS: number;
}

/** One subtitle's measurement.
 *
 *  Sign convention: the engine maps `video time = ratio × subtitle time + offset`, and a positive
 *  offset moves the subtitle later. So `offsetS` is already **the delay to add to the subtitle so it
 *  lines up** (MKVBatchMux's delay field, mkvmerge's `--sync`), with no negation — unlike audio,
 *  whose engine delay is negated. A subtitle that shows 2.5 s late measures `offsetS: -2.5`. */
export interface SubsyncResultEvent {
  runId: string;
  key: string | null;
  /** Null when nothing clear was found (`applied` false) or on error. With `ratio` ≠ 1 it is the
   *  offset after scaling; with splits, the offset from the start of the video. */
  offsetS: number | null;
  /** 25/23.976 ≈ 1.0427 for a subtitle timed for PAL speed; 1 for a pure delay. */
  ratio: number | null;
  /** How many places the offset changes. */
  splits: number;
  /** 0–1: how clearly the match stood out, times how much of the subtitle landed on speech. */
  score: number | null;
  /** The engine that measured it: "audio" | "subtitle". */
  method: string | null;
  /** The engine's sentence: what it did and how sure it is. */
  description: string | null;
  /** The engine's re-timed copy, in the output folder. Null when nothing was moved. */
  retimedPath: string | null;
  /** "Can't be synced automatically: …" for picture subtitles (PGS/VobSub), or the engine's error. */
  error: string | null;
  /** False when no match was clear enough to act on. */
  applied: boolean;
  confidence: "high" | "medium" | "low" | null;
  /** e.g. "25 → 23.976" when a frame-rate conversion was found. */
  framerate: string | null;
  splitPoints: SubsyncSplitPoint[];
  warnings: string[];
}

/** What an `ExternalFile` keeps when its fix is the engine's re-timed copy (contract:
 *  `ExternalFile.retimed`), muxed instead of the original with delay 0. */
export interface RetimedSubtitle {
  path: string;
  offsetS: number;
  ratio: number;
  splits: number;
  score: number | null;
}
