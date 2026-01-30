/** The measurement readout shown beside an audio row's delay field.
 *
 *  Four things the user asked to see: how confident the measurement is, the
 *  offset in frames, a warning when the file drifts or was rate-converted, and
 *  the original unrounded milliseconds so the rounding into the three-decimal
 *  field is visible rather than silent. See plan §5.3.
 *
 *  Every warning here goes through `WarningBadge`, which will not render
 *  without both halves of the answer: what caused it, and what to do about it.
 *  A badge that only names the problem sends the user back to the same guess
 *  they were making before they hovered it.
 */

import { AlertTriangle, Gauge, RefreshCw, Scissors } from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import type { MeasuredDelay } from "@/shared/types";
import { MAX_PLAUSIBLE_OFFSET_MS } from "@/shared/types/audiosync";
import { WarningBadge } from "@/features/workspace/components/WarningBadge";
import {
  confidenceLevel,
  formatConfidence,
  formatFrameOffset,
  formatPlayerDelayMs,
  formatRateConversion,
  formatRateDrift,
  isUnconvincing,
  rateConversionFor,
} from "@/features/workspace/lib/delayConversion";

const CONFIDENCE_STYLES: Record<ReturnType<typeof confidenceLevel>, string> = {
  high: "text-emerald-600 dark:text-emerald-400",
  medium: "text-amber-600 dark:text-amber-400",
  low: "text-red-600 dark:text-red-400",
};

/** Drift is reported per second, which is too small a unit to picture. Over an
 *  hour it becomes a number the user can compare against "did it look off". */
function driftPerHour(driftMsPerS: number): string {
  return `${Math.abs((driftMsPerS * 3600) / 1000).toFixed(1)} s per hour`;
}

interface MeasuredDelayInfoProps {
  measured: MeasuredDelay;
  /** Offered whenever a delay was withheld, so the user can override. */
  onApplyAnyway?: () => void;
  /** True while this measurement is staged but not yet in the delay field. */
  pending?: boolean;
  /** The reference track currently selected for this file's video. When it is
   *  not the one the measurement used, the result no longer describes what the
   *  next measurement would produce, and the row says so. */
  currentReferenceTrack?: number;
}

