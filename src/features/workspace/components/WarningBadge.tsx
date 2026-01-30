/** A warning marker on an audio row, with the whole story behind it.
 *
 *  Every red or amber badge in this app raises the same two questions, and a
 *  label answers neither: why did this happen, and what do I do now. Having one
 *  component take both as required props is what stops a new warning shipping
 *  with only the first half -- the type will not compile without a fix.
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/utils";

/** `blocking` is for a result that was withheld from the delay field; `caution`
 *  for one that was applied but needs the user to know something. */
export type WarningTone = "blocking" | "caution";

const TONE_STYLES: Record<WarningTone, string> = {
  blocking: "border-red-500 text-red-600 dark:text-red-400",
  caution: "border-amber-500 text-amber-600 dark:text-amber-400",
};

interface WarningBadgeProps {
  tone: WarningTone;
  icon: LucideIcon;
  label: string;
  /** What happened and how it came about, in the row's own numbers. */
  cause: ReactNode;
  /** The next action, concretely enough to carry out without guessing. */
  fix: ReactNode;
  /** Filled rather than outlined. Reserved for the one warning on a row that
   *  most needs reading first. */
  solid?: boolean;
}

export function WarningBadge({ tone, icon: Icon, label, cause, fix, solid }: WarningBadgeProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant={solid ? "destructive" : "outline"}
            className={cn("gap-1 cursor-help", !solid && TONE_STYLES[tone])}
          >
            <Icon className="h-3 w-3" />
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm space-y-1.5">
          <p>{cause}</p>
          <p>
            <span className="font-semibold">What to do: </span>
            {fix}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
