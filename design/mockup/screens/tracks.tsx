import {
  AddRegular,
  ArrowImportRegular,
  ArrowSyncRegular,
  CheckmarkRegular,
  ChevronDownRegular,
  ChevronUpRegular,
  ClosedCaptionRegular,
  CopyRegular,
  DeleteRegular,
  DocumentRegular,
  EditRegular,
  FolderOpenRegular,
  GaugeRegular,
  MusicNote2Regular,
  StopRegular,
  TimelineRegular,
} from "@fluentui/react-icons";
import type { ReactNode } from "react";

import { DUB_DIR, DUBS, SUB_DIR, SUBS, VIDEOS, type Dub } from "../data";
import { Btn, Chk, Cmd, Combo, DL, Empty, Fld, Grip, Meter, MidText, Status, TBox, TRow, Table, Toggle, Tr, type St } from "../kit";
import { AutoGo, Box, Dialog, Window, useProgress, useProto, type LcdProps } from "../shell";
import { Dash, L, Links, QueueBtn, SearchBox } from "./common";

/* ------------------------------ shared ------------------------------ */

function Strip({ kind, slot = 1 }: { kind: "audio" | "subs"; slot?: number }) {
  const icon = kind === "audio" ? <MusicNote2Regular /> : <ClosedCaptionRegular />;
  const name = kind === "audio" ? "Audio" : "Subtitle";
  const slots = kind === "audio" ? ["Hindi", "English"] : ["English"];
  return (
    <>
      {slots.map((lang, i) => (
        <button key={lang} type="button" className={i + 1 === slot ? "tool on" : "tool"}>
          <span className="ic">{icon}</span>
          {name} {i + 1}<span className="t3">· {lang}</span>
        </button>
      ))}
      <button type="button" className="tool"><span className="ic"><AddRegular /></span>New track</button>
      <span className="end">
        <Cmd sm icon={<CopyRegular />} title={`Duplicate ${name} ${slot}`} />
        <Cmd sm icon={<DeleteRegular />} title={`Delete ${name} ${slot}`} />
      </span>
    </>
  );
}

/** The slot's settings: what every file in it is muxed with. */
function SlotSettings({ kind, slot = 1, lang = "Hindi" }: { kind: "audio" | "subs"; slot?: number; lang?: string }) {
  return (
    <Box title={`${kind === "audio" ? "Audio" : "Subtitle"} ${slot}`}>
      <div className="fgrid">
        <Fld label="Language"><Combo value={lang} w="100%" /></Fld>
        <Fld label="Delay"><TBox value="0.000" unit="s" mono /></Fld>
        <Fld label="Track name"><TBox ph="Keep the file's name" /></Fld>
        <Fld label="Place after"><Combo value={kind === "audio" ? "Video" : "After audio tracks"} w="100%" /></Fld>
      </div>
      <span className="row" style={{ gap: 20 }}>
        <span className="cell"><Chk on={kind === "subs"} />Default</span>
        {kind === "subs" && <span className="cell"><Chk on={false} />Forced</span>}
      </span>
    </Box>
  );
}

/* ================================ AUDIO ================================ */

export type APhase = "empty" | "ready" | "unlinked" | "measuring" | "measured" | "applied" | "engine";

/** A file past the last video: the unlinked case. */
const EXTRA: Dub = { name: "Goblin.S01E16.5.Special.Hindi.DDP5.1.eac3", size: "88 MB", m: { kind: "fail", err: "" } };

const statusOf = (d: Dub, applied: boolean): [St, string] => {
  const m = d.m;
  if (m.kind === "ok") return ["ok", applied ? "Applied" : "Measured"];
  if (m.kind === "cut") return ["warn", "Different cut"];
  if (m.kind === "rate") return ["warn", `${m.from} → ${m.to} fps`];
  if (m.kind === "weak") return ["warn", `Weak match`];
  return ["bad", "Failed"];
};

