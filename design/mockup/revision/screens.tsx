import {
  AddRegular,
  ArrowDownRegular,
  ArrowImportRegular,
  ArrowSyncRegular,
  ArrowUpRegular,
  AttachRegular,
  BookmarkMultipleRegular,
  BracesRegular,
  CheckmarkRegular,
  CheckmarkStarburstRegular,
  ChevronDownRegular,
  ChevronUpRegular,
  ClosedCaptionRegular,
  CopyRegular,
  DeleteRegular,
  DismissRegular,
  EditRegular,
  FolderOpenRegular,
  FolderRegular,
  GaugeRegular,
  ImageRegular,
  InfoRegular,
  MusicNote2Regular,
  OptionsRegular,
  PauseRegular,
  PlayRegular,
  StopRegular,
  TextBulletListSquareRegular,
  TextFontRegular,
  TimelineRegular,
  VideoClipRegular,
  WarningFilled,
} from "@fluentui/react-icons";
import { useState, type ReactNode } from "react";

import { CHAP_DIR, CHAPTERS, DUB_DIR, DUBS, FONT_DIR, FONTS, OUT_DIR, SHOW_DIR, SUB_DIR, SUBS, VIDEOS, type Measure } from "../data";
import { Btn, Chk, Cmd, Combo, DL, Fld, Grip, InfoBar, Meter, Status, TBox, Table, Toggle, Tr, cx } from "../kit";
import { PrefsWindow } from "../screens/app";
import { Dash, L, Name, SearchBox } from "../screens/common";
import { Box, useProgress, useProto } from "../shell";
import { Window2, type StatusProps } from "./frame";

/* ------------------------------------------------------------------ panel */

/** The list, its header row, and the settings that shape it, always in
 *  view: tabs or a title on the left, search on the right. */
function Panel({ left, end, sheet, children }: { left: ReactNode; end?: ReactNode; sheet?: ReactNode; children: ReactNode }) {
  return (
    <section className="box">
      <div className="phead">
        {left}
        <span className="end">{end}</span>
      </div>
      {sheet && <div className="sheet">{sheet}</div>}
      {children}
    </section>
  );
}

/** A folder as its last two parts, the full path on hover. */
const Crumb = ({ path }: { path: string }) => {
  const parts = path.split("\\");
  return (
    <span className="crumb" title={path}>
      <span className="t3">{parts[parts.length - 2]}</span>
      <span className="t4" aria-hidden>/</span>
      <span>{parts[parts.length - 1]}</span>
    </span>
  );
};

const Title = ({ children, n }: { children: ReactNode; n: string }) => (
  <span className="crumb">{children}<span className="t3" style={{ fontWeight: 400 }}>{n}</span></span>
);

