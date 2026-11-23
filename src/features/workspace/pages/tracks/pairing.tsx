/** The pairing controls the Subtitles, Audio and Chapters pages share: the
 *  Pair by choice, the Match column, and a file's pairing in its popup. */

import { LinkDismissRegular, LinkRegular } from "@fluentui/react-icons";
import type { ReactNode } from "react";

import { pairLabel, type PairBy, type PairInfo, type PairingConflict } from "@/features/workspace/lib/smartPairing";
import type { ExternalFile } from "@/shared/types";
import { Combo, Status } from "@/ui/kit";

import { L } from "./MeasurePane";

const PAIR_BY_OPTIONS: { value: PairBy; label: string }[] = [
  { value: "episode", label: "Pair by episode" },
  { value: "order", label: "Pair by order" },
];

/** Pair by: episode or order, for the whole page. */
export function PairByCombo({ value, chosen, disabled, onChange }: { value: PairBy; chosen: boolean; disabled?: boolean; onChange: (value: PairBy) => void }) {
  return (
    <span
      title={
        chosen
          ? undefined
          : value === "episode"
            ? "Most names have an episode number, so files go beside the video of their episode"
            : "Too few names have an episode number, so file n goes with video n"
      }
    >
      <Combo<PairBy> ghost sm w={132} label="Pair by" value={value} options={PAIR_BY_OPTIONS} disabled={disabled} onChange={onChange} />
    </span>
  );
}

/** How a row's file is paired, or why it is not: the Match column. */
export function MatchCell({ file, info, conflict }: { file: ExternalFile | undefined; info: PairInfo | undefined; conflict: PairingConflict | undefined }) {
  if (!file || file.placeholder) return <span />;
  if (conflict)
    return (
      <span style={{ minWidth: 0 }} title={`${file.name} ${conflict.message}`}>
        <Status s="bad" text={conflict.short} />
      </span>
    );
  if (!info) return <span className="t3">—</span>;
  if (info.warnings.length > 0)
    return (
      <span style={{ minWidth: 0 }} title={info.warnings.join("\n")}>
        <Status s="warn" text={pairLabel(info)} />
      </span>
    );
  return <span className={info.method === "order" ? "t3 truncate" : "t2 truncate"}>{pairLabel(info)}</span>;
}

/** A file's pairing in words, for its popup: how, and anything to check. */
export function pairingLine(info: PairInfo | undefined, conflict: PairingConflict | undefined, file: ExternalFile): ReactNode {
  if (conflict) return <span className="bad">{`${file.name} ${conflict.message}`}</span>;
  if (!info) return "No video";
  const how = { hand: "By hand", audio: `By audio, ${Math.round(info.confidence * 100)}% sure`, episode: "By episode", order: "By order" }[info.method];
  return info.warnings.length ? (
    <span className="col" style={{ gap: 2 }}>
      <span>{how}</span>
      {info.warnings.map((warning) => (
        <span key={warning} className="warn">{warning}</span>
      ))}
    </span>
  ) : (
    how
  );
}

/** "Keep this pairing" for a file its name says belongs elsewhere; "Pair
 *  automatically" for one put in place by hand or by audio. */
export function PairingLinks({ info, conflict, onKeep, onRelease, disabled }: { info: PairInfo | undefined; conflict: PairingConflict | undefined; onKeep: () => void; onRelease: () => void; disabled?: boolean }) {
  return (
    <>
      {conflict && (conflict.kind === "mismatch" || conflict.kind === "season") && (
        <L icon={<LinkRegular />} onClick={onKeep} disabled={disabled} title="Mux it with this video whatever its name says">Keep this pairing</L>
      )}
      {info && (info.method === "hand" || info.method === "audio") && (
        <L icon={<LinkDismissRegular />} onClick={onRelease} disabled={disabled}>Pair automatically</L>
      )}
    </>
  );
}
