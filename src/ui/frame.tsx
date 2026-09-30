/** The window frame: title bar with the menu bar and caption buttons, a
 *  toolbar with the status display, the workspace of docked panels, and the
 *  page bar along the bottom — design/mockup/shell.tsx, made real. It is
 *  AudioSyncMaster's frame, on Tauri 1's window API. */

import {
  CheckmarkCircleFilled,
  CheckmarkRegular,
  DismissRegular,
  ErrorCircleFilled,
  HistoryRegular,
  SettingsRegular,
  WarningFilled,
  WindowConsoleRegular,
} from "@fluentui/react-icons";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { Ring, cx } from "./kit";

/** Which chrome the window draws. macOS: native traffic lights over the
 *  title bar (titleBarStyle Overlay) and menus in the system bar. Windows:
 *  no native decorations, so the in-window menu bar and caption buttons.
 *  Linux: native decorations, the in-window menu bar only. A dev build can
 *  force one with ?os=windows|mac|linux to review each. */
function detectOs(): "mac" | "windows" | "linux" {
  if (typeof navigator === "undefined") return "windows";
  if (import.meta.env.DEV && typeof location !== "undefined") {
    const forced = new URLSearchParams(location.search).get("os");
    if (forced === "mac" || forced === "windows" || forced === "linux") return forced;
  }
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "mac";
  if (/Windows/i.test(ua)) return "windows";
  return "linux";
}
export const OS = detectOs();
export const IS_MAC = OS === "mac";

/* ------------------------------------------------------------------ menus */

export type MenuItem =
  | {
      label: string;
      shortcut?: string;
      onSelect?: () => void;
      disabled?: boolean;
      checked?: boolean;
    }
  | "separator";

export interface Menu {
  label: string;
  items: MenuItem[];
}

