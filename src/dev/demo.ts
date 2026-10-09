/** Demo harness: the real app in a plain browser, with the desktop shell
 *  mocked.
 *
 *  Loaded only by `src/app/main.tsx`, only in `vite dev`, only when the URL
 *  has `?demo`. Nothing here reaches a production build: Vite drops the
 *  import with the `import.meta.env.DEV` branch around it, and the marker
 *  string below must not appear in dist/.
 *
 *    /?demo=empty      nothing loaded
 *    /?demo=ready      Goblin S01: 16 videos, Hindi dubs, English subtitles,
 *                      chapters and fonts loaded (the default)
 *    /?demo=measured   ready, then every dub measured (one different cut, one
 *                      frame-rate change, one weak match, one broken file)
 *    /?demo=muxing     ready and queued, muxing under way
 *    /?demo=done       muxed, one job failed
 *    /?demo=unlinked   ready, with a 17th dub that has no video
 *    /?demo=engine     ready, the audio analysis engine missing
 *
 *  Options: `&page=audio` opens that page at the end, `&multi=1` makes E01's
 *  dub one file of three (Hindi, Tamil, Telugu), `&speed=0.25` runs the
 *  mocked commands four times faster, `&update=1` offers version 1.71.0,
 *  `&tools=missing` reports MediaInfo missing, `&os=mac|windows` picks the
 *  window chrome (src/ui/frame.tsx). `window.__demo.drop([...paths])` fakes a
 *  file drop on the page showing. */

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

import type { MuxStartRequest, ScanRequest } from "@/shared/lib/backend";
import type { ExternalFile, MuxPreviewResult, VideoFile } from "@/shared/types";
import type { MeasureStartRequest } from "@/shared/types/audiosync";

import {
  CHAP_DIR,
  DEMO_OPTIONS,
  DUB_DIR,
  EPISODES,
  FONTS,
  FONT_DIR,
  OUT_DIR,
  SHOW_DIR,
  SUB_DIR,
  chapterFile,
  dubFile,
  measureResult,
  muxLines,
  subFile,
  videoFile,
  videoPaths,
} from "./fixtures";

/** Unique string the production build must not contain. */
export const MARKER = "__MKVBATCHMUX_DEMO__";

type Args = Record<string, unknown>;
type Handler = { event: string; id: number };

const params = () => new URLSearchParams(typeof location === "undefined" ? "" : location.search);

let speed = 1;
const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms * speed));

// ----------------------------------------------------------------- events

const listeners = new Map<number, Handler>();
let nextEventId = 1;

function emitEvent(event: string, payload: unknown) {
  for (const [eventId, handler] of listeners) {
    if (handler.event !== event) continue;
    const callback = (window as unknown as Record<string, ((e: unknown) => void) | undefined>)[`_${handler.id}`];
    callback?.({ event, windowLabel: "main", id: eventId, payload });
  }
}

// ------------------------------------------------------------------ state

interface DemoState {
  scenario: string;
  options: typeof DEMO_OPTIONS;
  cancelledScans: Set<string>;
  mux: { paused: boolean; stopped: boolean; running: boolean };
  measureCancelled: boolean;
  extraDub: boolean;
  /** E01's dub is one file with three dubs in it, each its own offset. */
  multiDub: boolean;
  engine: boolean;
  update: boolean;
  mediainfo: boolean;
}

let state: DemoState;

const nameOf = (path: string) => path.replace(/^.*[\\/]/, "");
const episodeOf = (name: string) => {
  const match = /S01E(\d\d)/.exec(name);
  return match ? Number(match[1]) - 1 : 0;
};

/** The page on screen, read from the page bar: the folder picker answers
 *  with that page's fixture folder. */
const activePage = () => document.querySelector(".pg.on")?.textContent?.trim() ?? "Videos";

function pickFolder(): string {
  const page = activePage();
  if (page.startsWith("Audio")) return DUB_DIR;
  if (page.startsWith("Subtitles")) return SUB_DIR;
  if (page.startsWith("Chapters")) return CHAP_DIR;
  if (page.startsWith("Attachments")) return FONT_DIR;
  if (page.startsWith("Mux")) return OUT_DIR;
  return SHOW_DIR;
}

