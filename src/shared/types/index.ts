import type { DelayProvenance, MeasuredDelay, StretchSetting } from "./audiosync";
import type { ConformCodec, ConformMode, ConformedTrack, RetimedSubtitle, SubsyncEngine } from "./engineFeatures";
import type { VerificationReport } from "./verify";

export type { DelayProvenance, MeasuredDelay, StretchSetting };

/** A dub laid onto its video's cut (Conform, on the Audio page). */
export interface ConformedFile extends ConformedTrack {
  /** The video it was laid onto: a copy made for one video is no use with
   *  another, so the mux takes the original when the pairing has changed. */
  videoPath?: string;
  /** Why a lossless request was rendered instead. */
  fallbackReason?: string | null;
}

/** A subtitle's re-timed copy, made by Sync subtitles. */
export interface RetimedFile extends RetimedSubtitle {
  /** The video it was timed to; see `ConformedFile.videoPath`. */
  videoPath?: string;
}

/** What Sync subtitles found for a subtitle file. */
export interface SubtitleSync {
  /** "subtitle": against a text subtitle track inside the video, which
   *  measures to the millisecond; "audio": against the video's speech. */
  engine: SubsyncEngine;
  videoPath: string;
  videoName: string;
  /** The video's subtitle stream (subtitle engine) or audio stream (audio
   *  engine) it was measured against: the N of `0:s:N` / `0:a:N`. */
  referenceTrack: number;
  /** What to do with it: a delay, the re-timed copy, or nothing. */
  outcome: "delay" | "retimed" | "noMatch" | "error" | "picture";
  /** The delay to add, in seconds (the engine's offset, not negated). */
  offsetS: number | null;
  ratio: number | null;
  splits: number;
  score: number | null;
  confidence: "high" | "medium" | "low" | null;
  /** Shown, not filled in: the match was not sure enough (Apply anyway). */
  held: boolean;
  /** The engine's sentence, or why nothing was measured. */
  description: string | null;
  framerate: string | null;
  warnings: string[];
  /** The engine's re-timed copy, used when `outcome` is "retimed". */
  retimedPath: string | null;
  /** ISO 8601. */
  measuredAt: string;
}

export interface VideoFile {
  id: string;
  name: string;
  path: string;
  size: number;
  duration?: string;
  /** Unrounded length in seconds. `duration` is rounded to whole seconds for
   *  display, which is too coarse to divide one length by another. */
  durationSeconds?: number;
  fps?: number;
  status: 'pending' | 'processing' | 'completed' | 'error';
  tracks: Track[];
}

export interface Track {
  id: string;
  type: 'video' | 'audio' | 'subtitle' | 'chapter';
  codec?: string;
  language?: string;
  name?: string;
  isDefault?: boolean;
  isForced?: boolean;
  bitrate?: number; // Bitrate in bits per second
  /** Audio channel count: 6 is 5.1. Absent in sessions saved before it was read. */
  channels?: number;
  action?: 'keep' | 'remove' | 'modify';
  originalName?: string;
  originalLanguage?: string;
  originalDefault?: boolean;
  originalForced?: boolean;
}

export interface ExternalFile {
  id: string;
  name: string;
  path: string;
  type: 'audio' | 'subtitle' | 'chapter' | 'attachment';
  source?: 'bulk' | 'per-file';
  language?: string;
  trackName?: string;
  delay?: number;
  isDefault?: boolean;
  isForced?: boolean;
  matchedVideoId?: string;
  size?: number;
  bitrate?: number;
  duration?: string;
  /** See `VideoFile.durationSeconds`. */
  durationSeconds?: number;
  trackId?: number;
  tracks?: Track[];
  includedTrackIds?: number[];
  includeSubtitles?: boolean;
  includedSubtitleTrackIds?: number[];
  includedSubtitlesDefault?: boolean;
  includedSubtitlesForced?: boolean;
  includedSubtitlesFirst?: boolean;
  trackOverrides?: Record<
    number,
    {
      language?: string;
      delay?: number;
      /** Per-track equivalent of the file-level pendingDelay. */
      pendingDelay?: number;
      trackName?: string;
      stretch?: StretchSetting;
      measuredDelay?: MeasuredDelay;
      delayProvenance?: DelayProvenance;
    }
  >;
  muxAfter?: string;
  isManuallyEdited?: boolean;
  /** The user picked this file's video pairing by hand. Automatic positional
   *  pairing leaves it alone from then on. */
  isManuallyLinked?: boolean;
  /** An empty row: the video in this row has no file, so the files after it
   *  stay beside their own videos (row n is file n, video n). No path, never
   *  muxed, measured or counted; every consumer of a file list skips it
   *  (`isPlaceholder` in matchUtils). */
  placeholder?: boolean;
  /** Paired with this video by listening (Match by audio): the engine heard
   *  the file in it with this confidence. Kept with the file, so pairing by
   *  episode leaves it there; dropped when the file leaves that video. */
  audioMatch?: { videoId: string; confidence: number };
  /** What a measurement produced for this file. Fields are optional so
   *  sessions/presets saved before measurement existed still load. */
  measuredDelay?: MeasuredDelay;
  /** Where `delay` came from. Absent is treated as 'none'. */
  delayProvenance?: DelayProvenance;
  /** A measured delay waiting to be accepted. Measuring writes here rather
   *  than to `delay`, so nothing reaches the mux until the user applies it. */
  pendingDelay?: number;
  /** Opt-in linear stretch for a frame-rate-converted track. */
  stretch?: StretchSetting;
  /** Audio: the dub conformed to its video's cut. Muxed instead of this
   *  file: its one track (id 0), with delay 0. Undo removes it. */
  conformed?: ConformedFile;
  /** Subtitle: the engine's re-timed copy (a frame-rate change or scene
   *  offsets), muxed instead of this file with delay 0. Undo removes it. */
  retimed?: RetimedFile;
  /** Subtitle: what Sync subtitles measured. */
  subsync?: SubtitleSync;
}

