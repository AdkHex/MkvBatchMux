import {
  AddRegular,
  CheckmarkStarburstRegular,
  DeleteRegular,
  DismissRegular,
  FolderOpenRegular,
  LayerRegular,
  PauseRegular,
  PlayRegular,
  StopRegular,
  TextBulletListSquareRegular,
} from "@fluentui/react-icons";
import type { ReactNode } from "react";

import { OUT_DIR, VIDEOS } from "../data";
import { Btn, Cmd, Combo, Empty, Fld, InfoBar, Status, TBox, TRow, Table, Toggle, Tr } from "../kit";
import { AutoGo, Box, DockTabs, Window, useProgress, useProto, type LcdProps } from "../shell";
import { Dash, Name, OutputDock } from "./common";

export type MPhase = "empty" | "ready" | "unlinked" | "warnings" | "running" | "paused" | "done" | "stopped";

function OutputSettings({ busy }: { busy?: boolean }) {
  return (
    <Box title="Output">
      <Fld label="Folder">
        <div className="row" style={{ gap: 4 }}>
          <span className="grow"><TBox value={OUT_DIR} /></span>
          <Cmd icon={<FolderOpenRegular />} title="Choose folder" disabled={busy} />
        </div>
      </Fld>
      <Fld label="File name">
        <TBox mono value="{original_filename}" />
        <span className="sm t3 truncate">Goblin.S01E01.1080p.BluRay.x264-HDEX.mkv</span>
      </Fld>
      <TRow label="Overwrite the source when no folder is set"><Toggle on={false} /></TRow>
      <div className="hr" />
      <span className="sec">Remove from the source</span>
      <TRow label="Chapters"><Toggle on={false} /></TRow>
      <TRow label="Attachments"><Toggle on /></TRow>
      <TRow label="Global tags"><Toggle on /></TRow>
      <div className="hr" />
      <span className="sec">Track rules</span>
      <TRow label="Keep audio in"><Combo sm value="All languages" w={132} /></TRow>
      <TRow label="Default audio"><Combo sm value="Hindi" w={132} /></TRow>
      <TRow label="Keep subtitles in"><Combo sm value="All languages" w={132} /></TRow>
      <TRow label="Default subtitle"><Combo sm value="No change" w={132} /></TRow>
      <div className="hr" />
      <span className="sec">Safety</span>
      <TRow label="Write a CRC checksum"><Toggle on={false} /></TRow>
      <TRow label="Remove old CRC tags"><Toggle on={false} /></TRow>
      <TRow label="Stop at the first error"><Toggle on={false} /></TRow>
      <TRow label="Keep a log file"><Toggle on /></TRow>
      <div className="hr" />
      <span className="sec">Performance</span>
      <TRow label="Fast mux" d="Metadata only, in place, nothing added"><Toggle on={false} /></TRow>
      <TRow label="Jobs at once"><span className="t2 num">4 · follows the queue</span></TRow>
    </Box>
  );
}

function ReportDock() {
  return (
    <div style={{ height: 220, display: "flex", flexDirection: "column" }}>
      <DockTabs
        tabs={["Report", "Output", "History"]}
        on="Report"
        tools={<span className="t3 sm" style={{ paddingRight: 6 }}>Goblin.S01E04.1080p.BluRay.x264-HDEX.mkv</span>}
      />
      <div className="rep">
        <div className="col">
          <span className="sec warn">2 warnings</span>
          <span className="it t2">The subtitle ends 4.2 s after the video.</span>
          <span className="it t2">Audio 1 has a delay above 1 s.</span>
        </div>
        <div className="col">
          <span className="sec">Removed</span>
          <span className="it t2">Subtitle · English · SDH</span>
          <span className="sec">Added</span>
          <span className="it t2">Hindi · E-AC3 · +1.312 s · after the video</span>
          <span className="it t2">English · SRT · default</span>
        </div>
        <div className="col">
          <span className="sec">Rules</span>
          <span className="it t2">Remove attachments from the source</span>
          <span className="it t2">Remove global tags from the source</span>
        </div>
        <pre>mkvmerge --output "D:\Muxed\Goblin (2016)\Goblin.S01E04.1080p.BluRay.x264-HDEX.mkv" --subtitle-tracks 3,5 --no-attachments --no-global-tags "D:\Shows\Goblin (2016)\Season 1\Goblin.S01E04.1080p.BluRay.x264-HDEX.mkv" --language 0:hin --sync 0:1312 "D:\Dubs\Goblin Hindi\Goblin.S01E04.Hindi.DDP5.1.eac3"</pre>
      </div>
    </div>
  );
}

