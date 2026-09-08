/** The frame rate an audio file was *timed* at, in 23.976 / 25.000 terms.
 *
 *  This is not a property of the audio file. A bare .ec3, .eac3, .aac or .dts
 *  elementary stream carries a sample rate and nothing else; PAL-speedup audio
 *  and film-rate audio are structurally identical and differ only in how long
 *  they run. mediainfo does report a `FrameRate` for audio tracks -- 31.250 for
 *  AC-3, 46.875 for AAC-LC -- but that is only `SamplingRate / SamplesPerFrame`,
 *  a constant per codec, and it does not change when audio is sped from 23.976
 *  to 25. It is the wrong number for `--sync` and is deliberately not used here.
 *
 *  So the rate has to be inferred by comparison against the video:
 *
 *   - Once a measurement exists, the engine has already done this properly, by
 *     correlating the two waveforms. Its answer is used verbatim.
 *   - Before then, the only signal is the ratio of the two durations, which is
 *     good enough to separate 25 from 23.976 (4.27% apart) but not 24 from
 *     23.976 (0.1% apart, inside normal padding noise). Those cases are
 *     reported as estimates and flagged ambiguous.
 */

import type { ExternalFile, MeasuredDelay, VideoFile } from "@/shared/types";
import { conversionBetween, type RateConversion } from "./delayConversion";

/** Frame rates real releases actually use. Mirrors `COMMON_RATES` in
 *  AudioSyncMaster's `audiosync/framerate.py`; keep the two in step. */
export const COMMON_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

/** How far the duration-derived rate may sit from a common rate and still be
 *  named as it.
 *
 *  The engine uses 0.0004 because a correlation measures the speed ratio
 *  directly. A duration ratio cannot be held to that: encoder padding, trailing
 *  silence and a trimmed logo are each worth a second or two, and two seconds
 *  across a 24-minute episode is already 0.14%. The tolerance therefore has to
 *  be wide enough to survive that -- which means it is also wider than the
 *  0.1% gap between 23.976 and 24, so those two cannot be told apart this way.
 *  `ambiguous` says so rather than pretending otherwise.
 */
export const ESTIMATE_TOLERANCE = 0.005;

/** How close a candidate must sit to the video's own rate to *be* that rate.
 *
 *  Deliberately far tighter than `ESTIMATE_TOLERANCE`, and matching
 *  `FPS_TOLERANCE` in `delayConversion.ts`: 23.976 and 24 are 0.024 apart, and
 *  identifying "the video's rate" is an exact question about a known number,
 *  not a noisy one about a measured ratio.
 */
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

/** True when the audio has to be resampled to sit on this video at all.
 *  Compared with the same tolerance that identifies the video's own rate, so a
 *  file that matches the video is never reported as needing a change. */
export function needsRateChange(value: AudioFps): boolean {
  return Math.abs(value.fps - value.videoFps) >= VIDEO_MATCH_TOLERANCE;
}

/** The exact stretch this file needs, when both rates are standard ones.
 *  Null when no change is needed, or when a rate is not one the ratio table can
 *  name -- in which case only a measurement can produce a trustworthy ratio. */
export function rateChangeFor(value: AudioFps): RateConversion | null {
  if (!needsRateChange(value)) return null;
  return conversionBetween(value.fps, value.videoFps);
}

function usableMeasurement(measured: MeasuredDelay | undefined): boolean {
  return Boolean(measured && !measured.error);
}

/** The rate the engine concluded the audio was timed at, if it measured one. */
function measuredFps(measured: MeasuredDelay, videoFps: number | undefined): AudioFps | null {
  // Without the video's rate there is no "to" to name, and the answer would be
  // half a sentence. The measurement carries its own copy of it for the cases
  // where the video file's own rate never made it into state.
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
  // No mismatch found. That is only informative when the pair actually lines
  // up -- a likely-cut pair drifts for reasons that say nothing about rates, so
  // concluding "same rate as the video" from it would be an invention.
  if (measured.isRateMismatch || measured.isLikelyCut) return null;
  return { fps: against, videoFps: against, basis: "measured", ambiguous: false };
}

/** The rate implied by how long the audio runs against how long the video runs.
 *
 *  Content of N frames runs `N / fps` seconds, so
 *  `audioDuration / videoDuration = videoFps / audioFps`, and the audio's rate
 *  is `videoFps * videoDuration / audioDuration`.
 */
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

  // When the video's own rate is one of the candidates, prefer it. The
  // overwhelmingly common case is audio that was never converted at all, and
  // guessing 24 for a 23.976 video on the strength of a second of padding
  // would turn a no-op into a wrong stretch. This is not flagged ambiguous
  // even when 23.976 and 24 both fit: whichever of the two it is, it equals
  // the video's rate, so the conclusion -- no conversion -- is the same.
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