function scan(request: ScanRequest): (VideoFile | ExternalFile)[] {
  const all = Array.from({ length: EPISODES }, (_, i) => i);
  if (request.type === "video") return all.map((i) => videoFile(i, false));
  if (request.type === "audio") return [...all.map((i) => (i === 0 && state.multiDub ? multiDubFile() : dubFile(i))), ...(state.extraDub ? [dubFile(EPISODES, true)] : [])];
  if (request.type === "subtitle") return all.map(subFile);
  if (request.type === "chapter") return all.map(chapterFile);
  return FONTS;
}

function inspect(paths: string[], type: string): (VideoFile | ExternalFile)[] {
  return paths.map((path) => {
    const name = nameOf(path);
    const i = episodeOf(name);
    if (type === "video") return { ...videoFile(i, true), path, name };
    if (type === "audio") return { ...dubFile(i), path, name, id: `dropped-${name}` };
    if (type === "subtitle") return { ...subFile(i), path, name, id: `dropped-${name}` };
    return { id: `dropped-${name}`, name, path, type: type as ExternalFile["type"], size: 2048 };
  });
}

async function streamInspect(request: { scan_id: string; paths: string[]; type: string }) {
  const chunk = 3;
  for (let at = 0; at < request.paths.length; at += chunk) {
    await nap(260);
    if (state.cancelledScans.has(request.scan_id)) return;
    const paths = request.paths.slice(at, at + chunk);
    emitEvent("inspect-paths-stream-chunk", {
      scanId: request.scan_id,
      processed: Math.min(request.paths.length, at + chunk),
      total: request.paths.length,
      items: inspect(paths, request.type),
    });
  }
  emitEvent("inspect-paths-stream-done", { scanId: request.scan_id, total: request.paths.length });
}

function multiDubFile(): ExternalFile {
  const name = "Goblin.S01E01.3Audio.DDP5.1.mkv";
  const dub = (id: string, language: string) => ({ id, type: "audio" as const, codec: "E-AC3", language, name: "Surround 5.1", bitrate: 640_000, isDefault: id === "1" });
  return { ...dubFile(0), id: "dub-01-multi", name, path: `${DUB_DIR}\\${name}`, tracks: [{ id: "0", type: "video" }, dub("1", "hin"), dub("2", "tam"), dub("3", "tel"), { id: "4", type: "subtitle", codec: "SubRip/SRT", language: "eng", name: "SDH" }] };
}

async function measure(request: MeasureStartRequest) {
  let processed = 0;
  const total = request.pairs.length;
  const queue = [...request.pairs];
  // As the real engine does: several pairs at once, each announced by its
  // video when it starts and as its windows complete; the progress event
  // comes after a result and names the pair that just finished.
  const worker = async () => {
    while (queue.length > 0) {
      const pair = queue.shift()!;
      const video = nameOf(pair.primaryPath);
      emitEvent("measure-delays-file", { runId: request.runId, file: video, percent: 0 });
      const windows = 6;
      for (let w = 1; w <= windows; w++) {
        await nap((700 + (episodeOf(nameOf(pair.secondaryPath)) % 3) * 400) / windows);
        if (state.measureCancelled) return;
        emitEvent("measure-delays-file", { runId: request.runId, file: video, percent: Math.round(5 + (75 * w) / windows) });
      }
      const i = episodeOf(nameOf(pair.secondaryPath));
      emitEvent("audiosync-log", `Measured ${nameOf(pair.secondaryPath)} against ${video}`);
      const result = measureResult(i, video, nameOf(pair.secondaryPath));
      // Each dub of a multi-dub file sits at its own offset.
      const shift = pair.secondaryTrack * 160;
      emitEvent("measure-delays-result", {
        runId: request.runId,
        key: pair.key,
        result: { ...result, delayMs: (result.delayMs ?? 0) + shift, primaryTrack: pair.primaryTrack, secondaryTrack: pair.secondaryTrack },
      });
      processed += 1;
      emitEvent("measure-delays-progress", { runId: request.runId, processed, total, current: video });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, request.maxWorkers || 4) }, worker));
  emitEvent("measure-delays-done", { runId: request.runId, cancelled: state.measureCancelled, error: null });
}