export function MeasuredDelayInfo({
  measured,
  onApplyAnyway,
  pending,
  currentReferenceTrack,
}: MeasuredDelayInfoProps) {
  const implausible = Math.abs(measured.engineDelayMs) > MAX_PLAUSIBLE_OFFSET_MS;
  if (measured.error) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 cursor-help">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Measurement failed: {measured.error}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm space-y-1.5">
            <p>
              The engine could not analyse this pair at all, so there is no offset to show:{" "}
              {measured.error}
            </p>
            <p>
              <span className="font-semibold">What to do: </span>
              Check the file still exists at the path in the row and that it is a media file
              ffmpeg can decode, then measure again. A failure on every row instead of this one
              usually means the engine or ffmpeg is missing — the audio sync panel reports that
              at the top.
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // Changing the reference track changes the question, so a result measured
  // against the old one is no longer an answer to the current one. Shown as an
  // indicator in the row rather than an alert: it is information the user can
  // act on when they choose to, not something to interrupt them for.
  const referenceChanged =
    currentReferenceTrack !== undefined && currentReferenceTrack !== measured.referenceTrack;

  const level = confidenceLevel(measured.confidence);
  // The stored record carries the same fields the live result did, so the
  // staging rule can be re-evaluated for display without keeping the result.
  const weak = isUnconvincing({
    confidence: measured.confidence,
  } as Parameters<typeof isUnconvincing>[0]);
  const withheld = implausible || measured.isLikelyCut || weak;
  const frames = formatFrameOffset(measured.appliedMs, measured.primaryFps);
  const conversion = measured.isRateMismatch ? rateConversionFor(measured) : null;

  return (
    <TooltipProvider>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn("font-medium", CONFIDENCE_STYLES[level])}>
              {formatConfidence(measured.confidence)}
            </span>
          </TooltipTrigger>
          {/* Confidence is a property of the comparison, not of the file, and
              the comparison is against one particular track of the video. Two
              tools measuring the same pair report the same delay and different
              confidence when they reference different tracks -- the offset is
              shared by everything in the container, the correlation sharpness
              is not. Naming the track is what makes that difference readable
              instead of looking like one of the two being wrong. */}
          <TooltipContent className="max-w-xs">
            Measured against audio track {measured.referenceTrack + 1} of the video. Confidence
            says how distinct the correlation peak was against that track, so comparing it with
            another tool only means anything if that tool used the same one.
          </TooltipContent>
        </Tooltip>

        {/* The unrounded measurement, in the same convention the user reads in
            AudioSyncMaster, so the rounding into the field is visible. */}
        <span className="text-muted-foreground">
          {formatPlayerDelayMs(measured.engineDelayMs)}
        </span>

        {frames && <span className="text-muted-foreground">{frames}</span>}

        {/* Measuring stages a value; the delay field is unchanged until it is
            applied. Without this the row looked identical either way. */}
        {pending && (
          <Badge variant="outline" className="gap-1 border-primary/50 text-primary">
            Ready to apply
          </Badge>
        )}

        {referenceChanged && (
          <WarningBadge
            tone="caution"
            icon={RefreshCw}
            label="Reference changed"
            cause={
              <>
                This was measured against audio track {measured.referenceTrack + 1} of the video,
                but track {(currentReferenceTrack ?? 0) + 1} is the reference now. The two tracks
                can sit at different offsets, so the delay below answers a question you are no
                longer asking.
              </>
            }
            fix={
              <>
                Measure this row again to get a delay for track{" "}
                {(currentReferenceTrack ?? 0) + 1}, or set the reference back to track{" "}
                {measured.referenceTrack + 1} if that was the one you meant.
              </>
            }
          />
        )}

        {/* Checked before the others: a result this large is not a delay, and
            saying "different cut" about it would be a guess at the cause. */}
        {implausible && (
          <WarningBadge
            tone="blocking"
            solid
            icon={AlertTriangle}
            label="Implausible"
            cause={
              <>
                {formatPlayerDelayMs(measured.engineDelayMs)} is far larger than any real audio
                delay — a container offset is milliseconds, occasionally a second or two, so this
                was measured but not filled in. It nearly always means the correlator locked onto
                a repeated passage: the same music cue, an ident, or a stretch of near-silence
                that occurs twice. A high confidence does not rule that out, because it only says
                the sample windows agreed with each other, and a repeated passage looks identical
                in every window.
              </>
            }
            fix={
              <>
                Choose a reference track that actually shares dialogue with this dub and measure
                again — a music-only or commentary track is the usual cause. If the audio comes
                from a release with an extra logo or intro, trim it first, or type the offset by
                hand. Use <span className="font-medium">Apply anyway</span> only after playing
                both files at the same timestamp and confirming the offset is real.
              </>
            }
          />
        )}

        {!implausible && measured.isLikelyCut && (
          <WarningBadge
            tone="blocking"
            solid
            icon={Scissors}
            label="Different cut"
            cause={
              <>
                The offset does not stay put: it changes
                {measured.driftMsPerS !== null
                  ? ` by ${measured.driftMsPerS.toFixed(3)} ms every second (${driftPerHour(
                      measured.driftMsPerS,
                    )})`
                  : ""}
                , far faster than any frame-rate conversion can explain. That means the two files
                do not hold the same material end to end — scenes added or removed, an extended
                cut against a theatrical one, or recap footage only one of them has. Nothing was
                filled in, because no single delay and no stretch can align them.
                {measured.rateExplanation ? ` ${measured.rateExplanation}` : ""}
              </>
            }
            fix={
              <>
                Pair this audio with the release it was made for — matching runtimes are the quick
                check. If you have to keep this pairing, cut or pad the audio to match the video
                outside the app first; muxing it as-is will drift further out the longer it plays.
              </>
            }
          />
        )}

        {/* A weak correlation means no distinct peak was found, so the number
            beside it is not a measurement of anything. Ranked below the two
            structural problems, which explain themselves more specifically. */}
        {!implausible && !measured.isLikelyCut && weak && (
          <WarningBadge
            tone="blocking"
            icon={AlertTriangle}
            label="Weak match"
            cause={
              <>
                The analysis never found a clear peak — the sample windows disagreed with each
                other, so at {formatConfidence(measured.confidence)} the offset beside this is not
                a measurement of anything and was not filled in. It usually means the two files
                share little audible material: a heavily re-mixed dub, a reference track that is
                music and effects only, a different encode, or simply the wrong pairing.
              </>
            }
            fix={
              <>
                Check this audio really belongs to this video, then pick a reference track with
                dialogue in it and measure again. If it stays low, set the delay by hand after
                listening to both at the same timestamp —{" "}
                <span className="font-medium">Apply anyway</span> accepts this number unchanged
                rather than improving it.
              </>
            }
          />
        )}

        {!measured.isLikelyCut && measured.isRateMismatch && (
          <WarningBadge
            tone="caution"
            icon={Gauge}
            label={conversion ? formatRateConversion(conversion) : "Frame rate"}
            cause={
              <>
                {measured.rateExplanation ??
                  "This file looks frame-rate converted; a plain delay will drift over its length."}
                {conversion && <> The audio runs {formatRateDrift(conversion)}.</>}
              </>
            }
            fix={
              conversion ? (
                <>
                  Turn on <span className="font-medium">Correct frame rate</span> below: it muxes
                  the track with a {conversion.num}/{conversion.den} stretch, which is the exact
                  conversion between these two rates
                  {conversion.basis === "measured"
                    ? " as far as the measurement can tell — check the end of the file before running a batch"
                    : ""}
                  . A delay on its own only lines up the start.
                </>
              ) : (
                <>
                  Measure this row again so the engine can name both rates; without them a stretch
                  ratio would be a guess, and a wrong one drifts a file that a plain delay merely
                  leaves imperfect.
                </>
              )
            }
          />
        )}

        {!measured.isLikelyCut && !measured.isRateMismatch && measured.hasSignificantDrift && (
          <WarningBadge
            tone="caution"
            icon={AlertTriangle}
            label="Drift"
            cause={
              <>
                The offset changes across the file
                {measured.driftMsPerS !== null
                  ? ` by ${measured.driftMsPerS.toFixed(3)} ms per second, about ${driftPerHour(
                      measured.driftMsPerS,
                    )}`
                  : ""}
                , but by an amount that matches no standard frame-rate conversion. A
                variable-rate source, a file joined from several pieces, or audio resampled at a
                slightly wrong rate all look like this.
              </>
            }
            fix={
              <>
                The delay applied is the one measured at the start, so the opening will be in sync
                and the drift accumulates from there. Check the last few minutes; if it has gone
                far enough to notice, resample the audio outside the app rather than muxing it
                with a delay alone.
              </>
            }
          />
        )}

        {withheld && onApplyAnyway && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={onApplyAnyway}
          >
            Apply anyway
          </Button>
        )}
      </div>
    </TooltipProvider>
  );
}
