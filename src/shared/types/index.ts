import type { DelayProvenance, MeasuredDelay, StretchSetting } from "./audiosync";

export type { DelayProvenance, MeasuredDelay, StretchSetting };

export interface VideoFile {
  id: string;
  name: string;
  path: string;
  size: number;
  duration?: string;
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
  /** What a measurement produced for this file, kept so the row can keep
   *  explaining itself after a reload. Every field below is optional: sessions
   *  and presets saved before measurement existed must still load. */
  measuredDelay?: MeasuredDelay;
  /** Where `delay` came from. Absent is treated as 'none'. */
  delayProvenance?: DelayProvenance;
  /** A measured delay waiting to be accepted. Measuring writes here rather
   *  than to `delay`, so nothing reaches the mux until the user applies it. */
  pendingDelay?: number;
  /** Opt-in linear stretch for a frame-rate-converted track. */
  stretch?: StretchSetting;
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

export interface OptionsData {
  Presets: Preset[];
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
