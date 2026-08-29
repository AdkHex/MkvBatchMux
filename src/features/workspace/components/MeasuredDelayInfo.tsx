/** The measurement readout shown beside an audio row's delay field.
 *
 *  Four things the user asked to see: how confident the measurement is, the
 *  offset in frames, a warning when the file drifts or was rate-converted, and
 *  the original unrounded milliseconds so the rounding into the three-decimal
 *  field is visible rather than silent. See plan §5.3.
 */

import { AlertTriangle, Scissors } from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import type { MeasuredDelay } from "@/shared/types";
import { MAX_PLAUSIBLE_OFFSET_MS } from "@/shared/types/audiosync";
import {
  confidenceLevel,
  formatConfidence,
  formatFrameOffset,
  formatPlayerDelayMs,
} from "@/features/workspace/lib/delayConversion";

const CONFIDENCE_STYLES: Record<ReturnType<typeof confidenceLevel>, string> = {
  high: "text-emerald-600 dark:text-emerald-400",
  medium: "text-amber-600 dark:text-amber-400",
  low: "text-red-600 dark:text-red-400",
};

interface MeasuredDelayInfoProps {
  measured: MeasuredDelay;
  /** Offered only for a cut, where no delay was written. */
  onApplyAnyway?: () => void;
  /** True while this measurement is staged but not yet in the delay field. */
  pending?: boolean;
}

export function MeasuredDelayInfo({ measured, onApplyAnyway, pending }: MeasuredDelayInfoProps) {
  const implausible = Math.abs(measured.engineDelayMs) > MAX_PLAUSIBLE_OFFSET_MS;
  if (measured.error) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate" title={measured.error}>
          Measurement failed: {measured.error}
        </span>
      </div>
    );
  }

  const level = confidenceLevel(measured.confidence);
  const frames = formatFrameOffset(measured.appliedMs, measured.primaryFps);

  return (
    <TooltipProvider>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className={cn("font-medium", CONFIDENCE_STYLES[level])}>
          {formatConfidence(measured.confidence)}
        </span>

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

        {/* Checked before the others: a result this large is not a delay, and
            saying "different cut" about it would be a guess at the cause. */}
        {implausible && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="h-3 w-3" />
                Implausible
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {formatPlayerDelayMs(measured.engineDelayMs)} is far larger than any real
              audio delay, so it was measured but not filled in. It usually means the
              analysis locked onto a repeated part of the soundtrack rather than the
              matching one — high confidence only means the sample windows agreed with
              each other. Check the files play in sync before applying anything.
            </TooltipContent>
          </Tooltip>
        )}

        {!implausible && measured.isLikelyCut && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="destructive" className="gap-1">
                <Scissors className="h-3 w-3" />
                Different cut
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              These two files look like different cuts of the material, so no single delay can
              align them. Nothing was filled in.
              {measured.rateExplanation ? ` ${measured.rateExplanation}` : ""}
            </TooltipContent>
          </Tooltip>
        )}

        {!measured.isLikelyCut && measured.isRateMismatch && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="gap-1 border-amber-500 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3" />
                Frame rate
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {measured.rateExplanation ??
                "This file looks frame-rate converted; a plain delay will drift over its length."}
            </TooltipContent>
          </Tooltip>
        )}

        {!measured.isLikelyCut && !measured.isRateMismatch && measured.hasSignificantDrift && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="gap-1 border-amber-500 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3" />
                Drift
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              The offset changes across the file
              {measured.driftMsPerS !== null
                ? ` by ${measured.driftMsPerS.toFixed(3)} ms per second`
                : ""}
              . The delay applied is the one measured at the start.
            </TooltipContent>
          </Tooltip>
        )}

        {(measured.isLikelyCut || implausible) && onApplyAnyway && (
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
