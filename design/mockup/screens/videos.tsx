import {
  AddRegular,
  ArrowDownRegular,
  ArrowImportRegular,
  ArrowSyncRegular,
  ArrowUpRegular,
  ClosedCaptionRegular,
  DeleteRegular,
  EditRegular,
  FolderOpenRegular,
  InfoRegular,
  MusicNote2Regular,
  StopRegular,
  TextBulletListSquareRegular,
  VideoClipMultipleRegular,
  VideoRegular,
} from "@fluentui/react-icons";
import type { ReactNode } from "react";

import { SHOW_DIR, TRACKS, VIDEOS, type Trk } from "../data";
import { Btn, Chk, Cmd, Combo, DL, Empty, Grip, MidText, Status, Table, Tr } from "../kit";
import { AutoGo, Box, Dialog, DockTabs, Window, useProgress, useProto, type LcdProps } from "../shell";
import { Dash, HistoryDock, L, Links, Name, OutputDock, QueueBtn, SearchBox, TrackCounts } from "./common";

export type VPhase = "empty" | "drag" | "scanning" | "ready" | "one" | "many";

const typeIcon = (t: Trk["type"]) => (t === "video" ? <VideoRegular /> : t === "audio" ? <MusicNote2Regular /> : <ClosedCaptionRegular />);

/** A video's tracks as the inspector lists them: kept, removed, and added. */
export function TrackList({ added = true }: { added?: boolean }) {
  const rows: (Trk & { add?: boolean })[] = [
    TRACKS[0],
    TRACKS[1],
    TRACKS[2],
    ...(added ? [{ type: "audio" as const, codec: "E-AC3", lang: "Hindi", name: "Audio 1", add: true }] : []),
    TRACKS[3],
    TRACKS[4],
    TRACKS[5],
    ...(added ? [{ type: "subtitle" as const, codec: "SRT", lang: "English", name: "Subtitle 1", add: true }] : []),
  ];
  return (
    <div className="col">
      {rows.map((t, i) => (
        <div key={i} className={t.off ? "trk off" : "trk"}>
          <span className="fi">{typeIcon(t.type)}</span>
          <span className="grow truncate">{[t.type === "video" ? null : t.lang, t.codec, t.name].filter(Boolean).join(" · ")}</span>
          <span className="fl">{t.off ? "Removed" : t.add ? "Added" : t.def ? "Default" : t.forced ? "Forced" : ""}</span>
        </div>
      ))}
    </div>
  );
}

function Details({ phase, sel }: { phase: VPhase; sel: number[] }) {
  const { go } = useProto();
  if (phase === "many")
    return (
      <Box title={`${sel.length} videos`}>
        <DL rows={[["Size", "12.9 GB"], ["Duration", "3:18:21"], ["Frame rate", "23.976 fps"], ["Tracks", "1 video · 3 audio · 4 subtitles"]]} />
        <Links>
          <L icon={<InfoRegular />} onClick={() => go("videos-info")}>Media info</L>
          <L icon={<TextBulletListSquareRegular />} onClick={() => go("videos-modify")}>Modify tracks…</L>
          <L icon={<DeleteRegular />}>Remove</L>
        </Links>
      </Box>
    );
  if (phase === "one") {
    const v = VIDEOS[2];
    return (
      <Box title={<MidText text={v.name} tail={14} />}>
        <DL rows={[["Duration", v.dur], ["Frame rate", `${v.fps} fps`], ["Size", v.size], ["Folder", <span key="f" className="truncate" title={SHOW_DIR}>{SHOW_DIR}</span>]]} />
        <div className="col" style={{ gap: 4 }}>
          <span className="sec">Tracks</span>
          <TrackList />
        </div>
        <Links>
          <L icon={<EditRegular />} onClick={() => go("videos-edit")}>Edit tracks…</L>
          <L icon={<InfoRegular />} onClick={() => go("videos-info")}>Media info</L>
        </Links>
      </Box>
    );
  }
  return (
    <Box title="Season 1">
      <DL rows={[["Folder", <span key="f" className="truncate" title={SHOW_DIR}>{SHOW_DIR}</span>], ["Videos", "16 · MKV"], ["Size", "64.8 GB"], ["Duration", "17:28:37"], ["Frame rate", "23.976 fps"]]} />
      <div className="col" style={{ gap: 4 }}>
        <span className="sec">In every video</span>
        <TrackList added={false} />
      </div>
      <Links>
        <L icon={<TextBulletListSquareRegular />} onClick={() => go("videos-modify")}>Modify tracks…</L>
      </Links>
    </Box>
  );
}