function Measured({ d, i }: { d: Dub; i: number }) {
  const { go } = useProto();
  const m = d.m;
  if (m.kind === "fail")
    return (
      <>
        <div><div className="t3">Result</div><div className="big bad">Failed</div><div className="t2">{m.err}.</div></div>
        <DL rows={[["Video", <MidText key="v" text={VIDEOS[i].name} tail={14} />], ["Format", "E-AC3 · 5.1"]]} />
        <Links>
          <L icon={<GaugeRegular />}>Measure again</L>
          <L icon={<EditRegular />} onClick={() => go("audio-edit")}>Edit…</L>
          <L icon={<DeleteRegular />}>Remove</L>
        </Links>
      </>
    );
  const note =
    m.kind === "cut" ? <div className="warn">Different cut · a scene is missing near {m.at}</div>
    : m.kind === "rate" ? <div className="warn">Mastered at {m.from} fps · the video plays at {m.to}</div>
    : m.kind === "weak" ? <div className="warn">Weak match · not filled in</div>
    : <div className="t2">{m.frames} frames · constant · not applied yet</div>;
  return (
    <>
      <div>
        <div className="t3">Delay</div>
        <div className="big">{m.delay}<small>s</small></div>
        {note}
      </div>
      {m.kind === "rate" && (
        <TRow label="Correct the frame rate" d="Stretches the dub by 1001/960 as it muxes">
          <Toggle on />
        </TRow>
      )}
      <Links>
        {m.kind === "ok" || m.kind === "rate" ? <L icon={<CheckmarkRegular />}>Apply</L> : <L icon={<CheckmarkRegular />}>Apply anyway</L>}
        {m.kind === "cut" && <L icon={<TimelineRegular />}>Timeline details</L>}
        <L icon={<GaugeRegular />}>Measure again</L>
        <L icon={<EditRegular />} onClick={() => go("audio-edit")}>Edit…</L>
      </Links>
      <DL
        rows={[
          ["Against", <Combo key="r" sm value="1 · Korean · FLAC" w="100%" />],
          ["Confidence", <span key="c" className="cell num"><Meter pct={m.conf} />{m.conf}%</span>],
          ["Windows", m.kind === "cut" ? "4 of 6" : "6 of 6"],
          ["Frames", m.kind === "ok" ? `${m.frames} at 23.976 fps` : "—"],
        ]}
      />
    </>
  );
}

function AudioDetails({ phase, sel }: { phase: APhase; sel: number | null }) {
  const { go } = useProto();
  if (sel === null)
    return (
      <Box title="Audio 1 files">
        <DL rows={[["Folder", <span key="f" className="truncate" title={DUB_DIR}>{DUB_DIR}</span>], ["Files", phase === "unlinked" ? "17 · E-AC3" : "16 · E-AC3"], ["Paired", phase === "unlinked" ? "16 of 17" : "16 of 16"], ["Measured", phase === "measured" || phase === "applied" ? "15 of 16" : "None yet"]]} />
      </Box>
    );
  const d = DUBS[sel] ?? EXTRA;
  const measured = phase === "measured" || phase === "applied";
  if (!VIDEOS[sel])
    return (
      <Box title={<MidText text={d.name} tail={16} />}>
        <div><div className="t3">Video</div><div className="big warn">None</div><div className="t2">Row {sel + 1} is past the last video, so this file is not muxed.</div></div>
        <DL rows={[["Format", "E-AC3 · 5.1"], ["Size", d.size]]} />
        <Links>
          <L icon={<DeleteRegular />}>Remove</L>
        </Links>
      </Box>
    );
  return (
    <Box title={<MidText text={d.name} tail={16} />}>
      {measured ? (
        <Measured d={d} i={sel} />
      ) : (
        <>
          <DL rows={[["Video", <MidText key="v" text={VIDEOS[sel].name} tail={20} />], ["Format", "E-AC3 · 5.1 · 640 kb/s"], ["Size", d.size], ["Duration", VIDEOS[sel].dur], ["Delay", "0.000 s"]]} />
          <Links>
            <L icon={<GaugeRegular />}>Measure</L>
            <L icon={<EditRegular />} onClick={() => go("audio-edit")}>Edit…</L>
            <L icon={<CopyRegular />}>Duplicate</L>
            <L icon={<DeleteRegular />}>Remove</L>
          </Links>
        </>
      )}
    </Box>
  );
}

