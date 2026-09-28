/** Reading AudioSyncMaster's Dub sync plan as warnings: every cut, gap and frame-rate change
 *  across a pair's whole runtime. Nothing here changes a delay unless the user asks. */

import type { ExternalFile, MeasuredDelay } from "@/shared/types";
import type { TimelineCut, TimelinePlan, TimelineScan } from "@/shared/types/audiosync";
import { applyMeasuredDelay } from "./applyMeasurement";
import { engineMsToDelaySeconds } from "./delayConversion";

/** Picture edits move whole frames, 33 ms or more; a smaller difference between two stretches
 *  is measurement noise, not a cut. */
export const CUT_MIN_MS = 20;

/** Where lip-sync error becomes visible (ITU-R BT.1359, the stricter early-sound bound);
 *  AudioSyncMaster uses the same figure for its own checks. */
export const LIP_SYNC_VISIBLE_MS = 45;

/** A dub running this close to the video's speed is at the same rate. */
const SAME_SPEED = 1e-6;

/** Condense a plan into what the warnings need. */
export function summarizeTimeline(
  plan: TimelinePlan | null,
  description: string | null,
  error: string | null,
  scannedAt: string,
): TimelineScan {
  const empty: TimelineScan = {
    scannedAt,
    error: error ?? plan?.error ?? null,
    startOffsetMs: null,
    cuts: [],
    unverified: [],
    tailS: 0,
    videoFps: plan?.videoFps ?? null,
    dubRate: plan?.dubRate ?? null,
    speed: plan?.speed ?? 1,
    rateConfirmed: plan?.rateConfirmed ?? null,
    dubUsedShare: plan?.summary?.dubUsedShare ?? null,
    videoDurationS: plan?.videoDurationS ?? 0,
    description,
  };
  if (!plan || empty.error) return empty;

  const segments = [...plan.segments].sort((a, b) => a.startS - b.startS);
  const cuts: TimelineCut[] = [];
  let previousDub: (typeof segments)[number] | null = null;
  let fillsSince: typeof segments = [];

  for (const segment of segments) {
    if (segment.kind === "fill") {
      fillsSince.push(segment);
      continue;
    }
    if (segment.offsetS === null) continue;
    if (previousDub && previousDub.offsetS !== null) {
      const jumpMs = (segment.offsetS - previousDub.offsetS) * 1000;
      if (Math.abs(jumpMs) >= CUT_MIN_MS) {
        const missing = fillsSince.filter((fill) => fill.reason === "cut");
        cuts.push({
          // Where the dub stops matching: the start of the gap it cannot fill, else the
          // point it resumes at the new offset.
          atS: missing.length > 0 ? missing[0].startS : segment.startS,
          jumpMs,
          missingS: missing.reduce((sum, fill) => sum + (fill.endS - fill.startS), 0),
          uncertaintyS: Math.max(segment.uncertaintyS, ...fillsSince.map((fill) => fill.uncertaintyS)),
          offsetAfterMs: segment.offsetS * 1000,
        });
      }
    }
    previousDub = segment;
    fillsSince = [];
  }

  const firstDub = segments.find((segment) => segment.kind === "dub" && segment.offsetS !== null);
  return {
    ...empty,
    startOffsetMs: firstDub?.offsetS != null ? firstDub.offsetS * 1000 : null,
    cuts,
    unverified: segments
      .filter((segment) => segment.kind === "fill" && segment.reason === "unmatched")
      .map((segment) => ({ startS: segment.startS, endS: segment.endS })),
    tailS: segments
      .filter((segment) => segment.kind === "fill" && segment.reason === "tail")
      .reduce((sum, segment) => sum + (segment.endS - segment.startS), 0),
  };
}

/** The dub had to be played at another speed to line up: a frame-rate conversion. */
export function isRateChange(scan: TimelineScan): boolean {
  return Math.abs(scan.speed - 1) > SAME_SPEED;
}

/** How far the timeline's opening stretch sits from the measured delay, in ms. Null when there
 *  is nothing to compare, or when the dub runs at another speed and its offsets are on a
 *  stretched clock that a plain delay does not share. */
