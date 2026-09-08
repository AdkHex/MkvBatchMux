/** Conversion between the AudioSync engine's measurements and the delay values
 *  MkvBatchMux stores.
 *
 *  Two conventions meet here and disagree about both sign and unit, so every
 *  conversion goes through this module rather than being inlined at call sites.
 *  See docs/AUDIOSYNC_INTEGRATION_PLAN.md §2.1-2.3.
 */

import { MAX_PLAUSIBLE_OFFSET_MS, type SyncResult } from "@/shared/types/audiosync";
import type { MeasuredDelay } from "@/shared/types";

/** Engine milliseconds → the seconds value MkvBatchMux stores and mkvmerge consumes.
 *
 *  Negation is the engine→player sign flip: the engine reports *where the audio
 *  sits* (negative means the dub starts before the picture), while mkvmerge's
 *  `--sync`, every player, and this app's delay field all ask the opposite
 *  question -- how much delay do I *add* to fix this.
 *
 *  Rounding happens before the divide because the delay field holds three
 *  decimals of a second, i.e. whole milliseconds; rounding afterwards would
 *  depend on float formatting instead of being explicit.
 */
export function engineMsToDelaySeconds(engineDelayMs: number): number {
  const ms = Math.round(-engineDelayMs);
  // Math.round(-0) is -0, and (-0).toFixed(3) renders "-0.000" -- a negative
  // delay where there is none. Normalise it away at the source.
  return ms === 0 ? 0 : ms / 1000;
}

/** The engine value a correction should be built from.
 *
 *  With drift, `delayMs` is measured at the midpoint of the file but `--sync`
 *  applies its offset from t=0, so using the midpoint value over-shoots by half
 *  the total drift. `delayAtStartMs` exists for exactly this case.
 */
export function sourceDelayMs(result: Pick<SyncResult, "delayMs" | "delayAtStartMs">): number | null {
  return result.delayAtStartMs ?? result.delayMs;
}

/** Whether a result may be written into a delay field at all.
 *
 *  A likely-cut pair contains different material, so no single offset aligns it
 *  and auto-filling one would be a confident wrong answer. The user can still
 *  apply it deliberately -- that path passes `allowCut`.
 *
 *  Confidence below the low band means the correlator never found a distinct
 *  peak -- the windows disagreed, or the best match was barely better than the
 *  average one. That is not a small offset, it is no offset: staging it puts a
 *  number in front of the user that carries no information, and Apply-all would
 *  then push it into the mux. It is still measured, still shown, and still
 *  applicable by hand from the row.
 *
 *  The magnitude check is the same idea. High confidence only means the windows
 *  agreed with each other, and a correlator that locks onto a repeated musical
 *  phrase produces the same wrong answer in every window -- so agreement is not
 *  evidence the answer is right. A dub is never tens of seconds out from its
 *  own episode; a result that says otherwise gets shown, not applied.
 */
export function isAutoFillable(result: SyncResult): boolean {
  if (result.error) return false;
  const delay = sourceDelayMs(result);
  if (delay === null) return false;
  if (result.isLikelyCut) return false;
  if (Math.abs(delay) > MAX_PLAUSIBLE_OFFSET_MS) return false;
  if (isUnconvincing(result)) return false;
  return true;
}

/** The confidence below which a result is noise rather than a measurement. */
export const MIN_AUTOFILL_CONFIDENCE = 0.5;

/** True when a result was withheld only because the correlation was too weak. */
export function isUnconvincing(result: SyncResult): boolean {
  const confidence = result.confidence;
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) {
    return false;
  }
  return confidence < MIN_AUTOFILL_CONFIDENCE;
}

/** True when a result was withheld only because it is implausibly large.
 *  Lets the row explain that specifically rather than silently showing nothing. */
export function isImplausiblyLarge(result: SyncResult): boolean {
  const delay = sourceDelayMs(result);
  if (delay === null) return false;
  return Math.abs(delay) > MAX_PLAUSIBLE_OFFSET_MS;
}

/** Format a delay for the three-decimal seconds field the UI edits as a string. */
export function formatDelaySeconds(seconds: number): string {
  return seconds.toFixed(3);
}

/** The measured offset as the user would read it in AudioSyncMaster, i.e. in
 *  the player convention, unrounded. Shown next to the rounded field value so
 *  the rounding is visible rather than silent. */
export function playerDelayMs(engineDelayMs: number | null): number | null {
  if (engineDelayMs === null || !Number.isFinite(engineDelayMs)) return null;
  // -0 formats as "-0.0 ms", which reads as a real negative offset.
  return engineDelayMs === 0 ? 0 : -engineDelayMs;
}