export interface OutputSettings {
  directory: string;
  namingPattern: string;
  overwriteExisting: boolean;
}

export interface MuxJob {
  id: string;
  videoFile: VideoFile;
  status: 'queued' | 'processing' | 'completed' | 'error' | 'stopped';
  progress: number;
  errorMessage?: string;
  sizeBefore?: number;
  sizeAfter?: number;
  startedAt?: number;
  etaSeconds?: number;
  previewCommand?: string;
  previewWarnings?: string[];
  /** Set while the finished output is being checked. */
  stage?: "verifying";
  /** What checking the output found, once the job has finished. */
  verification?: VerificationReport;
}

export interface Preset {
  Preset_Name: string;
  Default_Video_Directory: string;
  Default_Video_Extensions: string[];
  Default_Subtitle_Directory: string;
  Default_Subtitle_Extensions: string[];
  Default_Subtitle_Language: string;
  Default_Audio_Directory: string;
  Default_Audio_Extensions: string[];
  Default_Audio_Language: string;
  Default_Chapter_Directory: string;
  Default_Chapter_Extensions: string[];
  Default_Attachment_Directory: string;
  Default_Destination_Directory: string;
  Default_Favorite_Subtitle_Languages: string[];
  Default_Favorite_Audio_Languages: string[];
}

export interface MeasurementSettings {
  windowSeconds: number;
  windowCount: number;
  maxOffsetMs: number;
  /** Lay every pair along its whole timeline for cuts and frame-rate changes. Reads both files
   *  end to end, minutes per film, so absent means off. Replaces `scanTimeline`, whose saved
   *  `true` would otherwise keep the slow route on for everyone who ever pressed Save. */
  fullTimeline?: boolean;
  /** Call a step between the sample windows a different cut, and hold its delay back
   *  (AudioSyncMaster's Cut check, which is off there by default). Absent: on. */
  cutCheck?: boolean;
  /** Conforming a dub to another cut: "render" re-encodes it to the sample
   *  (the default), "lossless" cuts its own frames. Absent: render. */
  conformMode?: ConformMode;
  /** For render: the dub's own codec ("same", the default) or FLAC. */
  conformCodec?: ConformCodec;
  /** Where conformed dubs go; empty or absent: a "MKVBatchMux conformed"
   *  folder beside each dub. */
  conformOutputDir?: string | null;
}

export interface OptionsData {
  Presets: Preset[];
  Measurement?: MeasurementSettings;
  FavoritePresetId: number;
  Dark_Mode: boolean;
  Attachment_Expert_Mode_Info_Message_Show: boolean;
  Choose_Preset_On_Startup: boolean;
}

export interface MuxSettings {
  destinationDir: string;
  outputNamingPattern?: string;
  overwriteSource: boolean;
  addCrc: boolean;
  removeOldCrc: boolean;
  keepLogFile: boolean;
  abortOnErrors: boolean;
  maxParallelJobs: number;
  onlyKeepAudiosEnabled: boolean;
  onlyKeepSubtitlesEnabled: boolean;
  onlyKeepAudioLanguages: string[];
  onlyKeepSubtitleLanguages: string[];
  discardOldChapters: boolean;
  discardOldAttachments: boolean;
  allowDuplicateAttachments: boolean;
  attachmentsExpertMode: boolean;
  removeGlobalTags: boolean;
  makeAudioDefaultLanguage?: string;
  makeSubtitleDefaultLanguage?: string;
  useMkvpropedit: boolean;
  /** Check every output before it replaces the source or counts as done
   *  (src-tauri/src/verify.rs). Absent: off. Measuring the added audio again reads
   *  minutes of a film, so it is only done when asked for. */
  verifyOutput?: boolean;
  /** Also measure each added audio track against the source's audio inside the output. */
  verifySync?: boolean;
  /** How far an added audio track may sit from the source's audio and still pass. */
  verifySyncToleranceMs?: number;
}

export type NavigationSection = 
  | 'source-files'
  | 'source-tracks'
  | 'add-subtitles'
  | 'add-audio'
  | 'add-chapters'
  | 'attachments'
  | 'output';

export interface MuxPreviewPlan {
  video: string;
  output: string;
  audios: ExternalFile[];
  subtitles: ExternalFile[];
  chapters: ExternalFile[];
  attachments: ExternalFile[];
}

export interface MuxPreviewResult {
  jobId: string;
  command: string;
  warnings: string[];
  plan: MuxPreviewPlan;
}
