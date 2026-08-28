/** Opt-in linear stretch for a frame-rate-converted track.
 *
 *  Defaults to off and stays off unless the user turns it on: a plain offset is
 *  merely imperfect on a rate-converted file, whereas a wrong stretch ratio
 *  actively drifts a file that was previously fine. See plan §5.5.
 */

import { Checkbox } from "@/shared/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";
import type { MeasuredDelay, StretchSetting } from "@/shared/types";
import { stretchRatioFor } from "@/features/workspace/lib/delayConversion";

interface StretchToggleProps {
  measured: MeasuredDelay;
  value: StretchSetting | undefined;
  onChange: (next: StretchSetting | undefined) => void;
  id: string;
  disabled?: boolean;
}

export function StretchToggle({ measured, value, onChange, id, disabled }: StretchToggleProps) {
  // Only offered where the engine actually diagnosed a rate conversion.
  if (!measured.isRateMismatch) return null;

  const ratio = stretchRatioFor(
    measured.correctionRatio,
    measured.rateSourceFps,
    measured.rateTargetFps,
  );
  if (!ratio) return null;

  const enabled = Boolean(value);

  return (
    <TooltipProvider>
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={enabled}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange(checked ? { num: ratio.num, den: ratio.den } : undefined)
          }
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <label htmlFor={id} className="cursor-pointer text-xs">
              Correct frame rate ({ratio.num}/{ratio.den})
              {!ratio.exact && <span className="text-amber-600 dark:text-amber-400"> ·approx</span>}
            </label>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {measured.rateExplanation ??
              "The audio was timed against a different frame rate than this video."}
            <br />
            Adds a linear stretch to the mux, on top of the delay. The delay itself is
            unaffected — it is measured at the start of the file, where the stretch pivots.
            {!ratio.exact && (
              <>
                <br />
                <span className="text-amber-600 dark:text-amber-400">
                  This ratio is approximated from the measured drift rather than matched to a
                  standard broadcast conversion; check the result before muxing a batch.
                </span>
              </>
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