export function Videos({ phase, overlay, dock, menu, busy }: { phase: VPhase; overlay?: ReactNode; dock?: "history" | "output"; menu?: "File" | "Edit" | "View" | "Tools" | "Help"; busy?: "mux" | "audio" }) {
  const { go } = useProto();
  const p = useProgress(44, 3200);
  const has = phase !== "empty" && phase !== "drag";
  const read = phase === "scanning" ? Math.min(16, Math.floor((p / 100) * 16)) : 16;
  const sel = phase === "one" ? [2] : phase === "many" ? [4, 5, 6] : [];

  const lcd: LcdProps =
    phase === "empty" || phase === "drag"
      ? { l1: "Drop a folder of videos to begin" }
      : phase === "scanning"
        ? { icon: "run", l1: `Reading media info ${read} of 16`, l2: SHOW_DIR, pct: p }
        : { l1: "16 videos · 64.8 GB", l2: "1 audio track · 1 subtitle track to add" };

  return (
    <Window
      page="videos"
      lcd={lcd}
      overlay={overlay}
      dock={dock === "history" ? <HistoryDock /> : dock === "output" ? <OutputDock /> : undefined}
      util={dock}
      cols={has ? "minmax(0,1fr) 300px" : "minmax(0,1fr)"}
      menu={menu}
      busy={busy ?? (phase === "scanning" ? "videos" : undefined)}
      tools={
        <>
          <Cmd icon={<FolderOpenRegular />} disabled={phase === "scanning"} onClick={() => go("videos-scanning")}>Choose folder</Cmd>
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" disabled={!has || phase === "scanning"} onClick={() => go("videos-scanning")} />
          <Cmd icon={<DeleteRegular />} title="Remove (Del)" disabled={sel.length === 0} />
          <Cmd icon={<EditRegular />} title="Edit tracks" disabled={sel.length !== 1} onClick={() => go("videos-edit")} />
          <Cmd icon={<InfoRegular />} title="Media info (Ctrl+I)" disabled={sel.length === 0} onClick={() => go("videos-info")} />
        </>
      }
      primary={
        phase === "scanning" ? (
          <Btn icon={<StopRegular />} kbd="Esc" onClick={() => go("videos-ready")}>Stop</Btn>
        ) : (
          <>
            <Btn icon={<TextBulletListSquareRegular />} disabled={!has} onClick={() => go("videos-modify")}>Modify tracks…</Btn>
            <QueueBtn disabled={!has} />
          </>
        )
      }
    >
      {has ? (
        <>
          <Box
            body={false}
            title="Videos"
            sub={<span title={SHOW_DIR}>{SHOW_DIR}</span>}
            end={
              <>
                <Combo ghost sm value="All formats" w={104} />
                <Combo ghost sm value="Loaded order" w={116} />
                <SearchBox />
              </>
            }
          >
            <Table cols="minmax(0,1fr) 108px 60px 68px 72px 88px" head={["Name", "Tracks", " FPS", " Duration", " Size", "Status"]}>
              {VIDEOS.map((v, i) => {
                const done = phase !== "scanning" || i < read;
                const reading = phase === "scanning" && i >= read && i < read + 4;
                return (
                  <Tr key={v.name} on={sel.includes(i)} onClick={() => go(i === 2 ? "videos-one" : "videos-ready")}>
                    <Name>{v.name}</Name>
                    {done ? <TrackCounts v={1} a={i === 7 ? 2 : 3} s={i === 7 ? 2 : 3} /> : <Dash />}
                    <span className="r num t2" style={{ display: "flex" }}>{done ? v.fps : <Dash />}</span>
                    <span className="r num t2" style={{ display: "flex" }}>{done ? v.dur : <Dash />}</span>
                    <span className="r num t2" style={{ display: "flex" }}>{v.size}</span>
                    {done ? <Status s="ready" /> : reading ? <Status s="run" text="Reading" pct={null} /> : <Status s="wait" />}
                  </Tr>
                );
              })}
            </Table>
          </Box>
          <Details phase={phase === "scanning" ? "ready" : phase} sel={sel} />
          {phase === "scanning" && <AutoGo to="videos-ready" ms={3400} />}
        </>
      ) : (
        <section className="box">
          <Empty icon={<VideoClipMultipleRegular />} title="Drop a folder of videos">
            <Btn icon={<FolderOpenRegular />} onClick={() => go("videos-scanning")}>Choose folder</Btn>
          </Empty>
          {phase === "drag" && (
            <div className="dropover">
              <span className="ic"><VideoClipMultipleRegular /></span>
              Drop to add the folder Season 1
            </div>
          )}
        </section>
      )}
    </Window>
  );
}