export function Audio({ phase, sel = null, overlay }: { phase: APhase; sel?: number | null; overlay?: ReactNode }) {
  const { go } = useProto();
  const p = useProgress(41, 5200);
  const has = phase !== "empty";
  const measured = phase === "measured" || phase === "applied";
  const n = Math.min(16, Math.floor((p / 100) * 16));
  const rows = phase === "unlinked" ? 17 : 16;

  const lcd: LcdProps =
    phase === "empty"
      ? { l1: "Drop a folder of audio files for Audio 1" }
      : phase === "engine"
        ? { icon: "warn", l1: "The audio analysis engine is missing", l2: "Measuring needs it · Preferences › Tools" }
        : phase === "unlinked"
          ? { icon: "warn", l1: "1 audio file has no video", l2: "Row 17 is past the last video" }
          : phase === "measuring"
            ? { icon: "run", l1: `Measuring ${Math.max(1, n)} of 16`, l2: DUBS[Math.min(15, n)].name, pct: p, time: `${Math.max(1, Math.round((100 - p) / 40))} min left` }
            : phase === "measured"
              ? { icon: "warn", l1: "12 measured · 4 to check", l2: "1 different cut · 1 frame rate · 1 weak match · 1 failed", time: "13 to apply" }
              : phase === "applied"
                ? { icon: "ok", l1: "13 delays applied", l2: "E05, E11 and E13 keep 0.000 s" }
                : { l1: "16 audio files · 16 paired", l2: "Audio 1 · Hindi · after the video" };

  return (
    <Window
      page="audio"
      lcd={lcd}
      overlay={overlay}
      flags={phase === "unlinked" ? ["audio", "mux"] : []}
      strip={<Strip kind="audio" />}
      tools={
        <>
          <Cmd icon={<FolderOpenRegular />} disabled={phase === "measuring"} onClick={() => go("audio-ready")}>Choose folder</Cmd>
          <Cmd icon={<ArrowImportRegular />} title="Import from a video" disabled={phase === "measuring"} onClick={() => go("audio-import")} />
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" disabled={!has || phase === "measuring"} />
          <Cmd icon={<CopyRegular />} title="Duplicate the file" disabled={sel === null || phase === "measuring"} />
          <Cmd icon={<DeleteRegular />} title="Remove (Del)" disabled={sel === null || phase === "measuring"} />
        </>
      }
      primary={
        phase === "measuring" ? (
          <Btn icon={<StopRegular />} kbd="Esc" onClick={() => go("audio-measured")}>Stop</Btn>
        ) : phase === "measured" ? (
          <>
            <Btn icon={<ArrowSyncRegular />} title="Measure every file again" onClick={() => go("audio-measuring")} />
            <Btn accent icon={<CheckmarkRegular />} onClick={() => go("audio-applied")}>Apply 13 delays</Btn>
          </>
        ) : phase === "applied" ? (
          <>
            <Btn icon={<ArrowSyncRegular />} title="Measure every file again" onClick={() => go("audio-measuring")} />
            <QueueBtn />
          </>
        ) : (
          <Btn accent icon={<GaugeRegular />} kbd="Enter" disabled={!has || phase === "engine"} onClick={() => go("audio-measuring")}>Measure delays</Btn>
        )
      }
    >
      {has ? (
        <>
          <Box
            body={false}
            title="Audio 1"
            sub={<span title={DUB_DIR}>{DUB_DIR}</span>}
            end={
              <>
                <Combo ghost sm value="All formats" w={104} />
                <Combo ghost sm value="All rows" w={96} />
                <Cmd sm icon={<ChevronUpRegular />} title="Move up (Alt+↑)" disabled={sel === null} />
                <Cmd sm icon={<ChevronDownRegular />} title="Move down (Alt+↓)" disabled={sel === null} />
                <SearchBox w={150} />
              </>
            }
          >
            <Table cols="24px minmax(0,1fr) minmax(0,1fr) 72px 136px" head={["#", "Video", "Audio file", " Delay", "Status"]}>
              {Array.from({ length: rows }, (_, i) => {
                const d = DUBS[i] ?? EXTRA;
                const v = VIDEOS[i];
                const done = phase === "measuring" ? i < n : measured;
                const running = phase === "measuring" && i >= n && i < n + 4;
                const [s, text] = statusOf(d, phase === "applied");
                const delay = "delay" in d.m ? d.m.delay : null;
                const pendingDelay = done && delay && phase !== "applied" && (d.m.kind === "ok" || d.m.kind === "rate");
                return (
                  <Tr key={i} on={i === sel} onClick={() => go(measured ? (i === 8 ? "audio-rate" : i === 4 ? "audio-cut" : "audio-measured") : "audio-one")}>
                    <span className="num t3">{i + 1}</span>
                    {v ? <span className="t2 truncate">{v.name}</span> : <span className="warn">No video</span>}
                    <span className="cell"><Grip /><span className="truncate">{d.name}</span></span>
                    <span className={pendingDelay ? "r num acc" : "r num t2"} style={{ display: "flex" }}>
                      {done && delay && d.m.kind !== "weak" && !(phase === "applied" && d.m.kind === "cut") ? delay : phase === "applied" || !done ? "0.000" : <Dash />}
                    </span>
                    {!v ? <Status s="warn" text="No video" />
                      : phase === "measuring" ? (done ? <Status s={s} text={text} /> : running ? <Status s="run" pct={Math.min(96, 8 + (p - i * 5) * 3)} /> : <Status s="wait" />)
                      : measured ? <Status s={s} text={text} />
                      : <Status s="ready" />}
                  </Tr>
                );
              })}
            </Table>
          </Box>
          <div className="stack">
            <SlotSettings kind="audio" />
            <AudioDetails phase={phase} sel={sel} />
          </div>
          {phase === "measuring" && <AutoGo to="audio-measured" ms={5400} />}
        </>
      ) : (
        <>
          <section className="box">
            <Empty icon={<MusicNote2Regular />} title="Drop a folder of audio files">
              <Btn icon={<FolderOpenRegular />} onClick={() => go("audio-ready")}>Choose folder</Btn>
              <Btn icon={<ArrowImportRegular />} onClick={() => go("audio-import")}>Import from a video</Btn>
            </Empty>
          </section>
          <div className="stack">
            <SlotSettings kind="audio" />
          </div>
        </>
      )}
    </Window>
  );
}

