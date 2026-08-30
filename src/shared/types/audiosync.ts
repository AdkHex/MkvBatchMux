/** Types crossing the AudioSync engine boundary.
 *
 *  Field names match AudioSyncMaster's `src/lib/types.ts` and the Python
 *  engine exactly -- all layers speak camelCase across the wire, so renaming
 *  anything here silently turns a value into `undefined`.
 */

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
  driftMsPerS: number;
  speedRatio: number;
  sourceFps: number | null;
  targetFps: number | null;
  isRateMismatch: boolean;
  isLikelyCut: boolean;
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
  isRateMismatch?: boolean | null;
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

/** Beyond this, a "delay" is not a delay.
 *
 *  This app measures a dub against the video it will be muxed into, so a real
 *  offset is container- and encoder-scale: milliseconds, occasionally a second
 *  or two. Ten seconds is already generous.
 *
 *  This is a gate on *applying* a result, not on searching for one. It was
 *  briefly both -- the engine's search was narrowed to this value to stop a
 *  correlator locking onto a repeated musical phrase. That made the search
 *  differ from AudioSyncMaster's and so made the two tools disagree, and it
 *  was treating the symptom: the wrong answers came from comparing two tracks
 *  that shared no material, which track selection now prevents. The search is
 *  upstream's again; an implausible result is still measured, shown, and kept
 *  out of the delay field unless the user applies it deliberately.
 */
export const MAX_PLAUSIBLE_OFFSET_MS = 10000;

export const ENGINE_DEFAULTS = {
  // Identical to AudioSyncMaster's DEFAULT_SETTINGS (its src/lib/types.ts), on
  // purpose: the engine is the same binary, so the only way the two tools can
  // report different delays for the same files is by asking it different
  // questions.
  //
  // windowCount is the one that bites. plan_windows() spreads the sample
  // points with step = (last - first) / (count - 1), so changing the count
  // moves every window; the result is the median of whatever those windows
  // measured. Sampling ten instead of six is not a more precise version of the
  // same measurement, it is a different one -- worth tens of milliseconds on
  // material whose offset wanders slightly across a film.
  windowSeconds: 45,
  windowCount: 6,
  maxOffsetMs: 60000,
  // The only parameter that cannot change a result: it sizes the engine's
  // thread pool (batch.py hands it straight to ThreadPoolExecutor) and each
  // pair is analysed independently. Kept higher than upstream's 3 purely for
  // throughput on a batch.
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
 *
 *  Stored so the row can keep explaining itself after a reload, and so a value
 *  that was measured can be told apart from one that was typed. */
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
