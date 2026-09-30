/** One measurement in the Audio inspector: the delay it found, what to do
 *  with it, and everything the engine said about it — the old row readout
 *  (MeasuredDelayInfo, TimelineScanInfo, StretchToggle), moved out of the
 *  list and into the pane for the selected row. */

import {
  CheckmarkCircleFilled,
  CheckmarkRegular,
  ChevronDownRegular,
  ChevronUpRegular,
  ErrorCircleFilled,
  GaugeRegular,
  TimelineRegular,
  WarningFilled,
} from "@fluentui/react-icons";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { engineMsToDelaySeconds, formatFrameOffset, formatPlayerDelayMs, formatRateConversion, rateConversionFor } from "@/features/workspace/lib/delayConversion";
import { isWithheld, measureFindings, type Finding } from "@/features/workspace/lib/measureVerdict";
import { canUseTimelineDelay } from "@/features/workspace/lib/timelineScan";
import type { MeasuredDelay, StretchSetting } from "@/shared/types";
import { Dialog } from "@/ui/frame";
import { Btn, DL, Links, Meter, TRow, Toggle } from "@/ui/kit";

import { formatDelay } from "../common";

const findingIcon = (tone: Finding["tone"]) =>
  tone === "ok" ? <CheckmarkCircleFilled className="ok" /> : tone === "warn" ? <WarningFilled className="warn" /> : <ErrorCircleFilled className="bad" />;

export const L = ({ icon, children, onClick, disabled, title }: { icon: ReactNode; children: ReactNode; onClick: () => void; disabled?: boolean; title?: string }) => (
  <button type="button" className="cmd" onClick={onClick} disabled={disabled} title={title}>
    <span className="ic" aria-hidden>{icon}</span>
    {children}
  </button>
);

/** The engine's findings, most serious first, one line each. A finding with
 *  more to say opens to show why, where, and what to do about it. */
