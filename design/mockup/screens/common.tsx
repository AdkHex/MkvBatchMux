import {
  ClosedCaptionRegular,
  CopyRegular,
  DeleteRegular,
  DocumentTextRegular,
  MusicNote2Regular,
  SearchRegular,
  VideoClipRegular,
  VideoRegular,
} from "@fluentui/react-icons";
import type { ReactNode } from "react";

import { HISTORY, OUTPUT } from "../data";
import { Btn, Cmd, Combo, MidText, Status, Table, Tr, type St } from "../kit";
import { DockTabs, useProto } from "../shell";

export function Name({ children, icon = <VideoClipRegular />, tail = 22 }: { children: string; icon?: ReactNode; tail?: number }) {
  return (
    <span className="cell">
      <span className="fi">{icon}</span>
      <MidText text={children} tail={tail} />
    </span>
  );
}

export const Dash = () => <span className="t3">—</span>;

export const Links = ({ children }: { children: ReactNode }) => <div className="links">{children}</div>;
export const L = ({ icon, children, onClick }: { icon: ReactNode; children: ReactNode; onClick?: () => void }) => (
  <button type="button" className="cmd" onClick={onClick}><span className="ic">{icon}</span>{children}</button>
);

/** Kept tracks per type, as icons and counts. */
export const TrackCounts = ({ v, a, s }: { v: number; a: number; s: number }) => (
  <span className="cell sm t2 num" style={{ gap: 10 }}>
    <span className="cell" style={{ gap: 3 }}><VideoRegular />{v}</span>
    <span className="cell" style={{ gap: 3 }}><MusicNote2Regular />{a}</span>
    <span className="cell" style={{ gap: 3 }}><ClosedCaptionRegular />{s}</span>
  </span>
);

/** The next action on every preparing page: hand the videos to the queue. */
export function QueueBtn({ n = 16, disabled }: { n?: number; disabled?: boolean }) {
  const { go } = useProto();
  return (
    <Btn accent disabled={disabled} onClick={() => go("mux-ready")}>
      Add to queue{!disabled && n ? <span className="kbd">{n}</span> : null}
    </Btn>
  );
}

/* ------------------------------- the dock ------------------------------- */

export function OutputDock({ own }: { own?: string[] }) {
  const { go } = useProto();
  return (
    <div style={{ height: 240, display: "flex", flexDirection: "column" }}>
      <DockTabs
        tabs={[...(own ?? []), "Output", "History"]}
        on="Output"
        onTab={(t) => t === "History" && go("history")}
        tools={
          <>
            <Cmd sm icon={<DocumentTextRegular />} title="Open the log file" />
            <Cmd sm icon={<CopyRegular />} title="Copy the output" />
            <Cmd sm icon={<DeleteRegular />} title="Clear the output" />
          </>
        }
      />
      <div className="log">
        {OUTPUT.map(([t, line], i) => (
          <div key={i}>
            <span className="t">{t}</span>
            <span className={/^Error|failed/.test(line) || line.includes(": failed") ? "bad" : /^Warning|different cut/.test(line) ? "warn" : /took|Measured|Scanned/.test(line) ? "ok" : undefined}>{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HistoryDock() {
  const { go } = useProto();
  const to: Record<string, string> = { Mux: "mux-done", Audio: "audio-measured" };
  return (
    <div style={{ height: 240, display: "flex", flexDirection: "column" }}>
      <DockTabs
        tabs={["Output", "History"]}
        on="History"
        onTab={(t) => t === "Output" && go("output")}
        tools={
          <>
            <Combo ghost sm value="All pages" w={112} />
            <div className="tbox" style={{ width: 200, height: 28 }}><SearchRegular className="t3" /><span className="ph">Search</span></div>
            <Cmd sm icon={<DeleteRegular />} title="Clear history" />
          </>
        }
      />
      <Table cols="96px minmax(0,1fr) minmax(0,1.3fr) 120px" head={["Page", "Name", "Result", "When"]}>
        {HISTORY.map((h, i) => (
          <Tr key={i} on={i === 0} onClick={() => go(to[h.page])}>
            <span className="t2">{h.page}</span>
            <span className="truncate">{h.name}</span>
            <Status s={h.tone as St} text={h.res} />
            <span className="t3 num">{h.when}</span>
            {i === 0 && (
              <span className="hdel"><Cmd sm icon={<DeleteRegular />} title="Delete this run" /></span>
            )}
          </Tr>
        ))}
      </Table>
    </div>
  );
}

export const SearchBox = ({ w = 160 }: { w?: number }) => (
  <div className="tbox" style={{ width: w }}><SearchRegular className="t3" /><span className="ph">Search</span></div>
);
