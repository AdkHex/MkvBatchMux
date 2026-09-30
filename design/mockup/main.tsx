import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { LangPicker, Prefs, Shortcuts, UpdateInstall } from "./screens/app";
import { Attachments, Chapters } from "./screens/extras";
import { ConfirmStart, Mux } from "./screens/mux";
import { Audio, AudioEdit, DeleteSlot, ImportStreams, SubsEdit, Subtitles, TrackDelays } from "./screens/tracks";
import { EditTracks, MediaInfo, ModifyTracks, Videos } from "./screens/videos";
import { Ctx, type Proto } from "./shell";

interface Screen {
  id: string;
  group: string;
  label: string;
  render: () => ReactNode;
}

const SCREENS: Screen[] = [
  { id: "videos-empty", group: "Videos", label: "Empty", render: () => <Videos phase="empty" /> },
  { id: "videos-drag", group: "Videos", label: "Dropping a folder", render: () => <Videos phase="drag" /> },
  { id: "videos-scanning", group: "Videos", label: "Reading media info", render: () => <Videos phase="scanning" /> },
  { id: "videos-ready", group: "Videos", label: "Ready", render: () => <Videos phase="ready" /> },
  { id: "videos-one", group: "Videos", label: "One selected", render: () => <Videos phase="one" /> },
  { id: "videos-many", group: "Videos", label: "Three selected", render: () => <Videos phase="many" /> },
  { id: "videos-edit", group: "Videos", label: "Edit tracks", render: () => <EditTracks /> },
  { id: "videos-modify", group: "Videos", label: "Modify tracks", render: () => <ModifyTracks /> },
  { id: "videos-info", group: "Videos", label: "Media info", render: () => <MediaInfo /> },

  { id: "subs-empty", group: "Subtitles", label: "Empty", render: () => <Subtitles phase="empty" /> },
  { id: "subs-ready", group: "Subtitles", label: "Ready", render: () => <Subtitles phase="ready" /> },
  { id: "subs-one", group: "Subtitles", label: "One selected", render: () => <Subtitles phase="one" /> },
  { id: "subs-edit", group: "Subtitles", label: "Edit a file", render: () => <SubsEdit /> },
  { id: "subs-import", group: "Subtitles", label: "Import from a video", render: () => <ImportStreams kind="subs" /> },

  { id: "audio-empty", group: "Audio", label: "Empty", render: () => <Audio phase="empty" /> },
  { id: "audio-ready", group: "Audio", label: "Ready", render: () => <Audio phase="ready" /> },
  { id: "audio-one", group: "Audio", label: "One selected", render: () => <Audio phase="ready" sel={2} /> },
  { id: "audio-unlinked", group: "Audio", label: "A file with no video", render: () => <Audio phase="unlinked" sel={16} /> },
  { id: "audio-engine", group: "Audio", label: "Engine missing", render: () => <Audio phase="engine" /> },
  { id: "audio-measuring", group: "Audio", label: "Measuring", render: () => <Audio phase="measuring" /> },
  { id: "audio-measured", group: "Audio", label: "Measured", render: () => <Audio phase="measured" sel={0} /> },
  { id: "audio-cut", group: "Audio", label: "Result: different cut", render: () => <Audio phase="measured" sel={4} /> },
  { id: "audio-rate", group: "Audio", label: "Result: frame rate", render: () => <Audio phase="measured" sel={8} /> },
  { id: "audio-fail", group: "Audio", label: "Result: failed", render: () => <Audio phase="measured" sel={12} /> },
  { id: "audio-applied", group: "Audio", label: "Applied", render: () => <Audio phase="applied" /> },
  { id: "audio-lang", group: "Audio", label: "Language picker", render: () => <LangPicker /> },
  { id: "audio-edit", group: "Audio", label: "Edit a file", render: () => <AudioEdit /> },
  { id: "audio-delays", group: "Audio", label: "Track delays", render: () => <TrackDelays /> },
  { id: "audio-import", group: "Audio", label: "Import from a video", render: () => <ImportStreams /> },
  { id: "audio-delete", group: "Audio", label: "Delete a track slot", render: () => <DeleteSlot /> },

  { id: "chapters-off", group: "Chapters", label: "Off", render: () => <Chapters on={false} /> },
  { id: "chapters-ready", group: "Chapters", label: "Ready", render: () => <Chapters on /> },
  { id: "attach-off", group: "Attachments", label: "Off", render: () => <Attachments on={false} /> },
  { id: "attach-ready", group: "Attachments", label: "Ready", render: () => <Attachments on /> },

  { id: "mux-empty", group: "Mux", label: "Empty queue", render: () => <Mux phase="empty" /> },
  { id: "mux-ready", group: "Mux", label: "Queued", render: () => <Mux phase="ready" /> },
  { id: "mux-unlinked", group: "Mux", label: "A file with no video", render: () => <Mux phase="unlinked" /> },
  { id: "mux-warnings", group: "Mux", label: "Validated with warnings", render: () => <Mux phase="warnings" /> },
  { id: "mux-confirm", group: "Mux", label: "Start anyway?", render: () => <ConfirmStart /> },
  { id: "mux-running", group: "Mux", label: "Muxing", render: () => <Mux phase="running" /> },
  { id: "mux-paused", group: "Mux", label: "Pausing", render: () => <Mux phase="paused" /> },
  { id: "mux-done", group: "Mux", label: "Done, one failed", render: () => <Mux phase="done" dock="output" /> },
  { id: "mux-report", group: "Mux", label: "Report", render: () => <Mux phase="warnings" dock="report" /> },
  { id: "mux-stopped", group: "Mux", label: "Stopped", render: () => <Mux phase="stopped" /> },
  { id: "videos-busy", group: "Mux", label: "Another page while muxing", render: () => <Videos phase="ready" busy="mux" /> },

  { id: "menu-file", group: "App", label: "File menu", render: () => <Videos phase="ready" menu="File" /> },
  { id: "menu-edit", group: "App", label: "Edit menu", render: () => <Videos phase="ready" menu="Edit" /> },
  { id: "menu-view", group: "App", label: "View menu", render: () => <Videos phase="ready" menu="View" /> },
  { id: "menu-tools", group: "App", label: "Tools menu", render: () => <Videos phase="ready" menu="Tools" /> },
  { id: "menu-help", group: "App", label: "Help menu", render: () => <Videos phase="ready" menu="Help" /> },
  { id: "history", group: "App", label: "History", render: () => <Videos phase="ready" dock="history" /> },
  { id: "output", group: "App", label: "Output", render: () => <Videos phase="ready" dock="output" /> },
  { id: "prefs", group: "App", label: "Preferences · General", render: () => <Prefs tab="general" /> },
  { id: "prefs-presets", group: "App", label: "Preferences · Presets", render: () => <Prefs tab="presets" /> },
  { id: "prefs-measure", group: "App", label: "Preferences · Measurement", render: () => <Prefs tab="measure" /> },
  { id: "prefs-tools", group: "App", label: "Preferences · Tools", render: () => <Prefs tab="tools" /> },
  { id: "prefs-updates", group: "App", label: "Preferences · Updates", render: () => <Prefs tab="updates" /> },
  { id: "update-install", group: "App", label: "Installing an update", render: () => <UpdateInstall /> },
  { id: "shortcuts", group: "App", label: "Keyboard shortcuts", render: () => <Shortcuts /> },
];