/** One labelled setting in the sheet; `wide` spans two columns. */
const P = ({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) => (
  <span className={cx("pf", wide && "wide")}>
    <span className="lb">{label}</span>
    {children}
  </span>
);

const FolderField = ({ path }: { path: string }) => (
  <span className="row" style={{ gap: 4, minWidth: 0 }}>
    <span className="grow" style={{ minWidth: 0 }}><TBox value={path} /></span>
    <Cmd icon={<FolderOpenRegular />} title="Choose folder" />
  </span>
);

/* ----------------------------------------------------------------- videos */

/** The whole width for the list: frame rate, duration and size beside each
 *  name. One click selects; a double-click opens Edit tracks. */
export function Videos2({ dock, overlay, sel: first = 2, muxing }: { dock?: boolean; overlay?: ReactNode; sel?: number | null; muxing?: boolean }) {
  const { go } = useProto();
  const [sel, setSel] = useState<number | null>(first);
  return (
    <Window2
      page="videos"
      cols="minmax(0,1fr)"
      status={muxing ? { icon: "run", text: <><b>Muxing 6 of 16</b> · 6 min left</>, pct: 38, to: "mux-running" } : undefined}
      busy={muxing ? "mux" : undefined}
      dock={dock ? { tab: "output", back: "videos" } : undefined}
      overlay={overlay}
      tools={
        <>
          <Cmd icon={<FolderOpenRegular />}>Choose folder</Cmd>
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" />
          <Cmd icon={<DeleteRegular />} title="Remove (Del)" disabled={sel === null} />
          <Cmd icon={<EditRegular />} title="Edit tracks" disabled={sel === null} onClick={() => go("edit")} />
          <Cmd icon={<InfoRegular />} title="Media info (Ctrl+I)" disabled={sel === null} />
        </>
      }
      primary={<Btn icon={<TextBulletListSquareRegular />}>Modify tracks…</Btn>}
    >
      <Panel left={<Crumb path={SHOW_DIR} />} end={<><Combo ghost sm value="All formats" w={104} /><Combo ghost sm value="Loaded order" w={116} /><SearchBox /></>}>
        <Table cols="minmax(0,1fr) 100px 88px 88px" head={["Name", " Frame rate", " Duration", " Size"]}>
          {VIDEOS.map((v, i) => (
            <Tr key={v.name} on={sel === i} onClick={() => setSel(i)} onDoubleClick={() => go("edit")}>
              <Name tail={40}>{v.name}</Name>
              <span className="r num t2" style={{ display: "flex" }}>{v.fps} fps</span>
              <span className="r num t2" style={{ display: "flex" }}>{v.dur}</span>
              <span className="r num t2" style={{ display: "flex" }}>{v.size}</span>
            </Tr>
          ))}
        </Table>
      </Panel>
    </Window2>
  );
}

/* ------------------------------------------------------------- track pages */

/** A track, as a tab on the list: its name and language; × on hover. */
function TrackTab({ n, kind, lang, on, hover }: { n: number; kind: "audio" | "subs"; lang: string; on?: boolean; hover?: boolean }) {
  const name = kind === "audio" ? "Audio" : "Subtitle";
  return (
    <span className={cx("ttab", on && "on", hover && "hover")}>
      <button type="button" className="tt">
        <span className="ic">{kind === "audio" ? <MusicNote2Regular /> : <ClosedCaptionRegular />}</span>
        {name} {n}
        <span className="lg">{lang}</span>
      </button>
      <button type="button" className="x" title={`Delete ${name} ${n}`} aria-label={`Delete ${name} ${n}`}><DismissRegular /></button>
    </span>
  );
}

/** The selected track's settings, always in view under its tab, as the old
 *  Track configuration was: two rows, labels in one column. */
function TrackSheet({ kind, lang, dir }: { kind: "audio" | "subs"; lang: string; dir: string }) {
  return (
    <>
      <P label="Folder" wide><FolderField path={dir} /></P>
      <P label="Language"><Combo value={lang} w="100%" /></P>
      <P label="Delay"><TBox value="0.000" unit="s" mono /></P>
      <P label="Formats"><Combo value="All formats" w="100%" /></P>
      <P label="Track name"><TBox ph="Keep the file's name" /></P>
      <P label="Place after"><Combo value={kind === "audio" ? "Video" : "Audio"} w="100%" /></P>
      <span className="checks">
        <label className="ck"><Chk on={false} />Default</label>
        {kind === "subs" && <label className="ck"><Chk on={false} />Forced</label>}
      </span>
    </>
  );
}

export function Subs2() {
  const [sel, setSel] = useState<number | null>(2);
  return (
    <Window2
      page="subtitles"
      cols="minmax(0,1fr)"
      tools={
        <>
          <Cmd icon={<ArrowImportRegular />}>Import from a video</Cmd>
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" />
          <Cmd icon={<CopyRegular />} title="Duplicate the track" />
          <Cmd icon={<DeleteRegular />} title="Remove (Del)" disabled={sel === null} />
        </>
      }
    >
      <Panel
        left={
          <>
            <TrackTab n={1} kind="subs" lang="English" on />
            <TrackTab n={2} kind="subs" lang="English signs" hover />
            <Cmd sm icon={<AddRegular />} title="New track" />
          </>
        }
        end={<SearchBox />}
        sheet={<TrackSheet kind="subs" lang="English" dir={SUB_DIR} />}
      >
        <Table cols="24px minmax(0,1fr) minmax(0,1fr) 72px" head={["#", "Video", "Subtitle file", " Delay"]}>
          {VIDEOS.map((v, i) => (
            <Tr key={v.name} on={sel === i} onClick={() => setSel(i)}>
              <span className="num t3">{i + 1}</span>
              <span className="truncate t2">{v.name}</span>
              <span className="cell"><Grip /><span className="truncate">{SUBS[i].name}</span></span>
              <span className="r num t2" style={{ display: "flex" }}>0.000</span>
            </Tr>
          ))}
        </Table>
      </Panel>
    </Window2>
  );
}

const statusOf = (m: Measure): ReactNode =>
  m.kind === "ok" ? <Status s="ok" text="Measured" />
  : m.kind === "cut" ? <Status s="warn" text="Different cut" />
  : m.kind === "rate" ? <Status s="warn" text={`${m.from} → ${m.to} fps`} />
  : m.kind === "weak" ? <Status s="warn" text="Weak match" />
  : <Status s="bad" text="Failed" />;

/** Audio: the same header and sheet; the measurement is in the columns and a
 *  double-click opens the whole of it for that file. */
export function Audio2({ overlay }: { overlay?: ReactNode }) {
  const { go } = useProto();
  const [sel, setSel] = useState<number | null>(4);
  return (
    <Window2
      page="audio"
      cols="minmax(0,1fr)"
      overlay={overlay}
      status={{ icon: "warn", text: <><b>12 measured</b> · 4 to check</> }}
      tools={
        <>
          <Cmd icon={<ArrowImportRegular />}>Import from a video</Cmd>
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" />
          <Cmd icon={<CopyRegular />} title="Duplicate the track" />
          <Cmd icon={<DeleteRegular />} title="Remove (Del)" disabled={sel === null} />
        </>
      }
      primary={
        <>
          <Btn icon={<GaugeRegular />} title="Measure again">Measure</Btn>
          <Btn accent icon={<CheckmarkRegular />}>Apply 13 delays</Btn>
        </>
      }
    >
      <Panel
        left={
          <>
            <TrackTab n={1} kind="audio" lang="Hindi" on />
            <Cmd sm icon={<AddRegular />} title="New track" />
          </>
        }
        end={<><span className="t3">Against</span><Combo ghost sm value="1 · Korean · FLAC" w={148} /><Combo ghost sm value="All rows" w={96} /><SearchBox /></>}
        sheet={<TrackSheet kind="audio" lang="Hindi" dir={DUB_DIR} />}
      >
        <Table cols="24px minmax(0,1fr) minmax(0,1fr) 68px 56px 104px 148px" head={["#", "Video", "Audio file", " Delay", " Frames", "Confidence", "Status"]}>
          {DUBS.map((d, i) => {
            const m = d.m;
            const filled = m.kind === "ok" || m.kind === "rate";
            return (
              <Tr key={d.name} on={sel === i} onClick={() => setSel(i)} onDoubleClick={() => go("audio-file")}>
                <span className="num t3">{i + 1}</span>
                <span className="truncate t2">{VIDEOS[i].name}</span>
                <span className="cell"><Grip /><span className="truncate">{d.name}</span></span>
                <span className={cx("r num", !filled && "t3")} style={{ display: "flex", color: filled ? "var(--accent-text)" : undefined }}>{filled && "delay" in m ? m.delay : "0.000"}</span>
                <span className="r num t2" style={{ display: "flex" }}>{m.kind === "ok" ? `+${m.frames}` : <Dash />}</span>
                {"conf" in m ? <span className="cell num t2"><Meter pct={m.conf} />{m.conf}%</span> : <Dash />}
                {statusOf(m)}
              </Tr>
            );
          })}
        </Table>
      </Panel>
    </Window2>
  );
}

/** A double-click on an audio row: the measurement in full, the reason
 *  behind a warning and what to do, then the file's own streams. */
export function AudioFile() {
  const { go } = useProto();
  const d = DUBS[4];
  return (
    <Audio2
      overlay={
        <div className="smoke">
          <div className="dialog xl" role="dialog" aria-label="Audio file">
            <div className="dh">
              <div className="grow col" style={{ minWidth: 0 }}>
                <div className="dt truncate">{d.name}</div>
                <div className="ds truncate">Row 5 · with {VIDEOS[4].name} · {d.size}</div>
              </div>
              <Cmd icon={<DismissRegular />} title="Close (Esc)" onClick={() => go("audio")} />
            </div>
            <div className="db compact" style={{ overflow: "auto", padding: 0, borderTop: "1px solid var(--divider)" }}>
              <div className="sect">Measurement</div>
              <div className="meas">
                <div>
                  <div className="t3">Delay</div>
                  <div className="big">+1.312<small>s</small></div>
                  <div className="warn">Different cut · not filled in</div>
                </div>
                <DL
                  rows={[
                    ["Against", <Combo key="a" sm value="1 · Korean · FLAC" w={200} />],
                    ["Confidence", <span key="c" className="cell num"><Meter pct={58} />58%</span>],
                    ["Windows", "4 of 6 agree"],
                    ["Method", "Sample windows"],
                  ]}
                />
              </div>
              <div className="links" style={{ padding: "0 16px 12px" }}>
                <L icon={<CheckmarkRegular />}>Apply anyway</L>
                <L icon={<TimelineRegular />}>Timeline details</L>
                <L icon={<GaugeRegular />}>Measure again</L>
              </div>
              <div className="finding">
                <span className="warn" style={{ display: "grid", fontSize: 16 }}><WarningFilled /></span>
                <div className="col" style={{ gap: 6 }}>
                  <span><span className="warn">Different cut</span><span className="t2"> · The offset jumps by 12.480 s at 0:41:07. Not filled in.</span></span>
                  <span className="t2 sm">The delay before 0:41:07 is not the delay after it, so the two files do not hold the same material end to end: a scene added or removed, an extended cut against a theatrical one, or a recap only one of them has. No single delay and no stretch can align them.</span>
                  <span className="t2 sm"><span style={{ color: "var(--text)", fontWeight: 600 }}>What to do: </span>pair this audio with the release it was made for. If you have to keep this pairing, cut or pad the audio to match the video outside the app first.</span>
                </div>
              </div>
              <div className="sect">Streams in this file</div>
              <Table style={{ flex: "none" }} cols="24px 56px 64px minmax(0,1fr) 160px 88px" head={["#", "Copy", "Default", "Name", "Language", " Delay"]}>
                <Tr on>
                  <span className="num t3">1</span>
                  <Chk on />
                  <Chk on={false} />
                  <span className="truncate">E-AC3 · 5.1 · 640 kb/s</span>
                  <Combo ghost sm value="Hindi" w="100%" />
                  <span className="r num t2" style={{ display: "flex" }}>0.000</span>
                </Tr>
              </Table>
              <div style={{ height: 12 }} />
            </div>
            <div className="df">
              <span className="l"><Btn icon={<DeleteRegular />}>Remove from the list</Btn></span>
              <Btn onClick={() => go("audio")}>Cancel</Btn>
              <Btn accent onClick={() => go("audio")}>Apply</Btn>
            </div>
          </div>
        </div>
      }
    />
  );
}

/* ------------------------------------------------------ chapters, fonts */

export function Chapters2() {
  const [sel, setSel] = useState<number | null>(4);
  return (
    <Window2
      page="chapters"
      cols="minmax(0,1fr)"
      tools={
        <>
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" />
          <Cmd icon={<ArrowUpRegular />} title="Move up (Alt+↑)" disabled={sel === null} />
          <Cmd icon={<ArrowDownRegular />} title="Move down (Alt+↓)" disabled={sel === null} />
        </>
      }
    >
      <Panel
        left={<Title n="16 files · all linked">Chapters</Title>}
        end={<SearchBox />}
        sheet={
          <>
            <P label="Folder" wide><FolderField path={CHAP_DIR} /></P>
            <span className="checks span2">
              <label className="ck"><Toggle on />Add chapters from the files</label>
              <label className="ck"><Chk on={false} />Discard the videos' own</label>
            </span>
            <P label="Formats"><Combo value="All formats" w="100%" /></P>
            <P label="Delay for all" wide>
              <span className="row" style={{ gap: 8 }}>
                <TBox value="0.000" unit="s" mono w={120} />
                <Btn>Apply to every file</Btn>
              </span>
            </P>
          </>
        }
      >
        <Table cols="24px minmax(0,1fr) minmax(0,1fr) 64px 72px 96px" head={["#", "Chapter file", "Video", " Size", " Delay", "Linked"]}>
          {CHAPTERS.map((c, i) => (
            <Tr key={c.name} on={sel === i} onClick={() => setSel(i)}>
              <span className="num t3">{i + 1}</span>
              <span className="cell"><span className="t3" style={{ display: "grid", fontSize: 16 }}><BookmarkMultipleRegular /></span><span className="truncate">{c.name}</span></span>
              <Combo ghost sm value={VIDEOS[i].name} w="100%" />
              <span className="r num t2" style={{ display: "flex" }}>{c.size}</span>
              <span className="r num t2" style={{ display: "flex" }}>0.000</span>
              <span className="t3">By order</span>
            </Tr>
          ))}
        </Table>
      </Panel>
    </Window2>
  );
}

export function Attachments2() {
  const [sel, setSel] = useState<number | null>(1);
  return (
    <Window2
      page="attachments"
      cols="minmax(0,1fr)"
      tools={
        <>
          <Cmd icon={<AddRegular />}>Add files</Cmd>
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" />
          <Cmd icon={<DeleteRegular />} title="Remove (Del)" disabled={sel === null} />
        </>
      }
    >
      <Panel
        left={<Title n="4 files · 8.5 MB">Attachments</Title>}
        end={<SearchBox />}
        sheet={
          <>
            <P label="Folder" wide><FolderField path={FONT_DIR} /></P>
            <span className="checks span2">
              <label className="ck"><Toggle on />Add to every queued video</label>
              <label className="ck"><Chk on />Discard the videos' own</label>
            </span>
            <P label="Formats"><Combo value="All formats" w="100%" /></P>
            <P label="Order"><Combo value="Loaded order" w="100%" /></P>
            <span className="checks span2">
              <label className="ck"><Chk on={false} />Allow duplicate names</label>
              <label className="ck"><Chk on={false} />Expert mode</label>
            </span>
          </>
        }
      >
        <Table cols="24px minmax(0,1fr) 128px 72px minmax(0,1fr)" head={["#", "Name", "Type", " Size", "Folder"]}>
          {FONTS.map((f, i) => (
            <Tr key={f.name} on={sel === i} onClick={() => setSel(i)}>
              <span className="num t3">{i + 1}</span>
              <span className="cell"><span className="t3" style={{ display: "grid", fontSize: 16 }}>{f.type === "JPG" ? <ImageRegular /> : <TextFontRegular />}</span><span className="truncate">{f.name}</span></span>
              <span className="t2">{f.type === "JPG" ? "JPEG image" : f.type === "OTF" ? "OpenType font" : "TrueType font"}</span>
              <span className="r num t2" style={{ display: "flex" }}>{f.size}</span>
              <span className="truncate t3">{FONT_DIR}</span>
            </Tr>
          ))}
        </Table>
      </Panel>
    </Window2>
  );
}

/* ------------------------------------------------------------ edit tracks */

type Row = { name: string; lang: string; copy: boolean; def?: boolean; forced?: boolean; added?: boolean };
const SUB_ROWS: Row[] = [
  { name: "Full", lang: "English", copy: true, def: true },
  { name: "SDH", lang: "English", copy: false },
  { name: "Signs & Songs", lang: "English", copy: true, forced: true },
  { name: "Korean", lang: "Korean", copy: true },
  { name: "Goblin.S01E03.en.srt", lang: "English", copy: true, added: true },
];

/** Bigger, and quieter: the file on its own line, the kinds as tabs with
 *  their counts, the commands beside them, full column names, taller rows,
 *  and each row's remove button only on the row under the pointer. */
export function EditTracks2() {
  const { go } = useProto();
  const [sel, setSel] = useState(0);
  const v = VIDEOS[2];
  return (
    <Videos2
      overlay={
        <div className="smoke">
          <div className="dialog xl" role="dialog" aria-label="Edit tracks">
            <div className="dh">
              <div className="grow col" style={{ minWidth: 0 }}>
                <div className="dt">Edit tracks</div>
                <div className="ds truncate">{v.name} · {v.size} · {v.dur}</div>
              </div>
              <Cmd icon={<DismissRegular />} title="Close (Esc)" onClick={() => go("videos")} />
            </div>
            <div className="dbar">
              {(
                [
                  ["Video", 1],
                  ["Audio", 3],
                  ["Subtitles", 5],
                ] as const
              ).map(([t, n]) => (
                <button key={t} type="button" className={cx("tab", t === "Subtitles" && "on")}>
                  {t}
                  <span className="n">{n}</span>
                </button>
              ))}
              <span className="tools">
                <Cmd sm icon={<AddRegular />}>Add a subtitle file…</Cmd>
                <Cmd sm icon={<ArrowImportRegular />}>Import from a video…</Cmd>
                <span className="vsep" />
                <Cmd sm icon={<ArrowUpRegular />} title="Move up (Alt+↑)" />
                <Cmd sm icon={<ArrowDownRegular />} title="Move down (Alt+↓)" />
              </span>
            </div>
            <div className="db">
              <Table
                cols="16px 24px 64px 72px 68px minmax(0,1fr) 200px 28px"
                head={[
                  "",
                  "#",
                  <span key="c" className="row" style={{ gap: 8 }}><Chk on={false} />Copy</span>,
                  <span key="d" className="row" style={{ gap: 8 }}><Chk on={false} />Default</span>,
                  <span key="f" className="row" style={{ gap: 8 }}><Chk on={false} />Forced</span>,
                  "Name",
                  "Language",
                  "",
                ]}
              >
                {SUB_ROWS.map((r, i) => (
                  <Tr key={r.name} on={sel === i} onClick={() => setSel(i)}>
                    <Grip />
                    <span className="num t3">{i + 1}</span>
                    <Chk on={r.copy} />
                    <span style={{ opacity: r.copy ? 1 : 0.4 }}><Chk on={!!r.def && r.copy} /></span>
                    <span style={{ opacity: r.copy ? 1 : 0.4 }}><Chk on={!!r.forced && r.copy} /></span>
                    <span className="cell">
                      <span className={cx("truncate", !r.copy && "t3")}>{r.name}</span>
                      {r.added && <span className="t3 sm">Added</span>}
                    </span>
                    <Combo ghost sm value={r.lang} w="100%" />
                    <span className="rx"><Cmd sm icon={<DismissRegular />} title="Remove from the list" /></span>
                  </Tr>
                ))}
              </Table>
            </div>
            <div className="df">
              <span className="l"><Btn>Reset</Btn></span>
              <Btn onClick={() => go("videos")}>Cancel</Btn>
              <Btn accent onClick={() => go("videos")}>Apply</Btn>
            </div>
          </div>
        </div>
      }
    />
  );
}

export function Prefs2() {
  return <Videos2 overlay={<PrefsWindow tab="general" />} />;
}

/* -------------------------------------------------------------------- mux */

/** Where the files go, always in the toolbar's middle: the folder and the
 *  name they get. A click opens its controls. */
function SaveToBox({ on }: { on?: boolean }) {
  const { go } = useProto();
  return (
    <span className="destw">
      <button type="button" className={cx("dest", on && "on")} onClick={() => go(on ? "mux" : "mux-edit")} title="Change where the files go">
        <span className="ic"><FolderRegular /></span>
        <span className="truncate">{OUT_DIR}</span>
        <span className="t3 truncate">\{"{original_filename}"}.mkv</span>
        <span className="ch"><ChevronDownRegular /></span>
      </button>
      <button type="button" className="destb" title="Choose the folder" aria-label="Choose the folder"><FolderOpenRegular /></button>
    </span>
  );
}

/** The Save to controls, under the box. */
function SaveTo() {
  return (
    <div className="fly setfly" style={{ top: 82, left: 367 }}>
      <div className="fh"><span className="strong">Save to</span></div>
      <Fld label="Folder"><FolderField path={OUT_DIR} /></Fld>
      <Fld label="File name">
        <span className="row" style={{ gap: 4, minWidth: 0 }}>
          <span className="grow" style={{ minWidth: 0 }}><TBox mono value="{original_filename}" unit=".mkv" /></span>
          <Cmd icon={<BracesRegular />} title="Insert a field: episode, show, language…" />
        </span>
        <span className="sm t3 truncate">Goblin.S01E01.1080p.BluRay.x264-HDEX.mkv</span>
      </Fld>
      <label className="ck"><Toggle on={false} />Overwrite the source when no folder is set</label>
    </div>
  );
}

/** Everything else about the mux, out of sight until Options opens it. */
function MuxOptions() {
  return (
    <div className="fly setfly wide" style={{ top: 82, left: 104 }}>
      <div className="fh"><span className="strong">Audio</span></div>
      <div className="fgrid">
        <Fld label="Keep"><Combo value="All languages" w="100%" /></Fld>
        <Fld label="Default"><Combo value="Hindi" w="100%" /></Fld>
      </div>
      <div className="fh"><span className="strong">Subtitles</span></div>
      <div className="fgrid">
        <Fld label="Keep"><Combo value="All languages" w="100%" /></Fld>
        <Fld label="Default"><Combo value="No change" w="100%" /></Fld>
      </div>
      <div className="fh"><span className="strong">Remove from the source</span></div>
      <div className="row" style={{ gap: 28 }}>
        <label className="ck"><Toggle on={false} />Chapters</label>
        <label className="ck"><Toggle on />Attachments</label>
        <label className="ck"><Toggle on />Global tags</label>
      </div>
      <div className="fh"><span className="strong">Run</span></div>
      <div className="fgrid">
        <Fld label="Jobs at once"><Combo value="4" w="100%" /></Fld>
        <span />
        <label className="ck"><Chk on={false} />Edit in place when possible</label>
        <label className="ck"><Chk on />Keep a log file</label>
        <label className="ck"><Chk on={false} />Stop at the first error</label>
        <label className="ck"><Chk on={false} />Write a CRC checksum</label>
        <span />
        <label className="ck"><Chk on={false} />Remove old CRC tags</label>
      </div>
    </div>
  );
}

/** What each job adds, at a glance. E13's dub has no audio stream. */
function Adds({ i }: { i: number }) {
  const miss = i === 12;
  return (
    <span className="adds">
      <span className={miss ? "miss" : undefined} title={miss ? "The dub has no audio stream" : "1 audio file"}><span className="ic"><MusicNote2Regular /></span>{miss ? 0 : 1}</span>
      <span title="1 subtitle file"><span className="ic"><ClosedCaptionRegular /></span>1</span>
      <span title="Chapters from a file"><span className="ic"><BookmarkMultipleRegular /></span>1</span>
      <span title="4 attachments"><span className="ic"><AttachRegular /></span>4</span>
    </span>
  );
}

export function Mux2({ phase, overlay, sel: first = null, open }: { phase: "ready" | "running"; overlay?: ReactNode; sel?: number | null; open?: "save" | "options" }) {
  const { go } = useProto();
  const [sel, setSel] = useState<number | null>(first);
  const p = useProgress(38, 120000, 37);
  const running = phase === "running";
  const done = Math.floor((p / 100) * 16);
  const pill: StatusProps | undefined = running ? { icon: "run", text: <><b>Muxing {done + 1} of 16</b> · 6 min left</>, pct: p } : undefined;
  const status = (i: number) => {
    if (!running) return <Status s="wait" text="Queued" />;
    if (i < done) return <Status s="ok" />;
    if (i < done + 4) return <Status s="run" pct={Math.min(96, Math.max(4, 88 - (i - done) * 24))} />;
    return <Status s="wait" text="Queued" />;
  };
  return (
    <Window2
      page="mux"
      status={pill}
      cols="minmax(0,1fr)"
      overlay={overlay ?? (open === "save" ? <SaveTo /> : open === "options" ? <MuxOptions /> : undefined)}
      center={<SaveToBox on={open === "save"} />}
      outputDot={running}
      busy={running ? "mux" : undefined}
      tools={
        <>
          <Cmd icon={<CheckmarkStarburstRegular />} disabled={running}>Validate</Cmd>
          <button type="button" className={cx("cmd", open === "options" && "on")} disabled={running} onClick={() => go(open === "options" ? "mux" : "mux-options")}>
            <span className="ic"><OptionsRegular /></span>
            <span className="lbl">Options</span>
          </button>
        </>
      }
      primary={
        running ? (
          <>
            <Btn icon={<PauseRegular />}>Pause</Btn>
            <Btn icon={<StopRegular />} kbd="Esc" onClick={() => go("mux")}>Stop</Btn>
          </>
        ) : (
          <>
            <Btn icon={<DeleteRegular />} title="Clear the queue" style={{ padding: "0 10px" }} />
            <Btn accent icon={<PlayRegular />} kbd="Enter" onClick={() => go("mux-running")}>Start muxing</Btn>
          </>
        )
      }
    >
      <Panel left={<Title n="16 videos · 64.8 GB">Queue</Title>} end={<SearchBox />}>
        <Table cols="24px minmax(0,1fr) 132px 72px 72px 150px 52px" head={["#", "Name", "Adds", " Before", " After", "Status", " Left"]}>
          {VIDEOS.map((v, i) => (
            <Tr key={v.name} on={sel === i} onClick={() => setSel(i)} onDoubleClick={() => go("mux-job")}>
              <span className="num t3">{i + 1}</span>
              <Name tail={40}>{v.name}</Name>
              <Adds i={i} />
              <span className="r num t2" style={{ display: "flex" }}>{v.size}</span>
              <span className="r num t2" style={{ display: "flex" }}>{running && i < done ? `${(v.gb * 1.07).toFixed(2)} GB` : <Dash />}</span>
              {status(i)}
              <span className="r num t2" style={{ display: "flex" }}>{running && i >= done && i < done + 4 ? `${1 + (i % 3)} min` : <Dash />}</span>
            </Tr>
          ))}
        </Table>
      </Panel>
    </Window2>
  );
}

/* ------------------------------------------------------------ job details */

type Out = { k: ReactNode; lang: string; trk: string; from: string; flags?: string; delay?: string; added?: boolean; gone?: boolean };
const OUT_TRACKS: Out[] = [
  { k: <VideoClipRegular />, lang: "—", trk: "AVC · 1920×1080", from: "Source", flags: "Default" },
  { k: <MusicNote2Regular />, lang: "Korean", trk: "FLAC · Stereo", from: "Source", flags: "Default" },
  { k: <MusicNote2Regular />, lang: "Korean", trk: "AC-3 · Surround 5.1", from: "Source" },
  { k: <MusicNote2Regular />, lang: "Hindi", trk: "E-AC3 · 5.1", from: "Goblin.S01E04.Hindi.DDP5.1.eac3", delay: "+1.312 s", added: true },
  { k: <ClosedCaptionRegular />, lang: "English", trk: "SRT · Full", from: "Goblin.S01E04.en.srt", flags: "Default", added: true },
  { k: <ClosedCaptionRegular />, lang: "Korean", trk: "ASS", from: "Source" },
  { k: <ClosedCaptionRegular />, lang: "English", trk: "SRT · SDH", from: "Source", flags: "Removed", gone: true },
];

/** A double-click on a job: everything the old Report showed, in a popup. */
export function JobDetails() {
  const { go } = useProto();
  const [showGone, setShowGone] = useState(false);
  const v = VIDEOS[3];
  return (
    <Mux2
      phase="ready"
      sel={3}
      overlay={
        <div className="smoke">
          <div className="dialog xl" role="dialog" aria-label="Job details">
            <div className="dh">
              <div className="grow col" style={{ minWidth: 0 }}>
                <div className="dt truncate">{v.name}</div>
                <div className="ds">Job 4 of 16 · Queued · {v.size}</div>
              </div>
              <Cmd icon={<DismissRegular />} title="Close (Esc)" onClick={() => go("mux")} />
            </div>
            <div className="db compact" style={{ overflow: "auto", padding: 0, borderTop: "1px solid var(--divider)" }}>
              <div style={{ padding: "12px 16px 0" }}>
                <InfoBar tone="warn">2 warnings · the subtitle ends 4.2 s after the video · Audio 3 has a delay above 1 s</InfoBar>
              </div>
              <div className="sect row" style={{ gap: 8 }}>
                Tracks in the new file <span className="t3">· 6 kept or added</span>
                <button type="button" className="drop" aria-expanded={showGone} onClick={() => setShowGone(!showGone)}>
                  1 removed
                  <span className="ic">{showGone ? <ChevronUpRegular /> : <ChevronDownRegular />}</span>
                </button>
              </div>
              <Table style={{ flex: "none" }} cols="20px 18px 76px minmax(0,.8fr) minmax(0,1.3fr) 72px 64px" head={["#", "", "Language", "Track", "From", "Flags", " Delay"]}>
                {OUT_TRACKS.filter((t) => showGone || !t.gone).map((t, i) => (
                  <Tr key={i}>
                    <span className="num t3">{t.gone ? "" : i + 1}</span>
                    <span className="t3" style={{ display: "grid", fontSize: 16 }}>{t.k}</span>
                    <span className={cx(t.gone && "t3 strike")}>{t.lang}</span>
                    <span className={cx("truncate", t.gone && "t3 strike")}>{t.trk}</span>
                    <span className={cx("truncate", t.added ? undefined : "t3")}>{t.from}{t.added && <span className="t3"> · added</span>}</span>
                    <span className={t.gone ? "t3" : "t2"}>{t.flags ?? ""}</span>
                    <span className="r num t2" style={{ display: "flex" }}>{t.delay ?? ""}</span>
                  </Tr>
                ))}
              </Table>
              <div className="sect">Also</div>
              <div className="also">
                <span className="k">Chapters</span><span>Replaced with Goblin.S01E04.chapters.xml</span>
                <span className="k">Attachments</span><span>4 fonts added · the old ones removed</span>
                <span className="k">Global tags</span><span>Removed</span>
                <span className="k">Into</span><span className="truncate">{OUT_DIR}\{v.name}</span>
              </div>
              <div className="sect">Command</div>
              <pre className="cmdline">mkvmerge --output "{OUT_DIR}\{v.name}" --subtitle-tracks 3,5 --no-attachments --no-global-tags "{SHOW_DIR}\{v.name}" --language 0:hin --sync 0:1312 "D:\Dubs\Goblin Hindi\Goblin.S01E04.Hindi.DDP5.1.eac3" --language 0:eng --default-track-flag 0:yes "D:\Subs\Goblin\Goblin.S01E04.en.srt" --chapters "D:\Shows\Goblin (2016)\Chapters\Goblin.S01E04.chapters.xml"</pre>
            </div>
            <div className="df">
              <span className="l"><Btn icon={<CopyRegular />}>Copy command</Btn></span>
              <Btn accent onClick={() => go("mux")}>Close</Btn>
            </div>
          </div>
        </div>
      }
    />
  );
}
