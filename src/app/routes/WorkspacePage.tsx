import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Settings,
  Video,
  Subtitles,
  AudioLines,
  List,
  Paperclip,
  SlidersHorizontal,
  Film,
  LayoutGrid,
} from "lucide-react";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { VideosTab } from "@/features/workspace/components/VideosTab";
import { SubtitlesTab } from "@/features/workspace/components/SubtitlesTab";
import { AudiosTab } from "@/features/workspace/components/AudiosTab";
import { ChaptersTab } from "@/features/workspace/components/ChaptersTab";
import { AttachmentsTab } from "@/features/workspace/components/AttachmentsTab";
import { MuxSettingTab } from "@/features/workspace/components/MuxSettingTab";
import { OptionsDialog } from "@/features/workspace/components/OptionsDialog";
import { ModifyTracksDialog } from "@/features/workspace/components/ModifyTracksDialog";
import { KeyboardShortcutsDialog } from "@/features/workspace/components/KeyboardShortcutsDialog";
import { SessionRecoveryDialog } from "@/features/session/components/SessionRecoveryDialog";
import { HistoryToolbar } from "@/features/history/components/HistoryToolbar";
import { useKeyboardShortcuts } from "@/features/workspace/hooks/useKeyboardShortcuts";
import { useCommand } from "@/features/history/hooks/useCommand";
import { useHistoryStore } from "@/features/history/store/useHistoryStore";
import { useTabState } from "@/features/workspace/store/useTabState";
import { toast } from "@/shared/hooks/use-toast";
import type {
  VideoFile,
  ExternalFile,
  OutputSettings,
  MuxJob,
  OptionsData,
  Preset,
  MuxSettings,
  MuxPreviewResult,
} from "@/shared/types";
import {
  inspectPaths,
  listenMuxLog,
  loadOptions,
  listenMuxProgress,
  openLogFile,
  pauseMuxing,
  previewMux,
  resumeMuxing,
  saveOptions,
  startMuxing,
  stopMuxing,
} from "@/shared/lib/backend";
import { listen } from "@tauri-apps/api/event";
import { AppShell } from "@/shared/components/AppShell";
import { SidebarNav } from "@/shared/components/SidebarNav";
import { CommandBar } from "@/shared/components/CommandBar";
import { IconButton } from "@/shared/components/IconButton";
import { checkForPendingSession, scheduleSave, clearSession, forceSave } from "@/features/session/lib/sessionManager";
import type { SessionState } from "@/features/session/store/useSessionStore";
import { AddVideosCommand } from "@/features/history/lib/commands/AddVideosCommand";
import { RemoveVideosCommand } from "@/features/history/lib/commands/RemoveVideosCommand";
import { ModifyTracksCommand } from "@/features/history/lib/commands/ModifyTracksCommand";
import { AddExternalFilesCommand } from "@/features/history/lib/commands/AddExternalFilesCommand";
import { RemoveExternalFilesCommand } from "@/features/history/lib/commands/RemoveExternalFilesCommand";
import { buildMuxJobRequests } from "@/features/workspace/lib/muxJobBuilder";
import { areVideoFilesEquivalent } from "@/features/workspace/lib/videoCompare";
import type { MuxProgressEvent } from "@/shared/lib/backend";
import { getUnlinkedExternalFiles } from "@/shared/lib/matchUtils";

type TabId = "videos" | "subtitles" | "audios" | "chapters" | "attachments" | "mux-setting";

const navItems: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "videos", label: "Videos", icon: Video },
  { id: "subtitles", label: "Subtitles", icon: Subtitles },
  { id: "audios", label: "Audio Tracks", icon: AudioLines },
  { id: "chapters", label: "Chapters", icon: List },
  { id: "attachments", label: "Attachments", icon: Paperclip },
  { id: "mux-setting", label: "Mux Settings", icon: SlidersHorizontal },
];

