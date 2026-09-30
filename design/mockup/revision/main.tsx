import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import "../styles.css";
import "./revision.css";
import { Ctx, type Proto } from "../shell";
import { Attachments2, Audio2, AudioFile, Chapters2, EditTracks2, JobDetails, Mux2, Prefs2, Subs2, Videos2 } from "./screens";

interface Screen {
  id: string;
  label: string;
  render: () => ReactNode;
  note: ReactNode;
}

const SCREENS: Screen[] = [
  {
    id: "videos",
    label: "Videos",
    render: () => <Videos2 />,
    note: (
      <>
        <b>The page bar at the bottom</b>, with "Made by Ionicboy" in small type on the left.
        <ul>
          <li><b>No status box:</b> the toolbar keeps only its buttons. A small status appears only while something runs.</li>
          <li><b>Frame rate, then Duration, then Size</b>, lined up under their headings.</li>
          <li>Click selects a row. Double-click opens Edit tracks.</li>
          <li><b>No Add to queue:</b> every loaded video is already in the Mux queue.</li>
        </ul>
      </>
    ),
  },
  {
    id: "videos-output",
    label: "Videos · Output open",
    render: () => <Videos2 dock />,
    note: <><b>Output only when you ask.</b> It opens from its icon in the page bar or Ctrl+`, and × or the icon hides it again. Nothing opens it on its own.</>,
  },
  {
    id: "videos-muxing",
    label: "Videos · while muxing",
    render: () => <Videos2 muxing />,
    note: <><b>The mux, seen from any page:</b> a small status in the toolbar with a thin progress line, and a spinner on Mux in the page bar. Click the status to go to Mux.</>,
  },
  {
    id: "subs",
    label: "Subtitles",
    render: () => <Subs2 />,
    note: (
      <>
        <b>Track settings always in view</b>, as the old Track configuration was: two rows under the track tabs, labels in one column.
        <ul>
          <li>Tabs on the list itself: × on hover deletes a track, + adds one.</li>
          <li>No big status box in the toolbar. A small status only shows up when something is running or has news.</li>
        </ul>
      </>
    ),
  },
  {
    id: "audio",
    label: "Audio",
    render: () => <Audio2 />,
    note: <><b>The same tabs and settings.</b> "Against" sits beside search. The small status shows the result: 12 measured, 4 to check. Double-click a row for everything about that file.</>,
  },
  {
    id: "audio-file",
    label: "Audio · file (double-click)",
    render: () => <AudioFile />,
    note: (
      <>
        <b>Everything the right panel showed for one file</b>, in a popup:
        <ul>
          <li>the delay;</li>
          <li>Apply anyway, Timeline details and Measure again;</li>
          <li>why it was flagged and what to do;</li>
          <li>the file's streams.</li>
        </ul>
      </>
    ),
  },
  {
    id: "chapters",
    label: "Chapters",
    render: () => <Chapters2 />,
    note: <><b>The page's settings in view:</b> the folder, add chapters from the files, discard the videos' own chapters, and one delay for every file.</>,
  },
  {
    id: "attachments",
    label: "Attachments",
    render: () => <Attachments2 />,
    note: <><b>The same:</b> the folder and all four switches in view above the list.</>,
  },
  {
    id: "edit",
    label: "Edit tracks",
    render: () => <EditTracks2 />,
    note: (
      <>
        <b>Bigger and cleaner popups.</b> Edit tracks is 1000 px wide:
        <ul>
          <li>the file on its own line;</li>
          <li>the kinds as tabs with their counts;</li>
          <li>full column names and taller rows;</li>
          <li>a × only on the row under the pointer.</li>
        </ul>
        Every other popup grows too.
      </>
    ),
  },
  {
    id: "prefs",
    label: "Preferences",
    render: () => <Prefs2 />,
    note: <><b>Preferences is bigger:</b> 920 × 660, with more room around each section.</>,
  },
  {
    id: "mux",
    label: "Mux · ready",
    render: () => <Mux2 phase="ready" />,
    note: (
      <>
        <b>Where the files go, in the toolbar's middle:</b> the folder and the name they get. Click it to change them.
        <ul>
          <li><b>Options</b> (next to Validate) keeps everything else out of sight until you open it: audio and subtitle languages, defaults, jobs at once, and the switches.</li>
          <li>The queue gets the whole page: every loaded video, no checkboxes. Double-click a job for its details.</li>
          <li>The bin beside Start muxing clears the queue.</li>
        </ul>
      </>
    ),
  },
  {
    id: "mux-edit",
    label: "Mux · Save to open",
    render: () => <Mux2 phase="ready" open="save" />,
    note: <><b>Save to</b> opens under the box: the folder, the file name and the name it makes, and the overwrite switch.</>,
  },
  {
    id: "mux-options",
    label: "Mux · Options open",
    render: () => <Mux2 phase="ready" open="options" />,
    note: (
      <>
        <b>Options</b>, only when opened:
        <ul>
          <li>which audio and subtitle languages to keep, and which is default;</li>
          <li><b>Remove from the source:</b> chapters, attachments and global tags. Attachments and global tags are on by default. These are the same switches as "Discard the videos' own" on the Chapters and Attachments pages, and the two always match.</li>
          <li>jobs at once and the run switches.</li>
        </ul>
      </>
    ),
  },
  {
    id: "mux-running",
    label: "Mux · muxing",
    render: () => <Mux2 phase="running" />,
    note: <><b>While muxing,</b> the small status takes the toolbar's middle, and Options is locked. A red dot on the Output icon means something new went wrong while Output was hidden.</>,
  },
  {
    id: "mux-job",
    label: "Mux · job (double-click)",
    render: () => <JobDetails />,
    note: <><b>Job details</b> opens with a double-click on a job. It lists the tracks the new file keeps or adds, with the removed ones folded behind a small "1 removed" dropdown. Then the warnings, what happens to chapters, attachments and tags, and the command.</>,
  },
];

const find = (id: string) => SCREENS.find((s) => s.id === id) ?? SCREENS[0];
const W = 1180;
const H = 780;

function read() {
  const h = new URLSearchParams(location.hash.slice(1));
  return { s: h.get("s") ?? "videos", theme: (h.get("theme") === "light" ? "light" : "dark") as "dark" | "light" };
}

function App() {
  const [st, setSt] = useState(read);
  const [nonce, setNonce] = useState(0);
  const go = useCallback((id: string) => {
    setSt((s) => ({ ...s, s: id }));
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const h = new URLSearchParams({ s: st.s });
    if (st.theme === "light") h.set("theme", "light");
    history.replaceState(null, "", `#${h}`);
  }, [st]);

  useEffect(() => {
    const onHash = () => setSt(read);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const i = SCREENS.findIndex((x) => x.id === st.s);
      if (e.key === "ArrowRight" || e.key === "ArrowDown") go(SCREENS[(i + 1) % SCREENS.length].id);
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") go(SCREENS[(i - 1 + SCREENS.length) % SCREENS.length].id);
      if (e.key === "t") setSt((s) => ({ ...s, theme: s.theme === "dark" ? "light" : "dark" }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [st.s, go]);

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
  }, []);

  const live: Proto = { go, live: true, theme: st.theme, mac: false };
  const screen = find(st.s);

  return (
    <div className={`stage ${st.theme}`}>
      <aside className="story">
        <h1>MKVBatchMux — revision 2</h1>
        <div className="opts">
          <button type="button" className={st.theme === "dark" ? "on" : ""} onClick={() => setSt((s) => ({ ...s, theme: "dark" }))}>Dark</button>
          <button type="button" className={st.theme === "light" ? "on" : ""} onClick={() => setSt((s) => ({ ...s, theme: "light" }))}>Light</button>
        </div>
        {SCREENS.map((x, i) => (
          <button key={x.id} type="button" className={`s${x.id === st.s ? " on" : ""}`} onClick={() => go(x.id)}>
            <i>{i + 1}</i>
            {x.label}
          </button>
        ))}
        <div className="note">{screen.note}</div>
        <div className="foot">← → step · T theme. Rows are clickable: click selects, double-click opens.</div>
      </aside>
      <div className="desk" ref={desk}>
        <div id="shot" style={{ position: "absolute", left: "50%", top: "50%", width: W, height: H, transform: `translate(-50%, -50%) scale(${k})` }}>
          <Ctx.Provider value={live}>
            <div key={`${st.s}-${nonce}`}>{screen.render()}</div>
          </Ctx.Provider>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
