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

/** Beyond this, a "delay" is not a delay: real offsets here are container/encoder-scale (ms, maybe a couple seconds).
 *  Gates applying a result, not searching for one — an implausible result is still measured and shown. */
export const MAX_PLAUSIBLE_OFFSET_MS = 10000;

export const ENGINE_DEFAULTS = {
  // Identical to AudioSyncMaster's defaults on purpose: since it's the same engine binary, the only
  // way the two tools can report different delays is by asking it different questions.
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

export interface MeasureStartRequest {
  runId: string;
  pairs: MeasurePair[];
  windowSeconds: number;
  windowCount: number;
  maxOffsetMs: number;
  maxWorkers: number;
}

export interface EngineStatus {
  /** The engine binary (or a dev Python checkout) was located. */
  engineAvailable: boolean;
  /** ffmpeg and ffprobe are on PATH. */
  ffmpegAvailable: boolean;
  /** Where the engine was found, for the log and for diagnosing a bad build. */
  enginePath: string | null;
  /** Which AudioSyncMaster build it is, e.g. "AudioSyncMaster v2.8.0 (8e53e8b)"; null when unstamped.
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