/** Menus are read when one opens, so what is enabled is always current. */
function MenuBar({ menus: source }: { menus: Menu[] | (() => Menu[]) }) {
  const [open, setOpen] = useState<number | null>(null);
  const [menus, setMenus] = useState<Menu[]>(() => (typeof source === "function" ? source() : source));
  useEffect(() => {
    if (typeof source !== "function") setMenus(source);
  }, [source]);
  const [left, setLeft] = useState(0);
  const barRef = useRef<HTMLElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const show = useCallback((index: number | null) => {
    if (index !== null && typeof source === "function") setMenus(source());
    setOpen(index);
    if (index !== null) {
      // The title bar is the button's offset parent, as it is the flyout's
      // frame; the flyout opens 2 px left of its button.
      const button = buttons.current[index];
      if (button) setLeft(button.offsetLeft - 2);
    }
  }, [source]);

  useEffect(() => {
    if (open === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
      if (event.key === "ArrowRight") show((open + 1) % menus.length);
      if (event.key === "ArrowLeft") show((open - 1 + menus.length) % menus.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, menus.length, show]);

  const checks = open !== null && menus[open].items.some((item) => item !== "separator" && item.checked !== undefined);

  return (
    <>
      <nav className="menubar" ref={barRef} aria-label="Menu" role="menubar">
        {menus.map((menu, i) => (
          <button
            key={menu.label}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === i}
            className={cx(open === i && "on")}
            onClick={() => show(open === i ? null : i)}
            onMouseEnter={() => open !== null && open !== i && show(i)}
          >
            {menu.label}
          </button>
        ))}
      </nav>
      {open !== null && (
        <>
          <div className="menu-scrim" onMouseDown={() => setOpen(null)} />
          <div className="fly menu-fly" role="menu" style={{ left }}>
            {/* A check column only in a menu that has checks (View). */}
            {menus[open].items.map((item, i) =>
              item === "separator" ? (
                <div key={i} className="msep" role="separator" />
              ) : (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className="mi"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(null);
                    item.onSelect?.();
                  }}
                >
                  {checks && <span className="mcheck" aria-hidden>{item.checked && <CheckmarkRegular />}</span>}
                  <span className="grow">{item.label}</span>
                  {item.shortcut && <span className="t3 sm">{item.shortcut}</span>}
                </button>
              ),
            )}
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------- title bar */

function AppIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <rect width="16" height="16" rx="4" fill="var(--accent)" />
      <path d="M4 5h8M4 8h8M4 11h5" stroke="var(--on-accent)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

type TauriWindow = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (handler: () => void) => Promise<() => void>;
};

/** The current Tauri window, or null in a plain browser. */
export async function currentWindow(): Promise<TauriWindow | null> {
  if (typeof window === "undefined" || !("__TAURI_IPC__" in window)) return null;
  try {
    const mod = await import("@tauri-apps/api/window");
    return mod.appWindow as unknown as TauriWindow;
  } catch {
    return null;
  }
}

function CaptionButtons() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void currentWindow().then(async (win) => {
      if (!win || cancelled) return;
      setMaximized(await win.isMaximized());
      const off = await win.onResized(() => void win.isMaximized().then(setMaximized));
      if (cancelled) off();
      else dispose = off;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  const act = (what: "minimize" | "toggleMaximize" | "close") => void currentWindow().then((win) => win?.[what]());
  return (
    <span className="caps">
      <button type="button" className="cap" aria-label="Minimize" onClick={() => act("minimize")}>
        <svg width="10" height="10" aria-hidden><path d="M0 5.5h10" stroke="currentColor" /></svg>
      </button>
      <button type="button" className="cap" aria-label={maximized ? "Restore" : "Maximize"} onClick={() => act("toggleMaximize")}>
        {maximized ? (
          <svg width="10" height="10" aria-hidden>
            <rect x="0.5" y="2.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" />
            <path d="M2.5 2.5V1.8a1.3 1.3 0 0 1 1.3-1.3h4.4a1.3 1.3 0 0 1 1.3 1.3v4.4a1.3 1.3 0 0 1-1.3 1.3H7.5" fill="none" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" aria-hidden><rect x=".5" y=".5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" /></svg>
        )}
      </button>
      <button type="button" className="cap x" aria-label="Close" onClick={() => act("close")}>
        <svg width="10" height="10" aria-hidden><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" /></svg>
      </button>
    </span>
  );
}

/* ------------------------------------------------------------------ status */

/** How a page describes what it is doing. Pages still say it in full; the
 *  toolbar shows it small, and only when there is something to show. */
export interface LcdProps {
  icon?: "run" | "ok" | "warn" | "bad" | "idle";
  l1: ReactNode;
  l2?: ReactNode;
  /** Progress, 0–100; null for "running, unknown". */
  pct?: number | null;
  time?: ReactNode;
}

export interface StatusProps {
  icon: "run" | "ok" | "warn" | "bad";
  text: ReactNode;
  /** The longer explanation, on hover. */
  detail?: string;
  time?: ReactNode;
  pct?: number | null;
  /** Open the page it is about, when it is about another page. */
  onClick?: () => void;
}

/** A page's status as the toolbar shows it: nothing when idle. */
export function lcdStatus(lcd: LcdProps): StatusProps | null {
  if (!lcd.icon || lcd.icon === "idle") return null;
  return { icon: lcd.icon, text: lcd.l1, detail: typeof lcd.l2 === "string" ? lcd.l2 : undefined, time: lcd.time, pct: lcd.pct };
}

/** The status, small, in the toolbar's middle: a run's progress or a result
 *  worth a look. */
export function StatusPill({ icon, text, detail, time, pct, onClick }: StatusProps) {
  return (
    <button type="button" className="stat" role="status" aria-live="polite" title={detail} disabled={!onClick} onClick={onClick}>
      <span className="ic" aria-hidden>
        {icon === "run" ? (
          <Ring size={14} />
        ) : icon === "ok" ? (
          <CheckmarkCircleFilled className="ok" />
        ) : icon === "warn" ? (
          <WarningFilled className="warn" />
        ) : (
          <ErrorCircleFilled className="bad" />
        )}
      </span>
      <span className="truncate">
        <b>{text}</b>
        {time && <> · {time}</>}
      </span>
      {pct !== undefined && (
        <span className={cx("bar", pct === null && "ind")}>
          <i style={pct === null ? undefined : { width: `${Math.max(0, Math.min(100, pct))}%` }} />
        </span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ pages */

export interface PageTab<P extends string> {
  id: P;
  label: string;
  icon: ReactNode;
  on: ReactNode;
  shortcut?: string;
}

export function AppWindow({
  title,
  menus,
  children,
  footer,
  overlay,
}: {
  title: string;
  menus: Menu[] | (() => Menu[]);
  children: ReactNode;
  footer: ReactNode;
  overlay?: ReactNode;
}) {
  return (
    <div className="win">
      <header className={cx("titlebar", IS_MAC && "mac")} data-tauri-drag-region>
        {!IS_MAC && (
          <>
            <AppIcon />
            <MenuBar menus={menus} />
          </>
        )}
        <span className="wtitle" data-tauri-drag-region>{title} — MKVBatchMux</span>
        {OS === "windows" && <CaptionButtons />}
      </header>
      {children}
      {footer}
      {overlay}
    </div>
  );
}

/** One page's toolbar and workspace. Hidden pages stay mounted, so a page
 *  keeps what it was showing when you come back to it. The toolbar's middle
 *  shows the status while there is one, and `center` otherwise. */
export function PageView({
  tools,
  status,
  center,
  primary,
  cols = "minmax(0,1fr)",
  dock,
  children,
  hidden,
}: {
  tools?: ReactNode;
  status?: StatusProps | null;
  center?: ReactNode;
  primary?: ReactNode;
  cols?: string;
  dock?: ReactNode;
  children: ReactNode;
  hidden?: boolean;
}) {
  return (
    <div className="pageview" hidden={hidden}>
      <div className="toolbar" data-tauri-drag-region>
        <div className="l">{tools}</div>
        <div className="c">{status ? <StatusPill {...status} /> : center}</div>
        <div className="r">{primary}</div>
      </div>
      <div className="ws" style={{ gridTemplateColumns: cols }}>
        {children}
        {dock && <div className="box dock">{dock}</div>}
      </div>
    </div>
  );
}

export function PageBar<P extends string>({
  pages,
  page,
  onPage,
  busy,
  flags = [],
  disabled,
  note,
  history,
  output,
  outputDot,
  onHistory,
  onOutput,
  onPreferences,
}: {
  pages: PageTab<P>[];
  page: P;
  onPage: (page: P) => void;
  busy?: P | null;
  /** Pages with files that cannot be muxed as they are. */
  flags?: P[];
  disabled?: boolean;
  note?: ReactNode;
  history?: boolean;
  output?: boolean;
  /** Something went wrong while Output was hidden. */
  outputDot?: boolean;
  onHistory: () => void;
  onOutput: () => void;
  onPreferences: () => void;
}) {
  return (
    <footer className="pagebar">
      <span className="l">{note}</span>
      <nav className="pages" aria-label="Pages">
        {pages.map((p) => (
          <button
            key={p.id}
            type="button"
            className={cx("pg", page === p.id && "on")}
            aria-current={page === p.id ? "page" : undefined}
            disabled={disabled && page !== p.id}
            onClick={() => onPage(p.id)}
            title={p.shortcut ? `${p.label} (${p.shortcut})` : p.label}
          >
            <span className="ic" aria-hidden>{page === p.id ? p.on : p.icon}</span>
            {p.label}
            {busy === p.id && page !== p.id ? (
              <span className="busy" aria-label="Running"><Ring size={10} /></span>
            ) : (
              flags.includes(p.id) && (
                <span className="flag" aria-label="Needs attention"><WarningFilled /></span>
              )
            )}
          </button>
        ))}
      </nav>
      <span className="r">
        <button type="button" className={cx("ub", history && "on")} title="History (Ctrl+H)" aria-label="History" aria-pressed={history} onClick={onHistory}>
          <span className="ic" aria-hidden><HistoryRegular /></span>
        </button>
        <button type="button" className={cx("ub", output && "on")} title={outputDot ? "Output: something went wrong (Ctrl+`)" : "Output (Ctrl+`)"} aria-label={outputDot ? "Output, something went wrong" : "Output"} aria-pressed={output} onClick={onOutput}>
          <span className="ic" aria-hidden><WindowConsoleRegular /></span>
          {outputDot && <i className="dot" aria-hidden />}
        </button>
        <button type="button" className="ub" title="Preferences (Ctrl+,)" aria-label="Preferences" onClick={onPreferences}>
          <span className="ic" aria-hidden><SettingsRegular /></span>
        </button>
      </span>
    </footer>
  );
}

/* ------------------------------------------------------------ panels */

/** A docked panel with a header. */
export function Box({
  title,
  sub,
  end,
  children,
  style,
  body = true,
  label,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  end?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  body?: boolean;
  label?: string;
}) {
  return (
    <section className="box" style={style} aria-label={label}>
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

/** A list with its one header row (tabs or a title on the left; filters and
 *  search on the right) and, under it, the settings that shape it. */
export function Panel({
  left,
  end,
  sheet,
  label,
  children,
}: {
  left: ReactNode;
  end?: ReactNode;
  sheet?: ReactNode;
  label?: string;
  children: ReactNode;
}) {
  return (
    <section className="box" aria-label={label}>
      <div className="phead">
        {left}
        {end && <span className="end">{end}</span>}
      </div>
      {sheet && <div className="sheet">{sheet}</div>}
      {children}
    </section>
  );
}

/** A folder as its last two parts, the whole path on hover. */
export function Crumb({ path, empty = "No folder" }: { path: string; empty?: string }) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return <span className="crumb t3">{empty}</span>;
  const last = parts[parts.length - 1];
  const parent = parts.length > 1 ? parts[parts.length - 2] : null;
  return (
    <span className="crumb" title={path}>
      {parent && (
        <>
          <span className="t3 truncate">{parent}</span>
          <span className="t3" aria-hidden>/</span>
        </>
      )}
      <span className="truncate">{last}</span>
    </span>
  );
}

/** A small panel of settings under the button that opened it. Closes on a
 *  click elsewhere and on Escape; lists opened from inside it (a language, a
 *  choice) do not close it. */
export function Popover({
  anchor,
  onClose,
  label,
  wide,
  align = "start",
  children,
}: {
  anchor: RefObject<HTMLElement>;
  onClose: () => void;
  label: string;
  wide?: boolean;
  align?: "start" | "center";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = anchor.current;
    const host = ref.current?.offsetParent as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const base = host?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth };
    const width = wide ? 480 : 420;
    const start = align === "center" ? r.left + r.width / 2 - width / 2 : r.left;
    const left = Math.max(8, Math.min(start - base.left, base.width - width - 8));
    setAt({ top: r.bottom - base.top + 6, left });
  }, [anchor, wide, align]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
      if (target.closest(".fly, .menu-scrim, .smoke")) return;
      closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor]);

  return createPortal(
    <div ref={ref} className={cx("fly setfly", wide && "wide")} role="dialog" aria-label={label} style={at ?? { visibility: "hidden" }}>
      {children}
    </div>,
    document.querySelector(".win") ?? document.body,
  );
}

/** Tabs with their counts across a large dialog's bar (Video 1, Audio 3,
 *  Subtitles 5), and the commands for the tab showing. */
export function DialogTabs<T extends string>({
  tabs,
  on,
  onTab,
  tools,
}: {
  tabs: { id: T; label: string; count?: number }[];
  on: T;
  onTab: (tab: T) => void;
  tools?: ReactNode;
}) {
  return (
    <>
      <span className="row" role="tablist" style={{ gap: 0 }}>
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === on} className={cx("tab", t.id === on && "on")} onClick={() => onTab(t.id)}>
            {t.label}
            {t.count !== undefined && <span className="n">{t.count}</span>}
          </button>
        ))}
      </span>
      {tools && <span className="tools">{tools}</span>}
    </>
  );
}

export function DockTabs<T extends string>({
  tabs,
  on,
  tools,
  onTab,
}: {
  tabs: { id: T; label: string }[];
  on: T;
  tools?: ReactNode;
  onTab?: (tab: T) => void;
}) {
  return (
    <div className="dtabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === on}
          className={cx("tab", t.id === on && "on")}
          onClick={() => onTab?.(t.id)}
        >
          {t.label}
        </button>
      ))}
      {tools && <span className="tools">{tools}</span>}
    </div>
  );
}

