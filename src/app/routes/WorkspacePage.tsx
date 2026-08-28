import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Settings,
  Video,
  Subtitles,
  AudioLines,
  List,
  Paperclip,
  SlidersHorizontal,
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
import { useKeyboardShortcuts } from "@/features/workspace/hooks/useKeyboardShortcuts";
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
import { buildMuxJobRequests } from "@/features/workspace/lib/muxJobBuilder";
import { areVideoListsEquivalent } from "@/features/workspace/lib/videoCompare";
import type { MuxProgressEvent } from "@/shared/lib/backend";
import { getUnlinkedExternalFiles } from "@/shared/lib/matchUtils";

type TabId = "videos" | "subtitles" | "audios" | "chapters" | "attachments" | "mux-setting";
const MAX_PARALLEL_JOBS = 16;

const navItems: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "videos", label: "Videos", icon: Video },
  { id: "subtitles", label: "Subtitles", icon: Subtitles },
  { id: "audios", label: "Audio Tracks", icon: AudioLines },
  { id: "chapters", label: "Chapters", icon: List },
  { id: "attachments", label: "Attachments", icon: Paperclip },
  { id: "mux-setting", label: "Mux Settings", icon: SlidersHorizontal },
];

const WorkspacePage = () => {
  // Dark is the default. Options load asynchronously from the backend, so
  // starting light would flash a white window before Dark_Mode arrives.
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebar-collapsed") === "true";
    } catch {
      return false;
    }
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
  const [searchValue, setSearchValue] = useState("");
  const [fileFilter, setFileFilter] = useState("all");
  const [fileSort, setFileSort] = useState("loaded");
  const [options, setOptions] = useState<OptionsData | null>(null);
  const [activePreset, setActivePreset] = useState<Preset | null>(null);
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);
  const [isModifyTracksOpen, setIsModifyTracksOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [videoSourceFolder, setVideoSourceFolder] = useState("");
  const activeAudioTrack = useTabState((state) => state.activeAudioTrack);
  const activeSubtitleTrack = useTabState((state) => state.activeSubtitleTrack);
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
    outputNamingPattern: "{original_filename}",
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

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("sidebar-collapsed", String(sidebarCollapsed));
    } catch {
      // Sidebar preference is non-critical.
    }
  }, [sidebarCollapsed]);

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
    setJobs((prev) => {
      const next = [...prev, ...newJobs];
      setMuxSettings((current) => ({
        ...current,
        maxParallelJobs: Math.max(1, Math.min(next.length || 1, MAX_PARALLEL_JOBS)),
      }));
      return next;
    });
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
    const inPlaceOverwrite = outputSettings.directory.trim() === "" && outputSettings.overwriteExisting;
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
    if (!fastMuxAvailable && muxSettings.useMkvpropedit) {
      setMuxSettings((prev) => ({ ...prev, useMkvpropedit: false }));
    }
  }, [fastMuxAvailable, muxSettings.useMkvpropedit]);

  const buildEffectiveMuxSettings = useCallback(
    (jobCount: number) => {
      const autoParallelJobs = Math.max(1, Math.min(jobCount || 1, MAX_PARALLEL_JOBS));
      const settings: MuxSettings = {
        ...muxSettings,
        maxParallelJobs: autoParallelJobs,
        destinationDir: outputSettings.directory,
        outputNamingPattern: outputSettings.namingPattern,
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
    // Pause stops the queue from starting new jobs; anything already handed to
    // mkvmerge finishes first. Say so, otherwise Pause looks broken.
    toast({
      title: "Pausing after current job",
      description:
        "No new jobs will start. Jobs already running will finish first — use Stop to cancel them immediately.",
    });
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
    saveOptions(updated).catch((error) => {
      const message =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : "Options could not be saved.";
      toast({
        title: "Options save failed",
        description: message,
        variant: "destructive",
      });
    });
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

  /** Smart video file change handler for add, remove, and modify updates. */
  // The caller already merged by file identity (path, then name+size), so the
  // list it hands over is authoritative and simply replaces state.
  //
  // This used to diff by `id` and append anything whose id was unseen. A scan
  // emits each file twice -- once as a pending stub, then again once inspected
  // -- and the backend mints a fresh id each time. mergeVideoFiles collapses
  // the pair and keeps the *first* id, so every inspected file read as "added"
  // and was appended: 16 files became 32.
  const handleVideoFilesChange = useCallback((newFiles: VideoFile[]) => {
    setVideoFiles((prev) => (areVideoListsEquivalent(prev, newFiles) ? prev : newFiles));
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
            searchValue={searchValue}
            filterValue={fileFilter}
            sortValue={fileSort}
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
            searchValue={searchValue}
            filterValue={fileFilter}
            sortValue={fileSort}
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
            searchValue={searchValue}
            filterValue={fileFilter}
            sortValue={fileSort}
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
            searchValue={searchValue}
            filterValue={fileFilter}
            sortValue={fileSort}
          />
        );
      case "attachments":
        return (
          <AttachmentsTab
            attachmentFiles={attachmentFiles}
            onAttachmentFilesChange={setAttachmentFiles}
            preset={activePreset}
            onMuxSettingsChange={(updates) => setMuxSettings((prev) => ({ ...prev, ...updates }))}
            searchValue={searchValue}
            sortValue={fileSort}
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

  // Counts shown next to each nav item, derived from state that already exists.
  // Purely presentational: nothing here changes what the app does.
  const navItemsWithCounts = useMemo(
    () =>
      navItems.map((item) => {
        switch (item.id) {
          case "videos":
            return { ...item, count: videoFiles.length };
          case "audios":
            return {
              ...item,
              count: audioFilesCount,
              warn: unlinkedAudioFiles.length > 0,
            };
          case "subtitles":
            return {
              ...item,
              count: subtitleFilesCount,
              warn: unlinkedSubtitleFiles.length > 0,
            };
          case "chapters":
            return { ...item, count: chapterFiles.length };
          case "attachments":
            return { ...item, count: attachmentFiles.length };
          case "mux-setting":
            return { ...item, count: jobs.length };
          default:
            return item;
        }
      }),
    [
      attachmentFiles.length,
      audioFilesCount,
      chapterFiles.length,
      jobs.length,
      subtitleFilesCount,
      unlinkedAudioFiles.length,
      unlinkedSubtitleFiles.length,
      videoFiles.length,
    ],
  );

  return (
    <TooltipProvider delayDuration={0}>
      <AppShell
        sidebar={
          <SidebarNav
            items={navItemsWithCounts}
            activeId={activeTab}
            collapsed={sidebarCollapsed}
            onSelect={(id) => setActiveTab(id as TabId)}
            onToggleCollapse={toggleSidebar}
          />
        }
        topbar={
          <CommandBar
            title={activeNavItem?.label || "Videos"}
            searchValue={searchValue}
            onSearchChange={setSearchValue}
            searchPlaceholder={`Search ${activeNavItem?.label?.toLowerCase() || "files"}...`}
            filterValue={fileFilter}
            onFilterChange={setFileFilter}
            sortValue={fileSort}
            onSortChange={setFileSort}
            rightActions={
              <>
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

      </AppShell>
    </TooltipProvider>
  );
};

export default WorkspacePage;
