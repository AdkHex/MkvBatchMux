/** The frame rate audio was timed at; not stored anywhere, so it's inferred by comparing durations against the video.
 *  mediainfo's audio `FrameRate` field is a per-codec constant (SamplingRate/SamplesPerFrame), not this — don't use it. */

import type { ExternalFile, MeasuredDelay, VideoFile } from "@/shared/types";
import { conversionBetween, type RateConversion } from "./delayConversion";

/** Frame rates real releases actually use; keep in sync with `EXACT_RATES` in delayConversion.ts.
 *  Decimals suffice here — matched against a duration ratio already noisier than the 1e-6 gap to the exact rational. */
export const COMMON_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

/** How far a duration-derived rate may sit from a common rate and still be named as it.
 *  Wide enough to absorb encoder padding and a trimmed logo — which also means 23.976 and 24 can't be told apart this way. */
export const ESTIMATE_TOLERANCE = 0.005;

/** How close a candidate must sit to the video's own rate to *be* that rate.
 *  Tighter than `ESTIMATE_TOLERANCE`: this compares to a known value, not a noisy measurement. */
const VIDEO_MATCH_TOLERANCE = 0.01;

export interface AudioFps {
  /** The rate the audio was timed at. */
  fps: number;
  /** The rate of the video it is matched to. Carried alongside so a row can say
   *  which rate to which, rather than leaving the user to work out what the
   *  audio's rate has to become. */
  videoFps: number;
  /** `measured` came from the engine's waveform correlation and can be trusted
   *  as an input to a stretch ratio. `estimated` is a duration-ratio guess. */
  basis: "measured" | "estimated";
  /** Another common rate fits the same measurement, so the exact value is a
   *  coin toss. Only ever set on an estimate. */
  ambiguous: boolean;
}

/** True when the audio has to be resampled to sit on this video, using the same tolerance that identifies the video's own rate. */
export function needsRateChange(value: AudioFps): boolean {
  return Math.abs(value.fps - value.videoFps) >= VIDEO_MATCH_TOLERANCE;
}

/** The exact stretch this file needs when both rates are standard ones; null otherwise, since only a measurement can then be trusted. */
export function rateChangeFor(value: AudioFps): RateConversion | null {
  if (!needsRateChange(value)) return null;
  return conversionBetween(value.fps, value.videoFps);
}

function usableMeasurement(measured: MeasuredDelay | undefined): boolean {
  return Boolean(measured && !measured.error);
}

/** The rate the engine concluded the audio was timed at, if it measured one. */
function measuredFps(measured: MeasuredDelay, videoFps: number | undefined): AudioFps | null {
  // Without the video's rate there's no "to" to name; fall back to the measurement's own copy.
  const against = videoFps ?? measured.rateTargetFps ?? measured.primaryFps ?? null;
  if (against === null) return null;

  // A named rate mismatch carries the answer outright.
  if (measured.rateSourceFps !== null && measured.rateSourceFps !== undefined) {
    return {
      fps: measured.rateSourceFps,
      videoFps: against,
      basis: "measured",
      ambiguous: false,
    };
  }
  // No mismatch found is only informative when the pair actually lines up;
  // a likely-cut pair drifts for reasons unrelated to rate.
  if (measured.isRateMismatch || measured.isLikelyCut) return null;
  return { fps: against, videoFps: against, basis: "measured", ambiguous: false };
}

/** The rate implied by how long the audio runs against how long the video runs (`videoFps * videoDuration / audioDuration`). */
export function estimateFpsFromDurations(
  audioDurationS: number | undefined,
  videoDurationS: number | undefined,
  videoFps: number | undefined,
): AudioFps | null {
  if (!audioDurationS || !videoDurationS || !videoFps) return null;
  if (audioDurationS <= 0 || videoDurationS <= 0 || videoFps <= 0) return null;

  const implied = videoFps * (videoDurationS / audioDurationS);

  const withinTolerance = COMMON_RATES.map((rate) => ({
    rate,
    error: Math.abs(rate - implied) / rate,
  }))
    .filter((candidate) => candidate.error <= ESTIMATE_TOLERANCE)
    .sort((a, b) => a.error - b.error);

  if (withinTolerance.length === 0) return null;

  // Prefer the video's own rate when it fits: the common case is unconverted audio.
  // Not flagged ambiguous even if 24 also matches — both imply no conversion.
  const matchesVideo = withinTolerance.find(
    (candidate) => Math.abs(candidate.rate - videoFps) < VIDEO_MATCH_TOLERANCE,
  );
  if (matchesVideo) {
    return { fps: matchesVideo.rate, videoFps, basis: "estimated", ambiguous: false };
  }

  // A conversion is being claimed, so a rival candidate genuinely matters:
  // 25 -> 23.976 and 25 -> 24 take different stretch ratios.
  return {
    fps: withinTolerance[0].rate,
    videoFps,
    basis: "estimated",
    ambiguous: withinTolerance.length > 1,
  };
}

/** The best available answer for one audio file, or null when there is none. */
export function audioFpsFor(file: ExternalFile, video: VideoFile | undefined): AudioFps | null {
  const videoFps = video?.fps;

  if (file.measuredDelay && usableMeasurement(file.measuredDelay)) {
    const fromEngine = measuredFps(file.measuredDelay, videoFps);
    if (fromEngine) return fromEngine;
  }

  return estimateFpsFromDurations(file.durationSeconds, video?.durationSeconds, videoFps);
}