export function formatPlayerDelayMs(engineDelayMs: number | null): string {
  const value = playerDelayMs(engineDelayMs);
  if (value === null) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)} ms`;
}

export type ConfidenceLevel = "high" | "medium" | "low";

/** Map a 0-1 engine confidence onto the three bands the UI displays.
 *  Bands match AudioSyncMaster's `confidenceLevel()` so the two apps agree. */
export function confidenceLevel(confidence: number | null | undefined): ConfidenceLevel {
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) {
    return "low";
  }
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

export function formatConfidence(confidence: number | null | undefined): string {
  const level = confidenceLevel(confidence);
  const label = level === "high" ? "High" : level === "medium" ? "Medium" : "Low";
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) {
    return label;
  }
  return `${label} · ${Math.round(confidence * 100)}%`;
}

/** A delay expressed in video frames, which is how editors think about sync.
 *  Returns null below half a frame, where there is nothing useful to say. */
export function frameOffset(delayMs: number | null, fps: number | null | undefined): number | null {
  if (delayMs === null || !fps || !Number.isFinite(delayMs) || !Number.isFinite(fps)) {
    return null;
  }
  const frames = Math.round((delayMs / 1000) * fps);
  return frames === 0 ? null : frames;
}

export function formatFrameOffset(delayMs: number | null, fps: number | null | undefined): string | null {
  const frames = frameOffset(delayMs, fps);
  if (frames === null) return null;
  return `${frames > 0 ? "+" : ""}${frames} ${Math.abs(frames) === 1 ? "frame" : "frames"}`;
}

/** The frame rates real releases use, as the exact rationals they actually are.
 *
 *  "23.976" is shorthand. The rate is 24000/1001, and the difference matters
 *  here because mkvmerge applies a stretch ratio literally to every timestamp:
 *  build the ratio from the decimal and 24 -> 23.976 comes out 1000/999 where
 *  the true conversion is 1001/1000. That is 1e-6, which is only 3.6 ms across
 *  an hour -- but it is 3.6 ms of avoidable drift in the one place the app
 *  claims to be exact.
 *
 *  Same set as the engine's `COMMON_RATES` (AudioSyncMaster's
 *  `audiosync/framerate.py`) and as `COMMON_RATES` in `audioFps.ts`, expressed
 *  exactly rather than as decimals; keep the three in step.
 */
const EXACT_RATES: ReadonlyArray<{ num: number; den: number }> = [
  { num: 24000, den: 1001 }, // 23.976
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 }, // 29.97
  { num: 30, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 }, // 59.94
  { num: 60, den: 1 },
];

/** 23.976 and 24 fps are only 0.024 apart, and they take different ratios. A
 *  tolerance wide enough to blur them would silently pick the wrong conversion,
 *  so it stays under half that gap and the closest rate wins outright. */
const FPS_TOLERANCE = 0.01;

/** How close a measured speed must sit to a standard conversion before that
 *  conversion is named on the strength of the measurement alone. Matches
 *  `RATIO_TOLERANCE` in the engine's framerate.py: the narrowest real
 *  conversion, 24 -> 23.976, is 0.1% wide, so this has to stay well inside it
 *  or neighbouring conversions get confused. */
const RATIO_TOLERANCE = 0.0004;

/** The exact rational for a reported frame rate, or null if it is not one of
 *  the standard rates -- a codec's own frame rate (31.25 for AC-3, 46.875 for
 *  AAC-LC) lands here, and must not be mistaken for a timing rate. */
function exactRateFor(fps: number | null | undefined): { num: number; den: number } | null {
  if (fps === null || fps === undefined || !Number.isFinite(fps) || fps <= 0) return null;
  let best: { num: number; den: number } | null = null;
  let bestError = FPS_TOLERANCE;
  for (const rate of EXACT_RATES) {
    const error = Math.abs(rate.num / rate.den - fps);
    if (error < bestError) {
      bestError = error;
      best = rate;
    }
  }
  return best;
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    [x, y] = [y, x % y];
  }
  return x || 1;
}

/** Where a conversion's numbers came from, worst case last:
 *
 *   - `named`: the engine identified both frame rates and both are standard,
 *     so the ratio is the exact broadcast conversion between them.
 *   - `inferred`: the engine named no usable pair, but the speed it measured
 *     matches one standard conversion and no other. Still exact.
 *   - `measured`: nothing standard fits. The ratio is approximated from the
 *     measured drift, so it carries that measurement's error into every
 *     timestamp and has to be checked rather than trusted.
 */
export type RateConversionBasis = "named" | "inferred" | "measured";

export interface RateConversion {
  /** The rate the audio was timed at. Null only when a `measured` conversion
   *  has no video rate to imply it against. */
  audioFps: number | null;
  /** The video's rate, which the audio has to be made to match. */
  videoFps: number | null;
  /** mkvmerge's linear-stretch factor, applied as `--sync <tid>:<ms>,<num>/<den>`.
   *
   *  Direction, verified against mkvmerge rather than reasoned about: muxing a
   *  60.01 s track with `--sync 0:0,25025/24000` produces a 62.57 s track, so
   *  o/p multiplies timestamps and a factor above 1 slows the audio down.
   *
   *  Audio timed at 25 fps holds the same frames in less time than a 23.976 fps
   *  video does, so it has to be slowed by 25/23.976 to line up. Hence
   *  `num/den = audioFps / videoFps`.
   *
   *  This is *not* the engine's `correctionRatio`, which is its reciprocal: the
   *  engine reports an ffmpeg `atempo` value, and atempo is a playback speed,
   *  where mkvmerge's is a timestamp multiplier. Handing one to the other
   *  doubles the drift instead of removing it.
   */
  num: number;
  den: number;
  basis: RateConversionBasis;
}

/** The exact conversion between two standard frame rates.
 *
 *  Null when either rate is not a standard one -- a codec frame rate, or a
 *  measured value that matches nothing -- and null when they are the same rate,
 *  because then there is no conversion to make.
 */
export function conversionBetween(
  audioFps: number | null | undefined,
  videoFps: number | null | undefined,
): RateConversion | null {
  const audio = exactRateFor(audioFps);
  const video = exactRateFor(videoFps);
  if (!audio || !video) return null;
  const num = audio.num * video.den;
  const den = audio.den * video.num;
  if (num === den) return null;
  const divisor = greatestCommonDivisor(num, den);
  return {
    audioFps: audio.num / audio.den,
    videoFps: video.num / video.den,
    num: num / divisor,
    den: den / divisor,
    basis: "named",
  };
}

/** The standard conversion that explains a measured stretch factor.
 *
 *  Three conversions share the 1001/1000 factor -- 24 -> 23.976, 30 -> 29.97
 *  and 60 -> 59.94 -- so a measurement can never separate them on speed alone.
 *  The video's own rate does, and it is the only candidate that can be true.
 *  Without it the ratio is still exact and still worth applying; only the two
 *  names are unknowable, and those are left null rather than picked.
 *
 *  A pool that genuinely disagrees about the *ratio* returns null instead: that
 *  is a coin toss applied to every timestamp in the file.
 */
function inferConversion(factor: number, videoFps: number | null): RateConversion | null {
  const candidates: Array<{ conversion: RateConversion; error: number }> = [];
  for (const audio of EXACT_RATES) {
    for (const video of EXACT_RATES) {
      const audioFps = audio.num / audio.den;
      const videoFps_ = video.num / video.den;
      if (audioFps === videoFps_) continue;
      const ratio = audioFps / videoFps_;
      const error = Math.abs(ratio - factor) / ratio;
      if (error > RATIO_TOLERANCE) continue;
      const conversion = conversionBetween(audioFps, videoFps_);
      if (conversion) candidates.push({ conversion, error });
    }
  }
  if (candidates.length === 0) return null;

  const againstThisVideo = candidates.filter(
    (candidate) =>
      videoFps !== null && Math.abs(candidate.conversion.videoFps! - videoFps) < FPS_TOLERANCE,
  );
  const pool = (againstThisVideo.length > 0 ? againstThisVideo : candidates).sort(
    (a, b) => a.error - b.error,
  );

  const best = pool[0].conversion;
  const sameRatio = pool.every(
    (candidate) => candidate.conversion.num === best.num && candidate.conversion.den === best.den,
  );
  if (!sameRatio) return null;

  const named = pool.length === 1;
  return {
    ...best,
    audioFps: named ? best.audioFps : null,
    videoFps: named ? best.videoFps : null,
    basis: "inferred",
  };
}

/** Best rational approximation of a value, by continued fractions.
 *
 *  Used only when no standard conversion fits. Continued fractions rather than
 *  rounding at a fixed denominator because the fixed-denominator answer for
 *  1.001001 is 1001/1000 at best and 999/1000 at the resolution the UI was
 *  showing -- a number that looks exact and is not.
 */
function approximateRatio(value: number, maxDenominator = 100000): { num: number; den: number } {
  let previousNum = 0;
  let num = 1;
  let previousDen = 1;
  let den = 0;
  let remainder = value;
  for (let step = 0; step < 64; step += 1) {
    const whole = Math.floor(remainder);
    const nextNum = whole * num + previousNum;
    const nextDen = whole * den + previousDen;
    if (nextDen > maxDenominator) break;
    [previousNum, num] = [num, nextNum];
    [previousDen, den] = [den, nextDen];
    const fraction = remainder - whole;
    if (fraction < 1e-12) break;
    remainder = 1 / fraction;
  }
  if (num <= 0 || den <= 0) return { num: 1, den: 1 };
  return { num, den };
}

/** The engine reports an ffmpeg `atempo` speed factor; mkvmerge wants a
 *  timestamp multiplier. They are reciprocals. */
function stretchFactorFrom(correctionRatio: number | null | undefined): number | null {
  if (
    correctionRatio === null ||
    correctionRatio === undefined ||
    !Number.isFinite(correctionRatio) ||
    correctionRatio <= 0
  ) {
    return null;
  }
  return 1 / correctionRatio;
}

/** What frame-rate change this audio needs, and the exact ratio that makes it.
 *
 *  Returns null when there is nothing trustworthy to apply: a wrong stretch
 *  ratio is worse than none, because it silently drifts the whole file.
 */
export function rateConversionFor(
  measured: Pick<
    MeasuredDelay,
    "correctionRatio" | "rateSourceFps" | "rateTargetFps" | "primaryFps"
  >,
): RateConversion | null {
  // The engine named both rates and both are standard: nothing measured can
  // beat the exact conversion between them.
  const named = conversionBetween(measured.rateSourceFps, measured.rateTargetFps);
  if (named) return named;

  const factor = stretchFactorFrom(measured.correctionRatio);
  if (factor === null) return null;

  // No usable pair of names, but the speed itself may still be a standard
  // conversion -- which is the answer the user is asking for, and an exact one.
  const inferred = inferConversion(factor, measured.primaryFps ?? measured.rateTargetFps ?? null);
  if (inferred) return inferred;

  // Nothing standard fits. Apply what was measured, and say so. The video's own
  // rate still lets the implied audio rate be named, which is more use than a
  // bare ratio even when it lands between the standard rates.
  const videoFps = measured.primaryFps ?? measured.rateTargetFps ?? null;
  return {
    audioFps: videoFps === null ? null : videoFps * factor,
    videoFps,
    ...approximateRatio(factor),
    basis: "measured",
  };
}

/** Render a frame rate the way the frame-rate world writes it: 25.000, 23.976. */
export function formatFps(fps: number): string {
  return fps.toFixed(3);
}

/** The change a conversion makes, written as the user thinks about it: which
 *  rate to which. Falls back to the bare factor only when neither rate can be
 *  named, which is the one case where there is no "from" and "to" to give. */
export function formatRateConversion(conversion: RateConversion): string {
  if (conversion.audioFps !== null && conversion.videoFps !== null) {
    return `${formatFps(conversion.audioFps)} → ${formatFps(conversion.videoFps)} fps`;
  }
  return `×${(conversion.num / conversion.den).toFixed(6)}`;
}

/** How the mismatch shows up while watching: the speed error, and how much sync
 *  it costs per hour. A percentage alone is too abstract to act on. */
export function formatRateDrift(conversion: RateConversion): string {
  const factor = conversion.num / conversion.den;
  const offBy = Math.abs(factor - 1);
  return `${(offBy * 100).toFixed(2)}% too ${factor > 1 ? "fast" : "slow"}, which is about ${(
    offBy * 3600
  ).toFixed(1)} s of drift every hour`;
}

/** Why a stored measurement's delay was not staged for Apply, or null if it
 *  was. Derived from the stored record rather than the live result so a row
 *  can still explain itself after a reload.
 *
 *  Shared by every row so the reasons cannot drift apart from `isAutoFillable`.
 */
export function withheldReason(
  measured: Pick<
    MeasuredDelay,
    "isLikelyCut" | "engineDelayMs" | "confidence" | "error"
  >,
): string | null {
  if (measured.error) return measured.error;
  if (measured.isLikelyCut) {
    return "These look like different cuts, so no single delay aligns them.";
  }
  if (Math.abs(measured.engineDelayMs) > MAX_PLAUSIBLE_OFFSET_MS) {
    return "Too large to be a real offset -- the correlator most likely locked onto a repeated passage.";
  }
  const confidence = measured.confidence;
  if (
    confidence !== null &&
    confidence !== undefined &&
    Number.isFinite(confidence) &&
    confidence < MIN_AUTOFILL_CONFIDENCE
  ) {
    return "The correlation was too weak to trust; check this one before applying it.";
  }
  return null;
}
