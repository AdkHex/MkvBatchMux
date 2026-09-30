import { CheckmarkCircleFilled, DismissRegular, ErrorCircleFilled, HistoryRegular, SettingsRegular, WarningFilled, WindowConsoleRegular } from "@fluentui/react-icons";
import type { ReactNode } from "react";

import { OUTPUT } from "../data";
import { Cmd, Ring, cx } from "../kit";
import { DockTabs, PAGES, useProto, type Page } from "../shell";

const MENUS = ["File", "Edit", "View", "Tools", "Help"];

/** Where each page button goes in this mockup. */
const TO: Record<Page, string> = { videos: "videos", subtitles: "subs", audio: "audio", chapters: "chapters", attachments: "attachments", mux: "mux" };

function AppIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <rect width="16" height="16" rx="4" fill="var(--accent)" />
      <path d="M4 5h8M4 8h8M4 11h5" stroke="var(--on-accent)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Output and History, hidden unless opened from their icons. */
export function Dock({ tab, back }: { tab: "output" | "history"; back: string }) {
  const { go } = useProto();
  return (
    <div style={{ height: 220, display: "flex", flexDirection: "column" }}>
      <DockTabs
        tabs={["Output", "History"]}
        on={tab === "output" ? "Output" : "History"}
        tools={
          <>
            <Cmd sm icon={<DismissRegular />} title="Hide (Ctrl+`)" onClick={() => go(back)} />
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

export interface StatusProps {
  icon: "run" | "ok" | "warn" | "bad";
  text: ReactNode;
  pct?: number;
  /** The page it opens, when it is about another page. */
  to?: string;
}

/** The status, small: only while something runs or has something to say —
 *  a scan, a measurement, a mux, on any page — and nothing when idle. */
function StatusPill({ icon, text, pct, to }: StatusProps) {
  const { go } = useProto();
  return (
    <button type="button" className="stat" onClick={() => to && go(to)} title={to ? "Open its page" : undefined}>
      <span className="ic">
        {icon === "run" ? <Ring size={14} /> : icon === "ok" ? <CheckmarkCircleFilled className="ok" /> : icon === "warn" ? <WarningFilled className="warn" /> : <ErrorCircleFilled className="bad" />}
      </span>
      <span className="truncate">{text}</span>
      {pct !== undefined && <span className="bar"><i style={{ width: `${pct}%` }} /></span>}
    </button>
  );
}

export function Window2({
  page,
  tools,
  status,
  center,
  primary,
  strip,
  cols = "minmax(0,1fr) 300px",
  children,
  dock,
  overlay,
  flags = [],
  busy,
  outputDot,
  onOutput,
  note = "Made by Ionicboy",
}: {
  page: Page;
  tools?: ReactNode;
  status?: StatusProps;
  /** Something that stays in the toolbar's middle while nothing runs. */
  center?: ReactNode;
  primary?: ReactNode;
  strip?: ReactNode;
  cols?: string;
  children: ReactNode;
  /** The open dock tab; the dock is hidden otherwise. */
  dock?: { tab: "output" | "history"; back: string };
  overlay?: ReactNode;
  /** Pages with something to look at. */
  flags?: Page[];
  busy?: Page;
  /** Output has something new since it was last opened. */
  outputDot?: boolean;
  onOutput?: () => void;
  note?: ReactNode;
}) {
  const { go, theme, mac } = useProto();
  const title = PAGES.find((p) => p.id === page)?.label;
  return (
    <div className={cx("win", "rev", `theme-${theme}`)}>
      <header className="titlebar">
        {mac ? (
          <span className="lights">
            <i style={{ background: "#ff5f57" }} />
            <i style={{ background: "#febc2e" }} />
            <i style={{ background: "#28c840" }} />
          </span>
        ) : (
          <>
            <AppIcon />
            <nav className="menubar">
              {MENUS.map((m) => <button key={m} type="button">{m}</button>)}
            </nav>
          </>
        )}
        <span className="wtitle">{title} — MKVBatchMux</span>
        {!mac && (
          <span className="caps">
            <button type="button" className="cap" aria-label="Minimize"><svg width="10" height="10"><path d="M0 5.5h10" stroke="currentColor" /></svg></button>
            <button type="button" className="cap" aria-label="Maximize"><svg width="10" height="10"><rect x=".5" y=".5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" /></svg></button>
            <button type="button" className="cap x" aria-label="Close"><svg width="10" height="10"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" /></svg></button>
          </span>
        )}
      </header>

      <div className="toolbar">
        <div className="l">{tools}</div>
        <div className="c">{status ? <StatusPill {...status} /> : center}</div>
        <div className="r">{primary}</div>
      </div>
      {strip && <div className="strip2">{strip}</div>}

      <div className="ws" style={{ gridTemplateColumns: cols }}>
        {children}
        {dock && <div className="box dock"><Dock tab={dock.tab} back={dock.back} /></div>}
      </div>

      <footer className="pagebar">
        <span className="l made">{note}</span>
        <nav className="pages" aria-label="Pages">
          {PAGES.map((p, i) => (
            <button key={p.id} type="button" className={cx("pg", page === p.id && "on")} onClick={() => go(TO[p.id])} title={`${p.label} (Ctrl+${i + 1})`}>
              <span className="ic">{page === p.id ? p.on : p.icon}</span>
              {p.label}
              {busy === p.id && page !== p.id ? (
                <span className="busy"><Ring size={10} /></span>
              ) : (
                flags.includes(p.id) && <span className="flag"><WarningFilled /></span>
              )}
            </button>
          ))}
        </nav>
        <span className="r">
          <button type="button" className={cx("ub", dock?.tab === "history" && "on")} title="History (Ctrl+H)"><span className="ic"><HistoryRegular /></span></button>
          <button type="button" className={cx("ub", dock?.tab === "output" && "on")} title="Output (Ctrl+`)" onClick={onOutput ?? (() => go(dock?.tab === "output" ? dock.back : "videos-output"))}>
            <span className="ic"><WindowConsoleRegular /></span>
            {outputDot && <i className="dot" />}
          </button>
          <button type="button" className="ub" title="Preferences (Ctrl+,)" onClick={() => go("prefs")}><span className="ic"><SettingsRegular /></span></button>
        </span>
      </footer>
      {overlay}
    </div>
  );
}
