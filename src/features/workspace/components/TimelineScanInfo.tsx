/** The full-timeline scan's findings beside an audio row's measurement: every cut, a frame-rate
 *  change, spans that could not be confirmed, and whether the measured delay holds lip to lip. */

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, FileText, Gauge, Scissors, ScanLine } from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";
import type { MeasuredDelay } from "@/shared/types";
import type { TimelineEdit } from "@/shared/types/audiosync";
import { WarningBadge } from "@/features/workspace/components/WarningBadge";
import { formatFps, formatPlayerDelayMs } from "@/features/workspace/lib/delayConversion";
import {
  LIP_SYNC_VISIBLE_MS,
  canUseTimelineDelay,
  describeCut,
  formatClock,
  formatSpan,
  isRateChange,
  timelineDisagreementMs,
} from "@/features/workspace/lib/timelineScan";

/** A tooltip holds this many cuts before the rest are summed up; the details view has them all. */
const LISTED_CUTS = 8;

/** A dub ending this much earlier than the video is worth saying; less is a trailing silence. */
const NOTABLE_TAIL_S = 5;

/** "4 edits · 1 major, 2 to check": the count, the worst grade present, and how many need an ear. */
function editsLabel(edits: TimelineEdit[]): string {
  const major = edits.filter((edit) => edit.severity === "major").length;
  const toCheck = edits.filter((edit) => edit.check).length;
  const parts = [`${edits.length} ${edits.length === 1 ? "edit" : "edits"}`];
  if (major > 0) parts.push(`${major} major`);
  if (toCheck > 0) parts.push(`${toCheck} to check`);
  return parts.join(" · ");
}

interface TimelineScanInfoProps {
  measured: MeasuredDelay;
  /** Write the timeline's opening offset into the delay field. Offered only when it differs. */
  onUseTimelineDelay?: () => void;
}

