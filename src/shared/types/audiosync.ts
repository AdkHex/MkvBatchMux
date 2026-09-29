/** Types crossing the AudioSync engine boundary.
 *  Field names match AudioSyncMaster's exactly — renaming any silently turns a value into `undefined`. */

export interface AudioTrackInfo {
  index: number;
  codec: string | null;
  language: string | null;
  title: string | null;
  channels: number | null;
  sampleRate: number | null;
  bitRate: number | null;
  isDefault: boolean;
  label: string;
}

export interface TrackListing {
  path: string;
  name: string;
  tracks: AudioTrackInfo[];
  fps: number | null;
  duration: number | null;
  error?: string | null;
}

/** Why a file drifts: a frame-rate conversion, or a different cut. */
export interface RateDiagnosis {
  /** Null when a cut left too few windows on one side to fit a line through. */
  driftMsPerS: number | null;
  speedRatio: number;
  sourceFps: number | null;
  targetFps: number | null;
  isRateMismatch: boolean;
  isLikelyCut: boolean;
  /** Where the offset jumps and by how much, once a splice has been located. */
  cutPositionS: number | null;
  cutMagnitudeMs: number | null;
  explanation: string;
  correctionRatio: number | null;
}

/** One measured pair, as returned by the engine. */
export interface SyncResult {
  videoFile: string;
  audioFile: string;
  primaryPath?: string | null;
  secondaryPath?: string | null;
  delayMs: number | null;
  /** Offset at t=0. With drift, delayMs is the midpoint value; a correction is
   *  applied from the start of the file and must use this instead. */
  delayAtStartMs: number | null;
  confidence: number | null;
  driftMsPerS: number | null;
  totalDriftMs: number | null;
  hasSignificantDrift: boolean | null;
  startDelayMs: number | null;
  endDelayMs: number | null;
  windowsUsed: number | null;
  windowsTotal: number | null;
  error: string | null;
  elapsedMs: number | null;
  primaryDurationS?: number | null;
  secondaryDurationS?: number | null;
  primaryTrack?: number | null;
  secondaryTrack?: number | null;
  primaryFps?: number | null;
  secondaryFps?: number | null;
  isLikelyCut?: boolean | null;
  /** Where the cut is in the video's timeline, how tightly that was pinned
   *  down, and how far the offset jumps there. Present only when isLikelyCut. */
  cutPositionS?: number | null;
  cutUncertaintyS?: number | null;
  cutMagnitudeMs?: number | null;
  isRateMismatch?: boolean | null;
  /** Playback-speed the engine undid during decoding so the two could be correlated; 1.0 means unmodified, ~1.0427 for a PAL-sped dub.
   *  Diagnostic only — drift and correctionRatio already describe the pair as the user has it. */
  speedCompensation?: number | null;
  codecDelayMs?: number | null;
  primaryCodec?: string | null;
  secondaryCodec?: string | null;
  rateDiagnosis?: RateDiagnosis | null;
  /** "survey": the sample windows alone, for a pair that is one offset throughout. "timeline": the
   *  dub laid along the whole video, because the survey saw a cut, drift, speed change or weak match. */
  method?: "survey" | "timeline" | null;
  /** Every place the dub departs from the video, from the timeline route; empty for a survey. */
  edits?: TimelineEdit[] | null;
  gaps?: TimelineGap[] | null;
  /** Things to check before trusting the delay: a damaged file, a weak survey, the same file twice. */
  warnings?: string[] | null;
  /** The frame-rate conversion the dub needs, when it runs at another speed. */
  rateGuide?: RateGuide | null;
  /** The whole-timeline plan the timeline route measured from, so it need not be scanned again. */
  timeline?: TimelinePlan | null;
  timelineDescription?: string | null;
}

/** One place the dub departs from the video, as the engine lists it however small. */
export interface TimelineEdit {
  index: number;
  /** "missing": the dub lacks part of the video. "extra": the dub has material the video does not.
   *  "replaced": a scene of the video is replaced in the dub by other material. */
  kind: "missing" | "extra" | "replaced";
  /** Under 1 s, under 30 s, or longer. Every edit is listed whatever its grade. */
  severity: "minor" | "moderate" | "major";
  videoS: number;
  videoEndS: number;
  /** Where it is in the dub file's own timeline. */
  dubS: number;
  dubEndS: number;
  /** How far the offset moves, engine convention: negative when the dub lacks material. */
  jumpMs: number;
  sizeMs: number;
  missingS: number;
  extraS: number;
  /** The size in the video's frames, when its frame rate is known. */
  frames: number | null;
  uncertaintyS: number;
  offsetBeforeMs: number;
  offsetAfterMs: number;
  shortestStretchS: number;
  /** Rests on a stretch of dub too short to rule out a repeated passage matched in the wrong place. */
  check: boolean;
  /** The edit as a sentence: where, what, and how the sync moves from there. */
  description: string;
}

