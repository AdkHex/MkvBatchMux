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
 *    /?demo=done       muxed and verified: E03 with a warning, E05 failing
 *                      verification (its dub went in without its delay), E07
 *                      unreadable
 *    /?demo=unlinked   ready, with a 17th dub that has no video
 *    /?demo=engine     ready, the audio analysis engine missing
 *
 *  Options: `&page=audio` opens that page at the end, `&multi=1` makes E01's
 *  dub one file of three (Hindi, Tamil, Telugu), `&speed=0.25` runs the
 *  mocked commands four times faster, `&update=1` offers version 1.71.0,
 *  `&tools=missing` reports MediaInfo missing, `&pairing=gap` leaves E05
 *  without a dub and names E07's "Hindi dub, final mix.eac3" (no episode in
 *  it: Match by audio places it), `&os=mac|windows` picks the
 *  window chrome (src/ui/frame.tsx). `window.__demo.drop([...paths])` fakes a
 *  file drop on the page showing.
 *
 *  Recipes, sessions and watch folders (Feature 5): `&recipes=1` saves a
 *  sample recipe ("Goblin — Hindi") and a watch folder on the show's folder
 *  that uses it, off; `&watch=1` leaves that watch folder on, so it starts
 *  with the app. `window.__demo.watch([...paths])` fakes new files landing
 *  in the first watch folder that is on (no paths: Goblin E17 and its dub);
 *  the store, session files and watchers live in memory.
 *
 *  Conform and Sync subtitles (Features 1 and 3): `/?demo=measured&page=audio`
 *  offers Conform on E05, the different cut, which completes and checks out.
 *  On the Subtitles page, Sync subtitles measures every row against the
 *  video's own English track, except E11, whose release carries no subtitles
 *  and is synced against its speech, not sure enough to be filled in (Apply
 *  anyway); E09's subtitle was timed for PAL and comes back as a re-timed
 *  copy; the rest are plain delays. */

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

import type { MuxStartRequest, ScanRequest } from "@/shared/lib/backend";
import type { ExternalFile, MuxPreviewResult, VideoFile } from "@/shared/types";
import type { MeasureStartRequest } from "@/shared/types/audiosync";
import type { ConformRequest, SubsyncRequest } from "@/shared/types/engineFeatures";
import type { VerificationCheck, VerificationReport } from "@/shared/types/verify";
import type { Recipe, WatchFolderConfig, WatchInfo, WatchRequest } from "@/shared/types/recipes";

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
  /** No dub for E05, and E07's under a name without its episode. */
  pairingGap: boolean;
  engine: boolean;
  update: boolean;
  mediainfo: boolean;
  /** The app data folder's JSON files, by store key. */
  store: Record<string, unknown>;
  /** Session files saved this run, by path. */
  sessions: Record<string, unknown>;
  watchers: Map<string, { request: WatchRequest; paused: boolean; reported: number }>;
  /** Episodes that "arrived" in a watch folder (index from 0), by video path. */
  arrivals: Map<string, number>;
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

/** E07's dub under `&pairing=gap`: a name pairing by episode cannot place. */
const RENAMED_DUB = "Hindi dub, final mix.eac3";
/** The episode a dub really is, whatever its name says. */
const trueEpisodeOf = (name: string) => (name === RENAMED_DUB ? 6 : episodeOf(name));

function demoDub(i: number): ExternalFile {
  if (i === 0 && state.multiDub) return multiDubFile();
  if (i === 6 && state.pairingGap) return { ...dubFile(6), id: "dub-renamed", name: RENAMED_DUB, path: `${DUB_DIR}\\${RENAMED_DUB}` };
  return dubFile(i);
}

