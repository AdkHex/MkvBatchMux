/** The frame rate an audio file was timed at, shown beside its name.
 *
 *  When that rate is not the video's, the badge names both — "25.000 → 23.976
 *  fps" — because the rate on its own is only half of what the user has to
 *  decide. The other half is the ratio it takes to get from one to the other,
 *  which is in the tooltip along with the fact that it takes a measurement to
 *  apply it.
 *
 *  Renders nothing when there is no answer -- an unmatched file, a video with
 *  no known rate, or a pair whose durations match no standard conversion. A
 *  blank is honest there; a fabricated rate would be read as fact and could be
 *  turned into a wrong `--sync` stretch.
 */

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { formatFps, formatRateDrift } from "@/features/workspace/lib/delayConversion";
import { needsRateChange, rateChangeFor, type AudioFps } from "@/features/workspace/lib/audioFps";

interface AudioFpsBadgeProps {
  value: AudioFps | null;
}

export function AudioFpsBadge({ value }: AudioFpsBadgeProps) {
  if (!value) return null;

  const estimated = value.basis === "estimated";
  const converted = needsRateChange(value);
  const change = rateChangeFor(value);
  const label = converted
    ? `${estimated ? "~" : ""}${formatFps(value.fps)} → ${formatFps(value.videoFps)} fps`
    : `${estimated ? "~" : ""}${formatFps(value.fps)} fps`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "text-[11px] font-mono tabular-nums shrink-0 cursor-default",
              converted || value.ambiguous
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground",
            )}
          >
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm space-y-1.5">
          <p>
            {converted ? (
              <>
                This audio was timed at {formatFps(value.fps)} fps, but the video it is matched to
                is {formatFps(value.videoFps)} fps
                {change ? <>, so it plays {formatRateDrift(change)}</> : null}.
              </>
            ) : (
              <>
                This audio was timed at the same rate as the video it is matched to (
                {formatFps(value.videoFps)} fps), so no frame-rate conversion is needed — a plain
                delay lines it up for the whole file.
              </>
            )}{" "}
            {estimated
              ? "That is estimated from how long the two files run, not measured."
              : "Measured by the audio sync engine."}
          </p>
          {converted && (
            <p>
              <span className="font-semibold">What to do: </span>
              Measure this row, then turn on{" "}
              <span className="font-medium">Correct frame rate</span>
              {change ? (
                <>
                  {" "}
                  to mux it with the exact {change.num}/{change.den} stretch
                </>
              ) : null}
              . A delay on its own only lines up the start of the file.
            </p>
          )}
          {value.ambiguous && (
            <p className="text-amber-600 dark:text-amber-400">
              Another standard rate fits these durations equally well — they are only 0.1% apart,
              which is less than the padding on a typical encode. The two take different stretch
              ratios, so measure before applying one.
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
