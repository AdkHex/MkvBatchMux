/** Conforming dubs to another cut and measuring subtitle delays: the Tauri commands, their events,
 *  and the pure rules for reading their results. Both runs use the engine, so a caller claims it
 *  first (`claimEngine` in src/app/Index.tsx) and cancels with `measureDelaysCancel`. */

import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import type {
  ConformedTrack,
  ConformProgressEvent,
  ConformRequest,
  ConformResultEvent,
  EngineRunDoneEvent,
  RetimedSubtitle,
  SubsyncProgressEvent,
  SubsyncRequest,
  SubsyncResultEvent,
} from "@/shared/types/engineFeatures";

// ------------------------------------------------------------------ commands and events

/** Start conforming; results arrive as `conform-result`, one per pair, then `conform-done`. */
export async function conformDubsStart(request: ConformRequest) {
  return invoke<void>("conform_dubs_start", { request });
}

export function listenConformProgress(handler: (payload: ConformProgressEvent) => void) {
  return listen<ConformProgressEvent>("conform-progress", (event) => handler(event.payload));
}

export function listenConformResult(handler: (payload: ConformResultEvent) => void) {
  return listen<ConformResultEvent>("conform-result", (event) => handler(event.payload));
}

export function listenConformDone(handler: (payload: EngineRunDoneEvent) => void) {
  return listen<EngineRunDoneEvent>("conform-done", (event) => handler(event.payload));
}

/** Start measuring; results arrive as `subsync-result`, one per job, then `subsync-done`. */
export async function subsyncStart(request: SubsyncRequest) {
  return invoke<void>("subsync_start", { request });
}

export function listenSubsyncProgress(handler: (payload: SubsyncProgressEvent) => void) {
  return listen<SubsyncProgressEvent>("subsync-progress", (event) => handler(event.payload));
}

export function listenSubsyncResult(handler: (payload: SubsyncResultEvent) => void) {
  return listen<SubsyncResultEvent>("subsync-result", (event) => handler(event.payload));
}

export function listenSubsyncDone(handler: (payload: EngineRunDoneEvent) => void) {
  return listen<EngineRunDoneEvent>("subsync-done", (event) => handler(event.payload));
}

// ------------------------------------------------------------------ conform results

/** How a conform result reads at a glance. */
export type ConformStatus = "verified" | "unverified" | "unchecked" | "failed";

export function conformStatus(result: Pick<ConformResultEvent, "outputPath" | "error" | "verified">): ConformStatus {
  if (result.error || !result.outputPath) return "failed";
  if (result.verified === true) return "verified";
  if (result.verified === false) return "unverified";
  return "unchecked";
}

/** What to keep on the file once conformed, or null when nothing was written. */
export function toConformedTrack(
  result: ConformResultEvent,
  sourceTrack: number,
  createdAt: string = new Date().toISOString(),
): ConformedTrack | null {
  if (result.error || !result.outputPath) return null;
  return {
    path: result.outputPath,
    mode: result.mode,
    codec: result.codec,
    verified: result.verified,
    verificationText: result.verificationText,
    residualMs: result.residualMs,
    sourceTrack,
    createdAt,
  };
}

// ------------------------------------------------------------------ subtitle results

/** A ratio this close to 1 is no frame-rate change: 1e-4 is 0.36 s over an hour, under a frame
 *  rounding of the delay itself would cost. */
export const PURE_OFFSET_RATIO_TOLERANCE = 1e-4;

/** Below this engine score a result is shown but not filled in (the user can still apply it).
 *  The engine's own scale: a correct subtitle scores near 1, another film's subtitle near 0. */
export const SUBSYNC_MIN_SCORE = 0.5;

/** The delay to add to the subtitle, in seconds rounded to the millisecond, as the delay field
 *  stores it. The engine's offset already has that sign (see `SubsyncResultEvent`), so it is not
 *  negated. Null when there is no offset. */
export function subsyncDelaySeconds(result: Pick<SubsyncResultEvent, "offsetS">): number | null {
  if (result.offsetS === null || !Number.isFinite(result.offsetS)) return null;
  const ms = Math.round(result.offsetS * 1000);
  // Math.round(-0.0004) is -0, which renders "-0.000".
  return ms === 0 ? 0 : ms / 1000;
}

/** A plain delay fixes it: no frame-rate change and no scene-by-scene offsets. */
export function isPureOffset(result: Pick<SubsyncResultEvent, "ratio" | "splits">): boolean {
  return result.ratio !== null && Math.abs(result.ratio - 1) <= PURE_OFFSET_RATIO_TOLERANCE && result.splits === 0;
}

export function isLowScore(result: Pick<SubsyncResultEvent, "score" | "confidence">): boolean {
  if (result.confidence === "low") return true;
  return result.score === null || !Number.isFinite(result.score) || result.score < SUBSYNC_MIN_SCORE;
}

/** What to do with a subtitle measurement:
 *  - `error`: nothing measured (picture subtitles land here, with the "Can't be synced
 *    automatically" text);
 *  - `noMatch`: the engine found nothing clear; nothing to apply;
 *  - `delay`: a pure offset, applied as a pending delay like audio (`delaySeconds`);
 *  - `retimed`: a frame-rate change or splits; the engine's copy is muxed instead (`retimed`).
 *  `lowScore` results are shown but not filled in, with "Apply anyway". */
export type SubsyncAction =
  | { kind: "error"; message: string }
  | { kind: "noMatch"; message: string }
  | { kind: "delay"; delaySeconds: number; lowScore: boolean }
  | { kind: "retimed"; retimed: RetimedSubtitle; lowScore: boolean };

export function subsyncAction(result: SubsyncResultEvent): SubsyncAction {
  if (result.error) return { kind: "error", message: result.error };
  const delaySeconds = subsyncDelaySeconds(result);
  if (!result.applied || delaySeconds === null || result.ratio === null) {
    return { kind: "noMatch", message: result.description ?? "No clear match was found." };
  }
  const lowScore = isLowScore(result);
  if (isPureOffset(result)) return { kind: "delay", delaySeconds, lowScore };
  if (!result.retimedPath) {
    return { kind: "error", message: "The engine found a frame-rate change or scene offsets but wrote no re-timed copy." };
  }
  return {
    kind: "retimed",
    retimed: {
      path: result.retimedPath,
      offsetS: result.offsetS ?? 0,
      ratio: result.ratio,
      splits: result.splits,
      score: result.score,
    },
    lowScore,
  };
}