/* ------------------------------- dialogs ------------------------------- */

type EditRow = { t: Trk; ext?: boolean; copy: boolean };

/** The track table shared by Edit tracks and Modify tracks. */
export function TrackTable({ rows, tab, sel = 1, across }: { rows: EditRow[]; tab: "Subtitles" | "Audio" | "Videos"; sel?: number; across?: boolean }) {
  const audio = tab === "Audio";
  const cols = `16px 24px 44px 52px 48px ${audio ? "64px " : ""}minmax(0,1fr) 132px 28px`;
  const head = ["", "#", "Copy", "Default", "Forced", ...(audio ? [" Bitrate"] : []), "Name", "Language", ""];
  return (
    <Table cols={cols} head={head}>
      {rows.map((r, i) => (
        <Tr key={i} on={i === sel}>
          <Grip />
          <span className="num t3">{i + 1}</span>
          <Chk on={r.copy} />
          <span style={{ opacity: r.copy ? 1 : 0.45 }}><Chk on={!!r.t.def && r.copy} /></span>
          <span style={{ opacity: r.copy ? 1 : 0.45 }}><Chk on={!!r.t.forced && r.copy} /></span>
          {audio && <span className="r num t2" style={{ display: "flex" }}>{r.t.kbps ? `${r.t.kbps} kb/s` : "—"}</span>}
          <span className="cell">
            <span className={r.copy ? "truncate" : "truncate t3"}>{across && i === 1 ? <span className="t3">Multiple</span> : r.t.name ?? r.t.codec}</span>
            {r.ext && <span className="t3 sm">Added</span>}
          </span>
          <Combo ghost sm value={r.t.lang === "und" ? "Undetermined" : r.t.lang} w="100%" />
          <Cmd sm icon={<DeleteRegular />} title="Remove from the list" />
        </Tr>
      ))}
    </Table>
  );
}

export function EditTracks() {
  const { go } = useProto();
  const rows: EditRow[] = [
    { t: TRACKS[3], copy: true },
    { t: TRACKS[4], copy: false },
    { t: TRACKS[5], copy: true },
    { t: { type: "subtitle", codec: "SRT", lang: "English", name: "Goblin.S01E03.en.srt" }, ext: true, copy: true },
  ];
  return (
    <Videos
      phase="one"
      overlay={
        <Dialog
          size="wide"
          title="Edit tracks"
          sub={<MidText text={VIDEOS[2].name} tail={30} />}
          foot={
            <>
              <Btn onClick={() => go("videos-one")}>Cancel</Btn>
              <Btn accent onClick={() => go("videos-one")}>Apply</Btn>
            </>
          }
        >
          <div className="frame">
            <DockTabs
              tabs={["Videos 1", "Subtitles 4", "Audio 3"]}
              on="Subtitles 4"
              tools={
                <>
                  <Cmd sm icon={<AddRegular />}>Add a subtitle file…</Cmd>
                  <Cmd sm icon={<ArrowImportRegular />}>Import from a video…</Cmd>
                  <span className="vsep" />
                  <Cmd sm icon={<ArrowUpRegular />} title="Move up" />
                  <Cmd sm icon={<ArrowDownRegular />} title="Move down" />
                </>
              }
            />
            <TrackTable rows={rows} tab="Subtitles" />
          </div>
        </Dialog>
      }
    />
  );
}