/* ------------------------------- dialogs ------------------------------- */

export function AudioEdit() {
  const { go } = useProto();
  return (
    <Audio
      phase="ready"
      sel={2}
      overlay={
        <Dialog
          size="mid"
          title="Edit audio file"
          sub={<MidText text={DUBS[2].name} tail={30} />}
          foot={
            <>
              <Btn onClick={() => go("audio-one")}>Cancel</Btn>
              <Btn accent onClick={() => go("audio-one")}>Save</Btn>
            </>
          }
        >
          <div className="fgrid">
            <Fld label="Language"><Combo value="Hindi" w="100%" /></Fld>
            <Fld label="Track name"><TBox ph="Keep the file's name" /></Fld>
            <Fld label="Delay"><TBox value="0.000" unit="s" mono /></Fld>
            <Fld label="Place after"><Combo value="Video" w="100%" /></Fld>
          </div>
          <div className="col" style={{ gap: 4 }}>
            <TRow label="Default audio" d="The first included track becomes the default"><Toggle on={false} /></TRow>
            <TRow label="Use this delay for every file"><Toggle on={false} /></TRow>
            <TRow label="Use every setting for every file" d="Track choices apply by position"><Toggle on={false} /></TRow>
          </div>
          <div className="frame">
            <div className="dtabs">
              <span className="tab on">Tracks in this file</span>
              <span className="tools">
                <Cmd sm icon={<TimelineRegular />} onClick={() => go("audio-delays")}>Track delays…</Cmd>
                <Cmd sm icon={<CheckmarkRegular />}>All</Cmd>
                <Cmd sm icon={<DeleteRegular />}>None</Cmd>
              </span>
            </div>
            <div className="box-b" style={{ gap: 0, padding: "4px 12px 8px 16px" }}>
              {[["1", "Hindi · E-AC3 · 5.1", true, "Default"], ["2", "Hindi · AAC · Stereo", false, ""]].map(([id, label, on, fl]) => (
                <div key={id as string} className="trk">
                  <Chk on={on as boolean} />
                  <span className="num t3" style={{ width: 14 }}>{id}</span>
                  <span className="grow truncate">{label}</span>
                  <span className="fl">{fl}</span>
                  <Cmd sm icon={<EditRegular />} title="Language, name and delay" />
                </div>
              ))}
            </div>
          </div>
        </Dialog>
      }
    />
  );
}

