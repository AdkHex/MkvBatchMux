/** Conversion between the AudioSync engine's measurements and the delay values
 *  MkvBatchMux stores.
 *
 *  Two conventions meet here and disagree about both sign and unit, so every
 *  conversion goes through this module rather than being inlined at call sites.
 *  See docs/AUDIOSYNC_INTEGRATION_PLAN.md §2.1-2.3.
 */

import type { SyncResult } from "@/shared/types/audiosync";

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
 */
export function isAutoFillable(result: SyncResult): boolean {
  if (result.error) return false;
  if (sourceDelayMs(result) === null) return false;
  if (result.isLikelyCut) return false;
  return true;
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

/** The known broadcast frame-rate conversions, as exact integer ratios.
 *
 *  Direction, which is the easy thing to get backwards: the engine's
 *  `sourceFps` is the rate the *audio* was timed at and `targetFps` is the
 *  *video's* rate (see `diagnose()` in AudioSyncMaster's framerate.py, whose
 *  comment spells this out). Audio timed at 25 fps and played against a 23.976
 *  fps video runs fast, so its timestamps must be stretched by
 *  `targetFps / sourceFps` -- and mkvmerge's `--sync` factor multiplies
 *  timestamps. Hence num/den = target/source.
 *
 *  A float-derived rational approximation of `correctionRatio` lands close to
 *  these but not on them, and mkvmerge applies the ratio literally -- so a
 *  near-miss accumulates real error over an episode. Matching the measured
 *  source/target frame rates against this table keeps the common cases exact.
 */
const KNOWN_RATE_CONVERSIONS: Array<{
  sourceFps: number;
  targetFps: number;
  num: number;
  den: number;
}> = [
  { sourceFps: 25, targetFps: 23.976, num: 24000, den: 25025 },
  { sourceFps: 23.976, targetFps: 25, num: 25025, den: 24000 },
  { sourceFps: 24, targetFps: 25, num: 25, den: 24 },
  { sourceFps: 25, targetFps: 24, num: 24, den: 25 },
];

/** 23.976 and 24 fps are only 0.024 apart, and they take different ratios. A
 *  tolerance wide enough to blur them would silently pick the wrong conversion,
 *  so it stays under half that gap and the closest row wins outright. */
const FPS_TOLERANCE = 0.01;

export interface StretchRatio {
  num: number;
  den: number;
  /** True when this came from the exact-conversion table rather than an
   *  approximation of the measured ratio. */
  exact: boolean;
}

/** Continued-fraction approximation, used only when no known conversion fits. */
function approximateRatio(value: number, maxDenominator = 100000): { num: number; den: number } {
  let bestNum = 1;
  let bestDen = 1;
  let bestError = Number.POSITIVE_INFINITY;
  for (let den = 1; den <= maxDenominator; den *= 10) {
    const num = Math.round(value * den);
    if (num <= 0) continue;
    const error = Math.abs(num / den - value);
    if (error < bestError) {
      bestError = error;
      bestNum = num;
      bestDen = den;
    }
    if (error === 0) break;
  }
  return { num: bestNum, den: bestDen };
}

/** Derive the `num/den` linear-stretch factor for mkvmerge's extended `--sync`.
 *
 *  Returns null when there is nothing trustworthy to apply: a wrong stretch
 *  ratio is worse than none, because it silently drifts the whole file.
 */
export function stretchRatioFor(
  correctionRatio: number | null | undefined,
  sourceFps?: number | null,
  targetFps?: number | null,
): StretchRatio | null {
  if (
    sourceFps !== null &&
    sourceFps !== undefined &&
    targetFps !== null &&
    targetFps !== undefined
  ) {
    const known = KNOWN_RATE_CONVERSIONS.filter(
      (entry) =>
        Math.abs(entry.sourceFps - sourceFps) < FPS_TOLERANCE &&
        Math.abs(entry.targetFps - targetFps) < FPS_TOLERANCE,
    ).sort(
      (a, b) =>
        Math.abs(a.sourceFps - sourceFps) +
        Math.abs(a.targetFps - targetFps) -
        (Math.abs(b.sourceFps - sourceFps) + Math.abs(b.targetFps - targetFps)),
    )[0];
    if (known) {
      return { num: known.num, den: known.den, exact: true };
    }
  }

  if (
    correctionRatio === null ||
    correctionRatio === undefined ||
    !Number.isFinite(correctionRatio) ||
    correctionRatio <= 0
  ) {
    return null;
  }

  const { num, den } = approximateRatio(correctionRatio);
  return { num, den, exact: false };
}