const WorkspacePage = () => {
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem("sidebar-collapsed");
    return saved === "true";
  });
  const [activeTab, setActiveTab] = useState<TabId>("videos");
  const [videoFiles, setVideoFiles] = useState<VideoFile[]>([]);
  const [subtitleFilesByTrack, setSubtitleFilesByTrack] = useState<Record<string, ExternalFile[]>>({});
  const [audioFilesByTrack, setAudioFilesByTrack] = useState<Record<string, ExternalFile[]>>({});
  const [chapterFiles, setChapterFiles] = useState<ExternalFile[]>([]);
  const [attachmentFiles, setAttachmentFiles] = useState<ExternalFile[]>([]);
  const [perVideoExternal, setPerVideoExternal] = useState<
    Record<string, { audios: ExternalFile[]; subtitles: ExternalFile[] }>
  >({});
  const [jobs, setJobs] = useState<MuxJob[]>([]);
  const [previewResults, setPreviewResults] = useState<Record<string, MuxPreviewResult>>({});
  const [previewLoading, setPreviewLoading] = useState(false);
  const [options, setOptions] = useState<OptionsData | null>(null);
  const [activePreset, setActivePreset] = useState<Preset | null>(null);
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);
  const [isModifyTracksOpen, setIsModifyTracksOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [videoSourceFolder, setVideoSourceFolder] = useState("");
  const activeAudioTrack = useTabState((state) => state.activeAudioTrack);
  const activeSubtitleTrack = useTabState((state) => state.activeSubtitleTrack);
  const { dispatch, undo, redo } = useCommand();
  const clearHistory = useHistoryStore((s) => s.clear);
  const createExternalId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const audioFilesCount = useMemo(
    () => Object.values(audioFilesByTrack).reduce((sum, list) => sum + list.length, 0),
    [audioFilesByTrack],
  );
  const subtitleFilesCount = useMemo(
    () => Object.values(subtitleFilesByTrack).reduce((sum, list) => sum + list.length, 0),
    [subtitleFilesByTrack],
  );
  const unlinkedAudioFiles = useMemo(
    () =>
      Object.values(audioFilesByTrack).flatMap((files) => getUnlinkedExternalFiles(files, videoFiles)),
    [audioFilesByTrack, videoFiles],
  );
  const unlinkedSubtitleFiles = useMemo(
    () =>
      Object.values(subtitleFilesByTrack).flatMap((files) => getUnlinkedExternalFiles(files, videoFiles)),
    [subtitleFilesByTrack, videoFiles],
  );
  const externalLinkIssues = useMemo(() => {
    const messages: string[] = [];
    if (unlinkedAudioFiles.length > 0) {
      messages.push(
        `${unlinkedAudioFiles.length} audio file${unlinkedAudioFiles.length === 1 ? "" : "s"} are not linked to a video.`,
      );
    }
    if (unlinkedSubtitleFiles.length > 0) {
      messages.push(
        `${unlinkedSubtitleFiles.length} subtitle file${unlinkedSubtitleFiles.length === 1 ? "" : "s"} are not linked to a video.`,
      );
    }
    return messages;
  }, [unlinkedAudioFiles.length, unlinkedSubtitleFiles.length]);

  useEffect(() => {
    setAudioFilesByTrack((prev) =>
      prev[activeAudioTrack] ? prev : { ...prev, [activeAudioTrack]: [] },
    );
  }, [activeAudioTrack]);

  useEffect(() => {
    setSubtitleFilesByTrack((prev) =>
      prev[activeSubtitleTrack] ? prev : { ...prev, [activeSubtitleTrack]: [] },
    );
  }, [activeSubtitleTrack]);

  const [outputSettings, setOutputSettings] = useState<OutputSettings>({
    directory: "",
    namingPattern: "{original_filename}",
    overwriteExisting: false,
  });
  const [muxSettings, setMuxSettings] = useState<MuxSettings>({
    destinationDir: "",
    overwriteSource: false,
    addCrc: false,
    removeOldCrc: false,
    keepLogFile: false,
    abortOnErrors: false,
    maxParallelJobs: 2,
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

  // Refs to access current state inside event listeners without stale closures
  const videoFilesRef = useRef(videoFiles);
  const audioFilesByTrackRef = useRef(audioFilesByTrack);
  const subtitleFilesByTrackRef = useRef(subtitleFilesByTrack);
  const chapterFilesRef = useRef(chapterFiles);
  const attachmentFilesRef = useRef(attachmentFiles);
  const perVideoExternalRef = useRef(perVideoExternal);
  const jobsRef = useRef(jobs);
  const muxSettingsRef = useRef(muxSettings);
  const outputSettingsRef = useRef(outputSettings);
  const activeTabRef = useRef(activeTab);
  const videoSourceFolderRef = useRef(videoSourceFolder);
  useEffect(() => { videoFilesRef.current = videoFiles; }, [videoFiles]);
  useEffect(() => { audioFilesByTrackRef.current = audioFilesByTrack; }, [audioFilesByTrack]);
  useEffect(() => { subtitleFilesByTrackRef.current = subtitleFilesByTrack; }, [subtitleFilesByTrack]);
  useEffect(() => { chapterFilesRef.current = chapterFiles; }, [chapterFiles]);
  useEffect(() => { attachmentFilesRef.current = attachmentFiles; }, [attachmentFiles]);
  useEffect(() => { perVideoExternalRef.current = perVideoExternal; }, [perVideoExternal]);
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);
  useEffect(() => { muxSettingsRef.current = muxSettings; }, [muxSettings]);
  useEffect(() => { outputSettingsRef.current = outputSettings; }, [outputSettings]);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { videoSourceFolderRef.current = videoSourceFolder; }, [videoSourceFolder]);

  // Apply theme
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [isDarkMode]);

  useEffect(() => {
    let mounted = true;
    loadOptions()
      .then((data) => {
        if (!mounted) return;
        setOptions(data);
        const preset = data.Presets[data.FavoritePresetId] || data.Presets[0];
        setActivePreset(preset);
        setIsDarkMode(Boolean(data.Dark_Mode));
        setVideoSourceFolder(preset.Default_Video_Directory || "");
        setOutputSettings((prev) => ({
          ...prev,
          directory: preset.Default_Destination_Directory || "",
        }));
        setMuxSettings((prev) => ({
          ...prev,
          destinationDir: preset.Default_Destination_Directory || "",
        }));
      })
      .catch(() => {
        if (!mounted) return;
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    useTabState.getState().resetSession();
    localStorage.removeItem("mkv-tab-state");
    // Check for a pending session from a previous run
    void checkForPendingSession();
  }, []);

  // Persist sidebar state
  useEffect(() => {
    localStorage.setItem("sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  const buildSessionSnapshot = useCallback(
    (): SessionState => ({
      version: "1.0.0",
      timestamp: Math.floor(Date.now() / 1000),
      videoFiles: videoFilesRef.current,
      audioFiles: audioFilesByTrackRef.current,
      subtitleFiles: subtitleFilesByTrackRef.current,
      chapterFiles: chapterFilesRef.current,
      attachmentFiles: attachmentFilesRef.current,
      perVideoExternal: perVideoExternalRef.current,
      jobs: jobsRef.current,
      muxSettings: muxSettingsRef.current,
      outputSettings: outputSettingsRef.current,
      activeTab: activeTabRef.current,
      videoSourceFolder: videoSourceFolderRef.current,
    }),
    [],
  );

  // Auto-save session on any state change (debounced 5s) without rebuilding the full snapshot eagerly.
  useEffect(() => {
    scheduleSave(buildSessionSnapshot);
  }, [
    buildSessionSnapshot,
    videoFiles,
    audioFilesByTrack,
    subtitleFilesByTrack,
    chapterFiles,
    attachmentFiles,
    perVideoExternal,
    jobs,
    muxSettings,
    outputSettings,
    activeTab,
    videoSourceFolder,
  ]);

  useEffect(() => {
    const flushSession = () => {
      void forceSave(buildSessionSnapshot());
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushSession();
      }
    };
    window.addEventListener("beforeunload", flushSession);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", flushSession);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [buildSessionSnapshot]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

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
            etaSeconds = Math.max(
              0,
              Math.round((elapsed * (100 - payload.progress)) / payload.progress),
            );
          }
          if (status === "completed") {
            etaSeconds = 0;
          }
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
      const isTerminal =
        payload.status === "completed" ||
        payload.status === "error" ||
        payload.status === "stopped";

      if (isTerminal) {
        bufferedProgress.delete(payload.job_id);
        applyProgress([payload]);
      } else {
        bufferedProgress.set(payload.job_id, payload);
        if (!flushTimeout) {
          flushTimeout = setTimeout(flushBufferedProgress, 120);
        }
      }

      if (payload.status === "error") {
        const description =
          payload.error_message || payload.message || "Muxing failed. Check logs for details.";
        toast({
          title: "Muxing Error",
          description,
          variant: "destructive",
        });
      }
    });
    return () => {
      flushBufferedProgress();
      if (flushTimeout) {
        clearTimeout(flushTimeout);
      }
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const previewResetKey = useMemo(
    () =>
      [
        videoFiles.length,
        audioFilesCount,
        subtitleFilesCount,
        chapterFiles.length,
        attachmentFiles.length,
        Object.keys(perVideoExternal).length,
      ].join("|"),
    [
      videoFiles.length,
      audioFilesCount,
      subtitleFilesCount,
      chapterFiles.length,
      attachmentFiles.length,
      perVideoExternal,
    ],
  );
  const lastPreviewResetKey = useRef(previewResetKey);
  useEffect(() => {
    if (lastPreviewResetKey.current === previewResetKey) return;
    lastPreviewResetKey.current = previewResetKey;
    if (!Object.keys(previewResults).length) return;
    setPreviewResults({});
  }, [previewResetKey, previewResults]);

  useEffect(() => {
    const unlistenPromise = listenMuxLog((payload) => {
      if (payload.line.startsWith("mkvmerge")) {
        console.info(`[mux] ${payload.line}`);
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<string[] | { paths?: string[] }>("tauri://file-drop", async (event) => {
      const payload = event.payload;
      const paths = Array.isArray(payload) ? payload : payload?.paths || [];
      if (!paths.length) return;
      const type =
        activeTab === "videos"
          ? "video"
          : activeTab === "subtitles"
            ? "subtitle"
            : activeTab === "audios"
              ? "audio"
              : activeTab === "chapters"
                ? "chapter"
                : "attachment";

      const allowed = (path: string) => {
        if (!activePreset) return true;
        const ext = path.split(".").pop()?.toLowerCase();
        if (!ext) return false;
        const list =
          type === "video"
            ? activePreset.Default_Video_Extensions
            : type === "subtitle"
              ? activePreset.Default_Subtitle_Extensions
              : type === "audio"
                ? activePreset.Default_Audio_Extensions
                : type === "chapter"
                  ? activePreset.Default_Chapter_Extensions
                  : [];
        if (!list || list.length === 0) return true;
        return list.map((e) => e.toLowerCase()).includes(ext);
      };

      const filtered = paths.filter(allowed);
      if (!filtered.length) return;
      const results = await inspectPaths({
        paths: filtered,
        type,
        include_tracks: type === "video" || type === "audio" || type === "subtitle",
      });

      if (type === "video") {
        const added = results as VideoFile[];
        dispatch(new AddVideosCommand(
          added,
          () => videoFilesRef.current,
          setVideoFiles,
        ));
      } else if (type === "subtitle") {
        const added = results as ExternalFile[];
        const track = activeSubtitleTrack;
        dispatch(new AddExternalFilesCommand(
          added,
          "subtitle",
          () => subtitleFilesByTrackRef.current[track] || [],
          (files) => setSubtitleFilesByTrack((prev) => ({ ...prev, [track]: files })),
        ));
      } else if (type === "audio") {
        const added = results as ExternalFile[];
        const track = activeAudioTrack;
        dispatch(new AddExternalFilesCommand(
          added,
          "audio",
          () => audioFilesByTrackRef.current[track] || [],
          (files) => setAudioFilesByTrack((prev) => ({ ...prev, [track]: files })),
        ));
      } else if (type === "chapter") {
        const added = results as ExternalFile[];
        dispatch(new AddExternalFilesCommand(
          added,
          "chapter",
          () => chapterFilesRef.current,
          setChapterFiles,
        ));
      } else {
        const added = results as ExternalFile[];
        dispatch(new AddExternalFilesCommand(
          added,
          "attachment",
          () => attachmentFilesRef.current,
          setAttachmentFiles,
        ));
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [activePreset, activeTab, activeAudioTrack, activeSubtitleTrack, dispatch]);

  const handleAddToQueue = () => {
    const queuedJobIds = new Set(jobs.map((job) => job.id));
    const newJobs: MuxJob[] = videoFiles
      .filter((f) => f.status === "pending")
      .filter((f) => !queuedJobIds.has(`job-${f.id}`))
      .map((f) => ({
        id: `job-${f.id}`,
        videoFile: f,
        status: "queued" as const,
        progress: 0,
        sizeBefore: f.size,
      }));
    if (newJobs.length === 0) return;
    setJobs((prev) => [...prev, ...newJobs]);
  };

  useEffect(() => {
    const validVideoIds = new Set(videoFiles.map((video) => video.id));
    setJobs((prev) => {
      const next = prev.filter((job) => validVideoIds.has(job.videoFile.id));
      return next.length === prev.length ? prev : next;
    });
    setPreviewResults((prev) => {
      const nextEntries = Object.entries(prev).filter(([jobId]) => {
        const videoId = jobId.startsWith("job-") ? jobId.slice(4) : jobId;
        return validVideoIds.has(videoId);
      });
      return nextEntries.length === Object.keys(prev).length ? prev : Object.fromEntries(nextEntries);
    });
    setPerVideoExternal((prev) => {
      const nextEntries = Object.entries(prev).filter(([videoId]) => validVideoIds.has(videoId));
      return nextEntries.length === Object.keys(prev).length ? prev : Object.fromEntries(nextEntries);
    });
  }, [videoFiles]);

  const buildJobRequests = useCallback(() => {
    return buildMuxJobRequests({
      videoFiles,
      jobs,
      audioFilesByTrack,
      subtitleFilesByTrack,
      chapterFiles,
      attachmentFiles,
      perVideoExternal,
    });
  }, [
    attachmentFiles,
    audioFilesByTrack,
    chapterFiles,
    jobs,
    perVideoExternal,
    subtitleFilesByTrack,
    videoFiles,
  ]);

  const getJobReport = useCallback(
    (jobId: string) => {
      const jobsRequest = buildJobRequests();
      const job = jobsRequest.find((item) => item.id === jobId);
      if (!job) return null;

      const formatTrackLabel = (track: VideoFile["tracks"][number], index: number) => {
        const name = track.name || track.codec || `Track ${index + 1}`;
        const lang = track.language ? ` (${track.language})` : "";
        return `${name}${lang}`;
      };

      const formatChange = (label: string, previous: string | undefined, next: string | undefined) => {
        const prevValue = previous && previous.length > 0 ? previous : "None";
        const nextValue = next && next.length > 0 ? next : "None";
        if (prevValue === nextValue) return null;
        return `${label}: ${prevValue} → ${nextValue}`;
      };

      const formatBoolChange = (label: string, previous: boolean | undefined, next: boolean | undefined) => {
        if (previous === undefined && next === undefined) return null;
        if (previous === next) return null;
        const prevValue = previous === undefined ? "Auto" : previous ? "Yes" : "No";
        const nextValue = next === undefined ? "Auto" : next ? "Yes" : "No";
        return `${label}: ${prevValue} → ${nextValue}`;
      };

      const resolveMuxAfterLabel = (muxAfter?: string) => {
        if (!muxAfter) return null;
        if (muxAfter === "video") return "After Video";
        if (muxAfter === "end") return "At End";
        if (muxAfter.startsWith("track-")) {
          const raw = Number(muxAfter.replace("track-", ""));
          if (!Number.isFinite(raw) || raw <= 0) return "After Track";
          const target = job.video.tracks?.[raw - 1];
          if (!target) return `After Track ${raw}`;
          const name = formatTrackLabel(target, raw - 1);
          return `After ${target.type.toUpperCase()} • ${name}`;
        }
        return null;
      };

      const removedTracks = (job.video.tracks || [])
        .map((track, index) => ({ track, index }))
        .filter(({ track }) => track.action === "remove");
      const modifiedTracks = (job.video.tracks || [])
        .map((track, index) => ({ track, index }))
        .filter(({ track }) => track.action === "modify");

      const formatDelay = (value?: number) => {
        if (!Number.isFinite(value)) return null;
        if (!value) return null;
        const formatted = Math.abs(value) < 1 ? value.toFixed(3) : value.toFixed(2);
        return `${formatted}s`;
      };

      const formatExternal = (file: ExternalFile) => {
        const details: string[] = [];
        if (file.source) details.push(file.source === "per-file" ? "Source: Per-video" : "Source: Bulk");
        if (file.language) details.push(`Language: ${file.language}`);
        const delay = formatDelay(file.delay);
        if (delay) details.push(`Delay: ${delay}`);
        if (file.isDefault) details.push("Default: Yes");
        if (file.isForced) details.push("Forced: Yes");
        const muxAfterLabel = resolveMuxAfterLabel(file.muxAfter);
        if (muxAfterLabel) details.push(`Order: ${muxAfterLabel}`);
        return { title: file.name, details };
      };

      const sections: { title: string; items: { title: string; details: string[] }[] }[] = [];

      if (removedTracks.length > 0) {
        sections.push({
          title: "Removed Tracks",
          items: removedTracks.map(({ track, index }) => ({
            title: `${track.type.toUpperCase()} • ${formatTrackLabel(track, index)}`,
            details: [],
          })),
        });
      }
      if (modifiedTracks.length > 0) {
        sections.push({
          title: "Modified Tracks",
          items: modifiedTracks.map(({ track, index }) => {
            const name = formatTrackLabel(track, index);
            const details: string[] = [];
            const nameChange = formatChange(
              "Name",
              track.originalName,
              track.name || track.originalName,
            );
            const languageChange = formatChange(
              "Language",
              track.originalLanguage,
              track.language || track.originalLanguage,
            );
            const defaultChange = formatBoolChange(
              "Default",
              track.originalDefault,
              track.isDefault,
            );
            const forcedChange = formatBoolChange(
              "Forced",
              track.originalForced,
              track.isForced,
            );
            [nameChange, languageChange, defaultChange, forcedChange]
              .filter(Boolean)
              .forEach((entry) => details.push(entry as string));
            return {
              title: `${track.type.toUpperCase()} • ${name}`,
              details,
            };
          }),
        });
      }
      if (job.audios.length > 0) {
        sections.push({
          title: "Added External Audio",
          items: job.audios.map(formatExternal),
        });
      }
      if (job.subtitles.length > 0) {
        sections.push({
          title: "Added External Subtitles",
          items: job.subtitles.map(formatExternal),
        });
      }
      if (job.chapters.length > 0) {
        sections.push({
          title: "Added Chapters",
          items: job.chapters.map(formatExternal),
        });
      }
      if (job.attachments.length > 0) {
        sections.push({
          title: "Added Attachments",
          items: job.attachments.map(formatExternal),
        });
      }

      const rules: string[] = [];
      if (muxSettings.discardOldChapters) rules.push("Remove existing chapters from source");
      if (muxSettings.discardOldAttachments) rules.push("Remove existing attachments from source");
      if (muxSettings.removeGlobalTags) rules.push("Remove global tags from source");
      if (rules.length > 0) {
        sections.push({
          title: "Rules Applied",
          items: rules.map((rule) => ({ title: rule, details: [] })),
        });
      }

      return {
        title: job.video.name,
        sections,
      };
    },
    [buildJobRequests, muxSettings.discardOldAttachments, muxSettings.discardOldChapters, muxSettings.removeGlobalTags],
  );

  const fastMuxAvailable = useMemo(() => {
    const hasExternal =
      audioFilesCount > 0 ||
      subtitleFilesCount > 0 ||
      chapterFiles.length > 0 ||
      attachmentFiles.length > 0;
    const hasPerVideoExternal = Object.values(perVideoExternal).some(
      (entry) => entry.audios.length > 0 || entry.subtitles.length > 0,
    );
    const hasRemovedTracks = videoFiles.some((video) =>
      (video.tracks || []).some((track) => track.action === "remove"),
    );
    const hasLanguageFilters =
      muxSettings.onlyKeepAudiosEnabled ||
      muxSettings.onlyKeepSubtitlesEnabled ||
      Boolean(muxSettings.makeAudioDefaultLanguage) ||
      Boolean(muxSettings.makeSubtitleDefaultLanguage);
    return !hasExternal && !hasPerVideoExternal && !hasRemovedTracks && !hasLanguageFilters;
  }, [
    audioFilesCount,
    attachmentFiles.length,
    chapterFiles.length,
    subtitleFilesCount,
    muxSettings.makeAudioDefaultLanguage,
    muxSettings.makeSubtitleDefaultLanguage,
    muxSettings.onlyKeepAudiosEnabled,
    muxSettings.onlyKeepSubtitlesEnabled,
    perVideoExternal,
    videoFiles,
  ]);

  useEffect(() => {
    if (!fastMuxAvailable && muxSettings.useMkvpropedit) {
      setMuxSettings((prev) => ({ ...prev, useMkvpropedit: false }));
    }
  }, [fastMuxAvailable, muxSettings.useMkvpropedit]);

  const buildEffectiveMuxSettings = useCallback(
    (jobCount: number) => {
      const cpuCount =
        typeof navigator !== "undefined" && navigator.hardwareConcurrency
          ? navigator.hardwareConcurrency
          : 12;
      const autoParallelJobs = Math.min(jobCount, cpuCount, 12);
      const settings: MuxSettings = {
        ...muxSettings,
        maxParallelJobs: Math.max(1, autoParallelJobs),
        addCrc: false,
        removeOldCrc: false,
        keepLogFile: false,
        abortOnErrors: false,
        destinationDir: outputSettings.directory,
        overwriteSource: outputSettings.overwriteExisting,
      };
      return settings;
    },
    [muxSettings, outputSettings],
  );

  const handleStartMuxing = useCallback(() => {
    if (externalLinkIssues.length > 0) {
      toast({
        title: "Link external files first",
        description: externalLinkIssues[0],
        variant: "destructive",
      });
      return;
    }
    const jobsRequest = buildJobRequests();
    const settings = buildEffectiveMuxSettings(jobsRequest.length);
    startMuxing({ settings, jobs: jobsRequest }).catch(() => {
      setJobs((prev) =>
        prev.map((job) => ({
          ...job,
          status: job.status === "queued" ? "error" : job.status,
          errorMessage: "Failed to start muxing. Check logs.",
        })),
      );
    });
  }, [buildEffectiveMuxSettings, buildJobRequests, externalLinkIssues]);

  const handlePreviewQueue = useCallback(async () => {
    if (externalLinkIssues.length > 0) {
      toast({
        title: "Validation blocked",
        description: externalLinkIssues[0],
        variant: "destructive",
      });
      return;
    }
    const jobsRequest = buildJobRequests();
    if (!jobsRequest.length) {
      toast({
        title: "Queue is empty",
        description: "Add files to the queue to validate mux settings.",
      });
      return;
    }
    setPreviewLoading(true);
    try {
      const settings = buildEffectiveMuxSettings(jobsRequest.length);
      const results = await previewMux({ settings, jobs: jobsRequest });
      const mapped: Record<string, MuxPreviewResult> = {};
      results.forEach((result) => {
        mapped[result.jobId] = result;
      });
      setPreviewResults(mapped);
      const totalWarnings = results.reduce((acc, result) => acc + result.warnings.length, 0);
      toast({
        title: totalWarnings ? "Validation completed with warnings" : "Validation complete",
        description: totalWarnings
          ? `${totalWarnings} warning${totalWarnings === 1 ? "" : "s"} found.`
          : "No issues detected for queued jobs.",
      });
    } catch (error) {
      const message =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : "Unable to validate mux jobs.";
      toast({
        title: "Validation failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setPreviewLoading(false);
    }
  }, [buildEffectiveMuxSettings, buildJobRequests, externalLinkIssues]);

  const handlePauseMuxing = useCallback(() => {
    pauseMuxing();
  }, []);

  const handleResumeMuxing = useCallback(() => {
    resumeMuxing();
  }, []);

  const handleStopMuxing = useCallback(() => {
    stopMuxing();
    setJobs((prev) =>
      prev.map((job) =>
        job.status === "processing" || job.status === "queued"
          ? { ...job, status: "stopped", errorMessage: "Stopped by user." }
          : job,
      ),
    );
  }, []);

  const handleViewLog = useCallback(() => {
    openLogFile().catch((error) => {
      const message =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : "Log file could not be opened.";
      toast({
        title: "Unable to open log file",
        description: message,
        variant: "destructive",
      });
    });
  }, []);

  const handleSaveOptions = useCallback((updated: OptionsData) => {
    setOptions(updated);
    saveOptions(updated).catch(() => undefined);
    const preset = updated.Presets[updated.FavoritePresetId] || updated.Presets[0];
    setActivePreset(preset);
    setIsDarkMode(Boolean(updated.Dark_Mode));
    setVideoSourceFolder(preset.Default_Video_Directory || "");
    setOutputSettings((prev) => ({
      ...prev,
      directory: preset.Default_Destination_Directory || prev.directory,
    }));
    setMuxSettings((prev) => ({
      ...prev,
      destinationDir: preset.Default_Destination_Directory || prev.destinationDir,
    }));
  }, []);

  /**
   * Smart video file change handler — dispatches the appropriate Command
   * based on what changed (add, remove, or modify).
   */
  const handleVideoFilesChange = useCallback(
    (newFiles: VideoFile[]) => {
      const currentIds = new Set(videoFiles.map((v) => v.id));
      const newIds = new Set(newFiles.map((v) => v.id));
      const added = newFiles.filter((v) => !currentIds.has(v.id));
      const removed = videoFiles.filter((v) => !newIds.has(v.id));

      if (added.length > 0 && removed.length === 0) {
        dispatch(new AddVideosCommand(added, () => videoFiles, setVideoFiles));
      } else if (removed.length > 0 && added.length === 0) {
        dispatch(new RemoveVideosCommand(removed, () => videoFiles, setVideoFiles));
      } else if (added.length === 0 && removed.length === 0) {
        const modified = newFiles.filter((v) => {
          const orig = videoFiles.find((o) => o.id === v.id);
          return orig && !areVideoFilesEquivalent(orig, v);
        });
        if (modified.length > 0) {
          const prevModified = videoFiles.filter((v) => modified.some((m) => m.id === v.id));
          dispatch(
            new ModifyTracksCommand(prevModified, modified, () => videoFiles, setVideoFiles),
          );
        } else {
          setVideoFiles(newFiles);
        }
      } else {
        setVideoFiles(newFiles);
      }
    },
    [videoFiles, dispatch],
  );

  const handleRestoreSession = useCallback((session: SessionState) => {
    setVideoFiles(session.videoFiles ?? []);
    setAudioFilesByTrack(session.audioFiles ?? {});
    setSubtitleFilesByTrack(session.subtitleFiles ?? {});
    setChapterFiles(session.chapterFiles ?? []);
    setAttachmentFiles(session.attachmentFiles ?? []);
    setPerVideoExternal(session.perVideoExternal ?? {});
    setJobs(session.jobs ?? []);
    if (session.muxSettings) setMuxSettings(session.muxSettings);
    if (session.outputSettings) setOutputSettings(session.outputSettings);
    if (session.activeTab) setActiveTab(session.activeTab as TabId);
    if (session.videoSourceFolder) setVideoSourceFolder(session.videoSourceFolder);
    // Clear history when restoring a session
    clearHistory();
    toast({ title: "Session Restored", description: "Your previous session has been restored." });
  }, [clearHistory]);

  const handleDiscardSession = useCallback(async () => {
    await clearSession();
  }, []);

  const handleNewTrack = useCallback(() => {
    if (activeTab === "subtitles" && window.__subtitlesAddTrack) {
      window.__subtitlesAddTrack();
    } else if (activeTab === "audios" && window.__audiosAddTrack) {
      window.__audiosAddTrack();
    }
  }, [activeTab]);

  const handleAddExternalFiles = useCallback(
    (
      type: "audio" | "subtitle",
      videoFileId: string,
      paths: string[],
      config: {
        trackName: string;
        language: string;
        delay: number;
        isDefault: boolean;
        isForced: boolean;
        muxAfter: string;
      },
    ) => {
      const addEntries = async () => {
        const inspected = await inspectPaths({
          paths,
          type,
          include_tracks: true,
        });
        const byPath = new Map(
          (inspected as ExternalFile[]).map((item) => [item.path, item]),
        );
        const newEntries = paths.map((path) => {
          const info = byPath.get(path);
          const defaultIncluded =
            info?.tracks && info.tracks.length > 0
              ? info.tracks.map((track) => Number(track.id)).filter((id) => !Number.isNaN(id))
              : [];
          const defaultSubtitleIncluded =
            info?.tracks && info.tracks.length > 0
              ? info.tracks
                  .filter((track) => track.type === "subtitle")
                  .map((track) => Number(track.id))
                  .filter((id) => !Number.isNaN(id))
              : [];
          const defaultIncludeSubtitles =
            type === "audio" &&
            (info?.includeSubtitles !== undefined
              ? info.includeSubtitles
              : defaultSubtitleIncluded.length > 0);
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
            includedSubtitleTrackIds:
              info?.includedSubtitleTrackIds?.length ? info.includedSubtitleTrackIds : defaultSubtitleIncluded,
            trackOverrides: info?.trackOverrides ?? {},
          };
        });
        setPerVideoExternal((prev) => {
          const current = prev[videoFileId] || { audios: [], subtitles: [] };
          return {
            ...prev,
            [videoFileId]:
              type === "audio"
                ? { ...current, audios: [...current.audios, ...newEntries] }
                : { ...current, subtitles: [...current.subtitles, ...newEntries] },
          };
        });
      };
      void addEntries();
    },
    [],
  );

  const handleExternalFilesChange = useCallback(
    (videoFileId: string, type: "audio" | "subtitle", files: ExternalFile[]) => {
      setPerVideoExternal((prev) => {
        const current = prev[videoFileId] || { audios: [], subtitles: [] };
        return {
          ...prev,
          [videoFileId]: type === "audio" ? { ...current, audios: files } : { ...current, subtitles: files },
        };
      });
    },
    [],
  );

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onOpenOptions: () => setIsOptionsOpen(true),
    onModifyTracks: () => setIsModifyTracksOpen(true),
    onNewTrack: handleNewTrack,
    onShowHelp: () => setIsShortcutsOpen(true),
    onToggleSidebar: toggleSidebar,
    onUndo: undo,
    onRedo: redo,
  });

  const renderTabContent = () => {
    switch (activeTab) {
      case "videos":
        return (
          <VideosTab
            files={videoFiles}
            sourceFolder={videoSourceFolder}
            onSourceFolderChange={setVideoSourceFolder}
            onFilesChange={handleVideoFilesChange}
            onAddExternalFiles={handleAddExternalFiles}
            onExternalFilesChange={handleExternalFilesChange}
            externalFilesByVideoId={perVideoExternal}
            preset={activePreset}
          />
        );
      case "subtitles":
        return (
          <SubtitlesTab
            subtitleFiles={subtitleFilesByTrack[activeSubtitleTrack] || []}
            videoFiles={videoFiles}
            onSubtitleFilesChange={(files) =>
              setSubtitleFilesByTrack((prev) => ({
                ...prev,
                [activeSubtitleTrack]: files,
              }))
            }
            onVideoFilesChange={handleVideoFilesChange}
            onAddTrack={handleNewTrack}
            preset={activePreset}
          />
        );
      case "audios":
        return (
          <AudiosTab
            audioFiles={audioFilesByTrack[activeAudioTrack] || []}
            videoFiles={videoFiles}
            onAudioFilesChange={(files) =>
              setAudioFilesByTrack((prev) => ({
                ...prev,
                [activeAudioTrack]: files,
              }))
            }
            onVideoFilesChange={handleVideoFilesChange}
            onAddTrack={handleNewTrack}
            preset={activePreset}
          />
        );
      case "chapters":
        return (
          <ChaptersTab
            chapterFiles={chapterFiles}
            videoFiles={videoFiles}
            onChapterFilesChange={setChapterFiles}
            preset={activePreset}
            onMuxSettingsChange={(updates) => setMuxSettings((prev) => ({ ...prev, ...updates }))}
          />
        );
      case "attachments":
        return (
          <AttachmentsTab
            attachmentFiles={attachmentFiles}
            onAttachmentFilesChange={setAttachmentFiles}
            preset={activePreset}
            onMuxSettingsChange={(updates) => setMuxSettings((prev) => ({ ...prev, ...updates }))}
          />
        );
      case "mux-setting":
        return (
          <MuxSettingTab
            settings={outputSettings}
            onSettingsChange={(updates) => setOutputSettings((prev) => ({ ...prev, ...updates }))}
            fastMuxAvailable={fastMuxAvailable}
            externalLinkIssues={externalLinkIssues}
            jobs={jobs}
            videoFiles={videoFiles}
            onAddToQueue={handleAddToQueue}
            onClearAll={() => setJobs([])}
            onStartMuxing={handleStartMuxing}
            onPauseMuxing={handlePauseMuxing}
            onResumeMuxing={handleResumeMuxing}
            onStopMuxing={handleStopMuxing}
            onViewLog={handleViewLog}
            muxSettings={muxSettings}
            onMuxSettingsChange={(updates) => setMuxSettings((prev) => ({ ...prev, ...updates }))}
            previewResults={previewResults}
            previewLoading={previewLoading}
            onPreviewQueue={handlePreviewQueue}
            getJobReport={getJobReport}
          />
        );
      default:
        return null;
    }
  };

  const activeNavItem = navItems.find((item) => item.id === activeTab);

  return (
    <TooltipProvider delayDuration={0}>
      <AppShell
        sidebar={
          <SidebarNav
            items={navItems}
            activeId={activeTab}
            collapsed={sidebarCollapsed}
            onSelect={(id) => setActiveTab(id as TabId)}
            onToggleCollapse={toggleSidebar}
                brand={
                  <div className="w-9 h-9 rounded-lg bg-accent/20 border border-accent/40 flex items-center justify-center shrink-0">
                    <Film className="w-4 h-4 text-primary" />
                  </div>
                }
              />
            }
        topbar={
          <CommandBar
            title={activeNavItem?.label || "Videos"}
            rightActions={
              <>
                <HistoryToolbar />
                <IconButton onClick={() => setIsOptionsOpen(true)} aria-label="Settings">
                  <Settings />
                </IconButton>
                <IconButton onClick={() => setIsShortcutsOpen(true)} aria-label="Keyboard shortcuts">
                  <LayoutGrid />
                </IconButton>
              </>
            }
          />
        }
      >
        <div className="h-full animate-fade-in">{renderTabContent()}</div>

        {/* Dialogs */}
        <OptionsDialog
          open={isOptionsOpen}
          onOpenChange={setIsOptionsOpen}
          options={options}
          onSave={handleSaveOptions}
        />

        <ModifyTracksDialog
          open={isModifyTracksOpen}
          onOpenChange={setIsModifyTracksOpen}
          videoFiles={videoFiles}
          onFilesChange={handleVideoFilesChange}
        />

        <KeyboardShortcutsDialog open={isShortcutsOpen} onOpenChange={setIsShortcutsOpen} />

        <SessionRecoveryDialog
          onRestore={handleRestoreSession}
          onDiscard={handleDiscardSession}
        />
      </AppShell>
    </TooltipProvider>
  );
};

export default WorkspacePage;