export function TrackDelays() {
  const { go } = useProto();
  return (
    <Audio
      phase="ready"
      sel={2}
      overlay={
        <Dialog
          size="mid"
          title="Track delays"
          sub={<MidText text={DUBS[2].name} tail={30} />}
          foot={
            <>
              <Btn onClick={() => go("audio-edit")}>Cancel</Btn>
              <Btn accent onClick={() => go("audio-edit")}>Save</Btn>
            </>
          }
        >
          <div className="row" style={{ gap: 8 }}>
            <TBox value="0.000" unit="s" mono w={140} />
            <Btn>Set for every track</Btn>
          </div>
          <div className="col">
            {[["1", "Hindi · E-AC3 · 5.1", "Included", "+1.312"], ["2", "Hindi · AAC · Stereo", "Not included", "0.000"]].map(([id, label, inc, d]) => (
              <div key={id} className="trow" style={{ minHeight: 44 }}>
                <span className="grow"><div>{id} · {label}</div><div className="d">ID {id} · {inc}</div></span>
                <TBox value={d} unit="s" mono w={120} />
              </div>
            ))}
          </div>
        </Dialog>
      }
    />
  );
}

export function ImportStreams({ kind = "audio" }: { kind?: "audio" | "subs" }) {
  const { go } = useProto();
  const back = kind === "audio" ? "audio-ready" : "subs-ready";
  const streams = kind === "audio"
    ? [["1", "Korean · FLAC · Stereo", true, ""], ["2", "Korean · AC-3 · Surround 5.1", true, "+0.040 s"]]
    : [["1", "English · SRT · Full", true, ""], ["2", "English · SRT · SDH", false, ""], ["3", "Korean · ASS", false, ""]];
  const dialog = (
    <Dialog
      size="mid"
      title={kind === "audio" ? "Import audio from a video" : "Import subtitles from a video"}
      sub="Into row 3, beside Goblin.S01E03"
      foot={
        <>
          <Btn onClick={() => go(back)}>Cancel</Btn>
          <Btn accent onClick={() => go(back)}>Import 2</Btn>
        </>
      }
    >
      <Fld label="From"><Combo value={VIDEOS[2].name} w="100%" /></Fld>
      <div className="frame">
        <div className="dtabs">
          <span className="tab on">{kind === "audio" ? "Audio streams" : "Subtitle streams"}</span>
        </div>
        <div className="box-b" style={{ gap: 0, padding: "4px 12px 8px 16px" }}>
          {streams.map(([id, label, on, delay]) => (
            <div key={id as string} className="trk">
              <Chk on={on as boolean} />
              <span className="num t3" style={{ width: 14 }}>{id}</span>
              <span className="grow truncate">{label}</span>
              {delay && <span className="num acc sm">{delay}</span>}
              <Cmd sm icon={<EditRegular />} title="Language, name and delay" />
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
  return kind === "audio" ? <Audio phase="ready" sel={2} overlay={dialog} /> : <Subtitles phase="one" overlay={dialog} />;
}

export function DeleteSlot() {
  const { go } = useProto();
  return (
    <Audio
      phase="ready"
      overlay={
        <div className="smoke">
          <div className="dialog">
            <div className="db">
              <div className="dt">Delete Audio 2?</div>
              <div className="t2">Its settings go, and none of its files are muxed.</div>
            </div>
            <div className="df">
              <Btn accent onClick={() => go("audio-ready")}>Delete</Btn>
              <Btn onClick={() => go("audio-ready")}>Cancel</Btn>
            </div>
          </div>
        </div>
      }
    />
  );
}

/* ============================== SUBTITLES ============================== */

export type SPhase = "empty" | "ready" | "one";

export function Subtitles({ phase, overlay }: { phase: SPhase; overlay?: ReactNode }) {
  const { go } = useProto();
  const has = phase !== "empty";
  const sel = phase === "one" ? 2 : null;
  return (
    <Window
      page="subtitles"
      lcd={has ? { l1: "16 subtitle files · 16 paired", l2: "Subtitle 1 · English · default · after the audio" } : { l1: "Drop a folder of subtitles for Subtitle 1" }}
      overlay={overlay}
      strip={<Strip kind="subs" />}
      tools={
        <>
          <Cmd icon={<FolderOpenRegular />} onClick={() => go("subs-ready")}>Choose folder</Cmd>
          <Cmd icon={<ArrowImportRegular />} title="Import from a video" onClick={() => go("subs-import")} />
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" disabled={!has} />
          <Cmd icon={<CopyRegular />} title="Duplicate the file" disabled={sel === null} />
          <Cmd icon={<DeleteRegular />} title="Remove (Del)" disabled={sel === null} />
        </>
      }
      primary={<QueueBtn disabled={!has} />}
    >
      {has ? (
        <Box
          body={false}
          title="Subtitle 1"
          sub={<span title={SUB_DIR}>{SUB_DIR}</span>}
          end={
            <>
              <Combo ghost sm value="All formats" w={104} />
              <Combo ghost sm value="All rows" w={96} />
              <Cmd sm icon={<ChevronUpRegular />} title="Move up (Alt+↑)" disabled={sel === null} />
              <Cmd sm icon={<ChevronDownRegular />} title="Move down (Alt+↓)" disabled={sel === null} />
              <SearchBox w={150} />
            </>
          }
        >
          <Table cols="24px minmax(0,1fr) minmax(0,1fr) 88px 64px" head={["#", "Video", "Subtitle file", "Language", " Delay"]}>
            {SUBS.map((s, i) => (
              <Tr key={s.name} on={i === sel} onClick={() => go("subs-one")}>
                <span className="num t3">{i + 1}</span>
                <span className="t2 truncate">{VIDEOS[i].name}</span>
                <span className="cell"><Grip /><span className="truncate">{s.name}</span></span>
                <span className="t2">English</span>
                <span className="r num t2" style={{ display: "flex" }}>0.000</span>
              </Tr>
            ))}
          </Table>
        </Box>
      ) : (
        <section className="box">
          <Empty icon={<ClosedCaptionRegular />} title="Drop a folder of subtitles">
            <Btn icon={<FolderOpenRegular />} onClick={() => go("subs-ready")}>Choose folder</Btn>
            <Btn icon={<ArrowImportRegular />} onClick={() => go("subs-import")}>Import from a video</Btn>
          </Empty>
        </section>
      )}
      <div className="stack">
        <SlotSettings kind="subs" lang="English" />
        {has && (
          sel === null ? (
            <Box title="Subtitle 1 files">
              <DL rows={[["Folder", <span key="f" className="truncate" title={SUB_DIR}>{SUB_DIR}</span>], ["Files", "16 · SRT"], ["Paired", "16 of 16"]]} />
            </Box>
          ) : (
            <Box title={<MidText text={SUBS[sel].name} tail={16} />}>
              <DL rows={[["Video", <MidText key="v" text={VIDEOS[sel].name} tail={20} />], ["Format", "SRT"], ["Size", SUBS[sel].size], ["Language", "English"], ["Delay", "0.000 s"]]} />
              <Links>
                <L icon={<EditRegular />} onClick={() => go("subs-edit")}>Edit…</L>
                <L icon={<CopyRegular />}>Duplicate</L>
                <L icon={<DeleteRegular />}>Remove</L>
              </Links>
            </Box>
          )
        )}
      </div>
    </Window>
  );
}

export function SubsEdit() {
  const { go } = useProto();
  return (
    <Subtitles
      phase="one"
      overlay={
        <Dialog
          size="mid"
          title="Edit subtitle file"
          sub={<span className="cell"><DocumentRegular />{SUBS[2].name}</span>}
          foot={
            <>
              <Btn onClick={() => go("subs-one")}>Cancel</Btn>
              <Btn accent onClick={() => go("subs-one")}>Save</Btn>
            </>
          }
        >
          <div className="fgrid">
            <Fld label="Language"><Combo value="English" w="100%" /></Fld>
            <Fld label="Track name"><TBox ph="Keep the file's name" /></Fld>
            <Fld label="Delay"><TBox value="0.000" unit="s" mono /></Fld>
            <Fld label="Place after"><Combo value="After audio tracks" w="100%" /></Fld>
          </div>
          <div className="col" style={{ gap: 4 }}>
            <TRow label="Default subtitle"><Toggle on /></TRow>
            <TRow label="Forced"><Toggle on={false} /></TRow>
            <TRow label="Use this delay for every file"><Toggle on={false} /></TRow>
            <TRow label="Use every setting for every file"><Toggle on={false} /></TRow>
          </div>
        </Dialog>
      }
    />
  );
}
