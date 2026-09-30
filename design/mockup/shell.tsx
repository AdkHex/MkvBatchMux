import {
  AttachFilled,
  AttachRegular,
  BookmarkMultipleFilled,
  BookmarkMultipleRegular,
  CheckmarkCircleFilled,
  CheckmarkRegular,
  ClosedCaptionFilled,
  ClosedCaptionRegular,
  ErrorCircleFilled,
  HistoryRegular,
  InfoRegular,
  LayerFilled,
  LayerRegular,
  MusicNote2Filled,
  MusicNote2Regular,
  SettingsRegular,
  VideoClipMultipleFilled,
  VideoClipMultipleRegular,
  WarningFilled,
  WindowConsoleRegular,
} from "@fluentui/react-icons";
import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { Ring, cx } from "./kit";

/* ------------------------------ prototype ------------------------------ */
export interface Proto {
  go: (id: string) => void;
  live: boolean;
  theme: "dark" | "light";
  mac: boolean;
}
export const Ctx = createContext<Proto>({ go: () => {}, live: false, theme: "dark", mac: false });
export const useProto = () => useContext(Ctx);

export function useProgress(still: number, ms: number, from = 0) {
  const { live } = useProto();
  const [p, setP] = useState(live ? from : still);
  useEffect(() => {
    if (!live) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      setP(from + (100 - from) * k);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [live, ms, from]);
  return p;
}

export function AutoGo({ to, ms }: { to: string; ms: number }) {
  const { live, go } = useProto();
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => go(to), ms);
    return () => clearTimeout(t);
  }, [live, go, to, ms]);
  return null;
}

/* -------------------------------- window -------------------------------- */
export type Page = "videos" | "subtitles" | "audio" | "chapters" | "attachments" | "mux";

export const PAGES: { id: Page; label: string; icon: ReactNode; on: ReactNode; to: string }[] = [
  { id: "videos", label: "Videos", icon: <VideoClipMultipleRegular />, on: <VideoClipMultipleFilled />, to: "videos-ready" },
  { id: "subtitles", label: "Subtitles", icon: <ClosedCaptionRegular />, on: <ClosedCaptionFilled />, to: "subs-ready" },
  { id: "audio", label: "Audio", icon: <MusicNote2Regular />, on: <MusicNote2Filled />, to: "audio-measured" },
  { id: "chapters", label: "Chapters", icon: <BookmarkMultipleRegular />, on: <BookmarkMultipleFilled />, to: "chapters-ready" },
  { id: "attachments", label: "Attachments", icon: <AttachRegular />, on: <AttachFilled />, to: "attach-ready" },
  { id: "mux", label: "Mux", icon: <LayerRegular />, on: <LayerFilled />, to: "mux-ready" },
];

const MENUS = ["File", "Edit", "View", "Tools", "Help"];

function AppIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <rect width="16" height="16" rx="4" fill="var(--accent)" />
      <path d="M4 5h8M4 8h8M4 11h5" stroke="var(--on-accent)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export interface LcdProps {
  icon?: "run" | "ok" | "warn" | "bad" | "idle";
  l1: ReactNode;
  l2?: ReactNode;
  pct?: number | null;
  time?: ReactNode;
}

/** The status display in the middle of the toolbar. */
export function Lcd({ icon = "idle", l1, l2, pct, time }: LcdProps) {
  return (
    <div className="lcd">
      <span className="ic">
        {icon === "run" ? <Ring size={16} /> : icon === "ok" ? <CheckmarkCircleFilled className="ok" /> : icon === "warn" ? <WarningFilled className="warn" /> : icon === "bad" ? <ErrorCircleFilled className="bad" /> : <InfoRegular />}
      </span>
      <div className="col" style={{ minWidth: 0 }}>
        <span className="l1 truncate">{l1}</span>
        {l2 && <span className="l2 truncate">{l2}</span>}
      </div>
      {time && <span className="time">{time}</span>}
      {pct !== undefined && (
        <span className="bar"><i style={pct === null ? { width: "30%", animation: "ind 1.5s var(--ease) infinite" } : { width: `${pct}%` }} /></span>
      )}
    </div>
  );
}