export function Mux({ phase, overlay, dock }: { phase: MPhase; overlay?: ReactNode; dock?: "report" | "output" }) {
  const { go } = useProto();
  const p = useProgress(38, 6000);
  const running = phase === "running" || phase === "paused";
  const has = phase !== "empty";
  const done = Math.floor((p / 100) * 16);
  const rowState = (i: number): [ReactNode, string, string] => {
    if (phase === "done") return i === 6 ? [<Status key="s" s="bad" text="Failed" />, "—", ""] : [<Status key="s" s="ok" />, VIDEOS[i].size.replace(/(\d)\.(\d\d)/, (_, a, b) => `${a}.${String(Number(b) + 7).padStart(2, "0")}`), ""];
    if (phase === "stopped") return i < 6 ? [<Status key="s" s="ok" />, VIDEOS[i].size, ""] : i < 10 ? [<Status key="s" s="warn" text="Stopped" />, "—", ""] : [<Status key="s" s="wait" text="Not started" />, "—", ""];
    if (running) {
      if (i < done) return [<Status key="s" s="ok" />, VIDEOS[i].size, ""];
      if (i < done + 4) return [<Status key="s" s="run" pct={Math.min(97, Math.max(3, p * 2.2 - (i - done) * 18))} />, "—", `${1 + (i % 3)} min`];
      return [<Status key="s" s="wait" text="Queued" />, "—", ""];
    }
    if (phase === "warnings" && (i === 3 || i === 10)) return [<Status key="s" s="warn" text={i === 3 ? "2 warnings" : "1 warning"} />, "—", ""];
    return [<Status key="s" s="wait" text="Queued" />, "—", ""];
  };

  const lcd: LcdProps =
    phase === "empty" ? { l1: "The queue is empty", l2: "16 videos are ready to add" }
    : phase === "unlinked" ? { icon: "warn", l1: "1 audio file has no video", l2: "Pair it on Audio before muxing" }
    : phase === "warnings" ? { icon: "warn", l1: "Validated · 3 warnings in 2 jobs", l2: "Start asks before it runs" }
    : phase === "running" ? { icon: "run", l1: `Muxing ${Math.min(16, done + 1)} of 16`, l2: VIDEOS[Math.min(15, done)].name, pct: p, time: `${Math.max(1, Math.round((100 - p) / 12))} min left` }
    : phase === "paused" ? { icon: "warn", l1: "Pausing after the running jobs", l2: "No new job starts until you resume", pct: p }
    : phase === "done" ? { icon: "warn", l1: "15 muxed · 1 failed", l2: `Into ${OUT_DIR} in 9m 12s` }
    : phase === "stopped" ? { icon: "warn", l1: "Stopped · 6 muxed", l2: "4 stopped, 6 not started" }
    : { l1: "16 in the queue", l2: `Into ${OUT_DIR} · 4 at a time` };

  const dockEl = dock === "report" ? <ReportDock /> : dock === "output" ? <OutputDock own={["Report"]} /> : undefined;

  return (
    <Window
      page="mux"
      lcd={lcd}
      overlay={overlay}
      dock={dockEl}
      util={dock === "output" ? "output" : undefined}
      flags={phase === "unlinked" ? ["audio", "mux"] : []}
      tools={
        <>
          <Cmd icon={<AddRegular />} disabled={running} onClick={() => go("mux-ready")}>Add to queue</Cmd>
          <Cmd icon={<CheckmarkStarburstRegular />} disabled={!has || running || phase === "unlinked"} onClick={() => go("mux-warnings")}>Validate</Cmd>
          <Cmd icon={<TextBulletListSquareRegular />} title="Report for the selected job" disabled={!has} onClick={() => go("mux-report")} />
          <Cmd icon={<DeleteRegular />} title="Remove the selected job (Del)" disabled={!has || running} />
          <Cmd icon={<DismissRegular />} title="Clear the queue" disabled={!has || running} onClick={() => go("mux-empty")} />
        </>
      }
      primary={
        running ? (
          <>
            {phase === "paused" ? <Btn icon={<PlayRegular />} onClick={() => go("mux-running")}>Resume</Btn> : <Btn icon={<PauseRegular />} onClick={() => go("mux-paused")}>Pause</Btn>}
            <Btn icon={<StopRegular />} kbd="Esc" onClick={() => go("mux-stopped")}>Stop</Btn>
          </>
        ) : phase === "done" || phase === "stopped" ? (
          <Btn icon={<DismissRegular />} onClick={() => go("mux-empty")}>Clear the queue</Btn>
        ) : (
          <Btn accent icon={<PlayRegular />} kbd="Enter" disabled={!has || phase === "unlinked"} onClick={() => go(phase === "warnings" ? "mux-confirm" : "mux-running")}>Start muxing</Btn>
        )
      }
    >
      {has ? (
        <Box body={false} title="Queue" sub="16 jobs">
          {phase === "unlinked" && (
            <InfoBar tone="warn" actions={<Btn onClick={() => go("audio-unlinked")}>Show on Audio</Btn>}>
              Row 17 on Audio 1 has no video to go into.
            </InfoBar>
          )}
          {phase === "warnings" && (
            <InfoBar tone="warn" actions={<Btn onClick={() => go("mux-report")}>Show</Btn>}>
              Validation found 3 warnings in 2 jobs.
            </InfoBar>
          )}
          <Table cols="24px minmax(0,1fr) 144px 72px 72px 64px" head={["#", "Name", "Status", " Before", " After", " Left"]}>
            {VIDEOS.map((v, i) => {
              const [st, after, left] = rowState(i);
              return (
                <Tr key={v.name} on={(phase === "warnings" && i === 3) || (dock === "report" && i === 3) || (phase === "done" && i === 6)} onClick={() => go("mux-report")}>
                  <span className="num t3">{i + 1}</span>
                  <Name>{v.name}</Name>
                  {st}
                  <span className="r num t2" style={{ display: "flex" }}>{v.size}</span>
                  <span className="r num t2" style={{ display: "flex" }}>{after === "—" ? <Dash /> : after}</span>
                  <span className="r num t2" style={{ display: "flex" }}>{left || <Dash />}</span>
                </Tr>
              );
            })}
          </Table>
        </Box>
      ) : (
        <section className="box">
          <Empty icon={<LayerRegular />} title="The queue is empty">
            <Btn icon={<AddRegular />} onClick={() => go("mux-ready")}>Add 16 videos</Btn>
          </Empty>
        </section>
      )}
      <OutputSettings busy={running} />
      {phase === "running" && <AutoGo to="mux-done" ms={6200} />}
    </Window>
  );
}

export function ConfirmStart() {
  const { go } = useProto();
  return (
    <Mux
      phase="warnings"
      overlay={
        <div className="smoke">
          <div className="dialog">
            <div className="db">
              <div className="dt">Start with 3 warnings?</div>
              <div className="t2">Muxing anyway may give files that are not what you expect.</div>
              <div className="col sm t2" style={{ gap: 4, padding: "10px 12px", background: "var(--layer)", borderRadius: 4, border: "1px solid var(--divider)" }}>
                <span>E04: the subtitle ends 4.2 s after the video.</span>
                <span>E04: Audio 1 has a delay above 1 s.</span>
                <span>E11: the chapters end after the video.</span>
              </div>
            </div>
            <div className="df">
              <Btn accent onClick={() => go("mux-running")}>Start muxing</Btn>
              <Btn onClick={() => go("mux-warnings")}>Cancel</Btn>
            </div>
          </div>
        </div>
      }
    />
  );
}