/** A span of the video the dub does not cover: before it starts, after it ends, silent, unmatched. */
export interface TimelineGap {
  startS: number;
  endS: number;
  lengthS: number;
  reason: string;
  uncertaintyS: number;
  description: string;
}

/** The frame-rate conversion a dub needs, from which rate to which (engine `conversion_guide`). */
export interface RateGuide {
  videoFps: number | null;
  dubFps: number | null;
  fromFps: number | null;
  toFps: number | null;
  fromLabel: string | null;
  toLabel: string | null;
  /** Both rates are standard ones, so the ratio is the exact conversion between them. */
  named: boolean;
  alternatives: string[];
  confirmed: boolean | null;
  speed: number;
  /** mkvmerge's stretch, dub rate over video rate. */
  stretch: { num: number; den: number };
  /** ffmpeg's tempo factor, the reciprocal of the stretch. */
  tempo: number;
  tempoPercent: number;
  lengthPercent: number;
  pitchSemitones: number;
  driftPerHourS: number;
  dubDurationS: number | null;
  convertedDurationS: number | null;
  /** The delay to pair with the stretch: mkvmerge stretches first and shifts after. */
  delayWithStretchMs: number | null;
  sampleRate: number | null;
  /** Sample-exact resample for the dub's own sample rate; null when that was not known. */
  resampleFilter: string | null;
  atempoFilter: string;
  ffmpegFilter: string;
  pitchNote: string;
  stretchNote: string;
  instruction: string;
}

/** One measurement request. `key` ties the result back to the ExternalFile (and
 *  track) it came from, so write-back never has to re-derive the pairing. */
export interface MeasurePair {
  primaryPath: string;
  secondaryPath: string;
  key: string;
  method: string;
  score: number;
  primaryTrack: number;
  secondaryTrack: number;
}

/** Beyond this, a "delay" is not a delay: real offsets here are container/encoder-scale or a
 *  dub that skips the video's intro, which reaches minutes. Gates applying a result, not
 *  searching for one — an implausible result is still measured and shown. */
export const MAX_PLAUSIBLE_OFFSET_MS = 300000;

export const ENGINE_DEFAULTS = {
  // AudioSyncMaster's own defaults, so an untouched install measures what AudioSyncMaster does.
  // A larger maxOffsetMs pads every window with that much audio, which changes the correlation
  // peaks and so the result; a pair these windows cannot place is searched again wider
  // (WIDE_SEARCH_MS).
  //
  // windowCount changes where every window sits (step = (last-first)/(count-1)), so a different count
  // isn't a more precise measurement — it's a different one, worth tens of ms on drifting material.
  windowSeconds: 45,
  windowCount: 6,
  maxOffsetMs: 60000,
  // The only parameter that cannot change a result: it just sizes the engine's thread pool, and each
  // pair is analysed independently. Kept higher than upstream's 3 purely for throughput.
  maxWorkers: 4,
} as const;

/** AudioSyncMaster's Settings limits for the same three fields, so any value set there can be set here. */
export const ENGINE_LIMITS = {
  windowCount: { min: 1, max: 20 },
  windowSeconds: { min: 5, max: 600 },
  maxOffsetSeconds: { min: 1, max: 600 },
} as const;

/** The second look for a pair the survey could not place, typically a dub without the video's
 *  recap (+92 s is common). The engine's fast route decodes one long window and an end check
 *  instead of padding six windows with this much audio, so it costs seconds, not a full read. */
export const WIDE_SEARCH_MS = 300000;

export interface MeasureStartRequest {
  runId: string;
  pairs: MeasurePair[];
  windowSeconds: number;
  windowCount: number;
  maxOffsetMs: number;
  maxWorkers: number;
  /** One long window plus an end check before the survey. */
  fast: boolean;
  /** Re-measure a pair the survey does not settle along its whole timeline: reads both files
   *  end to end, the slowest thing the engine does. */
  timeline: boolean;
}

export interface EngineStatus {
  /** The engine binary (or a dev Python checkout) was located. */
  engineAvailable: boolean;
  /** ffmpeg and ffprobe are on PATH. */
  ffmpegAvailable: boolean;
  /** Where the engine was found, for the log and for diagnosing a bad build. */
  enginePath: string | null;
  /** Which AudioSyncMaster build it is, e.g. "AudioSyncMaster v2.13.0 (9c400ce)"; null when unstamped.
   *  The two apps can only be expected to agree while this matches the installed release. */
  engineVersion: string | null;
  message: string | null;
}

export interface MeasureProgressEvent {
  runId: string;
  processed: number;
  total: number;
  current: string | null;
}

export interface MeasureResultEvent {
  runId: string;
  /** The `key` from the originating MeasurePair. */
  key: string | null;
  result: SyncResult;
}

export interface MeasureDoneEvent {
  runId: string;
  cancelled: boolean;
  error: string | null;
}

/** What a measurement produced, kept alongside the delay value it wrote.
 *  Stored so a row can keep explaining itself after a reload, and so measured can be told apart from typed. */
