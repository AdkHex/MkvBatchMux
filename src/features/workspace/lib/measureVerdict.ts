/** A measurement in the app's one status vocabulary: the word a row's Status
 *  column shows, and the findings the inspector lists for the selected row.
 *
 *  The rules are the ones the old badges used (MeasuredDelayInfo and
 *  TimelineScanInfo): the same checks, in the same order of importance, so a
 *  file is flagged exactly when it was before. Each finding keeps the old
 *  explanation and advice; the inspector shows them when it is opened. */

import type { St } from "@/ui/kit";
import type { ExternalFile, MeasuredDelay } from "@/shared/types";
import { MAX_PLAUSIBLE_OFFSET_MS } from "@/shared/types/audiosync";
import type { TimelineEdit } from "@/shared/types/audiosync";
import {
  formatConfidence,
  formatFps,
  formatPlayerDelayMs,
  formatRateConversion,
  formatRateDrift,
  isBlockingCut,
  isUnconvincing,
  rateConversionFor,
} from "./delayConversion";
import { LIP_SYNC_VISIBLE_MS, describeCut, formatClock, formatSpan, isRateChange, timelineDisagreementMs } from "./timelineScan";

export interface Finding {
  tone: Extract<St, "ok" | "warn" | "bad">;
  /** One or two words: "Different cut", "Weak match", "25 → 23.976 fps". */
  word: string;
  /** One sentence that says what was found. */
  line: string;
  /** Why, in full: the old badge's explanation, shown when the finding is opened. */
  cause?: string;
  /** The places it applies to, one per line (every edit, every span). */
  list?: string[];
  /** What to do about it. */
  fix?: string;
}

/** A dub ending this much earlier than the video is worth saying; less is a trailing silence. */
const NOTABLE_TAIL_S = 5;
/** A finding lists this many places before the rest are summed up; Timeline details has them all. */
const LISTED_CUTS = 8;

const isImplausible = (m: Pick<MeasuredDelay, "engineDelayMs">) => Math.abs(m.engineDelayMs) > MAX_PLAUSIBLE_OFFSET_MS;
const isWeak = (m: Pick<MeasuredDelay, "confidence">) => isUnconvincing({ confidence: m.confidence } as Parameters<typeof isUnconvincing>[0]);
/** 25 → "25", 23.976 → "23.976": short enough for a status column. */
const shortFps = (fps: number) => fps.toFixed(3).replace(/\.?0+$/, "");
/** Drift is reported per second, which is too small a unit to picture. Over an
 *  hour it becomes a number the user can compare against "did it look off". */
const perHour = (msPerS: number) => `${Math.abs((msPerS * 3600) / 1000).toFixed(1)} s per hour`;

function editsWord(edits: TimelineEdit[]): string {
  const major = edits.filter((edit) => edit.severity === "major").length;
  const toCheck = edits.filter((edit) => edit.check).length;
  const parts = [`${edits.length} ${edits.length === 1 ? "edit" : "edits"}`];
  if (major > 0) parts.push(`${major} major`);
  if (toCheck > 0) parts.push(`${toCheck} to check`);
  return parts.join(" · ");
}

/** Everything the measurement says, most serious first; for a clean result
 *  only what the timeline scan confirmed, if one ran. The rules and the words
 *  of cause and fix are the old badges'. */
