import { CheckmarkCircleFilled, CheckmarkFilled, ChevronDownRegular, ErrorCircleFilled, InfoFilled, ReOrderDotsVerticalRegular, WarningFilled } from "@fluentui/react-icons";
import type { CSSProperties, ReactNode } from "react";

/** Middle ellipsis for file names: the end (release, extension) is what tells them apart. */
export const mid = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.ceil(max * 0.4))}…${s.slice(-Math.floor(max * 0.6) + 1)}`);

/** Middle ellipsis that adapts to the column: the tail (release, extension)
 *  always shows, and it starts on a word boundary. */
export function MidText({ text, tail = 18, className }: { text: string; tail?: number; className?: string }) {
  let at = Math.max(0, text.length - tail);
  const b = Math.max(text.lastIndexOf(" ", at), text.lastIndexOf(".", at));
  if (b > 0 && at - b < 8) at = b + 1;
  if (at < 12) return <span className={cx("truncate", className)} title={text}>{text}</span>;
  return (
    <span className={cx("midtext", className)} title={text}>
      <span className="h">{text.slice(0, at).replace(/ $/, "\u00a0")}</span>
      <span className="t"><bdi dir="ltr">{text.slice(at)}</bdi></span>
    </span>
  );
}

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type Fn = () => void;

export function Btn({ children, accent, icon, kbd, disabled, onClick, style, title }: { children?: ReactNode; accent?: boolean; icon?: ReactNode; kbd?: string; disabled?: boolean; onClick?: Fn; style?: CSSProperties; title?: string }) {
  return (
    <button type="button" className={cx("btn", accent && "accent")} disabled={disabled} onClick={onClick} style={style} title={title}>
      {icon && <span className="ic">{icon}</span>}
      {children}
      {kbd && <span className="kbd">{kbd}</span>}
    </button>
  );
}

/** CommandBar button: icon + label, no chrome until hovered. */
export function Cmd({ icon, children, onClick, disabled, sm, title }: { icon: ReactNode; children?: ReactNode; onClick?: Fn; disabled?: boolean; sm?: boolean; title?: string }) {
  return (
    <button type="button" className={cx("cmd", !children && "icon", sm && "sm")} onClick={onClick} disabled={disabled} title={title}>
      <span className="ic">{icon}</span>
      {children && <span className="lbl">{children}</span>}
    </button>
  );
}

export function Combo({ value, w, sm, ghost, placeholder, onClick }: { value: ReactNode; w?: number | string; sm?: boolean; ghost?: boolean; placeholder?: boolean; onClick?: Fn }) {
  return (
    <button type="button" className={cx("combo", sm && "sm", ghost && "ghost", placeholder && "placeholder")} style={{ width: w }} onClick={onClick}>
      <span className="v">{value}</span>
      <span className="ic"><ChevronDownRegular /></span>
    </button>
  );
}

export function TBox({ value, ph, unit, w, focus, area, mono }: { value?: ReactNode; ph?: string; unit?: string; w?: number | string; focus?: boolean; area?: boolean; mono?: boolean }) {
  return (
    <div className={cx("tbox", focus && "focus", area && "area")} style={{ width: w }}>
      {value ? <span className={cx(mono && "mono")} style={{ whiteSpace: "pre-line" }}>{value}</span> : <span className="ph">{ph}</span>}
      {unit && <span className="u">{unit}</span>}
    </div>
  );
}

export const Toggle = ({ on, label }: { on: boolean; label?: boolean }) => (
  <span className={cx("tgl", on && "on")}>
    {label && <span style={{ minWidth: 22 }}>{on ? "On" : "Off"}</span>}
    <span className="tr"><span className="kn" /></span>
  </span>
);
export const Chk = ({ on }: { on: boolean }) => <span className={cx("chk", on && "on")}>{on && <CheckmarkFilled />}</span>;
export const Radio = ({ on }: { on: boolean }) => <span className={cx("rad", on && "on")} />;

export function Seg({ items, value }: { items: string[]; value: number }) {
  return (
    <span className="seg">
      {items.map((t, i) => (
        <button key={t} type="button" className={cx(i === value && "on")}>{t}</button>
      ))}
    </span>
  );
}

export const Slider = ({ pct }: { pct: number }) => (
  <span className="sld">
    <span className="r" />
    <span className="f" style={{ width: `${pct}%` }} />
    <span className="t" style={{ left: `${pct}%` }} />
  </span>
);

export const PBar = ({ pct, ind, w }: { pct?: number; ind?: boolean; w?: number | string }) => (
  <span className={cx("pbar", ind && "ind")} style={{ width: w ?? "100%", display: "block" }}>
    <i style={ind ? undefined : { width: `${pct ?? 0}%` }} />
  </span>
);

/** Fluent ProgressRing (indeterminate). */
export const Ring = ({ size = 16 }: { size?: number }) => (
  <svg className="ring" width={size} height={size} viewBox="0 0 16 16">
    <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeDasharray="18 40" strokeLinecap="round" />
  </svg>
);

export const toneOf = (c: number) => (c >= 75 ? "var(--ok)" : c >= 50 ? "var(--warn)" : "var(--bad)");
export const Meter = ({ pct }: { pct: number }) => (
  <span className="meter"><i style={{ width: `${pct}%`, background: toneOf(pct) }} /></span>
);

export type St = "ready" | "wait" | "run" | "ok" | "warn" | "bad" | "written" | "writing";
/** One status vocabulary for every queue in the app. */
export function Status({ s, text, pct }: { s: St; text?: string; pct?: number | null }) {
  if (s === "run" || s === "writing")
    return (
      <span className="cell" style={{ width: "100%" }}>
        <PBar pct={pct ?? 0} ind={pct === null} w={64} />
        <span className="sm t2 num">{text ?? `${Math.round(pct ?? 0)}%`}</span>
      </span>
    );
  const icon =
    s === "ok" || s === "written" ? <CheckmarkCircleFilled className="ok" /> : s === "warn" ? <WarningFilled className="warn" /> : s === "bad" ? <ErrorCircleFilled className="bad" /> : null;
  return (
    <span className={cx("cell", (s === "ready" || s === "wait") && "t3")}>
      {icon && <span style={{ fontSize: 16, display: "grid" }}>{icon}</span>}
      <span className="truncate">{text ?? { ready: "Ready", wait: "Waiting", ok: "Done", warn: "Check", bad: "Failed", written: "Written" }[s]}</span>
    </span>
  );
}

/* ---------------- table ---------------- */
export function Table({ cols, head, children, style }: { cols: string; head: ReactNode[]; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="tbl" style={{ ["--cols" as string]: cols, ...style }}>
      <div className="th">{head.map((h, i) => <span key={i} className={cx(typeof h === "string" && h.startsWith(" ") && "r")}>{typeof h === "string" ? h.trim() : h}</span>)}</div>
      <div className="tb">{children}</div>
    </div>
  );
}
export function Tr({ on, onClick, children, style }: { on?: boolean; onClick?: Fn; children: ReactNode; style?: CSSProperties }) {
  return <div className={cx("tr", on && "on")} onClick={onClick} style={style}>{children}</div>;
}

/* ---------------- panes ---------------- */
export const DL = ({ rows }: { rows: [ReactNode, ReactNode][] }) => (
  <dl className="dl">
    {rows.map(([k, v], i) => (
      <div key={i} style={{ display: "contents" }}>
        <dt>{k}</dt>
        <dd>{v}</dd>
      </div>
    ))}
  </dl>
);

export function InfoBar({ tone, children, actions }: { tone: "ok" | "warn" | "bad" | "info"; children: ReactNode; actions?: ReactNode }) {
  const icon = tone === "ok" ? <CheckmarkCircleFilled className="ok" /> : tone === "warn" ? <WarningFilled className="warn" /> : tone === "bad" ? <ErrorCircleFilled className="bad" /> : <InfoFilled className="acc" />;
  return (
    <div className="info">
      <span className="ic">{icon}</span>
      <span className="grow">{children}</span>
      {actions && <span className="end">{actions}</span>}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="glyph">{icon}</span>
      <span className="h">{title}</span>
      {children && <div className="row" style={{ gap: 8, marginTop: 4 }}>{children}</div>}
    </div>
  );
}

/* ---------------- waveform: a filled min/max envelope ---------------- */
function rng(seed: number) {
  let s = (seed * 9301 + 49297) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}
export function envelope(seed: number, n: number) {
  const r = rng(seed);
  const out: number[] = [];
  let lvl = 0.5;
  let left = 0;
  for (let i = 0; i < n; i++) {
    if (left-- <= 0) {
      left = 4 + Math.floor(r() * 18);
      lvl = r() < 0.15 ? 0.05 : 0.25 + r() * 0.7;
    }
    out.push(Math.max(0.03, Math.min(1, lvl * (0.6 + r() * 0.5))));
  }
  return out;
}
export function Wave({ seed, color, n = 240, style }: { seed: number; color: string; n?: number; style?: CSSProperties }) {
  const e = envelope(seed, n);
  const W = 1000;
  const top = e.map((v, i) => `${((i / (n - 1)) * W).toFixed(1)},${(50 - v * 46).toFixed(1)}`);
  const bot = e.map((v, i) => `${((i / (n - 1)) * W).toFixed(1)},${(50 + v * 46).toFixed(1)}`).reverse();
  return (
    <svg viewBox={`0 0 ${W} 100`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height: "100%", ...style }}>
      <polygon points={[...top, ...bot].join(" ")} fill={color} />
    </svg>
  );
}

export const Video = ({ tc, children, style }: { tc?: string; children?: ReactNode; style?: CSSProperties }) => (
  <div className="video" style={style}>
    <div className="sc" />
    {tc && <span className="tc">{tc}</span>}
    {children}
  </div>
);

/* ---------------- MKVBatchMux additions ---------------- */

/** A labelled field in an inspector: the label sits above the control. */
export const Fld = ({ label, children, style }: { label: string; children: ReactNode; style?: CSSProperties }) => (
  <div className="fld" style={style}>
    <span className="lb">{label}</span>
    {children}
  </div>
);

/** A setting that is one switch or box: its name on the left, the control on the right. */
export const TRow = ({ label, d, children }: { label: ReactNode; d?: ReactNode; children: ReactNode }) => (
  <div className="trow">
    <span className="grow">
      <div>{label}</div>
      {d && <div className="d">{d}</div>}
    </span>
    {children}
  </div>
);

/** The drag handle at the start of a row that can be reordered. */
export const Grip = () => <span className="grip-h"><ReOrderDotsVerticalRegular /></span>;