const GROUPS = [...new Set(SCREENS.map((s) => s.group))];
const find = (id: string) => SCREENS.find((s) => s.id === id) ?? SCREENS[0];

const SIZES = { big: [1180, 780], min: [900, 600] } as const;
type Size = keyof typeof SIZES;

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  return {
    s: h.get("s") ?? "videos-ready",
    all: h.get("view") === "all",
    theme: (h.get("theme") as "dark" | "light") ?? "dark",
    mac: h.get("os") === "mac",
    size: (h.get("size") === "min" ? "min" : "big") as Size,
  };
}

function Scaled({ children, w, h }: { children: ReactNode; w: number; h: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(0.3);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setK(el.getBoundingClientRect().width / w));
    ro.observe(el);
    return () => ro.disconnect();
  }, [w]);
  return (
    <div className="ovframe" ref={ref} style={{ aspectRatio: `${w} / ${h}` }}>
      <div style={{ transform: `scale(${k})`, width: w, height: h }}>{children}</div>
    </div>
  );
}

function App() {
  const [st, setSt] = useState(readHash);
  const [nonce, setNonce] = useState(0);
  const go = useCallback((id: string) => {
    setSt((s) => ({ ...s, s: id, all: false }));
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const h = new URLSearchParams({ s: st.s });
    if (st.all) h.set("view", "all");
    if (st.theme === "light") h.set("theme", "light");
    if (st.mac) h.set("os", "mac");
    if (st.size === "min") h.set("size", "min");
    history.replaceState(null, "", `#${h}`);
  }, [st]);

  useEffect(() => {
    const onHash = () => setSt(readHash());
    const onKey = (e: KeyboardEvent) => {
      const i = SCREENS.findIndex((x) => x.id === st.s);
      if (e.key === "ArrowRight" || e.key === "ArrowDown") go(SCREENS[(i + 1) % SCREENS.length].id);
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") go(SCREENS[(i - 1 + SCREENS.length) % SCREENS.length].id);
      if (e.key === "g") setSt((s) => ({ ...s, all: !s.all }));
      if (e.key === "t") setSt((s) => ({ ...s, theme: s.theme === "dark" ? "light" : "dark" }));
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKey);
    };
  }, [st.s, go]);

  const [W, H] = SIZES[st.size];
  const desk = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(1);
  useLayoutEffect(() => {
    const el = desk.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setK(Math.min(1, (r.width - 48) / W, (r.height - 48) / H));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [st.all, W, H]);

  const live: Proto = { go, live: true, theme: st.theme, mac: st.mac };
  const vars = { "--win-w": `${W}px`, "--win-h": `${H}px` } as CSSProperties;
  let n = 0;

  return (
    <div className={`stage ${st.theme}`} style={vars}>
      <aside className="story">
        <h1>MKVBatchMux — mockup</h1>
        <div className="opts">
          <button type="button" className={!st.all ? "on" : ""} onClick={() => setSt((s) => ({ ...s, all: false }))}>Prototype</button>
          <button type="button" className={st.all ? "on" : ""} onClick={() => setSt((s) => ({ ...s, all: true }))}>All screens</button>
          <button type="button" className={st.theme === "dark" ? "on" : ""} onClick={() => setSt((s) => ({ ...s, theme: "dark" }))}>Dark</button>
          <button type="button" className={st.theme === "light" ? "on" : ""} onClick={() => setSt((s) => ({ ...s, theme: "light" }))}>Light</button>
          <button type="button" className={!st.mac ? "on" : ""} onClick={() => setSt((s) => ({ ...s, mac: false }))}>Windows</button>
          <button type="button" className={st.mac ? "on" : ""} onClick={() => setSt((s) => ({ ...s, mac: true }))}>macOS</button>
          <button type="button" className={st.size === "big" ? "on" : ""} onClick={() => setSt((s) => ({ ...s, size: "big" }))}>1180×780</button>
          <button type="button" className={st.size === "min" ? "on" : ""} onClick={() => setSt((s) => ({ ...s, size: "min" }))}>900×600</button>
        </div>
        {GROUPS.map((g) => (
          <div key={g}>
            <div className="g">{g}</div>
            {SCREENS.filter((x) => x.group === g).map((x) => {
              n += 1;
              return (
                <button key={x.id} type="button" className={`s${x.id === st.s && !st.all ? " on" : ""}`} onClick={() => go(x.id)}>
                  <i>{n}</i>
                  {x.label}
                </button>
              );
            })}
          </div>
        ))}
        <div className="foot">← → step · G all screens · T theme. Everything in the window is clickable; running screens finish by themselves.</div>
      </aside>

      {st.all ? (
        <div className="overview">
          <Ctx.Provider value={{ ...live, live: false }}>
            {GROUPS.map((g) => (
              <section key={g}>
                <h2>{g}</h2>
                <div className="ovgrid">
                  {SCREENS.filter((x) => x.group === g).map((x) => (
                    <div key={x.id} className="ovcell" onClick={() => go(x.id)}>
                      <Scaled w={W} h={H}>{x.render()}</Scaled>
                      <span className="ovcap"><b>{x.label}</b></span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </Ctx.Provider>
        </div>
      ) : (
        <div className="desk" ref={desk}>
          <div id="shot" style={{ position: "absolute", left: "50%", top: "50%", width: W, height: H, transform: `translate(-50%, -50%) scale(${k})` }}>
            <Ctx.Provider value={live}>
              <div key={`${st.s}-${nonce}`}>{find(st.s).render()}</div>
            </Ctx.Provider>
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