function scan(request: ScanRequest): (VideoFile | ExternalFile)[] {
  const all = Array.from({ length: EPISODES }, (_, i) => i);
  if (request.type === "video") return all.map((i) => videoFile(i, false));
  if (request.type === "audio") return [...all.filter((i) => !(state.pairingGap && i === 4)).map(demoDub), ...(state.extraDub ? [dubFile(EPISODES, true)] : [])];
  if (request.type === "subtitle") return all.map(subFile);
  if (request.type === "chapter") return all.map(chapterFile);
  return FONTS;
}

function inspect(paths: string[], type: string): (VideoFile | ExternalFile)[] {
  return paths.map((path) => {
    const name = nameOf(path);
    const i = episodeOf(name);
    // E11's release has no subtitles of its own: Sync subtitles listens to its speech.
    if (type === "video") return { ...videoFile(i, true), path, name, ...(i === 10 ? { tracks: videoFile(i, true).tracks.filter((t) => t.type !== "subtitle") } : {}) };
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
  // Match by audio: a quick listen that hears the right episode, and not the others.
  const matching = request.runId.startsWith("match-");
  // As the real engine does: several pairs at once, each announced by its
  // video when it starts and as its windows complete; the progress event
  // comes after a result and names the pair that just finished.
  const worker = async () => {
    while (queue.length > 0) {
      const pair = queue.shift()!;
      const video = nameOf(pair.primaryPath);
      emitEvent("measure-delays-file", { runId: request.runId, file: video, percent: 0 });
      const windows = matching ? 2 : 6;
      for (let w = 1; w <= windows; w++) {
        await nap((700 + (episodeOf(nameOf(pair.secondaryPath)) % 3) * 400) / windows);
        if (state.measureCancelled) return;
        emitEvent("measure-delays-file", { runId: request.runId, file: video, percent: Math.round(5 + (75 * w) / windows) });
      }
      const i = episodeOf(nameOf(pair.secondaryPath));
      emitEvent("audiosync-log", `Measured ${nameOf(pair.secondaryPath)} against ${video}`);
      const result = matching
        ? { ...measureResult(i, video, nameOf(pair.secondaryPath)), confidence: trueEpisodeOf(nameOf(pair.secondaryPath)) === episodeOf(video) ? 0.93 : 0.11 }
        : measureResult(i, video, nameOf(pair.secondaryPath));
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

/** Conform: each dub laid onto its video's cut, checked, as the engine does. */
async function conform(request: ConformRequest) {
  const total = request.pairs.length;
  let processed = 0;
  for (const pair of request.pairs) {
    const stages = request.mode === "lossless" ? ["Planning", "Cutting the dub's frames", "Checking the conformed track"] : ["Planning", "Rendering", "Checking the finished track"];
    for (const [n, stage] of stages.entries()) {
      for (const percent of [10, 55, 90]) {
        await nap(260);
        if (state.measureCancelled) return emitEvent("conform-done", { runId: request.runId, cancelled: true, error: null });
        const overall = request.mode === "lossless" ? Math.round((n * 100 + percent) / stages.length) : percent;
        emitEvent("conform-progress", { runId: request.runId, key: pair.key, percent: overall, stage, processed, total });
      }
    }
    const dub = nameOf(pair.secondaryPath).replace(/\.[^.]+$/, "");
    const folder = request.outputDir ?? `${pair.secondaryPath.replace(/[\\/][^\\/]*$/, "")}\\MKVBatchMux conformed`;
    const lossless = request.mode === "lossless";
    emitEvent("audiosync-log", `Conformed ${nameOf(pair.secondaryPath)} to ${nameOf(pair.primaryPath)}`);
    emitEvent("conform-result", {
      runId: request.runId,
      key: pair.key,
      outputPath: `${folder}\\${dub}.conformed.${lossless ? "mka" : request.codec === "flac" ? "flac" : "eac3"}`,
      mode: request.mode,
      codec: request.codec === "flac" && !lossless ? "flac" : "eac3",
      verified: true,
      verificationText: lossless
        ? "Checked against the video: the dub sits within one 32 ms frame throughout (-8.0 to +13.4 ms)."
        : "Checked against the video at 12 spots and a sweep of 40 windows: every one within lip-sync, the worst 0.4 ms.",
      residualMs: lossless ? 13.4 : -0.4,
      plan: null,
      description: "Stretch 1: 0:00 – 41:07 at +1.312 s\nGap 41:07 – 41:19: 12.5 s of the video the dub lacks (silence)\nStretch 2: 41:19 – 1:03:57 at -11.168 s",
      error: null,
      fallbackReason: null,
    });
    processed += 1;
    emitEvent("conform-progress", { runId: request.runId, key: pair.key, percent: 100, stage: null, processed, total });
  }
  emitEvent("conform-done", { runId: request.runId, cancelled: false, error: null });
}

/** Sync subtitles: E09 timed for PAL (a re-timed copy), E11 against speech
 *  and not sure, the rest plain delays against the video's own track. */
async function subsync(request: SubsyncRequest) {
  const total = request.jobs.length;
  let processed = 0;
  for (const job of request.jobs) {
    for (const [percent, stage] of [[15, "Reading the subtitle"], [45, request.engine === "audio" ? "Finding speech" : "Reading the reference"], [80, "Lining up"]] as const) {
      await nap(220);
      if (state.measureCancelled) return emitEvent("subsync-done", { runId: request.runId, cancelled: true, error: null });
      emitEvent("subsync-progress", { runId: request.runId, key: job.key, percent, stage, processed, total });
    }
    const i = episodeOf(nameOf(job.subtitlePath));
    const engineName = request.engine === "audio" ? "the video's speech" : "the reference subtitle";
    const copy = `${job.subtitlePath.replace(/[\\/][^\\/]*$/, "")}\\MKVBatchMux synced\\${nameOf(job.subtitlePath)}`;
    const base = { runId: request.runId, key: job.key, method: request.engine, retimedPath: copy, error: null, applied: true, splitPoints: [], warnings: [] as string[], splits: 0, framerate: null as string | null };
    const result =
      i === 8
        ? { ...base, offsetS: -0.0722, ratio: 1.0427083333, score: 0.97, confidence: "high", framerate: "25 → 23.976", description: `Matched against ${engineName} (high confidence, score 0.97): shifted by -0.072 s, converted 25 → 23.976 fps.` }
        : request.engine === "audio"
          ? { ...base, offsetS: 0.31, ratio: 1, score: 0.58, confidence: "medium", description: `Matched against ${engineName} (medium confidence, score 0.58): shifted by +0.310 s.` }
          : (() => {
              const offset = -(2.5 + (i % 4) * 0.042);
              return { ...base, offsetS: offset, ratio: 1, score: 1, confidence: "high", description: `Matched against ${engineName} (high confidence, score 1.00): shifted by ${offset.toFixed(3)} s.` };
            })();
    emitEvent("audiosync-log", `Synced ${nameOf(job.subtitlePath)} against ${nameOf(job.videoPath)}`);
    emitEvent("subsync-result", result);
    processed += 1;
    emitEvent("subsync-progress", { runId: request.runId, key: job.key, percent: 100, stage: null, processed, total });
  }
  emitEvent("subsync-done", { runId: request.runId, cancelled: false, error: null });
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
      if (progress < 100) emitEvent("mux-progress", { job_id: job.id, status: "processing", progress });
    }
    emitEvent("mux-log", { job_id: job.id, line: `Multiplexing took ${20 + (episodeOf(job.video.name) % 9)} seconds.` });
    const size_after = Math.round(job.video.size * 1.07);
    if (request.settings.verifyOutput === false) {
      emitEvent("mux-progress", { job_id: job.id, status: "completed", progress: 100, size_after });
      return;
    }
    // As the backend does: the output is checked before it counts as done.
    emitEvent("mux-progress", { job_id: job.id, status: "processing", progress: 100, message: "Verifying the output", stage: "verifying" });
    await nap(job.audios.length && request.settings.verifySync !== false ? 900 : 250);
    const verification = verificationOf(job, request.settings, out);
    if (verification.ok) {
      emitEvent("mux-progress", { job_id: job.id, status: "completed", progress: 100, size_after, verification });
      return;
    }
    const failure = verification.checks.find((check) => check.status === "fail")!;
    emitEvent("mux-log", { job_id: job.id, line: `Kept the unverified output as ${verification.keptPath}; the source was not touched` });
    emitEvent("mux-progress", { job_id: job.id, status: "error", progress: 0, message: "Verification failed", error_message: `Verification failed: ${failure.detail}`, verification });
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

/** What checking a demo job's output finds: E03's dub runs short (a
 *  warning), E05's went in without its delay (a failure), the rest pass. */
function verificationOf(job: MuxStartRequest["jobs"][number], settings: MuxStartRequest["settings"], out: string): VerificationReport {
  const i = episodeOf(job.video.name);
  const dub = job.audios[0];
  const pass = (id: string, label: string, detail: string): VerificationCheck => ({ id, label, status: "pass", detail });
  const skip = (id: string, label: string, detail: string): VerificationCheck => ({ id, label, status: "skip", detail });
  const checks: VerificationCheck[] = [
    pass("tracks", "Tracks", `1 video, ${dub ? 2 : 1} audio, ${1 + job.subtitles.length} subtitle tracks`),
    dub || job.subtitles.length ? pass("added", "Added tracks", `${job.audios.length + job.subtitles.length} added tracks there, each in its language`) : skip("added", "Added tracks", "Nothing added"),
    pass("duration", "Duration", "23:41, as the source"),
    job.chapters.length ? pass("chapters", "Chapters", "6 chapters") : skip("chapters", "Chapters", "None added"),
    job.attachments.length ? pass("attachments", "Attachments", `${job.attachments.length} files added`) : skip("attachments", "Attachments", "None added"),
    pass("order", "Track order", "As asked"),
    pass("flags", "Names and flags", "As asked"),
    !dub
      ? skip("audioLength", "Added audio length", "No audio added")
      : i === 2
        ? { id: "audioLength", label: "Added audio length", status: "warn", detail: `${dub.name} runs 22:58.4, 3.0 % shorter than the video` }
        : pass("audioLength", "Added audio length", "Each runs as long as the video"),
  ];
  let residualMs: number | null = null;
  let syncConfidence: number | null = null;
  if (!dub) checks.push(skip("sync", "Sync", "No audio added"));
  else if (settings.verifySync === false) checks.push(skip("sync", "Sync", "Turned off"));
  else {
    const tolerance = settings.verifySyncToleranceMs ?? 40;
    residualMs = i === 4 ? 1312.4 : 3 + (i % 5) * 2.1;
    syncConfidence = i === 4 ? 0.998 : 0.97;
    checks.push(
      residualMs > tolerance
        ? { id: "sync", label: `Sync: ${dub.name}`, status: "fail", detail: `${dub.name} plays ${Math.round(residualMs)} ms late, more than the ${tolerance} ms allowed (100 % confidence)` }
        : pass("sync", `Sync: ${dub.name}`, `In sync: ${Math.round(residualMs)} ms late, within ${tolerance} ms (97 % confidence)`),
    );
  }
  const ok = !checks.some((check) => check.status === "fail");
  return { ok, checks, residualMs, syncConfidence, keptPath: ok ? null : out.replace(/\.mkv$/, ".unverified.mkv") };
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
      return [...scan(request as unknown as ScanRequest), ...arrivedFiles(request as unknown as ScanRequest)];
    case "inspect_paths":
      await nap(200);
      return inspectArrived((request.paths as string[]) ?? [], String(request.type));
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
    case "conform_dubs_start":
      state.measureCancelled = false;
      void conform(request as unknown as ConformRequest);
      return null;
    case "subsync_start":
      state.measureCancelled = false;
      void subsync(request as unknown as SubsyncRequest);
      return null;
    case "store_read":
      return structuredClone(state.store[String(args.key)] ?? null);
    case "store_write":
      state.store[String(args.key)] = structuredClone(args.value);
      return null;
    case "store_delete":
      delete state.store[String(args.key)];
      return null;
    case "store_location":
      return { dir: "C:\\Users\\demo\\AppData\\Roaming\\MKVBatchMux" };
    case "session_save":
      state.sessions[String(args.path)] = structuredClone(args.value);
      return null;
    case "session_open":
      if (!(String(args.path) in state.sessions)) throw `${args.path} doesn't exist.`;
      return structuredClone(state.sessions[String(args.path)]);
    case "paths_exist":
      return ((args.paths as string[]) ?? []).map((path) => Boolean(path.trim()));
    case "watch_start":
      return watchStart(request as unknown as WatchRequest);
    case "watch_stop": {
      const had = state.watchers.delete(String(args.id));
      if (had) setTimeout(() => emitEvent("watch-status", { id: args.id, state: "stopped", error: null }), 50);
      return had;
    }
    case "watch_set_paused": {
      const watcher = state.watchers.get(String(args.id));
      if (!watcher) return false;
      watcher.paused = Boolean(args.paused);
      emitEvent("watch-status", { id: args.id, state: watcher.paused ? "paused" : "watching", error: null });
      return true;
    }
    case "watch_list":
      return [...state.watchers.keys()].sort().map(watchInfo);
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
    // Sessions: saved as one demo file, opened as the last one saved.
    if (message.cmd === "saveDialog") return "C:\\Users\\demo\\Documents\\Goblin S01.mbmux";
    if (JSON.stringify(options.filters ?? []).includes("mbmux")) return Object.keys(state.sessions).pop() ?? null;
    if (options.directory) return pickFolder();
    if (activePage().startsWith("Attachments")) return FONTS.map((f) => f.path);
    return options.multiple ? [`${SUB_DIR}\\Goblin.S01E03.en.forced.srt`] : `${SUB_DIR}\\Goblin.S01E03.en.forced.srt`;
  }
  if (module === "Shell" || module === "Process") return null;
  console.warn("[demo] unhandled module", module, message);
  return null;
}

// ------------------------------------------------------ watch folders

const pad2 = (n: number) => String(n).padStart(2, "0");

function watchInfo(id: string): WatchInfo {
  const watcher = state.watchers.get(id)!;
  const { request } = watcher;
  return { id, folder: request.folder, extensions: request.extensions ?? [], recursive: Boolean(request.recursive), intervalSeconds: request.intervalSeconds ?? 10, stablePolls: 2, state: watcher.paused ? "paused" : "watching", error: null, paused: watcher.paused, settling: 0, reported: watcher.reported, held: 0 };
}

function watchStart(request: WatchRequest): WatchInfo {
  const replaced = state.watchers.has(request.id);
  state.watchers.set(request.id, { request, paused: Boolean(request.paused), reported: 0 });
  // As the backend did before it was fixed: a replaced watcher's last word comes late.
  if (replaced) setTimeout(() => emitEvent("watch-status", { id: request.id, state: "stopped", error: null }), 80);
  setTimeout(() => emitEvent("watch-status", { id: request.id, state: request.paused ? "paused" : "watching", error: null }), 20);
  return watchInfo(request.id);
}

/** A new episode (index from 0, past the season's 16) as the watcher would find it. */
const arrivalPath = (i: number) => `${SHOW_DIR}\\Goblin.S01E${pad2(i + 1)}.1080p.WEB-DL.x264-HDEX.mkv`;

/** The dubs of episodes that arrived, as the dub folder now holds them. */
function arrivedFiles(request: ScanRequest): ExternalFile[] {
  if (request.type !== "audio" || request.folder !== DUB_DIR) return [];
  return [...new Set(state.arrivals.values())].map((i) => {
    const name = `Goblin.S01E${pad2(i + 1)}.Hindi.DDP5.1.eac3`;
    return { ...dubFile(i % EPISODES), id: `dub-${pad2(i + 1)}`, name, path: `${DUB_DIR}\\${name}` };
  });
}

function inspectArrived(paths: string[], type: string): (VideoFile | ExternalFile)[] {
  const arrived = type === "video" ? paths.filter((path) => state.arrivals.has(path)) : [];
  const rest = inspect(paths.filter((path) => !arrived.includes(path)), type);
  return [...rest, ...arrived.map((path) => ({ ...videoFile(state.arrivals.get(path)! % EPISODES, true), id: `video-${pad2(state.arrivals.get(path)! + 1)}`, path, name: nameOf(path) }))];
}

/** `window.__demo.watch([...paths])`: files landing in the first watch folder that is on. */
function fakeArrival(paths?: string[]) {
  const id = [...state.watchers.entries()].find(([, watcher]) => !watcher.paused)?.[0];
  if (!id) {
    console.warn("[demo] no watch folder is on: turn one on in File › Watch folders (or load with &recipes=1&watch=1)");
    return;
  }
  const next = paths?.length ? paths : [arrivalPath(EPISODES + state.arrivals.size)];
  next.forEach((path) => {
    if (!state.arrivals.has(path)) state.arrivals.set(path, episodeOf(nameOf(path)) || EPISODES + state.arrivals.size);
  });
  state.watchers.get(id)!.reported += next.length;
  emitEvent("watch-files", { id, paths: next });
}

function sampleRecipe(): Recipe {
  return {
    id: "recipe-goblin",
    name: "Goblin — Hindi",
    show: "Goblin",
    trackRules: [
      { id: "rule-sdh", label: "Drop the SDH subtitles", match: { type: "subtitle", nameRegex: "sdh" }, action: { keep: false } },
      { id: "rule-kor", label: "Korean stereo by its layout", match: { type: "audio", languages: ["kor"], codecRegex: "flac" }, action: { rename: "Korean {channels}" } },
    ],
    audioSlots: [{ sourceFolder: DUB_DIR, extension: "all", language: "hin", trackName: "Hindi", delay: "0.000", isDefault: true, isForced: false, muxAfter: "video" }],
    subtitleSlots: [],
    namingPattern: "{show} - {episode}",
    destination: OUT_DIR,
    measurement: { autoMeasure: true, autoApply: true, autoApplyMinConfidence: 0.9, autoConformCuts: false },
    createdAt: "2026-11-23T09:00:00.000Z",
    updatedAt: "2026-11-23T09:00:00.000Z",
  };
}

function sampleWatch(on: boolean): WatchFolderConfig {
  return { id: "watch-goblin", enabled: on, recipeId: "recipe-goblin", videoFolder: SHOW_DIR, videoExtensions: ["mkv"], recursive: false, audioFolder: DUB_DIR, subtitleFolder: "", chapterFolder: "", intervalSeconds: 10 };
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
    pairingGap: options.get("pairing") === "gap",
    engine: scenario !== "engine",
    update: options.get("update") === "1",
    mediainfo: options.get("tools") !== "missing",
    store: options.get("recipes") === "1" ? { recipes: { version: 1, recipes: [sampleRecipe()] }, "watch-folders": { version: 1, folders: [sampleWatch(options.get("watch") === "1")] } } : {},
    sessions: {},
    watchers: new Map(),
    arrivals: new Map(),
  };
  mockWindows("main");
  mockIPC((cmd, args) => handle(cmd, (args ?? {}) as Args));
  (window as unknown as Record<string, unknown>).__demo = { marker: MARKER, drop, key, go, paths: videoPaths, watch: fakeArrival };
  void run(scenario);
}