export function measureFindings(m: MeasuredDelay, currentReferenceTrack?: number): Finding[] {
  const out: Finding[] = [];
  if (m.error) {
    out.push({
      tone: "bad",
      word: "Failed",
      line: m.error,
      cause: `The engine could not analyse this pair at all, so there is no offset to show: ${m.error}`,
      fix: "Check the file still exists at the path in the row and that it is a media file ffmpeg can decode, then measure again. A failure on every row instead of this one usually means the engine or ffmpeg is missing — Preferences › Tools says which.",
    });
  } else {
    const implausible = isImplausible(m);
    const weak = isWeak(m);
    // A completed timeline scan lists every cut with its position, which says
    // more than the quick measurement's single split.
    const scannedForCuts = Boolean(m.timeline && !m.timeline.error);
    // A slip of about a frame is reported but does not hold the delay back.
    const blockingCut = isBlockingCut(m);
    const conversion = m.isRateMismatch ? rateConversionFor(m) : null;
    // Checked before the others: a result this large is not a delay, and
    // saying "different cut" about it would be a guess at the cause.
    if (implausible)
      out.push({
        tone: "warn",
        word: "Implausible",
        line: `${formatPlayerDelayMs(m.engineDelayMs)} is far larger than a real delay. Not filled in.`,
        cause: `${formatPlayerDelayMs(m.engineDelayMs)} is far larger than any real audio delay — a container offset is milliseconds, occasionally a second or two, so this was measured but not filled in. It nearly always means the correlator locked onto a repeated passage: the same music cue, an ident, or a stretch of near-silence that occurs twice. A high confidence does not rule that out, because it only says the sample windows agreed with each other, and a repeated passage looks identical in every window.`,
        fix: "Choose a reference track that actually shares dialogue with this dub and measure again — a music-only or commentary track is the usual cause. If the audio comes from a release with an extra logo or intro, trim it first, or type the offset by hand. Use Apply anyway only after playing both files at the same timestamp and confirming the offset is real.",
      });
    if (!implausible && m.isLikelyCut && m.isMinorSlip && !scannedForCuts) {
      const cutAt = m.cutPositionS ?? null;
      const size = m.cutMagnitudeMs != null ? `${Math.abs(m.cutMagnitudeMs).toFixed(0)} ms` : "about a frame";
      out.push({
        tone: "warn",
        word: "Minor slip",
        line: `The offset moves by ${size}${cutAt !== null ? ` at ${formatClock(cutAt)}` : ""}, about a frame. Delay filled in.`,
        cause: `The offset steps by ${size}${cutAt !== null ? ` at ${formatClock(cutAt)}` : ""}${m.cutUncertaintyS != null && m.cutUncertaintyS >= 0.5 ? ` (±${m.cutUncertaintyS.toFixed(0)} s)` : ""}: a slip of about one frame, the kind a dub picks up when it is conformed to another master. That is below what a viewer notices — lips look in sync until the sound leads the picture by about 45 ms or trails it by about 125 ms (ITU-R BT.1359) — so the delay measured before it was filled in.`,
        fix: `Nothing is needed for ordinary watching. To check, play a dialogue scene just after ${cutAt !== null ? formatClock(cutAt) : "the slip"}; the delay there differs by ${size}.`,
      });
    }
    if (!implausible && blockingCut && !scannedForCuts) {
      const cutAt = m.cutPositionS ?? null;
      out.push({
        tone: "warn",
        word: "Different cut",
        line:
          cutAt !== null
            ? `The offset jumps${m.cutMagnitudeMs != null ? ` by ${(Math.abs(m.cutMagnitudeMs) / 1000).toFixed(3)} s` : ""} at ${formatClock(cutAt)}. Not filled in.`
            : `The offset keeps changing${m.driftMsPerS != null ? `, ${perHour(m.driftMsPerS)}` : ""}. Not filled in.`,
        cause: `${
          cutAt !== null
            ? `The offset jumps${m.cutMagnitudeMs != null ? ` by ${(Math.abs(m.cutMagnitudeMs) / 1000).toFixed(3)} s` : ""} at ${formatClock(cutAt)}${m.cutUncertaintyS != null && m.cutUncertaintyS >= 0.5 ? ` (±${m.cutUncertaintyS.toFixed(0)} s)` : ""}: the delay before it is not the delay after it. That means the two files`
            : `The offset does not stay put: it changes${m.driftMsPerS !== null ? ` by ${m.driftMsPerS.toFixed(3)} ms every second (${perHour(m.driftMsPerS)})` : ""}, far faster than any frame-rate conversion can explain. That means the two files`
        } do not hold the same material end to end — scenes added or removed, an extended cut against a theatrical one, or recap footage only one of them has. Nothing was filled in, because no single delay and no stretch can align them.${m.rateExplanation ? ` ${m.rateExplanation}` : ""}`,
        fix: "Pair this audio with the release it was made for — matching runtimes are the quick check. If you have to keep this pairing, cut or pad the audio to match the video outside the app first; muxing it as-is will drift further out the longer it plays.",
      });
    }
    // Ranked below the two structural problems, which explain themselves more specifically.
    if (!implausible && !blockingCut && weak)
      out.push({
        tone: "warn",
        word: "Weak match",
        line: `Confidence ${m.confidence == null ? "unknown" : `${Math.round(m.confidence * 100)}%`}. Not filled in.`,
        cause: `The analysis never found a clear peak — the sample windows disagreed with each other, so at ${formatConfidence(m.confidence)} the offset beside this is not a measurement of anything and was not filled in. It usually means the two files share little audible material: a heavily re-mixed dub, a reference track that is music and effects only, a different encode, or simply the wrong pairing.`,
        fix: "Check this audio really belongs to this video, then pick a reference track with dialogue in it and measure again. If it stays low, set the delay by hand after listening to both at the same timestamp — Apply anyway accepts this number unchanged rather than improving it.",
      });
    if (!blockingCut && m.isRateMismatch)
      out.push({
        tone: "warn",
        word:
          conversion?.audioFps != null && conversion.videoFps != null
            ? `${shortFps(conversion.audioFps)} → ${shortFps(conversion.videoFps)} fps`
            : conversion
              ? formatRateConversion(conversion)
              : "Frame rate",
        line: conversion ? `Frame-rate converted: ${formatRateConversion(conversion)}.` : "Frame-rate converted: a plain delay drifts.",
        cause: `${m.rateExplanation ?? "This file looks frame-rate converted; a plain delay will drift over its length."}${conversion ? ` The audio runs ${formatRateDrift(conversion)}.` : ""}`,
        fix: conversion
          ? `Turn on Correct the frame rate: it muxes the track with a ${conversion.num}/${conversion.den} stretch, which is the exact conversion between these two rates${conversion.basis === "measured" ? " as far as the measurement can tell — check the end of the file before running a batch" : ""}. A delay on its own only lines up the start.`
          : "Measure this row again so the engine can name both rates; without them a stretch ratio would be a guess, and a wrong one drifts a file that a plain delay merely leaves imperfect.",
      });
    if (!blockingCut && !m.isRateMismatch && m.hasSignificantDrift)
      out.push({
        tone: "warn",
        word: "Drift",
        line: `The offset changes${m.driftMsPerS != null ? `, ${perHour(m.driftMsPerS)}` : " across the file"}.`,
        cause: `The offset changes across the file${m.driftMsPerS !== null ? ` by ${m.driftMsPerS.toFixed(3)} ms per second, about ${perHour(m.driftMsPerS)}` : ""}, but by an amount that matches no standard frame-rate conversion. A variable-rate source, a file joined from several pieces, or audio resampled at a slightly wrong rate all look like this.`,
        fix: "The delay applied is the one measured at the start, so the opening will be in sync and the drift accumulates from there. Check the last few minutes; if it has gone far enough to notice, resample the audio outside the app rather than muxing it with a delay alone.",
      });
  }
  if (currentReferenceTrack !== undefined && currentReferenceTrack !== m.referenceTrack)
    out.push({
      tone: "warn",
      word: "Reference changed",
      line: `Measured against audio track ${m.referenceTrack + 1}; the reference is now track ${currentReferenceTrack + 1}.`,
      cause: `This was measured against audio track ${m.referenceTrack + 1} of the video, but track ${currentReferenceTrack + 1} is the reference now. The two tracks can sit at different offsets, so the delay answers a question you are no longer asking.`,
      fix: `Measure this row again to get a delay for track ${currentReferenceTrack + 1}, or set the reference back to track ${m.referenceTrack + 1} if that was the one you meant.`,
    });
  if (m.warnings && m.warnings.length > 0)
    out.push({
      tone: "warn",
      word: m.warnings.length === 1 ? "1 note" : `${m.warnings.length} notes`,
      line: m.warnings[0],
      list: m.warnings,
      fix: "Each note says what to check. The delay is the engine's best answer either way.",
    });
  out.push(...timelineFindings(m));
  return out;
}