async function mux(request: MuxStartRequest) {
  state.mux = { paused: false, stopped: false, running: true };
  const jobs = [...request.jobs];
  const parallel = Math.min(4, request.settings.maxParallelJobs || 1);
  const runJob = async (job: MuxStartRequest["jobs"][number]) => {
    const out = `${request.settings.destinationDir || SHOW_DIR}\\${job.video.name}`;
    for (const line of muxLines(job.video.path, job.audios[0]?.path ?? null, out)) emitEvent("mux-log", { job_id: job.id, line });
    // E07 sits on a share the demo cannot read.
    if (job.video.name.includes("S01E07")) {
      await nap(900);
      const error = `'${job.video.path}' could not be opened for reading: permission denied.`;
      emitEvent("mux-log", { job_id: job.id, line: `Error: ${error}` });
      emitEvent("mux-progress", { job_id: job.id, status: "error", progress: 0, error_message: error });
      return;
    }
    for (let progress = 5; progress <= 100; progress += 5) {
      await nap(180 + (episodeOf(job.video.name) % 3) * 40);
      if (state.mux.stopped) {
        emitEvent("mux-progress", { job_id: job.id, status: "stopped", progress });
        return;
      }
      emitEvent("mux-progress", { job_id: job.id, status: progress < 100 ? "processing" : "completed", progress, size_after: progress === 100 ? Math.round(job.video.size * 1.07) : undefined });
    }
    emitEvent("mux-log", { job_id: job.id, line: `Multiplexing took ${20 + (episodeOf(job.video.name) % 9)} seconds.` });
  };
  const worker = async () => {
    while (jobs.length > 0) {
      if (state.mux.stopped) return;
      while (state.mux.paused && !state.mux.stopped) await nap(200);
      const job = jobs.shift();
      if (job) await runJob(job);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  if (state.mux.stopped) for (const job of jobs) emitEvent("mux-progress", { job_id: job.id, status: "stopped", progress: 0 });
  state.mux.running = false;
}

function preview(request: MuxStartRequest): MuxPreviewResult[] {
  return request.jobs.map((job) => {
    const i = episodeOf(job.video.name);
    const warnings =
      i === 3 ? ["The subtitle ends 4.2 s after the video.", "Audio 1 has a delay above 1 s."] : i === 10 ? ["The chapters end after the video."] : [];
    const audio = job.audios[0];
    return {
      jobId: job.id,
      command: `mkvmerge --output "${request.settings.destinationDir || SHOW_DIR}\\${job.video.name}" --no-attachments --no-global-tags "${job.video.path}"${audio ? ` --language 0:${audio.language ?? "und"} --sync 0:${Math.round((audio.delay ?? 0) * 1000)} "${audio.path}"` : ""}`,
      warnings,
      plan: { video: job.video.path, output: job.video.name, audios: job.audios, subtitles: job.subtitles, chapters: job.chapters, attachments: job.attachments },
    };
  });
}

// ------------------------------------------------------------------ IPC

async function handle(cmd: string, args: Args): Promise<unknown> {
  const request = (args.request ?? {}) as Record<string, unknown>;
  switch (cmd) {
    case "tauri":
      return tauriModule(args);
    case "get_app_paths":
      return { app_data_dir: "C:\\Users\\demo\\AppData\\Roaming\\MKVBatchMux", options_path: "setting.json", log_path: "muxing_log_file.txt" };
    case "load_options":
      return structuredClone(state.options);
    case "save_options":
      state.options = structuredClone(args.options as typeof DEMO_OPTIONS);
      return null;
    case "scan_media":
      await nap(300);
      return scan(request as unknown as ScanRequest);
    case "inspect_paths":
      await nap(200);
      return inspect((request.paths as string[]) ?? [], String(request.type));
    case "inspect_paths_stream":
      void streamInspect(request as { scan_id: string; paths: string[]; type: string });
      return null;
    case "cancel_scan":
      state.cancelledScans.add(String(args.scanId));
      return null;
    case "preview_mux":
      await nap(900);
      return preview(request as unknown as MuxStartRequest);
    case "start_muxing":
      if (state.mux.running) throw "A mux batch is already running.";
      void mux(request as unknown as MuxStartRequest);
      return null;
    case "pause_muxing":
      state.mux.paused = true;
      return null;
    case "resume_muxing":
      state.mux.paused = false;
      return null;
    case "stop_muxing":
      state.mux.stopped = true;
      return null;
    case "open_log_file":
      return null;
    case "dependency_status":
      return [
        { id: "mkvtoolnix", name: "MKVToolNix", purpose: "Performs the actual muxing (mkvmerge, mkvpropedit).", available: true, version: "mkvmerge v88.0 ('All I Know') 64-bit", bundled: false, path: null, required: true, downloadUrl: "https://mkvtoolnix.download/downloads.html" },
        { id: "mediainfo", name: "MediaInfo CLI", purpose: "Reads track details from your files.", available: state.mediainfo, version: state.mediainfo ? "MediaInfo Command line, MediaInfoLib - v24.12" : null, bundled: false, path: null, required: true, downloadUrl: "https://mediaarea.net/en/MediaInfo/Download/Windows" },
        { id: "ffmpeg", name: "FFmpeg", purpose: "Decodes audio for delay measurement.", available: true, version: "ffmpeg version 7.1-full_build-www.gyan.dev", bundled: false, path: "C:\\ffmpeg\\bin\\ffmpeg.exe", required: false, downloadUrl: "https://www.gyan.dev/ffmpeg/builds/" },
        { id: "audiosync", name: "Audio analysis engine", purpose: "Measures how far a dub drifts from the video.", available: state.engine, version: state.engine ? "AudioSyncMaster v2.15.0" : null, bundled: true, path: null, required: false, downloadUrl: "https://github.com/AdkHex/AudioSyncMaster/releases" },
      ];
    case "install_dependency":
      await nap(2500);
      state.mediainfo = true;
      return "Installed MediaInfo CLI 24.12.";
    case "audiosync_engine_status":
      return state.engine
        ? { engineAvailable: true, ffmpegAvailable: true, enginePath: "C:\\Program Files\\MKVBatchMux\\engine\\audiosync.exe", engineVersion: "AudioSyncMaster v2.15.0", message: null }
        : { engineAvailable: false, ffmpegAvailable: true, enginePath: null, engineVersion: null, message: "The audio analysis engine is not installed. Reinstall MKVBatchMux to get it back." };
    case "list_reference_tracks":
      return { files: [] };
    case "measure_delays_start":
      state.measureCancelled = false;
      void measure(request as unknown as MeasureStartRequest);
      return null;
    case "measure_delays_cancel":
      state.measureCancelled = true;
      return null;
    case "scan_timeline_start":
      setTimeout(() => emitEvent("timeline-scan-done", { runId: (request as { runId: string }).runId, cancelled: false, error: null }), 100);
      return null;
    default:
      console.warn(`[demo] unhandled command ${cmd}`, args);
      return null;
  }
}

async function tauriModule(args: Args): Promise<unknown> {
  const module = args.__tauriModule as string;
  const message = (args.message ?? {}) as Record<string, unknown>;
  if (module === "Event") {
    if (message.cmd === "listen") {
      const eventId = nextEventId++;
      listeners.set(eventId, { event: String(message.event), id: Number(message.handler) });
      return eventId;
    }
    if (message.cmd === "unlisten") {
      listeners.delete(Number(message.eventId));
      return null;
    }
    if (message.cmd === "emit") {
      const event = String(message.event);
      if (event === "tauri://update") {
        setTimeout(() => {
          if (state.update) emitEvent("tauri://update-available", { version: "1.71.0", date: "2026-09-30", body: "Workstation layout, folders dropped on the window, History." });
          else emitEvent("tauri://update-status", { status: "UPTODATE" });
        }, 400);
      } else if (event === "tauri://update-install") {
        setTimeout(() => emitEvent("tauri://update-status", { status: "DONE" }), 2500 * speed);
      } else emitEvent(event, message.payload);
      return null;
    }
  }
  if (module === "Window") {
    const type = ((message.data as Record<string, unknown> | undefined)?.cmd as Record<string, unknown> | undefined)?.type;
    if (type === "isMaximized") return false;
    if (type === "scaleFactor") return 1;
    return null;
  }
  if (module === "Dialog") {
    const options = (message.options ?? {}) as Record<string, unknown>;
    if (options.directory) return pickFolder();
    if (activePage().startsWith("Attachments")) return FONTS.map((f) => f.path);
    return options.multiple ? [`${SUB_DIR}\\Goblin.S01E03.en.forced.srt`] : `${SUB_DIR}\\Goblin.S01E03.en.forced.srt`;
  }
  if (module === "Shell" || module === "Process") return null;
  console.warn("[demo] unhandled module", module, message);
  return null;
}

// -------------------------------------------------------------- scenarios

const key = (k: string, mods: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...mods }));
const drop = (paths: string[]) => emitEvent("tauri://file-drop", paths);
const PAGE_KEYS: Record<string, string> = { videos: "1", subtitles: "2", audio: "3", chapters: "4", attachments: "5", mux: "6" };
const go = (page: string) => key(PAGE_KEYS[page] ?? "1", { ctrlKey: true });

