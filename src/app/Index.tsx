/** The app shell: one window frame (title bar with the menu bar, the page bar
 *  along the bottom) around six pages that each keep their own state while
 *  hidden.
 *
 *  The workspace itself — the videos, the files added to them, the queue and
 *  the mux settings — lives here, as it did in the old single workspace page,
 *  and reaches the pages as props. What the pages share beyond that is the
 *  shell (src/app/shell.tsx): the engine claim, Output, History, menus,
 *  keyboard shortcuts, file drops and Preferences. */

import {
  AttachFilled,
  AttachRegular,
  BookmarkMultipleFilled,
  BookmarkMultipleRegular,
  ClosedCaptionFilled,
  ClosedCaptionRegular,
  LayerFilled,
  LayerRegular,
  MusicNote2Filled,
  MusicNote2Regular,
  VideoClipMultipleFilled,
  VideoClipMultipleRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { AttachmentsPage } from "@/features/workspace/pages/AttachmentsPage";
import { AudioPage } from "@/features/workspace/pages/AudioPage";
import { ChaptersPage } from "@/features/workspace/pages/ChaptersPage";
import { MuxPage, type ReportTrack } from "@/features/workspace/pages/MuxPage";
import { SubtitlesPage } from "@/features/workspace/pages/SubtitlesPage";
import { VideosPage } from "@/features/workspace/pages/VideosPage";
import { ModifyTracksDialog } from "@/features/workspace/components/ModifyTracksDialog";
import { installUpdateAndRestart, useAutoUpdate } from "@/features/workspace/hooks/useAutoUpdate";
import { buildMuxJobRequests } from "@/features/workspace/lib/muxJobBuilder";
import { jobsToRun, parallelJobs, syncJobs } from "@/features/workspace/lib/queue";
import { areVideoListsEquivalent } from "@/features/workspace/lib/videoCompare";
import { useTabState } from "@/features/workspace/store/useTabState";
import {
  dependencyStatus,
  inspectPaths,
  listenAudiosyncLog,
  listenMuxLog,
  listenMuxProgress,
  loadOptions,
  openLogFile,
  pauseMuxing,
  previewMux,
  resumeMuxing,
  saveOptions,
  startMuxing,
  stopMuxing,
  type DependencyStatus,
  type MuxProgressEvent,
} from "@/shared/lib/backend";
import { getUnlinkedExternalFiles } from "@/shared/lib/matchUtils";
import type { ExternalFile, MuxJob, MuxPreviewResult, MuxSettings, OptionsData, OutputSettings, Preset, VideoFile } from "@/shared/types";
import { AppWindow, IS_MAC, PageBar, type Menu, type PageTab, type StatusProps } from "@/ui/frame";
import { toast } from "@/ui/toast";

import { HistoryBody, HistoryTools, OutputBody, OutputTools, severityOf, useHistoryFilter, type CommonTab, type LogLine } from "./dock";
import { loadHistory, muxOutcome, runName, saveHistory, type HistoryEntry } from "./history";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { PreferencesWindow, type PrefsTab } from "./Preferences";
import { ShellContext, type CommandKey, type EnginePage, type PageCommands, type PageId, type Shell } from "./shell";
import { UpdateProgress } from "./UpdateProgress";

/** Injected from package.json at build time, so Preferences always reports
 *  the version CI tagged the release with. */
const APP_VERSION = __APP_VERSION__;

const MAX_PARALLEL_JOBS = 16;
const MAX_LOG_LINES = 1000;

export const PAGES: PageTab<PageId>[] = [
  { id: "videos", label: "Videos", icon: <VideoClipMultipleRegular />, on: <VideoClipMultipleFilled />, shortcut: "Ctrl+1" },
  { id: "subtitles", label: "Subtitles", icon: <ClosedCaptionRegular />, on: <ClosedCaptionFilled />, shortcut: "Ctrl+2" },
  { id: "audio", label: "Audio", icon: <MusicNote2Regular />, on: <MusicNote2Filled />, shortcut: "Ctrl+3" },
  { id: "chapters", label: "Chapters", icon: <BookmarkMultipleRegular />, on: <BookmarkMultipleFilled />, shortcut: "Ctrl+4" },
  { id: "attachments", label: "Attachments", icon: <AttachRegular />, on: <AttachFilled />, shortcut: "Ctrl+5" },
  { id: "mux", label: "Mux", icon: <LayerRegular />, on: <LayerFilled />, shortcut: "Ctrl+6" },
];

const PAGE_LABEL = Object.fromEntries(PAGES.map((p) => [p.id, p.label])) as Record<PageId, string>;

/** Drop entries for tracks that no longer exist, keeping the same object when
 *  there is nothing to drop so the state update is a no-op. */
function pruneFilesByTrack(filesByTrack: Record<string, ExternalFile[]>, tracks: string[]): Record<string, ExternalFile[]> {
  const live = new Set(tracks);
  const stale = Object.keys(filesByTrack).filter((trackId) => !live.has(trackId));
  if (stale.length === 0) return filesByTrack;
  const next = { ...filesByTrack };
  stale.forEach((trackId) => delete next[trackId]);
  return next;
}

const clock = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function logReducer(state: LogLine[], action: { type: "add"; text: string } | { type: "clear" }): LogLine[] {
  if (action.type === "clear") return [];
  const next = state.length >= MAX_LOG_LINES ? state.slice(state.length - MAX_LOG_LINES + 1) : state.slice();
  next.push({ at: clock(), text: action.text });
  return next;
}

const errorText = (error: unknown, fallback: string) =>
  typeof error === "string" ? error : error instanceof Error ? error.message : fallback;

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

const createExternalId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/** "Drop to add 16 videos": what a drop holds, in the page's words. */
function dropLabel(paths: string[], page: PageId): string {
  const names = paths.map((p) => p.replace(/[\\/]+$/, "").replace(/^.*[\\/]/, ""));
  if (names.length === 0) return "Drop to add files";
  const folders = names.filter((n) => !/\.[a-z0-9]{1,5}$/i.test(n));
  if (folders.length === 1 && names.length === 1) return `Drop to use the folder ${folders[0]}`;
  const noun = page === "videos" ? "video" : page === "attachments" ? "attachment" : "file";
  return `Drop to add ${names.length} ${noun}${names.length === 1 ? "" : "s"}`;
}

export default function Index() {
  const desktop = typeof window !== "undefined" && "__TAURI_IPC__" in window;

  // --------------------------------------------------------------- pages

  const [active, setActive] = useState<PageId>("videos");
  const activeRef = useRef(active);
  activeRef.current = active;
  const commandsRef = useRef<Partial<Record<PageId, PageCommands>>>({});
  const [, bumpCommands] = useReducer((n: number) => n + 1, 0);
  const setCommands = useCallback((page: PageId, commands: PageCommands | null) => {
    if (commands) commandsRef.current[page] = commands;
    else delete commandsRef.current[page];
    bumpCommands();
  }, []);
  const command = useCallback(<K extends CommandKey>(key: K): PageCommands[K] | undefined => {
    const commands = commandsRef.current[activeRef.current];
    if (!commands || commands.disabled?.[key]) return undefined;
    return commands[key];
  }, []);

  // ----------------------------------------------------------- workspace

  // Dark is the default. Options load asynchronously from the backend, so
  // starting light would flash a white window before Dark_Mode arrives.
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [videoFiles, setVideoFiles] = useState<VideoFile[]>([]);
  const [subtitleFilesByTrack, setSubtitleFilesByTrack] = useState<Record<string, ExternalFile[]>>({});
  const [audioFilesByTrack, setAudioFilesByTrack] = useState<Record<string, ExternalFile[]>>({});
  const [chapterFiles, setChapterFiles] = useState<ExternalFile[]>([]);
  const [attachmentFiles, setAttachmentFiles] = useState<ExternalFile[]>([]);
  const [perVideoExternal, setPerVideoExternal] = useState<Record<string, { audios: ExternalFile[]; subtitles: ExternalFile[] }>>({});
  const [jobs, setJobs] = useState<MuxJob[]>([]);
  const [previewResults, setPreviewResults] = useState<Record<string, MuxPreviewResult>>({});
  const [previewLoading, setPreviewLoading] = useState(false);
  const [options, setOptions] = useState<OptionsData | null>(null);
  const [activePreset, setActivePreset] = useState<Preset | null>(null);
  const [videoSourceFolder, setVideoSourceFolder] = useState("");
  const activeAudioTrack = useTabState((state) => state.activeAudioTrack);
  const activeSubtitleTrack = useTabState((state) => state.activeSubtitleTrack);
  const audioTracks = useTabState((state) => state.audioTracks);
  const subtitleTracks = useTabState((state) => state.subtitleTracks);

  const audioFilesCount = useMemo(() => Object.values(audioFilesByTrack).reduce((sum, list) => sum + list.length, 0), [audioFilesByTrack]);
  const subtitleFilesCount = useMemo(() => Object.values(subtitleFilesByTrack).reduce((sum, list) => sum + list.length, 0), [subtitleFilesByTrack]);
  const unlinkedAudioFiles = useMemo(
    () => Object.values(audioFilesByTrack).flatMap((files) => getUnlinkedExternalFiles(files, videoFiles)),
    [audioFilesByTrack, videoFiles],
  );
  const unlinkedSubtitleFiles = useMemo(
    () => Object.values(subtitleFilesByTrack).flatMap((files) => getUnlinkedExternalFiles(files, videoFiles)),
    [subtitleFilesByTrack, videoFiles],
  );
  const externalLinkIssues = useMemo(() => {
    const messages: string[] = [];
    if (unlinkedAudioFiles.length > 0)
      messages.push(`${unlinkedAudioFiles.length} audio file${unlinkedAudioFiles.length === 1 ? " has" : "s have"} no video to go into.`);
    if (unlinkedSubtitleFiles.length > 0)
      messages.push(`${unlinkedSubtitleFiles.length} subtitle file${unlinkedSubtitleFiles.length === 1 ? " has" : "s have"} no video to go into.`);
    return messages;
  }, [unlinkedAudioFiles.length, unlinkedSubtitleFiles.length]);

  useEffect(() => {
    setAudioFilesByTrack((prev) => (prev[activeAudioTrack] ? prev : { ...prev, [activeAudioTrack]: [] }));
  }, [activeAudioTrack]);
  useEffect(() => {
    setSubtitleFilesByTrack((prev) => (prev[activeSubtitleTrack] ? prev : { ...prev, [activeSubtitleTrack]: [] }));
  }, [activeSubtitleTrack]);
  // A track slot removed from the strip must take its files with it, or the
  // mux would still pick them up by their old track key.
  useEffect(() => {
    setAudioFilesByTrack((prev) => pruneFilesByTrack(prev, audioTracks));
  }, [audioTracks]);
  useEffect(() => {
    setSubtitleFilesByTrack((prev) => pruneFilesByTrack(prev, subtitleTracks));
  }, [subtitleTracks]);

  const [outputSettings, setOutputSettings] = useState<OutputSettings>({
    directory: "",
    namingPattern: "{original_filename}",
    overwriteExisting: false,
  });
  const [muxSettings, setMuxSettings] = useState<MuxSettings>({
    destinationDir: "",
    outputNamingPattern: "{original_filename}",
    overwriteSource: false,
    addCrc: false,
    removeOldCrc: false,
    keepLogFile: false,
    abortOnErrors: false,
    maxParallelJobs: 0,
    onlyKeepAudiosEnabled: false,
    onlyKeepSubtitlesEnabled: false,
    onlyKeepAudioLanguages: [],
    onlyKeepSubtitleLanguages: [],
    discardOldChapters: false,
    discardOldAttachments: true,
    allowDuplicateAttachments: false,
    attachmentsExpertMode: false,
    removeGlobalTags: true,
    makeAudioDefaultLanguage: undefined,
    makeSubtitleDefaultLanguage: undefined,
    useMkvpropedit: false,
  });
  const updateMuxSettings = useCallback((updates: Partial<MuxSettings>) => setMuxSettings((prev) => ({ ...prev, ...updates })), []);

  // The theme is a class on <html>, which index.html sets to dark before the
  // first paint.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDarkMode);
    document.documentElement.classList.toggle("light", !isDarkMode);
  }, [isDarkMode]);

  const applyOptions = useCallback((data: OptionsData, keepDirectory: boolean) => {
    const preset = data.Presets[data.FavoritePresetId] || data.Presets[0];
    setActivePreset(preset);
    setIsDarkMode(Boolean(data.Dark_Mode));
    setVideoSourceFolder(preset?.Default_Video_Directory || "");
    setOutputSettings((prev) => ({ ...prev, directory: preset?.Default_Destination_Directory || (keepDirectory ? prev.directory : "") }));
    setMuxSettings((prev) => ({ ...prev, destinationDir: preset?.Default_Destination_Directory || (keepDirectory ? prev.destinationDir : "") }));
  }, []);

  useEffect(() => {
    let mounted = true;
    loadOptions()
      .then((data) => {
        if (!mounted) return;
        setOptions(data);
        applyOptions(data, false);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [applyOptions]);

  // ------------------------------------------------------------- output

  const [logs, logDispatch] = useReducer(logReducer, []);
  const [dockTab, setDockTab] = useState<CommonTab | null>(null);
  const openOutput = useCallback(() => setDockTab("output"), []);
  // Output stays out of the way until asked for. An error written while it is
  // hidden lights a dot on its icon; opening it puts the dot out.
  const [outputDot, setOutputDot] = useState(false);
  const outputShowing = useRef(false);
  outputShowing.current = dockTab === "output";
  useEffect(() => {
    if (dockTab === "output") setOutputDot(false);
  }, [dockTab]);
  const log = useCallback((text: string) => {
    logDispatch({ type: "add", text });
    if (!outputShowing.current && severityOf(text) === "bad") setOutputDot(true);
  }, []);

  /** What each page shows in the toolbar's status. */
  const [statuses, setStatuses] = useState<Partial<Record<PageId, StatusProps>>>({});
  const publishStatus = useCallback((page: PageId, status: StatusProps | null) => {
    setStatuses((prev) => {
      if (!status && !prev[page]) return prev;
      const next = { ...prev };
      if (status) next[page] = status;
      else delete next[page];
      return next;
    });
  }, []);

  useEffect(() => {
    const unlistenMux = listenMuxLog((payload) => log(payload.line));
    const unlistenEngine = listenAudiosyncLog((line) => log(line));
    return () => {
      void unlistenMux.then((unlisten) => unlisten()).catch(() => undefined);
      void unlistenEngine.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [log]);

  // -------------------------------------------------------------- engine

  const [enginePage, setEnginePage] = useState<EnginePage | null>(null);
  const engineRef = useRef<EnginePage | null>(null);
  const claimEngine = useCallback((page: EnginePage) => {
    if (engineRef.current && engineRef.current !== page) return false;
    engineRef.current = page;
    setEnginePage(page);
    return true;
  }, []);
  const releaseEngine = useCallback((page: EnginePage) => {
    if (engineRef.current !== page) return;
    engineRef.current = null;
    setEnginePage(null);
  }, []);
  const refuseBusy = useCallback((what: string) => {
    toast({ title: `Measuring is running`, description: `${what} once the delays are measured, or stop the measurement first.` });
  }, []);

  // ---------------------------------------------------------------- mux

  useEffect(() => {
    const bufferedProgress = new Map<string, MuxProgressEvent>();
    let flushTimeout: ReturnType<typeof setTimeout> | null = null;

    const applyProgress = (payloads: MuxProgressEvent[]) => {
      if (!payloads.length) return;
      const payloadById = new Map(payloads.map((payload) => [payload.job_id, payload] as const));
      setJobs((prev) => {
        const now = Date.now();
        return prev.map((job) => {
          const payload = payloadById.get(job.id);
          if (!payload) return job;
          if (job.status === "stopped") return job;
          const status = payload.status as MuxJob["status"];
          const startedAt = job.startedAt ?? (status === "processing" ? now : job.startedAt);
          let etaSeconds = job.etaSeconds;
          if (status === "processing" && payload.progress > 0 && startedAt) {
            const elapsed = (now - startedAt) / 1000;
            etaSeconds = Math.max(0, Math.round((elapsed * (100 - payload.progress)) / payload.progress));
          }
          if (status === "completed") etaSeconds = 0;
          return {
            ...job,
            status,
            progress: payload.progress,
            sizeAfter: payload.size_after ?? job.sizeAfter,
            errorMessage: payload.error_message ?? job.errorMessage,
            startedAt,
            etaSeconds,
          };
        });
      });
    };

    const flushBufferedProgress = () => {
      if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
      }
      if (!bufferedProgress.size) return;
      const payloads = Array.from(bufferedProgress.values());
      bufferedProgress.clear();
      applyProgress(payloads);
    };

    const unlistenPromise = listenMuxProgress((payload) => {
      const isTerminal = payload.status === "completed" || payload.status === "error" || payload.status === "stopped";
      if (isTerminal) {
        bufferedProgress.delete(payload.job_id);
        applyProgress([payload]);
      } else {
        bufferedProgress.set(payload.job_id, payload);
        if (!flushTimeout) flushTimeout = setTimeout(flushBufferedProgress, 120);
      }
      if (payload.status === "error") {
        const description = payload.error_message || payload.message || "Muxing failed. Check the output for details.";
        log(`Error: ${description}`);
        toast({ title: "A job failed", description, variant: "destructive" });
      }
    });
    return () => {
      flushBufferedProgress();
      if (flushTimeout) clearTimeout(flushTimeout);
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [log]);

  const previewResetKey = useMemo(
    () => [videoFiles.length, audioFilesCount, subtitleFilesCount, chapterFiles.length, attachmentFiles.length, Object.keys(perVideoExternal).length].join("|"),
    [videoFiles.length, audioFilesCount, subtitleFilesCount, chapterFiles.length, attachmentFiles.length, perVideoExternal],
  );
  const lastPreviewResetKey = useRef(previewResetKey);
  useEffect(() => {
    if (lastPreviewResetKey.current === previewResetKey) return;
    lastPreviewResetKey.current = previewResetKey;
    if (!Object.keys(previewResults).length) return;
    setPreviewResults({});
  }, [previewResetKey, previewResults]);

  // The queue is every loaded video, kept in step with the Videos list.
  useEffect(() => {
    setJobs((prev) => syncJobs(prev, videoFiles));
  }, [videoFiles]);

  useEffect(() => {
    const validVideoIds = new Set(videoFiles.map((video) => video.id));
    setPreviewResults((prev) => {
      const nextEntries = Object.entries(prev).filter(([jobId]) => validVideoIds.has(jobId.startsWith("job-") ? jobId.slice(4) : jobId));
      return nextEntries.length === Object.keys(prev).length ? prev : Object.fromEntries(nextEntries);
    });
    setPerVideoExternal((prev) => {
      const nextEntries = Object.entries(prev).filter(([videoId]) => validVideoIds.has(videoId));
      return nextEntries.length === Object.keys(prev).length ? prev : Object.fromEntries(nextEntries);
    });
  }, [videoFiles]);

  const buildJobRequests = useCallback(
    (only?: MuxJob[]) => buildMuxJobRequests({ videoFiles, jobs: only ?? jobs, audioFilesByTrack, subtitleFilesByTrack, chapterFiles, attachmentFiles, perVideoExternal }),
    [attachmentFiles, audioFilesByTrack, chapterFiles, jobs, perVideoExternal, subtitleFilesByTrack, videoFiles],
  );

  const getJobReport = useCallback(
    (jobId: string) => {
      const job = buildJobRequests().find((item) => item.id === jobId);
      if (!job) return null;

      const formatTrackLabel = (track: VideoFile["tracks"][number], index: number) => {
        const name = track.name || track.codec || `Track ${index + 1}`;
        return `${name}${track.language ? ` (${track.language})` : ""}`;
      };
      const formatChange = (label: string, previous: string | undefined, next: string | undefined) => {
        const prevValue = previous && previous.length > 0 ? previous : "None";
        const nextValue = next && next.length > 0 ? next : "None";
        return prevValue === nextValue ? null : `${label}: ${prevValue} → ${nextValue}`;
      };
      const formatBoolChange = (label: string, previous: boolean | undefined, next: boolean | undefined) => {
        if (previous === undefined && next === undefined) return null;
        if (previous === next) return null;
        const show = (value: boolean | undefined) => (value === undefined ? "Auto" : value ? "Yes" : "No");
        return `${label}: ${show(previous)} → ${show(next)}`;
      };
      const resolveMuxAfterLabel = (muxAfter?: string) => {
        if (!muxAfter) return null;
        if (muxAfter === "video") return "After the video";
        if (muxAfter === "end") return "At the end";
        if (muxAfter.startsWith("track-")) {
          const raw = Number(muxAfter.replace("track-", ""));
          if (!Number.isFinite(raw) || raw <= 0) return "After a track";
          const target = job.video.tracks?.[raw - 1];
          if (!target) return `After track ${raw}`;
          return `After ${target.type} ${formatTrackLabel(target, raw - 1)}`;
        }
        return null;
      };
      const formatDelay = (value?: number) => {
        if (!Number.isFinite(value) || !value) return null;
        return `${Math.abs(value) < 1 ? value.toFixed(3) : value.toFixed(2)} s`;
      };
      const formatExternal = (file: ExternalFile) => {
        const details: string[] = [];
        if (file.source) details.push(file.source === "per-file" ? "This video only" : "From a track slot");
        if (file.language) details.push(file.language);
        const delay = formatDelay(file.delay);
        if (delay) details.push(delay);
        if (file.isDefault) details.push("default");
        if (file.isForced) details.push("forced");
        const muxAfterLabel = resolveMuxAfterLabel(file.muxAfter);
        if (muxAfterLabel) details.push(muxAfterLabel.toLowerCase());
        return { title: file.name, details };
      };

      const sections: { title: string; items: { title: string; details: string[] }[] }[] = [];
      const indexed = (job.video.tracks || []).map((track, index) => ({ track, index }));
      const removed = indexed.filter(({ track }) => track.action === "remove");
      const modified = indexed.filter(({ track }) => track.action === "modify");
      if (removed.length > 0)
        sections.push({ title: "Removed", items: removed.map(({ track, index }) => ({ title: `${track.type} · ${formatTrackLabel(track, index)}`, details: [] })) });
      if (modified.length > 0)
        sections.push({
          title: "Changed",
          items: modified.map(({ track, index }) => ({
            title: `${track.type} · ${formatTrackLabel(track, index)}`,
            details: [
              formatChange("Name", track.originalName, track.name || track.originalName),
              formatChange("Language", track.originalLanguage, track.language || track.originalLanguage),
              formatBoolChange("Default", track.originalDefault, track.isDefault),
              formatBoolChange("Forced", track.originalForced, track.isForced),
            ].filter((entry): entry is string => Boolean(entry)),
          })),
        });
      if (job.audios.length > 0) sections.push({ title: "Added audio", items: job.audios.map(formatExternal) });
      if (job.subtitles.length > 0) sections.push({ title: "Added subtitles", items: job.subtitles.map(formatExternal) });
      if (job.chapters.length > 0) sections.push({ title: "Added chapters", items: job.chapters.map(formatExternal) });
      if (job.attachments.length > 0) sections.push({ title: "Added attachments", items: job.attachments.map(formatExternal) });
      const rules: string[] = [];
      if (muxSettings.discardOldChapters) rules.push("Remove the source's chapters");
      if (muxSettings.discardOldAttachments) rules.push("Remove the source's attachments");
      if (muxSettings.removeGlobalTags) rules.push("Remove the source's global tags");
      if (rules.length > 0) sections.push({ title: "Rules", items: rules.map((rule) => ({ title: rule, details: [] })) });

      // Every track of the new file: the source's, then the added files; the
      // removed ones last, for the Job details list.
      const flagsOf = (isDefault?: boolean, isForced?: boolean) => [isDefault ? "Default" : null, isForced ? "Forced" : null].filter((flag): flag is string => Boolean(flag));
      const sourceTracks: ReportTrack[] = (job.video.tracks || [])
        .filter((track) => track.type !== "chapter")
        .map((track, index) => ({
          type: track.type as ReportTrack["type"],
          language: track.language,
          name: [track.codec, track.name].filter(Boolean).join(" · ") || `Track ${index + 1}`,
          from: "Source",
          flags: flagsOf(track.isDefault, track.isForced),
          removed: track.action === "remove",
        }));
      const added = (type: "audio" | "subtitle", files: ExternalFile[]): ReportTrack[] =>
        files.map((file) => ({ type, language: file.language, name: file.trackName || file.name.split(".").pop()?.toUpperCase() || type, from: file.name, flags: flagsOf(file.isDefault, file.isForced), delay: file.delay, added: true }));
      const tracks = [...sourceTracks.filter((t) => !t.removed), ...added("audio", job.audios), ...added("subtitle", job.subtitles), ...sourceTracks.filter((t) => t.removed)];
      const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
      const also: [string, string][] = [
        ["Chapters", job.chapters.length ? `From ${job.chapters.map((file) => file.name).join(", ")}${muxSettings.discardOldChapters ? " · the source's removed" : ""}` : muxSettings.discardOldChapters ? "The source's removed" : "The source's kept"],
        ["Attachments", job.attachments.length ? `${plural(job.attachments.length, "file")} added${muxSettings.discardOldAttachments ? " · the source's removed" : ""}` : muxSettings.discardOldAttachments ? "The source's removed" : "The source's kept"],
        ["Global tags", muxSettings.removeGlobalTags ? "Removed" : "Kept"],
      ];
      return { title: job.video.name, sections, tracks, also };
    },
    [buildJobRequests, muxSettings.discardOldAttachments, muxSettings.discardOldChapters, muxSettings.removeGlobalTags],
  );

  /** What each job adds to its video, for the queue's Adds column. */
  const addsByJob = useMemo(
    () =>
      Object.fromEntries(
        buildJobRequests().map((job) => [job.id, { audio: job.audios.length, subtitle: job.subtitles.length, chapter: job.chapters.length, attachment: job.attachments.length }]),
      ),
    [buildJobRequests],
  );

  const fastMuxAvailable = useMemo(() => {
    const inPlaceOverwrite = outputSettings.directory.trim() === "" && outputSettings.overwriteExisting;
    const hasExternal = audioFilesCount > 0 || subtitleFilesCount > 0 || chapterFiles.length > 0 || attachmentFiles.length > 0;
    const hasPerVideoExternal = Object.values(perVideoExternal).some((entry) => entry.audios.length > 0 || entry.subtitles.length > 0);
    const hasRemovedTracks = videoFiles.some((video) => (video.tracks || []).some((track) => track.action === "remove"));
    const hasLanguageFilters =
      muxSettings.onlyKeepAudiosEnabled ||
      muxSettings.onlyKeepSubtitlesEnabled ||
      Boolean(muxSettings.makeAudioDefaultLanguage) ||
      Boolean(muxSettings.makeSubtitleDefaultLanguage);
    return inPlaceOverwrite && !hasExternal && !hasPerVideoExternal && !hasRemovedTracks && !hasLanguageFilters;
  }, [
    audioFilesCount,
    attachmentFiles.length,
    chapterFiles.length,
    subtitleFilesCount,
    muxSettings.makeAudioDefaultLanguage,
    muxSettings.makeSubtitleDefaultLanguage,
    muxSettings.onlyKeepAudiosEnabled,
    muxSettings.onlyKeepSubtitlesEnabled,
    outputSettings.directory,
    outputSettings.overwriteExisting,
    perVideoExternal,
    videoFiles,
  ]);

  useEffect(() => {
    if (!fastMuxAvailable && muxSettings.useMkvpropedit) setMuxSettings((prev) => ({ ...prev, useMkvpropedit: false }));
  }, [fastMuxAvailable, muxSettings.useMkvpropedit]);

  /** Set while a start request is in flight, so a second click cannot issue one. */
  const muxStartPendingRef = useRef(false);
  /** Same, for validation: two overlapping previews would race to set results. */
  const previewPendingRef = useRef(false);

  const buildEffectiveMuxSettings = useCallback(
    (jobCount: number): MuxSettings => ({
      ...muxSettings,
      maxParallelJobs: parallelJobs(muxSettings.maxParallelJobs, jobCount, MAX_PARALLEL_JOBS),
      destinationDir: outputSettings.directory,
      outputNamingPattern: outputSettings.namingPattern,
      overwriteSource: outputSettings.overwriteExisting,
    }),
    [muxSettings, outputSettings],
  );

  /** The batch being muxed: when it started, and whether it is pausing. */
  const [batch, setBatch] = useState<{ startedAt: number | null; finishedAt: number | null; paused: boolean }>({ startedAt: null, finishedAt: null, paused: false });

  const handleStartMuxing = useCallback(() => {
    // The button only disables once a job reports "processing", a round trip
    // away, so a second click can land before that and must be ignored.
    if (muxStartPendingRef.current) return;
    if (externalLinkIssues.length > 0) {
      toast({ title: "Pair every file with a video first", description: externalLinkIssues[0], variant: "destructive" });
      return;
    }
    if (!claimEngine("mux")) {
      refuseBusy("Start muxing");
      return;
    }
    const run = jobsToRun(jobs);
    const jobsRequest = buildJobRequests(run);
    if (jobsRequest.length === 0) {
      toast({ title: "The queue is empty", description: "Load videos on the Videos page to mux them." });
      releaseEngine("mux");
      return;
    }
    const runIds = new Set(run.map((job) => job.id));
    setJobs((prev) =>
      prev.map((job) =>
        runIds.has(job.id) && job.status !== "queued"
          ? { ...job, status: "queued", progress: 0, errorMessage: undefined, sizeAfter: undefined, etaSeconds: undefined, startedAt: undefined }
          : job,
      ),
    );
    const settings = buildEffectiveMuxSettings(jobsRequest.length);
    muxStartPendingRef.current = true;
    setBatch({ startedAt: Date.now(), finishedAt: null, paused: false });
    log(`Muxing ${jobsRequest.length} job${jobsRequest.length === 1 ? "" : "s"}, ${settings.maxParallelJobs} at a time${settings.destinationDir ? `, into ${settings.destinationDir}` : ", over the sources"}`);
    startMuxing({ settings, jobs: jobsRequest })
      .catch((error) => {
        // A batch that is already running is not a failed start: leave its jobs
        // alone rather than reporting the run the user is watching as broken.
        if (String(error).toLowerCase().includes("already running")) {
          toast({ title: "Already muxing", description: "A batch is already running." });
          return;
        }
        log(`Error: could not start muxing: ${errorText(error, "unknown error")}`);
        setJobs((prev) =>
          prev.map((job) => ({ ...job, status: job.status === "queued" ? "error" : job.status, errorMessage: "Failed to start muxing. See Output." })),
        );
      })
      .finally(() => {
        muxStartPendingRef.current = false;
      });
  }, [buildEffectiveMuxSettings, buildJobRequests, externalLinkIssues, claimEngine, releaseEngine, refuseBusy, log, jobs]);

  /** Clear the queue: the queue is the loaded videos, so this empties the
   *  Videos list, ready for the next batch. */
  const handleClearQueue = useCallback(() => {
    setVideoFiles([]);
    setVideoSourceFolder("");
    setPreviewResults({});
    setBatch({ startedAt: null, finishedAt: null, paused: false });
    log("Cleared the queue");
  }, [log]);

  const handlePreviewQueue = useCallback(async () => {
    // previewLoading only disables the button on the next render, so two quick
    // clicks can both get through and the slower reply would win.
    if (previewPendingRef.current) return;
    if (externalLinkIssues.length > 0) {
      toast({ title: "Pair every file with a video first", description: externalLinkIssues[0], variant: "destructive" });
      return;
    }
    const jobsRequest = buildJobRequests();
    if (!jobsRequest.length) {
      toast({ title: "The queue is empty", description: "Add videos to the queue to validate them." });
      return;
    }
    if (!claimEngine("mux")) {
      refuseBusy("Validate");
      return;
    }
    previewPendingRef.current = true;
    setPreviewLoading(true);
    try {
      const results = await previewMux({ settings: buildEffectiveMuxSettings(jobsRequest.length), jobs: jobsRequest });
      const mapped: Record<string, MuxPreviewResult> = {};
      results.forEach((result) => {
        mapped[result.jobId] = result;
      });
      setPreviewResults(mapped);
      const totalWarnings = results.reduce((acc, result) => acc + result.warnings.length, 0);
      log(totalWarnings ? `Validated ${results.length} jobs: ${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}` : `Validated ${results.length} jobs: no warnings`);
    } catch (error) {
      const message = errorText(error, "Unable to validate mux jobs.");
      log(`Error: validation failed: ${message}`);
      toast({ title: "Validation failed", description: message, variant: "destructive" });
    } finally {
      previewPendingRef.current = false;
      setPreviewLoading(false);
      // Muxing claims the engine again when it starts.
      if (!muxStartPendingRef.current) releaseEngine("mux");
    }
  }, [buildEffectiveMuxSettings, buildJobRequests, externalLinkIssues, claimEngine, releaseEngine, refuseBusy, log]);

  /** Report a queue control that the backend refused, instead of dropping it. */
  const reportControlFailure = useCallback((action: string, error: unknown) => {
    toast({ title: `Could not ${action} muxing`, description: errorText(error, String(error)), variant: "destructive" });
  }, []);

  const handlePauseMuxing = useCallback(() => {
    // Pause stops the queue from starting new jobs; anything already handed to
    // mkvmerge finishes first. The status display says so.
    pauseMuxing()
      .then(() => {
        setBatch((prev) => ({ ...prev, paused: true }));
        log("Pausing: no new job starts; the running ones finish");
      })
      .catch((error) => reportControlFailure("pause", error));
  }, [reportControlFailure, log]);

  const handleResumeMuxing = useCallback(() => {
    resumeMuxing()
      .then(() => {
        setBatch((prev) => ({ ...prev, paused: false }));
        log("Resumed");
      })
      .catch((error) => reportControlFailure("resume", error));
  }, [reportControlFailure, log]);

  const handleStopMuxing = useCallback(() => {
    // Jobs are only marked stopped once the backend confirms it, so the UI
    // never claims a job stopped while mkvmerge is still running.
    stopMuxing()
      .then(() => {
        setJobs((prev) =>
          prev.map((job) => (job.status === "processing" || job.status === "queued" ? { ...job, status: "stopped", errorMessage: "Stopped by user." } : job)),
        );
        log("Stopped by the user");
      })
      .catch((error) => reportControlFailure("stop", error));
  }, [reportControlFailure, log]);

  // Offered as a toast, never a modal: an install restarts the app and a
  // running batch can be minutes from finishing.
  const muxIsRunning = useMemo(() => jobs.some((job) => job.status === "processing" || job.status === "queued") && batch.startedAt !== null && batch.finishedAt === null, [jobs, batch]);

  // --------------------------------------------------------------- history

  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const addHistory = useCallback((entry: HistoryEntry) => setHistory((current) => saveHistory([entry, ...current])), []);
  const persistHistory = useCallback((entries: HistoryEntry[]) => setHistory(saveHistory(entries)), []);
  const [historyFilter, setHistoryFilter] = useHistoryFilter();

  // A batch ends when no job is waiting or running any more: record it, and
  // give the engine back.
  useEffect(() => {
    if (batch.startedAt === null || batch.finishedAt !== null || muxStartPendingRef.current) return;
    const live = jobs.some((job) => job.status === "processing" || job.status === "queued");
    if (live) return;
    const finishedAt = Date.now();
    setBatch((prev) => ({ ...prev, finishedAt, paused: false }));
    releaseEngine("mux");
    if (jobs.length === 0) return;
    const outcome = muxOutcome(jobs);
    log(`Finished: ${outcome.parts.join(", ")}`);
    addHistory({
      id: createExternalId(),
      page: "mux",
      name: runName(jobs.map((job) => job.videoFile.name)),
      outcome: { tone: outcome.tone, text: outcome.parts.join(", ") },
      date: new Date(finishedAt).toISOString(),
      files: jobs.map((job) => ({
        name: job.videoFile.name,
        tone: job.status === "completed" ? "ok" : job.status === "error" ? "bad" : "warn",
        text: job.status === "completed" ? "Muxed" : job.status === "error" ? (job.errorMessage ?? "Failed") : "Stopped",
      })),
    });
  }, [jobs, batch, releaseEngine, addHistory, log]);

  // ---------------------------------------------------------------- update

  const [update, setUpdate] = useState<{ version: string; notes: string } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [prefs, setPrefs] = useState<PrefsTab | null>(null);

  const installUpdate = useCallback(() => {
    setPrefs(null);
    setInstalling(true);
    installUpdateAndRestart().catch((error) => {
      setInstalling(false);
      toast({ title: "Update failed", description: errorText(error, String(error)), variant: "destructive" });
    });
  }, []);

  useAutoUpdate({
    isBusy: jobs.some((job) => job.status === "processing" || job.status === "queued"),
    onUpdateAvailable: useCallback(
      (version: string, notes: string) => {
        setUpdate({ version, notes });
        toast({
          title: `Version ${version} is ready`,
          description: "Installing restarts the app. Your queue and settings are kept.",
          duration: 30000,
          action: { label: "Install", onClick: installUpdate },
        });
      },
      [installUpdate],
    ),
  });

  // ------------------------------------------------------------------ tools

  const [tools, setTools] = useState<DependencyStatus[] | null>(null);
  const refreshTools = useCallback(() => {
    dependencyStatus()
      .then(setTools)
      .catch(() => setTools([]));
  }, []);
  useEffect(() => {
    if (desktop) refreshTools();
  }, [desktop, refreshTools]);

  // ---------------------------------------------------------------- handlers

  const handleViewLog = useCallback(() => {
    openLogFile().catch((error) => {
      toast({ title: "Could not open the log file", description: errorText(error, "Log file could not be opened."), variant: "destructive" });
    });
  }, []);

  const handleSaveOptions = useCallback(
    (updated: OptionsData) => {
      setOptions(updated);
      saveOptions(updated).catch((error) => {
        toast({ title: "Preferences were not saved", description: errorText(error, "Options could not be saved."), variant: "destructive" });
      });
      applyOptions(updated, true);
    },
    [applyOptions],
  );

  /** Applies add/remove/modify updates to the video file list. */
  // The caller already merged by file identity (path, then name+size), so
  // the list it hands over is authoritative and simply replaces state.
  const handleVideoFilesChange = useCallback((newFiles: VideoFile[]) => {
    setVideoFiles((prev) => (areVideoListsEquivalent(prev, newFiles) ? prev : newFiles));
  }, []);

  const handleAddExternalFiles = useCallback(
    (
      type: "audio" | "subtitle",
      videoFileId: string,
      paths: string[],
      config: { trackName: string; language: string; delay: number; isDefault: boolean; isForced: boolean; muxAfter: string },
    ) => {
      const addEntries = async () => {
        const inspected = await inspectPaths({ paths, type, include_tracks: true });
        const byPath = new Map((inspected as ExternalFile[]).map((item) => [item.path, item]));
        const newEntries = paths.map((path) => {
          const info = byPath.get(path);
          const defaultIncluded =
            info?.tracks && info.tracks.length > 0 ? info.tracks.map((track) => Number(track.id)).filter((id) => !Number.isNaN(id)) : [];
          const defaultSubtitleIncluded =
            info?.tracks && info.tracks.length > 0
              ? info.tracks.filter((track) => track.type === "subtitle").map((track) => Number(track.id)).filter((id) => !Number.isNaN(id))
              : [];
          const defaultIncludeSubtitles =
            type === "audio" && (info?.includeSubtitles !== undefined ? info.includeSubtitles : defaultSubtitleIncluded.length > 0);
          return {
            id: createExternalId(),
            name: path.split(/[\\/]/).pop() || path,
            path,
            type,
            language: config.language,
            trackName: config.trackName,
            delay: config.delay,
            isDefault: config.isDefault,
            isForced: config.isForced,
            matchedVideoId: videoFileId,
            muxAfter: config.muxAfter,
            size: info?.size,
            bitrate: info?.bitrate,
            duration: info?.duration,
            trackId: info?.trackId,
            tracks: info?.tracks,
            includedTrackIds: info?.includedTrackIds?.length ? info.includedTrackIds : defaultIncluded,
            includeSubtitles: defaultIncludeSubtitles,
            includedSubtitleTrackIds: info?.includedSubtitleTrackIds?.length ? info.includedSubtitleTrackIds : defaultSubtitleIncluded,
            trackOverrides: info?.trackOverrides ?? {},
          };
        });
        setPerVideoExternal((prev) => {
          const current = prev[videoFileId] || { audios: [], subtitles: [] };
          return {
            ...prev,
            [videoFileId]: type === "audio" ? { ...current, audios: [...current.audios, ...newEntries] } : { ...current, subtitles: [...current.subtitles, ...newEntries] },
          };
        });
      };
      void addEntries();
    },
    [],
  );

  const handleExternalFilesChange = useCallback((videoFileId: string, type: "audio" | "subtitle", files: ExternalFile[]) => {
    setPerVideoExternal((prev) => {
      const current = prev[videoFileId] || { audios: [], subtitles: [] };
      return { ...prev, [videoFileId]: type === "audio" ? { ...current, audios: files } : { ...current, subtitles: files } };
    });
  }, []);

  // --------------------------------------------------------------- dialogs

  const [modifyOpen, setModifyOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied" });
    } catch {
      toast({ title: "Could not copy", variant: "destructive" });
    }
  }, []);

  const clearLogs = useCallback(() => logDispatch({ type: "clear" }), []);
  const openPreferences = useCallback((tab: PrefsTab = "general") => setPrefs(tab), []);

  const openHistoryEntry = useCallback((entry: HistoryEntry) => setActive(entry.page), []);

  const dock = useMemo(
    () => ({
      tab: dockTab,
      setTab: setDockTab,
      output: <OutputBody lines={logs} />,
      history: (
        <HistoryBody
          entries={history}
          filter={historyFilter}
          onOpen={openHistoryEntry}
          onDelete={(id) => persistHistory(history.filter((entry) => entry.id !== id))}
        />
      ),
      outputTools: <OutputTools lines={logs} onCopy={(text) => void copy(text)} onClear={clearLogs} onOpenLog={handleViewLog} />,
      historyTools: <HistoryTools filter={historyFilter} onFilter={setHistoryFilter} empty={history.length === 0} onClear={() => persistHistory([])} />,
    }),
    [dockTab, logs, history, historyFilter, openHistoryEntry, persistHistory, copy, clearLogs, handleViewLog, setHistoryFilter],
  );

  const shell: Shell = useMemo(
    () => ({
      active,
      show: setActive,
      desktop,
      enginePage,
      claimEngine,
      releaseEngine,
      log,
      openOutput,
      dock,
      addHistory,
      setCommands,
      openPreferences,
      copy: (text: string) => void copy(text),
      publishStatus,
      runStatus: enginePage && statuses[enginePage] ? { page: enginePage, status: statuses[enginePage]! } : null,
    }),
    [active, desktop, enginePage, claimEngine, releaseEngine, log, openOutput, dock, addHistory, setCommands, openPreferences, copy, publishStatus, statuses],
  );

  // The OS window's title follows the page, for the taskbar and Alt+Tab.
  useEffect(() => {
    if (!desktop) return;
    void import("@tauri-apps/api/window")
      .then(({ appWindow }) => appWindow.setTitle(`${PAGE_LABEL[active]} — MKVBatchMux`))
      .catch(() => undefined);
  }, [active, desktop]);

  // ------------------------------------------------------------ file drops

  /** What is being dragged over the window: null when nothing is. */
  const [dragging, setDragging] = useState<string[] | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    const disposers: (() => void)[] = [];
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const offs = await Promise.all([
        listen<string[]>("tauri://file-drop-hover", (event) => setDragging(event.payload ?? [])),
        listen("tauri://file-drop-cancelled", () => setDragging(null)),
        listen<string[]>("tauri://file-drop", (event) => {
          setDragging(null);
          const drop = commandsRef.current[activeRef.current]?.drop;
          if (drop) drop(event.payload ?? []);
          else toast({ title: `${PAGE_LABEL[activeRef.current]} does not take files` });
        }),
      ]);
      if (cancelled) offs.forEach((off) => off());
      else disposers.push(...offs);
    });
    return () => {
      cancelled = true;
      disposers.forEach((off) => off());
    };
  }, [desktop]);

  // ------------------------------------------------------------------ keys

  const showPage = useCallback((page: PageId) => setActive(page), []);
  const toggleDock = useCallback((tab: CommonTab) => setDockTab((current) => (current === tab ? null : tab)), []);
  const startMuxingFromAnywhere = useCallback(() => {
    setActive("mux");
    commandsRef.current.mux?.start?.();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const modal = prefs || document.querySelector(".smoke");
      if (meta && /^[1-6]$/.test(key)) {
        event.preventDefault();
        setActive(PAGES[Number(key) - 1].id);
      } else if (meta && key === ",") {
        event.preventDefault();
        setPrefs("general");
      } else if (modal) {
        return;
      } else if (meta && key === "h") {
        event.preventDefault();
        toggleDock("history");
      } else if (meta && key === "`") {
        event.preventDefault();
        toggleDock("output");
      } else if (meta && key === "o") {
        event.preventDefault();
        command("chooseFolder")?.();
      } else if (meta && key === "n") {
        event.preventDefault();
        command("newTrack")?.();
      } else if (meta && key === "m") {
        event.preventDefault();
        setModifyOpen(true);
      } else if (meta && key === "i") {
        event.preventDefault();
        command("mediaInfo")?.();
      } else if (meta && event.key === "Enter") {
        event.preventDefault();
        startMuxingFromAnywhere();
      } else if (isTyping(event.target)) {
        return;
      } else if (meta && key === "a") {
        const selectAll = command("selectAll");
        if (selectAll) {
          event.preventDefault();
          selectAll();
        }
      } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        command(event.key === "ArrowUp" ? "moveUp" : "moveDown")?.();
      } else if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
      } else if (event.key === "Enter" && !event.defaultPrevented && (event.target as HTMLElement)?.tagName !== "BUTTON") {
        event.preventDefault();
        command("start")?.();
      } else if (event.key === "Escape" && !document.querySelector(".smoke")) {
        // With a dialog open, Escape is the dialog's.
        const stop = command("stop");
        if (stop) {
          event.preventDefault();
          stop();
        }
      } else if (event.key === "Delete" && !event.defaultPrevented) {
        command("removeSelected")?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [command, prefs, toggleDock, startMuxingFromAnywhere]);

  // ----------------------------------------------------------------- menus

  const buildMenus = (): Menu[] => {
    const commands = commandsRef.current[activeRef.current] ?? {};
    const off = (key: CommandKey) => !commands[key] || commands.disabled?.[key] === true;
    const run = (key: CommandKey) => () => (commands[key] as (() => void) | undefined)?.();
    return [
      {
        label: "File",
        items: [
          { label: "Choose folder…", shortcut: "Ctrl+O", onSelect: run("chooseFolder"), disabled: off("chooseFolder") },
          { label: "Add files…", onSelect: run("addFiles"), disabled: off("addFiles") },
          { label: "Import from a video…", onSelect: run("importFromVideo"), disabled: off("importFromVideo") },
          "separator",
          { label: "Open log file", onSelect: handleViewLog },
          "separator",
          { label: "Preferences…", shortcut: "Ctrl+,", onSelect: () => setPrefs("general") },
          "separator",
          {
            label: "Exit",
            shortcut: "Alt+F4",
            onSelect: () => void import("@tauri-apps/api/window").then(({ appWindow }) => appWindow.close()).catch(() => undefined),
          },
        ],
      },
      {
        label: "Edit",
        items: [
          { label: "Select all", shortcut: "Ctrl+A", onSelect: run("selectAll"), disabled: off("selectAll") },
          { label: "Remove", shortcut: "Del", onSelect: run("removeSelected"), disabled: off("removeSelected") },
          { label: "Clear the list", onSelect: run("clear"), disabled: off("clear") },
          "separator",
          { label: "Move up", shortcut: "Alt+↑", onSelect: run("moveUp"), disabled: off("moveUp") },
          { label: "Move down", shortcut: "Alt+↓", onSelect: run("moveDown"), disabled: off("moveDown") },
          "separator",
          { label: "New track", shortcut: "Ctrl+N", onSelect: run("newTrack"), disabled: off("newTrack") },
          { label: "Duplicate track", onSelect: run("duplicateTrack"), disabled: off("duplicateTrack") },
        ],
      },
      {
        label: "View",
        items: [
          ...PAGES.map((p) => ({ label: p.label, shortcut: p.shortcut, checked: p.id === activeRef.current, onSelect: () => setActive(p.id) })),
          "separator" as const,
          { label: "Output", shortcut: "Ctrl+`", checked: dockTab === "output", onSelect: () => toggleDock("output") },
          { label: "History", shortcut: "Ctrl+H", checked: dockTab === "history", onSelect: () => toggleDock("history") },
        ],
      },
      {
        label: "Tools",
        items: [
          { label: "Measure delays", onSelect: () => commandsRef.current.audio?.start?.(), disabled: activeRef.current !== "audio" || off("start") },
          { label: "Modify tracks…", shortcut: "Ctrl+M", onSelect: () => setModifyOpen(true), disabled: videoFiles.length === 0 },
          { label: "Media info", shortcut: "Ctrl+I", onSelect: run("mediaInfo"), disabled: off("mediaInfo") },
          "separator",
          { label: "Validate", onSelect: () => void handlePreviewQueue(), disabled: jobs.length === 0 || previewLoading || muxIsRunning },
          { label: "Start muxing", shortcut: "Ctrl+Enter", onSelect: startMuxingFromAnywhere, disabled: jobs.length === 0 || muxIsRunning },
          "separator",
          { label: "Tools and dependencies…", onSelect: () => setPrefs("tools") },
        ],
      },
      {
        label: "Help",
        items: [
          { label: "Keyboard shortcuts", shortcut: "?", onSelect: () => setShortcutsOpen(true) },
          { label: "Check for updates…", onSelect: () => setPrefs("updates") },
          { label: "Release notes", onSelect: openReleaseNotes },
          "separator",
          { label: `About MKVBatchMux ${APP_VERSION}`, onSelect: () => setPrefs("general") },
        ],
      },
    ];
  };

  // macOS: the native menus (src-tauri app_menu) send their item ids here.
  const menuActions = useRef<Record<string, () => void>>({});
  menuActions.current = {
    prefs: () => setPrefs("general"),
    "choose-folder": () => command("chooseFolder")?.(),
    "add-files": () => command("addFiles")?.(),
    "import-from-video": () => command("importFromVideo")?.(),
    "open-log": handleViewLog,
    "select-all": () => command("selectAll")?.(),
    remove: () => command("removeSelected")?.(),
    clear: () => command("clear")?.(),
    "move-up": () => command("moveUp")?.(),
    "move-down": () => command("moveDown")?.(),
    "new-track": () => command("newTrack")?.(),
    "duplicate-track": () => command("duplicateTrack")?.(),
    output: () => toggleDock("output"),
    history: () => toggleDock("history"),
    "measure-delays": () => commandsRef.current.audio?.start?.(),
    "modify-tracks": () => setModifyOpen(true),
    "media-info": () => command("mediaInfo")?.(),
    validate: () => void handlePreviewQueue(),
    "start-muxing": startMuxingFromAnywhere,
    tools: () => setPrefs("tools"),
    shortcuts: () => setShortcutsOpen(true),
    updates: () => setPrefs("updates"),
    "release-notes": openReleaseNotes,
    ...Object.fromEntries(PAGES.map((p) => [`page-${p.id}`, () => setActive(p.id)])),
  };
  useEffect(() => {
    if (!desktop || !IS_MAC) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<string>("app-menu", (event) => menuActions.current[event.payload]?.()))
      .then((unlisten) => {
        if (cancelled) unlisten();
        else dispose = unlisten;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [desktop]);

  // ---------------------------------------------------------------- render

  const missingTool = tools?.find((tool) => tool.required && !tool.available && !tool.bundled);
  const note = update ? (
    <button type="button" className="acc" onClick={() => setPrefs("updates")}>Version {update.version} is ready — Update</button>
  ) : missingTool ? (
    <button type="button" className="warn" onClick={() => setPrefs("tools")}>{missingTool.name} is missing — Install</button>
  ) : desktop ? (
    <span className="made">Made by Ionicboy</span>
  ) : (
    "Browser preview — files and runs need the desktop app"
  );

  const flags: PageId[] = [
    ...(unlinkedSubtitleFiles.length > 0 ? (["subtitles"] as const) : []),
    ...(unlinkedAudioFiles.length > 0 ? (["audio"] as const) : []),
    ...(externalLinkIssues.length > 0 && jobs.length > 0 ? (["mux"] as const) : []),
  ];

  return (
    <ShellContext.Provider value={shell}>
      <AppWindow
        title={PAGE_LABEL[active]}
        menus={IS_MAC ? [] : buildMenus}
        footer={
          <PageBar
            pages={PAGES}
            page={active}
            onPage={showPage}
            busy={enginePage}
            flags={flags}
            note={note}
            history={dockTab === "history"}
            output={dockTab === "output"}
            outputDot={outputDot}
            onHistory={() => toggleDock("history")}
            onOutput={() => toggleDock("output")}
            onPreferences={() => setPrefs("general")}
          />
        }
        overlay={
          <>
            {dragging && (
              <div className="dropover" style={{ inset: "89px 7px 59px" }}>
                {PAGES.find((p) => p.id === active)?.on && <span className="ic">{PAGES.find((p) => p.id === active)?.on}</span>}
                {dropLabel(dragging, active)}
              </div>
            )}
            {prefs && (
              <PreferencesWindow
                tab={prefs}
                onTab={setPrefs}
                options={options}
                onSave={handleSaveOptions}
                onPreviewTheme={setIsDarkMode}
                onClose={() => {
                  setPrefs(null);
                  if (options) setIsDarkMode(Boolean(options.Dark_Mode));
                }}
                version={APP_VERSION}
                tools={tools}
                onRefreshTools={refreshTools}
                update={update}
                onUpdateFound={setUpdate}
                onInstallUpdate={installUpdate}
                busy={muxIsRunning}
              />
            )}
            {installing && update && <UpdateProgress version={update.version} />}
            <KeyboardShortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
            <ModifyTracksDialog open={modifyOpen} onOpenChange={setModifyOpen} videoFiles={videoFiles} onFilesChange={handleVideoFilesChange} />
          </>
        }
      >
        <VideosPage
          hidden={active !== "videos"}
          files={videoFiles}
          sourceFolder={videoSourceFolder}
          onSourceFolderChange={setVideoSourceFolder}
          onFilesChange={handleVideoFilesChange}
          onAddExternalFiles={handleAddExternalFiles}
          externalFilesByVideoId={perVideoExternal}
          onExternalFilesChange={handleExternalFilesChange}
          preset={activePreset}
        />
        <SubtitlesPage
          hidden={active !== "subtitles"}
          subtitleFiles={subtitleFilesByTrack[activeSubtitleTrack] || []}
          videoFiles={videoFiles}
          onSubtitleFilesChange={(files) => setSubtitleFilesByTrack((prev) => ({ ...prev, [activeSubtitleTrack]: files }))}
          onVideoFilesChange={handleVideoFilesChange}
          preset={activePreset}
        />
        <AudioPage
          hidden={active !== "audio"}
          audioFiles={audioFilesByTrack[activeAudioTrack] || []}
          videoFiles={videoFiles}
          onAudioFilesChange={(files) => setAudioFilesByTrack((prev) => ({ ...prev, [activeAudioTrack]: files }))}
          onVideoFilesChange={handleVideoFilesChange}
          preset={activePreset}
          measurement={options?.Measurement}
        />
        <ChaptersPage
          hidden={active !== "chapters"}
          chapterFiles={chapterFiles}
          videoFiles={videoFiles}
          onChapterFilesChange={setChapterFiles}
          preset={activePreset}
          muxSettings={muxSettings}
          onMuxSettingsChange={updateMuxSettings}
        />
        <AttachmentsPage
          hidden={active !== "attachments"}
          attachmentFiles={attachmentFiles}
          onAttachmentFilesChange={setAttachmentFiles}
          preset={activePreset}
          muxSettings={muxSettings}
          onMuxSettingsChange={updateMuxSettings}
        />
        <MuxPage
          hidden={active !== "mux"}
          settings={outputSettings}
          onSettingsChange={(updates) => setOutputSettings((prev) => ({ ...prev, ...updates }))}
          fastMuxAvailable={fastMuxAvailable}
          externalLinkIssues={externalLinkIssues}
          unlinkedPage={unlinkedAudioFiles.length > 0 ? "audio" : unlinkedSubtitleFiles.length > 0 ? "subtitles" : null}
          jobs={jobs}
          videoFiles={videoFiles}
          addsByJob={addsByJob}
          onClearQueue={handleClearQueue}
          onStartMuxing={handleStartMuxing}
          onPauseMuxing={handlePauseMuxing}
          onResumeMuxing={handleResumeMuxing}
          onStopMuxing={handleStopMuxing}
          muxSettings={muxSettings}
          onMuxSettingsChange={updateMuxSettings}
          previewResults={previewResults}
          previewLoading={previewLoading}
          onPreviewQueue={() => void handlePreviewQueue()}
          getJobReport={getJobReport}
          batch={batch}
          running={muxIsRunning}
        />
      </AppWindow>
    </ShellContext.Provider>
  );
}

const openReleaseNotes = () =>
  void import("@tauri-apps/api/shell").then(({ open }) => open("https://github.com/AdkHex/MkvBatchMux/releases")).catch(() => undefined);