export function TimelineScanInfo({ measured, onUseTimelineDelay }: TimelineScanInfoProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const scan = measured.timeline;
  if (!scan) return null;

  if (scan.error) {
    return (
      <WarningBadge
        tone="caution"
        icon={ScanLine}
        label="Scan failed"
        cause={<>The full-timeline scan for cuts could not run on this pair: {scan.error}</>}
        fix={
          <>
            The delay beside this still stands on its own, but cuts and frame-rate changes were not
            checked. Measure this row again; if it keeps failing, open the pair in AudioSyncMaster's
            Dub sync mode, which runs the same analysis and shows where it stops.
          </>
        }
      />
    );
  }

  const rateChange = isRateChange(scan);
  const disagreement = timelineDisagreementMs(measured);
  const lipSyncOff = disagreement !== null && disagreement > LIP_SYNC_VISIBLE_MS;
  const endsEarly = scan.tailS >= NOTABLE_TAIL_S;
  // The engine's own list, when it sent one: each edit graded, placed on both timelines and
  // marked when it rests on too little dub to be sure. Older plans only carry the segments.
  const edits = scan.edits ?? null;
  const editCount = edits ? edits.length : scan.cuts.length;
  const clean = editCount === 0 && !rateChange && scan.unverified.length === 0 && !lipSyncOff;
  const opening = scan.startOffsetMs !== null ? formatPlayerDelayMs(scan.startOffsetMs) : null;
  const firstAtS = edits?.[0]?.videoS ?? scan.cuts[0]?.atS ?? 0;
  const guide = scan.rateGuide ?? null;

  return (
    <>
      {editCount > 0 && (
        <WarningBadge
          tone="blocking"
          solid
          icon={Scissors}
          label={edits ? editsLabel(edits) : `${scan.cuts.length} ${scan.cuts.length === 1 ? "cut" : "cuts"}`}
          cause={
            <>
              Across the full runtime the dub does not follow the video in one piece. It starts at{" "}
              {opening ?? "an unknown offset"}, then:
              {edits
                ? edits.slice(0, LISTED_CUTS).map((edit) => (
                    <span key={edit.index} className="block pl-2">
                      • {edit.check ? "(check) " : ""}
                      {edit.description}
                    </span>
                  ))
                : scan.cuts.slice(0, LISTED_CUTS).map((cut) => (
                    <span key={cut.atS} className="block pl-2">
                      • {describeCut(cut)}
                    </span>
                  ))}
              {editCount > LISTED_CUTS && (
                <span className="block pl-2">
                  …and {editCount - LISTED_CUTS} more (see Timeline details).
                </span>
              )}
            </>
          }
          fix={
            <>
              One delay only lines up the part before {formatClock(firstAtS)}; muxed as it is,
              everything after that is out of sync. Pair this audio with the release it was cut for
              (matching runtimes are the quick check), or re-lay it onto this video with
              AudioSyncMaster's Dub sync mode, which works from this same analysis.
            </>
          }
        />
      )}

      {rateChange && (
        <WarningBadge
          tone="blocking"
          icon={Gauge}
          label={
            scan.dubRate !== null && scan.videoFps !== null
              ? `FPS ${formatFps(scan.dubRate)} → ${formatFps(scan.videoFps)}`
              : "FPS change"
          }
          cause={
            guide ? (
              <>
                {guide.instruction} {guide.pitchNote}
              </>
            ) : (
              <>
                {scan.dubRate !== null && scan.videoFps !== null
                  ? `The video runs at ${formatFps(scan.videoFps)} fps, but the dub was mastered at ${formatFps(scan.dubRate)} fps. `
                  : ""}
                The dub only lines up played at {scan.speed.toFixed(6)}× its speed, so a plain delay drifts
                by about {(Math.abs(scan.speed - 1) * 3600).toFixed(1)} s every hour.
                {scan.rateConfirmed === false
                  ? " The audio did not confirm this rate sharply, so treat it as the likeliest explanation rather than a certainty."
                  : ""}
              </>
            )
          }
          fix={
            guide ? (
              <>
                Best: convert the dub before muxing with FFmpeg{" "}
                <code className="rounded bg-muted px-1">-af {guide.ffmpegFilter}</code>, then use a delay of{" "}
                {guide.delayWithStretchMs !== null ? formatPlayerDelayMs(guide.delayWithStretchMs) : "a fresh measurement"}
                . Or turn on <span className="font-medium">Correct frame rate</span> on this row: it stretches the
                timestamps by {guide.stretch.num}/{guide.stretch.den} and scales the delay to match, which plays in sync
                in players that follow the timestamps. Check the last minutes of the file after either.
              </>
            ) : (
              <>
                Use <span className="font-medium">Correct frame rate</span> on this row when it is offered,
                or convert the audio to {scan.videoFps !== null ? `${formatFps(scan.videoFps)} fps` : "the video's rate"}{" "}
                before muxing. Check the last minutes of the file after either.
              </>
            )
          }
        />
      )}

      {lipSyncOff && (
        <WarningBadge
          tone="caution"
          icon={AlertTriangle}
          label="Lip-sync check"
          cause={
            <>
              The full-timeline scan puts the opening stretch at {opening}, measured from that stretch
              alone at 2 ms resolution; the delay measured above is{" "}
              {formatPlayerDelayMs(measured.engineDelayMs)}. They are {disagreement!.toFixed(0)} ms apart,
              past the {LIP_SYNC_VISIBLE_MS} ms where lips visibly lead or trail the voice.
            </>
          }
          fix={
            <>
              Play the first dialogue scene with each value. The measured delay is the one
              AudioSyncMaster's Analyze reports; <span className="font-medium">Use timeline delay</span>{" "}
              writes the scan's instead.
            </>
          }
        />
      )}

      {scan.unverified.length > 0 && (
        <WarningBadge
          tone="caution"
          icon={AlertTriangle}
          label="Unconfirmed"
          cause={
            <>
              The dub was audible but matched nothing in the video across{" "}
              {scan.unverified
                .slice(0, LISTED_CUTS)
                .map((span) => `${formatClock(span.startS)} – ${formatClock(span.endS)}`)
                .join(", ")}
              {scan.unverified.length > LISTED_CUTS ? ", and more" : ""}, so sync there is unconfirmed.
            </>
          }
          fix={<>Watch those spans before muxing a batch; a re-edited scene or new music is the usual cause.</>}
        />
      )}

      {endsEarly && (
        <WarningBadge
          tone="caution"
          icon={Clock}
          label="Ends early"
          cause={
            <>
              The dub stops {formatSpan(scan.tailS)} before the video does, at{" "}
              {formatClock(scan.videoDurationS - scan.tailS)}.
            </>
          }
          fix={<>Usually missing end credits. If the video has dialogue there, it will be silent in this language.</>}
        />
      )}

      {clean && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className="gap-1 cursor-help border-emerald-500 text-emerald-600 dark:text-emerald-400"
              >
                <CheckCircle2 className="h-3 w-3" />
                No cuts
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">
              Scanned the full runtime: the dub follows the video in one piece
              {opening ? ` at ${opening}` : ""}, at the video's own frame rate
              {scan.dubUsedShare !== null ? `, using ${(scan.dubUsedShare * 100).toFixed(1)}% of the dub` : ""}.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {onUseTimelineDelay && canUseTimelineDelay(measured) && (
        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onUseTimelineDelay}>
          Use timeline delay ({opening})
        </Button>
      )}

      {scan.description && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs gap-1"
            onClick={() => setDetailsOpen(true)}
          >
            <FileText className="h-3 w-3" />
            Timeline details
          </Button>
          <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
            <DialogContent className="max-w-3xl">
              <DialogHeader>
                <DialogTitle>Timeline scan</DialogTitle>
                <DialogDescription>
                  AudioSyncMaster's Dub sync plan for this pair: which stretch of the dub sits at each
                  moment of the video, and where the video's own audio would have to fill in. Offsets
                  are dub time minus video time.
                </DialogDescription>
              </DialogHeader>
              <pre className="max-h-[60vh] overflow-auto rounded bg-muted p-3 text-xs leading-relaxed">
                {scan.description}
              </pre>
            </DialogContent>
          </Dialog>
        </>
      )}
    </>
  );
}
