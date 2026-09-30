import {
  ArrowDownloadRegular,
  ArrowSyncRegular,
  DismissRegular,
  FolderListRegular,
  FolderOpenRegular,
  GaugeRegular,
  SearchRegular,
  SettingsRegular,
  WrenchRegular,
} from "@fluentui/react-icons";
import type { ReactNode } from "react";

import { Btn, Cmd, Combo, InfoBar, PBar, Seg, Slider, TBox, Toggle, cx } from "../kit";
import { AutoGo, useProgress, useProto } from "../shell";
import { Audio } from "./tracks";
import { Videos } from "./videos";

const Row = ({ h, d, children }: { h: ReactNode; d?: ReactNode; children?: ReactNode }) => (
  <div className="srow">
    <div className="tx">
      <div>{h}</div>
      {d && <div className="d">{d}</div>}
    </div>
    {children}
  </div>
);
const SliderCtl = ({ pct, v }: { pct: number; v: string }) => (
  <div className="row" style={{ gap: 12, width: 240 }}><Slider pct={pct} /><span className="num" style={{ width: 40, textAlign: "right" }}>{v}</span></div>
);
const Folder = ({ path }: { path?: string }) => (
  <span className="row" style={{ gap: 2 }}>
    <TBox value={path} ph="Not set" w={260} mono />
    <Cmd icon={<FolderOpenRegular />} title="Choose folder" />
    <Cmd icon={<DismissRegular />} title="Clear" />
  </span>
);

export type PTab = "general" | "presets" | "measure" | "tools" | "updates";
const TABS: { id: PTab; label: string; icon: ReactNode }[] = [
  { id: "general", label: "General", icon: <SettingsRegular /> },
  { id: "presets", label: "Presets", icon: <FolderListRegular /> },
  { id: "measure", label: "Measurement", icon: <GaugeRegular /> },
  { id: "tools", label: "Tools", icon: <WrenchRegular /> },
  { id: "updates", label: "Updates", icon: <ArrowSyncRegular /> },
];

function PrefsBody({ tab }: { tab: PTab }) {
  const { go } = useProto();
  if (tab === "presets")
    return (
      <>
        <div className="group-h">Preset</div>
        <div className="group">
          <Row h="Preset in use" d="Folders, file types and languages the pages start with.">
            <Combo value="Default" w={160} />
          </Row>
          <div className="srow" style={{ minHeight: 48, justifyContent: "flex-end", gap: 8 }}>
            <Btn>Revert</Btn>
            <Btn>Set as default</Btn>
            <Btn>Save preset</Btn>
          </div>
        </div>
        <div className="group-h">Folders</div>
        <div className="group">
          <Row h="Videos"><Folder path="D:\Shows" /></Row>
          <Row h="Subtitles"><Folder path="D:\Subs" /></Row>
          <Row h="Audio"><Folder path="D:\Dubs" /></Row>
          <Row h="Chapters"><Folder /></Row>
          <Row h="Attachments"><Folder path="D:\Fonts" /></Row>
          <Row h="Output"><Folder path="D:\Muxed" /></Row>
        </div>
        <div className="group-h">File types</div>
        <div className="group">
          <Row h="Video"><Combo value="MKV, AVI, MP4, M4V, MOV" w={220} /></Row>
          <Row h="Subtitle"><Combo value="ASS, SRT, SSA, SUP, PGS" w={220} /></Row>
          <Row h="Audio"><Combo value="AAC, AC3, FLAC, EAC3, MKA" w={220} /></Row>
          <Row h="Chapter"><Combo value="XML" w={220} /></Row>
        </div>
        <div className="group-h">Languages</div>
        <div className="group">
          <Row h="New subtitle tracks"><Combo value="English" w={220} /></Row>
          <Row h="New audio tracks"><Combo value="Hindi" w={220} /></Row>
        </div>
      </>
    );
  if (tab === "measure")
    return (
      <>
        <div className="group-h">Measuring</div>
        <div className="group">
          <Row h="Sample windows" d="The same settings as AudioSyncMaster give the same delays."><SliderCtl pct={26} v="6" /></Row>
          <Row h="Window length"><SliderCtl pct={7} v="45 s" /></Row>
          <Row h="Largest offset"><SliderCtl pct={10} v="60 s" /></Row>
        </div>
        <div className="group-h">Checks</div>
        <div className="group">
          <Row h="Whole-timeline scan" d="Finds every cut and frame-rate change. Reads both files end to end: minutes per film.">
            <Toggle on={false} />
          </Row>
        </div>
      </>
    );
  if (tab === "tools")
    return (
      <>
        <div className="group-h" style={{ display: "flex", alignItems: "center" }}>
          <span className="grow">Tools</span>
          <Cmd sm icon={<ArrowSyncRegular />}>Check again</Cmd>
        </div>
        <div className="group">
          <Row h="MKVToolNix" d="v88.0 · C:\Program Files\MKVToolNix\mkvmerge.exe"><span className="t3">Installed</span></Row>
          <Row h="FFmpeg" d="7.1 · C:\ffmpeg\bin\ffmpeg.exe"><span className="t3">Installed</span></Row>
          <Row h="Audio analysis engine" d="AudioSyncMaster 2.15.0"><span className="t3">Included</span></Row>
          <Row h="MediaInfo CLI" d="Reads track details from your files."><span className="bad" style={{ marginRight: 8 }}>Required</span><Btn icon={<ArrowDownloadRegular />}>Install</Btn></Row>
        </div>
      </>
    );
  if (tab === "updates")
    return (
      <>
        <div className="group-h">Updates</div>
        <div className="group">
          <Row h="Version 1.71.0 is ready" d="Workstation layout, drop folders on the window, History. 14 MB.">
            <Btn accent icon={<ArrowDownloadRegular />} onClick={() => go("update-install")}>Install and restart</Btn>
          </Row>
          <Row h="MKVBatchMux 1.70.0" d="Checks on launch and every six hours, never during a mux." />
        </div>
      </>
    );
  return (
    <>
      <div className="group-h">Appearance</div>
      <div className="group">
        <Row h="Theme"><Seg items={["Dark", "Light"]} value={0} /></Row>
      </div>
      <div className="group-h">Startup</div>
      <div className="group">
        <Row h="Ask which preset to use"><Toggle on={false} /></Row>
      </div>
      <div className="group-h">About</div>
      <div className="group">
        <Row h="MKVBatchMux 1.70.0" d="By Ionicboy (AdkHex)"><Btn>Project page</Btn></Row>
      </div>
    </>
  );
}

