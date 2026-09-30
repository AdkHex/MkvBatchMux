/** The bottom dock. Every page shares two of its tabs — Output (the engine's
 *  log: mkvmerge, mkvpropedit and the audio analysis engine) and History
 *  (finished runs) — and may add its own in front of them: Report on Mux. */

import { CopyRegular, DeleteRegular, DocumentTextRegular, SearchRegular } from "@fluentui/react-icons";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { DockTabs } from "@/ui/frame";
import { Cmd, Combo, Status, Table, Tr } from "@/ui/kit";
import { PAGE_LABEL, whenText, type HistoryEntry, type HistoryPage } from "./history";

export type CommonTab = "output" | "history";

/** What the shell hands every page for its dock. */
export interface CommonDock {
  tab: CommonTab | null;
  setTab: (tab: CommonTab | null) => void;
  output: ReactNode;
  history: ReactNode;
  outputTools?: ReactNode;
  historyTools?: ReactNode;
}

export interface OwnTab<T extends string> {
  id: T;
  label: string;
  body: ReactNode;
  tools?: ReactNode;
}

/** A page's dock: its own tabs, then Output and History. Returns null when
 *  nothing is open, so the workspace gives the space back to the list. */
export function PageDock<T extends string>({
  own = [],
  ownTab,
  onOwnTab,
  common,
  height = 240,
}: {
  own?: OwnTab<T>[];
  /** The page's tab to show while Output and History are closed; null hides
   *  the dock unless one of them is open. */
  ownTab?: T | null;
  onOwnTab?: (tab: T) => void;
  common: CommonDock;
  height?: number;
}): ReactNode {
  const active: T | CommonTab | null = common.tab ?? ownTab ?? null;
  if (active === null) return null;
  const mine = own.find((t) => t.id === active);
  const tabs = [...own.map((t) => ({ id: t.id as T | CommonTab, label: t.label })), { id: "output" as const, label: "Output" }, { id: "history" as const, label: "History" }];
  return (
    <div style={{ height, display: "flex", flexDirection: "column" }}>
      <DockTabs<T | CommonTab>
        tabs={tabs}
        on={active}
        onTab={(tab) => {
          if (tab === "output" || tab === "history") common.setTab(tab as CommonTab);
          else {
            common.setTab(null);
            onOwnTab?.(tab as T);
          }
        }}
        tools={mine ? mine.tools : active === "output" ? common.outputTools : common.historyTools}
      />
      {mine ? mine.body : active === "output" ? common.output : common.history}
    </div>
  );
}

/* ---------------------------------------------------------------- output */

type Severity = "" | "ok" | "warn" | "bad";

/** Colour a log line by what it says. mkvmerge and the engine write plain
 *  lines, so severity is read from the words rather than plumbed through. */
export function severityOf(line: string): Severity {
  const text = line.toLowerCase();
  if (/^error|\b(error|failed|failure|cannot|could not|not found|traceback|aborted)\b/.test(text)) return "bad";
  if (/^warning|\b(warning|warn|skipped|unmatched|no video|different cut|weak match)\b/.test(text)) return "warn";
  if (/\b(multiplexing took|muxed|measured|scanned|done|complete|completed)\b/.test(text)) return "ok";
  return "";
}

export interface LogLine {
  at: string;
  text: string;
}

/** The engine's log, newest at the bottom, following the end while you are
 *  there and staying put when you scroll up to read. */
export const OutputBody = memo(function OutputBody({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const last = lines[lines.length - 1];
  useEffect(() => {
    const el = ref.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, last]);
  return (
    <div
      className="log"
      ref={ref}
      role="log"
      aria-label="Output"
      onScroll={(event) => {
        const el = event.currentTarget;
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lines.length === 0 ? (
        <div className="t3">mkvmerge and the analysis engine write here while they run.</div>
      ) : (
        lines.map((line, i) => (
          <div key={i}>
            <span className="t">{line.at}</span>
            <span className={severityOf(line.text) || undefined}>{line.text}</span>
          </div>
        ))
      )}
    </div>
  );
});

export function OutputTools({ lines, onCopy, onClear, onOpenLog }: { lines: LogLine[]; onCopy: (text: string) => void; onClear: () => void; onOpenLog: () => void }) {
  return (
    <>
      <Cmd sm icon={<DocumentTextRegular />} title="Open the log file" onClick={onOpenLog} />
      <Cmd sm icon={<CopyRegular />} title="Copy the output" disabled={lines.length === 0} onClick={() => onCopy(lines.map((l) => `${l.at}  ${l.text}`).join("\n"))} />
      <Cmd sm icon={<DeleteRegular />} title="Clear the output" disabled={lines.length === 0} onClick={onClear} />
    </>
  );
}

/* --------------------------------------------------------------- history */

export interface HistoryFilter {
  query: string;
  page: HistoryPage | "all";
}

export function useHistoryFilter() {
  return useState<HistoryFilter>({ query: "", page: "all" });
}

export function HistoryTools({
  filter,
  onFilter,
  onClear,
  empty,
}: {
  filter: HistoryFilter;
  onFilter: (filter: HistoryFilter) => void;
  onClear: () => void;
  empty: boolean;
}) {
  return (
    <>
      <Combo<HistoryPage | "all">
        ghost
        sm
        w={112}
        label="Page"
        value={filter.page}
        options={[
          { value: "all", label: "All pages" },
          { value: "mux", label: PAGE_LABEL.mux },
          { value: "audio", label: PAGE_LABEL.audio },
        ]}
        onChange={(page) => onFilter({ ...filter, page })}
      />
      <label className="tbox" style={{ width: 200, height: 28 }}>
        <SearchRegular className="t3" aria-hidden />
        <input aria-label="Search history" placeholder="Search" value={filter.query} onChange={(event) => onFilter({ ...filter, query: event.target.value })} />
      </label>
      <Cmd sm icon={<DeleteRegular />} title="Clear history" disabled={empty} onClick={onClear} />
    </>
  );
}

export function HistoryBody({
  entries,
  filter,
  onOpen,
  onDelete,
}: {
  entries: HistoryEntry[];
  filter: HistoryFilter;
  onOpen: (entry: HistoryEntry) => void;
  onDelete: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const shown = useMemo(() => {
    const q = filter.query.trim().toLowerCase();
    return entries.filter(
      (e) => (filter.page === "all" || e.page === filter.page) && (!q || `${e.name} ${e.outcome.text} ${PAGE_LABEL[e.page]}`.toLowerCase().includes(q)),
    );
  }, [entries, filter]);
  if (entries.length === 0) return <div className="log t3">Finished mux batches and measurements are kept here.</div>;
  return (
    <Table cols="96px minmax(0,1fr) minmax(0,1.3fr) 120px" head={["Page", "Name", "Result", "When"]} label="History">
      {shown.map((entry) => (
        <Tr
          key={entry.id}
          on={entry.id === selected}
          onClick={() => {
            setSelected(entry.id);
            onOpen(entry);
          }}
        >
          <span className="t2">{PAGE_LABEL[entry.page]}</span>
          <span className="truncate" title={entry.name}>{entry.name}</span>
          <Status s={entry.outcome.tone} text={entry.outcome.text} />
          <span className="t3 num truncate">{whenText(entry.date)}</span>
          {/* Shown on the row under the pointer or with focus. */}
          <span className="hdel">
            <button
              type="button"
              className="cmd sm icon"
              title="Delete this run"
              aria-label="Delete this run"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(entry.id);
              }}
            >
              <span className="ic" aria-hidden><DeleteRegular /></span>
            </button>
          </span>
        </Tr>
      ))}
    </Table>
  );
}