export function ModifyTracks() {
  const { go } = useProto();
  const rows: EditRow[] = [{ t: TRACKS[1], copy: true }, { t: TRACKS[2], copy: true }];
  return (
    <Videos
      phase="ready"
      overlay={
        <Dialog
          size="wide"
          title="Modify tracks"
          sub="Every loaded video, track by position"
          left={<Btn>Reset</Btn>}
          foot={
            <>
              <Btn onClick={() => go("videos-ready")}>Cancel</Btn>
              <Btn accent onClick={() => go("videos-ready")}>Apply</Btn>
            </>
          }
        >
          <div className="frame">
            <DockTabs
              tabs={["Videos 1", "Subtitles 3", "Audio 2"]}
              on="Audio 2"
              tools={
                <>
                  <Cmd sm icon={<ArrowUpRegular />} title="Move up" />
                  <Cmd sm icon={<ArrowDownRegular />} title="Move down" />
                </>
              }
            />
            <TrackTable rows={rows} tab="Audio" across />
          </div>
          <div className="frame">
            <div className="dtabs"><span className="tab on">Track 2 in each video</span></div>
            <Table cols="minmax(0,1fr) 56px 60px 56px 120px 96px" head={["Video", "Found", "Default", "Forced", "Name", "Language"]} style={{ maxHeight: 180 }}>
              {VIDEOS.slice(0, 5).map((v, i) => (
                <Tr key={v.name}>
                  <Name>{v.name}</Name>
                  <Status s={i === 3 ? "bad" : "ok"} text={i === 3 ? "No" : "Yes"} />
                  <span className="t2">{i === 3 ? "—" : "No"}</span>
                  <span className="t2">{i === 3 ? "—" : "No"}</span>
                  <span className="truncate t2">{i === 3 ? "—" : i === 2 ? "5.1" : "Surround 5.1"}</span>
                  <span className="t2">{i === 3 ? "—" : "Korean"}</span>
                </Tr>
              ))}
            </Table>
          </div>
        </Dialog>
      }
    />
  );
}

export function MediaInfo() {
  const { go } = useProto();
  const v = VIDEOS[4];
  return (
    <Videos
      phase="many"
      overlay={
        <Dialog
          size="wide"
          title="Media info"
          sub="Comparing 3 videos"
          foot={<Btn accent onClick={() => go("videos-many")}>Close</Btn>}
        >
          <div className="frame" style={{ overflow: "visible" }}>
            <DockTabs tabs={["Goblin.S01E05…HDEX.mkv", "Goblin.S01E06…HDEX.mkv", "Goblin.S01E07…HDEX.mkv"]} on="Goblin.S01E05…HDEX.mkv" />
            <div className="box-b" style={{ gap: 14 }}>
              <DL rows={[["File", v.name], ["Size", v.size], ["Duration", v.dur], ["Frame rate", `${v.fps} fps`], ["Folder", SHOW_DIR]]} />
              {(["video", "audio", "subtitle"] as const).map((type) => {
                const list = TRACKS.filter((t) => t.type === type);
                return (
                  <div key={type} className="col" style={{ gap: 2 }}>
                    <span className="sec">{type === "video" ? "Video" : type === "audio" ? "Audio" : "Subtitles"} <span className="t3" style={{ fontWeight: 400 }}>{list.length}</span></span>
                    {list.map((t, i) => (
                      <div key={i} className="trk">
                        <span className="num t3" style={{ width: 16 }}>{i + 1}</span>
                        <span className="grow truncate">{[t.codec, t.type === "video" ? null : t.lang, t.name].filter(Boolean).join(" · ")}</span>
                        <span className="fl">{[t.def ? "Default" : null, t.forced ? "Forced" : null, t.kbps ? `${t.kbps} kb/s` : null].filter(Boolean).join(" · ")}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </Dialog>
      }
    />
  );
}
