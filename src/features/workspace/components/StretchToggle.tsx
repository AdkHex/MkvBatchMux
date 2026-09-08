/** Opt-in linear stretch for a frame-rate-converted track.
 *
 *  Defaults to off and stays off unless the user turns it on: a plain offset is
 *  merely imperfect on a rate-converted file, whereas a wrong stretch ratio
 *  actively drifts a file that was previously fine. See plan §5.5.
 *
 *  The label names both rates rather than only the ratio. "999/1000" is not
 *  something anyone can check; "24.000 → 23.976 fps" is the sentence the user
 *  already has in their head, and it is the one thing they can confirm against
 *  the release they downloaded.
 */

import { useEffect, useRef } from "react";
import { Checkbox } from "@/shared/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";
import type { MeasuredDelay, StretchSetting } from "@/shared/types";
import {
  formatRateConversion,
  formatRateDrift,
  rateConversionFor,
} from "@/features/workspace/lib/delayConversion";

interface StretchToggleProps {
  measured: MeasuredDelay;
  value: StretchSetting | undefined;
  onChange: (next: StretchSetting | undefined) => void;
  id: string;
  disabled?: boolean;
}

export function StretchToggle({ measured, value, onChange, id, disabled }: StretchToggleProps) {
  // Only offered where the engine actually diagnosed a rate conversion.
  const conversion = measured.isRateMismatch ? rateConversionFor(measured) : null;
  const enabled = Boolean(value);

  // A ratio saved by an earlier build is not the ratio this one would set: the
  // stored number was the engine's atempo factor, which is the reciprocal of
  // what mkvmerge multiplies timestamps by, and conversions this build names
  // exactly were approximated then. Re-storing it keeps the promise the
  // checkbox makes -- that a tick means the ratio printed beside it -- instead
  // of muxing a number the user cannot see and would not recognise.
  //
  // The ref is only so a fresh `onChange` closure on every render does not
  // re-fire the effect; the correction depends on the ratio alone.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const num = conversion?.num;
  const den = conversion?.den;
  useEffect(() => {
    if (!enabled || num === undefined || den === undefined) return;
    if (value?.num === num && value?.den === den) return;
    onChangeRef.current({ num, den });
  }, [enabled, num, den, value?.num, value?.den]);

  if (!conversion) return null;

  const approximate = conversion.basis === "measured";

  return (
    <TooltipProvider>
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={enabled}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange(checked ? { num: conversion.num, den: conversion.den } : undefined)
          }
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <label htmlFor={id} className="cursor-pointer text-xs">
              Correct frame rate:{" "}
              <span className="font-medium">{formatRateConversion(conversion)}</span>
              <span className="text-muted-foreground">
                {" "}
                ·{conversion.num}/{conversion.den}
              </span>
              {approximate && (
                <span className="text-amber-600 dark:text-amber-400"> ·approx</span>
              )}
            </label>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm space-y-1.5">
            <p>
              {measured.rateExplanation ??
                "The audio was timed against a different frame rate than this video."}{" "}
              It runs {formatRateDrift(conversion)}.
            </p>
            <p>
              Turning this on muxes the track as{" "}
              <span className="font-mono">
                --sync {conversion.num}/{conversion.den}
              </span>
              , which slows or speeds every timestamp by exactly that factor. The delay itself is
              unaffected — it is measured at the start of the file, where the stretch pivots.
            </p>
            {approximate ? (
              <p className="text-amber-600 dark:text-amber-400">
                This ratio comes from the measured drift, not from a standard conversion between
                two known rates, so it carries the measurement's error. Mux one file and check
                the last few minutes before running a batch.
              </p>
            ) : (
              <p>
                {conversion.basis === "inferred"
                  ? "The rates were identified from the measured speed; the ratio between them is exact."
                  : "Both rates were identified, so this ratio is the exact broadcast conversion between them."}
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