async function waitFor(test: () => boolean, ms = 20000) {
  const until = Date.now() + ms;
  while (!test() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
}

const clickButton = (text: RegExp) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>(".pageview:not([hidden]) button")].find((b) => text.test(b.textContent ?? "") && !b.disabled);
  button?.click();
  return Boolean(button);
};

/** Load the season on every page, the way a user would: a folder dropped
 *  on each page in turn. */
async function loadSeason() {
  await waitFor(() => Boolean(document.querySelector(".pagebar")));
  await nap(150);
  go("videos");
  drop([SHOW_DIR]);
  await waitFor(() => document.querySelectorAll(".pageview:not([hidden]) .tbl .tr").length >= EPISODES && !document.querySelector(".pageview:not([hidden]) .lcd .ring"));
  for (const [page, folder] of [["subtitles", SUB_DIR], ["audio", DUB_DIR], ["chapters", CHAP_DIR], ["attachments", FONT_DIR]] as const) {
    go(page);
    await nap(80);
    drop([folder]);
    await nap(500);
  }
}

async function run(scenario: string) {
  if (scenario === "empty") return;
  await loadSeason();
  if (scenario === "measured" || scenario === "applied") {
    go("audio");
    await nap(200);
    key("Enter");
    await waitFor(() => !document.querySelector(".pageview:not([hidden]) .lcd .ring"), 60000);
    if (scenario === "applied") clickButton(/^Apply \d+ delays?/);
  }
  if (scenario === "muxing" || scenario === "done") {
    // The queue is every loaded video: nothing to add, just start.
    go("mux");
    await nap(300);
    key("Enter");
    if (scenario === "done") await waitFor(() => !document.querySelector(".pageview:not([hidden]) .lcd .ring"), 120000);
  }
  const page = params().get("page");
  go(page ?? (scenario === "measured" || scenario === "applied" ? "audio" : scenario === "muxing" || scenario === "done" ? "mux" : "videos"));
}

export function installDemo(scenario: string) {
  const options = params();
  speed = Number(options.get("speed") ?? "1") || 1;
  state = {
    scenario,
    options: structuredClone(DEMO_OPTIONS),
    cancelledScans: new Set(),
    mux: { paused: false, stopped: false, running: false },
    measureCancelled: false,
    extraDub: scenario === "unlinked",
    multiDub: options.get("multi") === "1",
    engine: scenario !== "engine",
    update: options.get("update") === "1",
    mediainfo: options.get("tools") !== "missing",
  };
  mockWindows("main");
  mockIPC((cmd, args) => handle(cmd, (args ?? {}) as Args));
  (window as unknown as Record<string, unknown>).__demo = { marker: MARKER, drop, key, go, paths: videoPaths };
  void run(scenario);
}