/** A modal layer: dims the window (Smoke) and holds a dialog. Escape and a
 *  click on the smoke close it unless it is not dismissible. */
export function Modal({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("button, input, select, textarea, [tabindex]");
    first?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    if (!onClose) return;
    // Listened for last, as the event bubbles out, so whatever inside the
    // dialog handles Escape first — a language list, a name being edited —
    // keeps it, and the dialog only closes on an Escape nothing else wanted.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Only the topmost dialog closes: a dialog opened from a dialog sits
      // after it in the document.
      const layers = document.querySelectorAll(".smoke");
      if (layers[layers.length - 1] !== ref.current) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Over the whole window wherever it is rendered from: a dialog opened from
  // inside a panel would otherwise be clipped to that panel.
  return createPortal(
    <div className="smoke" ref={ref} onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      {children}
    </div>,
    document.querySelector(".win") ?? document.body,
  );
}

/** A dialog inside a Modal: title, optional subtitle, body, and buttons.
 *  Without a size it is a Windows ContentDialog (440 px, equal buttons); "mid"
 *  and "wide" scroll their body and right-align the buttons. */
export function Dialog({
  title,
  sub,
  children,
  foot,
  left,
  size,
  onClose,
  label,
  alert,
  bar,
  bodyClass,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  foot: ReactNode;
  left?: ReactNode;
  size?: "mid" | "wide" | "xl";
  onClose?: () => void;
  /** Accessible name when the title is not plain text. */
  label?: string;
  /** A question that needs an answer before anything else (Windows'
   *  ContentDialog asking to confirm). */
  alert?: boolean;
  /** "xl" only: a row under the title, such as tabs and their commands. */
  bar?: ReactNode;
  /** "xl" only: classes for the body ("flush", "compact"). */
  bodyClass?: string;
}) {
  if (size === "xl")
    return (
      <Modal onClose={onClose}>
        <div className="dialog xl" role="dialog" aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : undefined)}>
          <div className="dh">
            <div className="grow col" style={{ minWidth: 0 }}>
              <div className="dt truncate" role="heading" aria-level={2}>{title}</div>
              {sub && <div className="ds truncate">{sub}</div>}
            </div>
            {onClose && (
              <button type="button" className="cmd icon" title="Close (Esc)" aria-label="Close" onClick={onClose}>
                <span className="ic" aria-hidden><DismissRegular /></span>
              </button>
            )}
          </div>
          {bar && <div className="dbar">{bar}</div>}
          <div className={cx("db", bodyClass)}>{children}</div>
          <div className="df">
            {left && <span className="l">{left}</span>}
            {foot}
          </div>
        </div>
      </Modal>
    );
  return (
    <Modal onClose={onClose}>
      <div className={cx("dialog", size)} role={alert ? "alertdialog" : "dialog"} aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : undefined)}>
        <div className="db">
          <div className="dt" role="heading" aria-level={2}>{title}</div>
          {sub && <div className="ds">{sub}</div>}
          {children}
        </div>
        <div className="df">
          {left && <span className="l">{left}</span>}
          {foot}
        </div>
      </div>
    </Modal>
  );
}