export interface MeasuredDelay {
  /** Raw engine value, before negation -- kept so the display can show the
   *  unrounded figure and so a re-derivation never double-flips the sign. */
  engineDelayMs: number;
  /** The rounded milliseconds actually written into the delay field. */
  appliedMs: number;
  confidence: number | null;
  driftMsPerS: number | null;
  hasSignificantDrift: boolean;
  isRateMismatch: boolean;
  isLikelyCut: boolean;
  correctionRatio: number | null;
  rateSourceFps: number | null;
  rateTargetFps: number | null;
  rateExplanation: string | null;
  /** Where the quick measurement found the offset jumping, on the video's timeline, and by how
   *  much. Optional so records stored before these existed still load. */
  cutPositionS?: number | null;
  cutUncertaintyS?: number | null;
  cutMagnitudeMs?: number | null;
  /** The full-timeline scan that followed this measurement, when one ran. */
  timeline?: TimelineScan;
  /** How the engine reached the delay; optional so older stored records still load. */
  method?: "survey" | "timeline" | null;
  /** The engine's warnings about this measurement, to check before trusting it. */
  warnings?: string[];
  /** Which of the video's audio tracks this was measured against. */
  referenceTrack: number;
  primaryFps: number | null;
  /** ISO 8601 -- a string, not a Date, because JSON has no Date type. */
  measuredAt: string;
  error: string | null;
}

/** Where a delay value came from. Measurement never overwrites `manual`. */
export type DelayProvenance = "manual" | "measured" | "none";

/** An opt-in linear stretch for a frame-rate-converted track. */
export interface StretchSetting {
  num: number;
  den: number;
}

/** One piece of AudioSyncMaster's Dub sync plan, on the video's timeline. */
export interface TimelineSegment {
  kind: "dub" | "fill";
  startS: number;
  endS: number;
  sourceStartS: number;
  /** Dub time minus video time, in seconds, for "dub" pieces: the engine's delay convention. */
  offsetS: number | null;
  match: number | null;
  note: string;
  /** For a fill, why the video's own audio plays there: "head", "tail", "cut", "silent",
   *  "unmatched" or "draft". */
  reason?: string;
  uncertaintyS: number;
}

/** The engine's Dub sync plan, as far as the timeline scan reads it. */
export interface TimelinePlan {
  speed: number;
  videoDurationS: number;
  dubDurationS: number;
  videoFps: number | null;
  dubRate: number | null;
  rateConfirmed?: boolean | null;
  segments: TimelineSegment[];
  warnings: string[];
  error: string | null;
  summary?: { dubUsedShare: number | null } | null;
  /** Present from engine builds that list edits themselves; older plans only have segments. */
  edits?: TimelineEdit[];
  gaps?: TimelineGap[];
  rateGuide?: RateGuide | null;
}

/** Where the offset changes between two stretches of dub. */
export interface TimelineCut {
  /** Position on the video's timeline. */
  atS: number;
  /** How far the offset moves there, engine convention: negative when the dub lacks material. */
  jumpMs: number;
  /** Seconds of the video the dub has nothing for at this cut. */
  missingS: number;
  uncertaintyS: number;
  /** The offset from here to the next cut, engine convention. */
  offsetAfterMs: number;
}

/** What the full-timeline scan found for one pair, kept compact enough to store with the session. */
export interface TimelineScan {
  scannedAt: string;
  error: string | null;
  /** Offset of the first stretch of dub, engine convention: the delay at the start, measured
   *  from that stretch alone at the planner's 2 ms resolution. */
  startOffsetMs: number | null;
  cuts: TimelineCut[];
  /** Spans where the dub was audible but did not correlate, so sync there is unconfirmed. */
  unverified: Array<{ startS: number; endS: number }>;
  /** Seconds at the end of the video the dub does not reach. */
  tailS: number;
  videoFps: number | null;
  /** The frame rate the dub was mastered at; differs from videoFps on a frame-rate conversion. */
  dubRate: number | null;
  /** Playback speed the dub needed to line up; 1 when it runs at the video's speed. */
  speed: number;
  rateConfirmed: boolean | null;
  dubUsedShare: number | null;
  videoDurationS: number;
  /** The engine's own table of the plan, for the details view. */
  description: string | null;
  /** The engine's own list of every edit, with each one's grade and sentence, when it gave one. */
  edits?: TimelineEdit[];
  rateGuide?: RateGuide | null;
}

export interface TimelineScanRequest {
  runId: string;
  pairs: MeasurePair[];
  maxWorkers: number;
}

export interface TimelineScanProgressEvent {
  runId: string;
  key: string | null;
  percent: number;
  stage: string | null;
  processed: number;
  total: number;
}

export interface TimelineScanResultEvent {
  runId: string;
  key: string | null;
  plan: TimelinePlan | null;
  description: string | null;
  error: string | null;
}