export function Findings({ findings }: { findings: Finding[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (findings.length === 0) return null;
  return (
    <div className="col" style={{ gap: 8 }}>
      {findings.map((finding) => {
        const more = Boolean(finding.cause || finding.list || finding.fix);
        const expanded = open === finding.word;
        return (
          <div key={finding.word} className="col" style={{ gap: 6 }}>
            <button
              type="button"
              className="row"
              style={{ gap: 8, alignItems: "flex-start", textAlign: "left" }}
              aria-expanded={more ? expanded : undefined}
              disabled={!more}
              onClick={() => setOpen(expanded ? null : finding.word)}
            >
              <span style={{ fontSize: 16, display: "grid", marginTop: 1 }} aria-hidden>{findingIcon(finding.tone)}</span>
              <span className="grow">
                <span className={finding.tone === "ok" ? undefined : finding.tone}>{finding.word}</span>
                <span className="t2"> · {finding.line}</span>
              </span>
              {more && <span className="t3" style={{ display: "grid", marginTop: 1 }} aria-hidden>{expanded ? <ChevronUpRegular /> : <ChevronDownRegular />}</span>}
            </button>
            {expanded && (
              <div className="col sm t2" style={{ gap: 6, paddingLeft: 24 }}>
                {finding.cause && <span>{finding.cause}</span>}
                {finding.list && (
                  <span className="col" style={{ gap: 2 }}>
                    {finding.list.map((item, i) => <span key={i}>• {item}</span>)}
                  </span>
                )}
                {finding.fix && (
                  <span>
                    <span className="strong" style={{ color: "var(--text)" }}>What to do: </span>
                    {finding.fix}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** "Correct the frame rate": an opt-in linear stretch for a frame-rate
 *  converted track. Off by default, since a wrong ratio drifts a file that was
 *  otherwise fine. */
function StretchRow({ measured, value, onChange, disabled }: { measured: MeasuredDelay; value: StretchSetting | undefined; onChange: (next: StretchSetting | undefined) => void; disabled?: boolean }) {
  // Only offered where the engine actually diagnosed a rate conversion.
  const conversion = measured.isRateMismatch ? rateConversionFor(measured) : null;
  const enabled = Boolean(value);
  // Re-store the ratio if an earlier build saved the reciprocal (atempo factor)
  // instead of mkvmerge's ratio. Ref avoids re-firing on every onChange identity change.
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
    <TRow
      label="Correct the frame rate"
      d={
        <span title={`Muxes the track as --sync ${conversion.num}/${conversion.den}. The delay is measured at the start, where the stretch pivots.`}>
          {formatRateConversion(conversion)} · {conversion.num}/{conversion.den}
          {approximate && <span className="warn"> · approximate, check the end</span>}
        </span>
      }
    >
      <Toggle
        name="Correct the frame rate"
        on={enabled}
        disabled={disabled}
        onChange={(on) => onChange(on ? { num: conversion.num, den: conversion.den } : undefined)}
      />
    </TRow>
  );
}

export function TimelineDetails({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <Dialog size="wide" title="Timeline scan" sub="AudioSyncMaster's Dub sync plan for this pair" onClose={onClose} foot={<Btn accent onClick={onClose}>Close</Btn>}>
      <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap", color: "var(--text-2)", lineHeight: "18px" }}>{text}</pre>
    </Dialog>
  );
}

/** A measurement, as the inspector shows it. */
export function MeasureSection({
  measured,
  pending,
  currentReferenceTrack,
  against,
  stretch,
  onStretch,
  busy,
  onApply,
  onApplyAnyway,
  onUseTimelineDelay,
  onMeasureAgain,
  more,
}: {
  measured: MeasuredDelay;
  /** The measured delay is staged but not in the delay field yet. */
  pending: boolean;
  currentReferenceTrack?: number;
  /** The reference track picker for the paired video. */
  against?: ReactNode;
  stretch: StretchSetting | undefined;
  onStretch: (next: StretchSetting | undefined) => void;
  busy: boolean;
  onApply: () => void;
  onApplyAnyway: () => void;
  onUseTimelineDelay: () => void;
  onMeasureAgain?: () => void;
  /** Further links: Edit…, Duplicate, Remove. */
  more?: ReactNode;
}) {
  const [details, setDetails] = useState(false);
  const findings = measureFindings(measured, currentReferenceTrack);
  const top = findings.find((finding) => finding.tone !== "ok");
  const withheld = isWithheld(measured);
  const scan = measured.timeline;
  const frames = formatFrameOffset(measured.appliedMs, measured.primaryFps);

  if (measured.error)
    return (
      <>
        <div>
          <div className="t3">Result</div>
          <div className="big bad">Failed</div>
          <div className="t2">{measured.error}</div>
        </div>
        <Links>
          {onMeasureAgain && <L icon={<GaugeRegular />} onClick={onMeasureAgain} disabled={busy}>Measure again</L>}
          {scan?.description && <L icon={<TimelineRegular />} onClick={() => setDetails(true)}>Timeline details</L>}
          {more}
        </Links>
        {against && <DL rows={[["Against", against]]} />}
        <Findings findings={findings.slice(1)} />
        {details && scan?.description && <TimelineDetails text={scan.description} onClose={() => setDetails(false)} />}
      </>
    );

  return (
    <>
      <div>
        <div className="t3">Delay</div>
        <div className="big">{formatDelay(engineMsToDelaySeconds(measured.engineDelayMs))}<small>s</small></div>
        {top ? (
          <div className={top.tone}>{top.word}{withheld ? " · not filled in" : ""}</div>
        ) : (
          <div className="t2">{[frames, pending ? "not applied yet" : "applied"].filter(Boolean).join(" · ")}</div>
        )}
      </div>
      <Links>
        {pending && <L icon={<CheckmarkRegular />} onClick={onApply} disabled={busy}>Apply</L>}
        {withheld && <L icon={<CheckmarkRegular />} onClick={onApplyAnyway} disabled={busy} title="Fill this delay in despite the warning">Apply anyway</L>}
        {canUseTimelineDelay(measured) && (
          <L icon={<TimelineRegular />} onClick={onUseTimelineDelay} disabled={busy}>
            Use timeline delay ({formatPlayerDelayMs(scan!.startOffsetMs)})
          </L>
        )}
        {scan?.description && <L icon={<TimelineRegular />} onClick={() => setDetails(true)}>Timeline details</L>}
        {onMeasureAgain && <L icon={<GaugeRegular />} onClick={onMeasureAgain} disabled={busy}>Measure again</L>}
        {more}
      </Links>
      <StretchRow measured={measured} value={stretch} onChange={onStretch} disabled={busy} />
      <DL
        rows={[
          ...(against ? ([["Against", against]] as [ReactNode, ReactNode][]) : []),
          [
            "Confidence",
            measured.confidence == null ? "—" : (
              <span key="c" className="cell num"><Meter pct={measured.confidence * 100} />{Math.round(measured.confidence * 100)}%</span>
            ),
          ],
          ["Frames", frames ?? "—"],
          ["Method", measured.method === "timeline" ? "Whole timeline" : "Sample windows"],
        ]}
      />
      <Findings findings={findings} />
      {details && scan?.description && <TimelineDetails text={scan.description} onClose={() => setDetails(false)} />}
    </>
  );
}