export function Window({
  page,
  tools,
  lcd,
  primary,
  strip,
  cols = "minmax(0,1fr) 300px",
  children,
  dock,
  overlay,
  menu,
  busy,
  flags = [],
  util,
  note = "MKVToolNix 88.0 · FFmpeg 7.1",
}: {
  menu?: "File" | "Edit" | "View" | "Tools" | "Help";
  page: Page;
  tools?: ReactNode;
  lcd: LcdProps;
  primary?: ReactNode;
  strip?: ReactNode;
  cols?: string;
  children: ReactNode;
  dock?: ReactNode;
  overlay?: ReactNode;
  busy?: Page;
  /** Pages with files that cannot be muxed as they are. */
  flags?: Page[];
  util?: "history" | "output";
  note?: ReactNode;
}) {
  const { go, theme, mac } = useProto();
  const title = PAGES.find((p) => p.id === page)?.label;
  return (
    <div className={cx("win", `theme-${theme}`)}>
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
              {MENUS.map((m) => (
                <button key={m} type="button" className={cx(menu === m && "on")} onClick={() => go(`menu-${m.toLowerCase()}`)}>{m}</button>
              ))}
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
        <Lcd {...lcd} />
        <div className="r">{primary}</div>
      </div>
      {strip && <div className="strip2">{strip}</div>}

      <div className="ws" style={{ gridTemplateColumns: cols }}>
        {children}
        {dock && <div className="box dock">{dock}</div>}
      </div>

      <footer className="pagebar">
        <span className="l">{note}</span>
        <nav className="pages" aria-label="Pages">
          {PAGES.map((p, i) => (
            <button key={p.id} type="button" className={cx("pg", page === p.id && "on")} onClick={() => go(p.to)} title={`${p.label} (Ctrl+${i + 1})`}>
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
          <button type="button" className={cx("ub", util === "history" && "on")} title="History (Ctrl+H)" onClick={() => go("history")}><span className="ic"><HistoryRegular /></span></button>
          <button type="button" className={cx("ub", util === "output" && "on")} title="Output (Ctrl+`)" onClick={() => go("output")}><span className="ic"><WindowConsoleRegular /></span></button>
          <button type="button" className="ub" title="Preferences (Ctrl+,)" onClick={() => go("prefs")}><span className="ic"><SettingsRegular /></span></button>
        </span>
      </footer>
      {menu && <MenuFly menu={menu} page={page} />}
      {overlay}
    </div>
  );
}

type MI = [label: string, key?: string, opts?: { to?: string; off?: boolean; check?: boolean }] | "-";

function menuItems(menu: string, page: Page): MI[] {
  if (menu === "File")
    return [
      ["Choose folder…", "Ctrl+O", { to: page === "audio" ? "audio-ready" : "videos-scanning" }],
      ["Add files…", undefined, { off: page !== "attachments" }],
      ["Import from a video…", undefined, { off: page !== "audio" && page !== "subtitles", to: "audio-import" }],
      "-",
      ["Open log file"],
      "-",
      ["Preferences…", "Ctrl+,", { to: "prefs" }],
      "-",
      ["Exit", "Alt+F4"],
    ];
  if (menu === "Edit")
    return [
      ["Select all", "Ctrl+A"],
      ["Remove", "Del"],
      ["Clear the list"],
      "-",
      ["Move up", "Alt+↑", { off: page === "videos" }],
      ["Move down", "Alt+↓", { off: page === "videos" }],
      "-",
      ["New track", "Ctrl+N", { off: page !== "audio" && page !== "subtitles" }],
      ["Duplicate track", undefined, { off: page !== "audio" && page !== "subtitles" }],
    ];
  if (menu === "View")
    return [
      ...PAGES.map((p, i): MI => [p.label, `Ctrl+${i + 1}`, { check: p.id === page, to: p.to }]),
      "-",
      ["Output", "Ctrl+`", { check: false, to: "output" }],
      ["History", "Ctrl+H", { check: false, to: "history" }],
    ];
  if (menu === "Tools")
    return [
      ["Measure delays", undefined, { off: page !== "audio", to: "audio-measuring" }],
      ["Apply measured delays", undefined, { off: page !== "audio" }],
      "-",
      ["Modify tracks…", "Ctrl+M", { to: "videos-modify" }],
      ["Media info", "Ctrl+I", { to: "videos-info" }],
      "-",
      ["Add to queue", undefined, { to: "mux-ready" }],
      ["Validate", undefined, { to: "mux-warnings" }],
      ["Start muxing", "Ctrl+Enter", { to: "mux-running" }],
      "-",
      ["Tools and dependencies…", undefined, { to: "prefs-tools" }],
    ];
  return [
    ["Keyboard shortcuts", "?", { to: "shortcuts" }],
    ["Check for updates…", undefined, { to: "prefs-updates" }],
    ["Release notes"],
    "-",
    ["About MKVBatchMux 1.70.0", undefined, { to: "prefs" }],
  ];
}

const MENU_LEFT: Record<string, number> = { File: 34, Edit: 70, View: 107, Tools: 148, Help: 193 };

function MenuFly({ menu, page }: { menu: string; page: Page }) {
  const { go } = useProto();
  const items = menuItems(menu, page);
  const checks = items.some((it) => it !== "-" && it[2]?.check !== undefined);
  const back = PAGES.find((p) => p.id === page)?.to ?? "videos-ready";
  return (
    <>
      <div style={{ position: "absolute", inset: 0, zIndex: 35 }} onClick={() => go(back)} />
      <div className="fly menu-fly" style={{ left: MENU_LEFT[menu] }}>
        {items.map((it, i) =>
          it === "-" ? (
            <div key={i} className="msep" />
          ) : (
            <div key={it[0]} className="mi" style={it[2]?.off ? { opacity: 0.45 } : undefined} onClick={() => it[2]?.to && !it[2]?.off && go(it[2].to)}>
              {checks && <span style={{ width: 16, display: "grid", placeItems: "center", marginLeft: -4, color: "var(--text-2)" }}>{it[2]?.check && <CheckmarkRegular />}</span>}
              <span className="grow">{it[0]}</span>
              {it[1] && <span className="t3 sm">{it[1]}</span>}
            </div>
          ),
        )}
      </div>
    </>
  );
}

/* A docked panel with a header. */
export function Box({ title, sub, end, children, style, body = true }: { title?: ReactNode; sub?: ReactNode; end?: ReactNode; children: ReactNode; style?: CSSProperties; body?: boolean }) {
  return (
    <section className="box" style={style}>
      {title !== undefined && (
        <div className="box-h">
          <span className="tt truncate">{title}</span>
          {sub && <span className="truncate t3">{sub}</span>}
          {end && <span className="end">{end}</span>}
        </div>
      )}
      {body ? <div className="box-b">{children}</div> : children}
    </section>
  );
}

export function DockTabs({ tabs, on, tools, onTab }: { tabs: string[]; on: string; tools?: ReactNode; onTab?: (t: string) => void }) {
  return (
    <div className="dtabs">
      {tabs.map((t) => (
        <button key={t} type="button" className={cx("tab", t === on && "on")} onClick={() => onTab?.(t)}>{t}</button>
      ))}
      {tools && <span className="tools">{tools}</span>}
    </div>
  );
}

/** A dialog over the window. */
export function Dialog({ title, sub, children, foot, size, left }: { title: ReactNode; sub?: ReactNode; children: ReactNode; foot: ReactNode; size?: "wide" | "mid"; left?: ReactNode }) {
  return (
    <div className="smoke">
      <div className={cx("dialog", size)}>
        <div className="db">
          <div className="dt">{title}</div>
          {sub && <div className="ds">{sub}</div>}
          {children}
        </div>
        <div className="df">
          {left && <span className="l">{left}</span>}
          {foot}
        </div>
      </div>
    </div>
  );
}