/** What the full-timeline scan found, if one ran. */
function timelineFindings(m: MeasuredDelay): Finding[] {
  const scan = m.timeline;
  if (!scan) return [];
  if (scan.error)
    return [
      {
        tone: "warn",
        word: "Scan failed",
        line: "The whole-timeline scan could not run on this pair.",
        cause: `The full-timeline scan for cuts could not run on this pair: ${scan.error}`,
        fix: "The delay still stands on its own, but cuts and frame-rate changes were not checked. Measure this row again; if it keeps failing, open the pair in AudioSyncMaster's Dub sync mode, which runs the same analysis and shows where it stops.",
      },
    ];
  const out: Finding[] = [];
  const rateChange = isRateChange(scan);
  const disagreement = timelineDisagreementMs(m);
  const lipSyncOff = disagreement !== null && disagreement > LIP_SYNC_VISIBLE_MS;
  const endsEarly = scan.tailS >= NOTABLE_TAIL_S;
  // The engine's own list, when it sent one: each edit graded, placed on both
  // timelines and marked when it rests on too little dub to be sure. Older
  // plans only carry the segments.
  const edits = scan.edits ?? null;
  const editCount = edits ? edits.length : scan.cuts.length;
  const opening = scan.startOffsetMs !== null ? formatPlayerDelayMs(scan.startOffsetMs) : null;
  const firstAtS = edits?.[0]?.videoS ?? scan.cuts[0]?.atS ?? 0;
  const guide = scan.rateGuide ?? null;
  if (editCount > 0) {
    const lines = edits ? edits.slice(0, LISTED_CUTS).map((edit) => `${edit.check ? "(check) " : ""}${edit.description}`) : scan.cuts.slice(0, LISTED_CUTS).map(describeCut);
    if (editCount > LISTED_CUTS) lines.push(`…and ${editCount - LISTED_CUTS} more (see Timeline details).`);
    out.push({
      tone: "warn",
      word: edits ? editsWord(edits) : `${editCount} ${editCount === 1 ? "cut" : "cuts"}`,
      line: `The dub stops following the video ${editCount === 1 ? "once" : `${editCount} times`}, first at ${formatClock(firstAtS)}.`,
      cause: `Across the full runtime the dub does not follow the video in one piece. It starts at ${opening ?? "an unknown offset"}, then:`,
      list: lines,
      fix: `One delay only lines up the part before ${formatClock(firstAtS)}; muxed as it is, everything after that is out of sync. Pair this audio with the release it was cut for (matching runtimes are the quick check), or re-lay it onto this video with AudioSyncMaster's Dub sync mode, which works from this same analysis.`,
    });
  }
  if (rateChange)
    out.push({
      tone: "warn",
      word: scan.dubRate !== null && scan.videoFps !== null ? `FPS ${formatFps(scan.dubRate)} → ${formatFps(scan.videoFps)}` : "FPS change",
      line: "The dub only lines up played at another speed. A plain delay drifts.",
      cause: guide
        ? `${guide.instruction} ${guide.pitchNote}`
        : `${scan.dubRate !== null && scan.videoFps !== null ? `The video runs at ${formatFps(scan.videoFps)} fps, but the dub was mastered at ${formatFps(scan.dubRate)} fps. ` : ""}The dub only lines up played at ${scan.speed.toFixed(6)}× its speed, so a plain delay drifts by about ${(Math.abs(scan.speed - 1) * 3600).toFixed(1)} s every hour.${scan.rateConfirmed === false ? " The audio did not confirm this rate sharply, so treat it as the likeliest explanation rather than a certainty." : ""}`,
      fix: guide
        ? `Best: convert the dub before muxing with FFmpeg -af ${guide.ffmpegFilter}, then use a delay of ${guide.delayWithStretchMs !== null ? formatPlayerDelayMs(guide.delayWithStretchMs) : "a fresh measurement"}. Or turn on Correct the frame rate: it stretches the timestamps by ${guide.stretch.num}/${guide.stretch.den} and scales the delay to match, which plays in sync in players that follow the timestamps. Check the last minutes of the file after either.`
        : `Use Correct the frame rate when it is offered, or convert the audio to ${scan.videoFps !== null ? `${formatFps(scan.videoFps)} fps` : "the video's rate"} before muxing. Check the last minutes of the file after either.`,
    });
  if (lipSyncOff)
    out.push({
      tone: "warn",
      word: "Lip-sync check",
      line: `The timeline opens ${disagreement!.toFixed(0)} ms away from the measured delay.`,
      cause: `The full-timeline scan puts the opening stretch at ${opening}, measured from that stretch alone at 2 ms resolution; the delay measured is ${formatPlayerDelayMs(m.engineDelayMs)}. They are ${disagreement!.toFixed(0)} ms apart, past the ${LIP_SYNC_VISIBLE_MS} ms where lips visibly lead or trail the voice.`,
      fix: "Play the first dialogue scene with each value. The measured delay is the one AudioSyncMaster's Analyze reports; Use timeline delay writes the scan's instead.",
    });
  if (scan.unverified.length > 0)
    out.push({
      tone: "warn",
      word: "Unconfirmed",
      line: `${scan.unverified.length} stretch${scan.unverified.length === 1 ? "" : "es"} could not be matched.`,
      cause: `The dub was audible but matched nothing in the video across ${scan.unverified
        .slice(0, LISTED_CUTS)
        .map((span) => `${formatClock(span.startS)} – ${formatClock(span.endS)}`)
        .join(", ")}${scan.unverified.length > LISTED_CUTS ? ", and more" : ""}, so sync there is unconfirmed.`,
      fix: "Watch those spans before muxing a batch; a re-edited scene or new music is the usual cause.",
    });
  if (endsEarly)
    out.push({
      tone: "warn",
      word: "Ends early",
      line: `The dub ends ${formatSpan(scan.tailS)} before the video.`,
      cause: `The dub stops ${formatSpan(scan.tailS)} before the video does, at ${formatClock(scan.videoDurationS - scan.tailS)}.`,
      fix: "Usually missing end credits. If the video has dialogue there, it will be silent in this language.",
    });
  if (editCount === 0 && !rateChange && scan.unverified.length === 0 && !lipSyncOff)
    out.push({
      tone: "ok",
      word: "No cuts",
      line: "The dub follows the video in one piece.",
      cause: `Scanned the full runtime: the dub follows the video in one piece${opening ? ` at ${opening}` : ""}, at the video's own frame rate${scan.dubUsedShare !== null ? `, using ${(scan.dubUsedShare * 100).toFixed(1)}% of the dub` : ""}.`,
    });
  return out;
}