export function timelineDisagreementMs(measured: MeasuredDelay): number | null {
  const scan = measured.timeline;
  if (!scan || scan.error || scan.startOffsetMs === null || isRateChange(scan)) return null;
  if (measured.error) return null;
  return Math.abs(scan.startOffsetMs - measured.engineDelayMs);
}

/** Whether the timeline's opening offset can be offered as the delay: it exists, runs at the
 *  video's speed, and says something the measurement did not. */
export function canUseTimelineDelay(measured: MeasuredDelay): boolean {
  const scan = measured.timeline;
  if (!scan || scan.error || scan.startOffsetMs === null || isRateChange(scan)) return false;
  const disagreement = timelineDisagreementMs(measured);
  return measured.error !== null || disagreement === null || disagreement > LIP_SYNC_VISIBLE_MS;
}

function measuredOf(file: ExternalFile, trackId: number | null): MeasuredDelay | undefined {
  return trackId === null ? file.measuredDelay : file.trackOverrides?.[trackId]?.measuredDelay;
}

function withMeasured(file: ExternalFile, trackId: number | null, measured: MeasuredDelay): ExternalFile {
  if (trackId === null) return { ...file, measuredDelay: measured };
  return {
    ...file,
    trackOverrides: {
      ...(file.trackOverrides ?? {}),
      [trackId]: { ...(file.trackOverrides?.[trackId] ?? {}), measuredDelay: measured },
    },
  };
}

/** Attach a scan to the measurement it followed. A row whose measurement was cleared in the
 *  meantime (typed over by hand) is left alone. */
export function attachTimelineScan(
  file: ExternalFile,
  trackId: number | null,
  scan: TimelineScan,
): ExternalFile {
  const measured = measuredOf(file, trackId);
  if (!measured) return file;
  return withMeasured(file, trackId, { ...measured, timeline: scan });
}

/** Write the timeline's opening offset into the delay field, as a measured value. Only ever
 *  called from an explicit click. */
export function applyTimelineDelay(file: ExternalFile, trackId: number | null): ExternalFile {
  const measured = measuredOf(file, trackId);
  const offset = measured?.timeline?.startOffsetMs;
  if (!measured || offset === null || offset === undefined) return file;
  const pendingDelay = engineMsToDelaySeconds(offset);
  const staged: ExternalFile =
    trackId === null
      ? { ...file, pendingDelay }
      : {
          ...file,
          trackOverrides: {
            ...(file.trackOverrides ?? {}),
            [trackId]: { ...(file.trackOverrides?.[trackId] ?? {}), pendingDelay },
          },
        };
  return applyMeasuredDelay(staged, trackId);
}

/** h:mm:ss.mmm, as AudioSyncMaster prints positions: a cut at 1:23:45.317 is a different claim
 *  from one at 1:23:45. */
export function formatClock(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const rest = (ms % 60_000) / 1000;
  return `${hours}:${String(minutes).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}

/** A span as people say it: "2m 30.0s", "0.7s". */
export function formatSpan(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  if (tenths >= 600) {
    const minutes = Math.floor(tenths / 600);
    return `${minutes}m ${((tenths - minutes * 600) / 10).toFixed(1).padStart(4, "0")}s`;
  }
  return `${(tenths / 10).toFixed(1)}s`;
}

/** One cut as a sentence: where, and what the dub does there. */
export function describeCut(cut: TimelineCut): string {
  const at = formatClock(cut.atS);
  const about = cut.uncertaintyS >= 0.05 ? ` (±${cut.uncertaintyS.toFixed(1)}s)` : "";
  const size = formatSpan(Math.abs(cut.jumpMs) / 1000);
  if (cut.missingS > 0) {
    return `${at}${about}: the dub lacks ${formatSpan(cut.missingS)} of the video here`;
  }
  if (Math.abs(cut.jumpMs) < 1000) {
    // A negative jump means the dub's material comes sooner than before, so with the opening
    // delay applied it plays that much ahead of the picture.
    return `${at}${about}: from here the dub plays ${Math.abs(cut.jumpMs).toFixed(0)} ms ${cut.jumpMs < 0 ? "early" : "late"}`;
  }
  return cut.jumpMs < 0
    ? `${at}${about}: the dub skips ${size} of the video`
    : `${at}${about}: the dub has ${size} the video lacks`;
}