function PrefsWindow({ tab }: { tab: PTab }) {
  const { go } = useProto();
  return (
    <div className="smoke">
      <div className="prefs">
        <div className="pt">
          Preferences
          <button type="button" className="cap x" style={{ marginLeft: "auto" }} aria-label="Close" onClick={() => go("videos-ready")}>
            <svg width="10" height="10"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" /></svg>
          </button>
        </div>
        <div className="ptabs">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={cx("ptab", t.id === tab && "on")} onClick={() => go(t.id === "general" ? "prefs" : `prefs-${t.id}`)}>
              <span className="ic">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
        <div className="pbody"><PrefsBody tab={tab} /></div>
        <div className="pfoot">
          {tab === "measure" && <Btn>Reset to AudioSyncMaster's</Btn>}
          <span style={{ flex: 1 }} />
          <Btn style={{ minWidth: 96 }} onClick={() => go("videos-ready")}>Cancel</Btn>
          <Btn accent style={{ minWidth: 96 }} onClick={() => go("videos-ready")}>Save</Btn>
        </div>
      </div>
    </div>
  );
}

export function Prefs({ tab }: { tab: PTab }) {
  return <Videos phase="ready" overlay={<PrefsWindow tab={tab} />} />;
}

function Installing() {
  const p = useProgress(26, 4000, 4);
  return (
    <div className="smoke">
      <AutoGo to="videos-ready" ms={4300} />
      <div className="dialog">
        <div className="db">
          <div className="dt">Updating to 1.71.0</div>
          <div className="row"><span className="grow">{p < 85 ? "Downloading" : "Installing"}</span></div>
          <PBar ind />
          <div className="t3">MKVBatchMux restarts when it's done. Your queue and settings are kept.</div>
        </div>
      </div>
    </div>
  );
}

export function UpdateInstall() {
  return <Videos phase="ready" overlay={<Installing />} />;
}

const KEYS: [string, string][] = [
  ["Videos · Subtitles · Audio · Chapters · Attachments · Mux", "Ctrl+1 – 6"],
  ["Choose folder", "Ctrl+O"],
  ["New track (Audio, Subtitles)", "Ctrl+N"],
  ["Modify tracks", "Ctrl+M"],
  ["Media info", "Ctrl+I"],
  ["Select all", "Ctrl+A"],
  ["Remove the selection", "Del"],
  ["Move up · down", "Alt+↑ · Alt+↓"],
  ["Run the page's action (Measure, Start muxing)", "Enter"],
  ["Stop", "Esc"],
  ["Output · History", "Ctrl+` · Ctrl+H"],
  ["Preferences", "Ctrl+,"],
  ["This list", "?"],
];

export function Shortcuts() {
  const { go } = useProto();
  return (
    <Videos
      phase="ready"
      overlay={
        <div className="smoke">
          <div className="dialog mid">
            <div className="db">
              <div className="dt">Keyboard shortcuts</div>
              <dl className="keys">
                {KEYS.map(([k, v]) => (
                  <div key={k} style={{ display: "contents" }}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="df"><Btn accent onClick={() => go("videos-ready")}>Close</Btn></div>
          </div>
        </div>
      }
    />
  );
}

const LANGS: [string, string][] = [["Hindi", "hin"], ["Hungarian", "hun"], ["Chhattisgarhi", "hne"], ["Hiri Motu", "hmo"], ["Hmong", "hmn"], ["Hittite", "hit"], ["Tahitian", "tah"], ["Thai", "tha"]];

/** The language combo, open: type to filter by name or code. */
export function LangPicker() {
  const { go } = useProto();
  return (
    <Audio
      phase="ready"
      overlay={
        <>
          <div style={{ position: "absolute", inset: 0, zIndex: 35 }} onClick={() => go("audio-ready")} />
          <div className="fly lang-fly" style={{ top: 250, right: 150 }}>
            <label className="tbox focus"><SearchRegular className="t3" /><span>hi</span></label>
            <div className="list">
              {LANGS.map(([l, c], i) => (
                <div key={c} className={cx("mi", i === 0 && "on")} onClick={() => go("audio-ready")}>
                  {l}
                  <span className="code">{c}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      }
    />
  );
}

export function EngineInfo() {
  return <InfoBar tone="warn">The audio analysis engine is missing.</InfoBar>;
}