/** Whether a measurement's delay was held back from Apply (the old
 *  "Apply anyway" rule). */
export function isWithheld(m: MeasuredDelay): boolean {
  return !m.error && (isImplausible(m) || isBlockingCut(m) || isWeak(m));
}

/** The Status column for one measured file or track. */
export function measureStatus(
  m: MeasuredDelay | undefined,
  { pending, currentReferenceTrack }: { pending: boolean; currentReferenceTrack?: number },
): { s: St; text: string } {
  if (!m) return { s: "ready", text: "Ready" };
  const top = measureFindings(m, currentReferenceTrack).find((finding) => finding.tone !== "ok");
  if (top) return { s: top.tone, text: top.word };
  return pending ? { s: "ok", text: "Measured" } : { s: "ok", text: "Applied" };
}

/** Every measurement a file holds: the file's own, or one per track. */
export function measurementsOf(file: ExternalFile): MeasuredDelay[] {
  const own = file.measuredDelay ? [file.measuredDelay] : [];
  const tracks = Object.values(file.trackOverrides ?? {})
    .map((override) => override.measuredDelay)
    .filter((m): m is MeasuredDelay => Boolean(m));
  return [...own, ...tracks];
}

/** A measuring run's result, as the status display and History say it:
 *  "12 measured · 1 different cut · 1 failed". */
export function measureOutcome(files: ExternalFile[]): { tone: St; parts: string[]; problems: number } {
  const counts = new Map<string, number>();
  let clean = 0;
  let failed = 0;
  for (const m of files.flatMap(measurementsOf)) {
    const top = measureFindings(m).find((finding) => finding.tone !== "ok");
    if (!top) clean += 1;
    else if (top.tone === "bad") failed += 1;
    else {
      const word = /→|^FPS|^Frame rate/.test(top.word) ? "frame rate" : /edit|cut/.test(top.word) && top.word !== "Different cut" ? "with cuts" : top.word.toLowerCase();
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const parts = [`${clean} measured`];
  for (const [word, n] of counts) parts.push(`${n} ${word}`);
  if (failed) parts.push(`${failed} failed`);
  const problems = failed + [...counts.values()].reduce((a, b) => a + b, 0);
  return { tone: failed && !clean ? "bad" : problems ? "warn" : "ok", parts, problems };
}
