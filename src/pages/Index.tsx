import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Settings,
  Keyboard,
  Video,
  Subtitles,
  AudioLines,
  List,
  Paperclip,
  SlidersHorizontal,
  Film,
} from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VideosTab } from "@/components/workspace/VideosTab";
import { SubtitlesTab } from "@/components/workspace/SubtitlesTab";
import { AudiosTab } from "@/components/workspace/AudiosTab";
import { ChaptersTab } from "@/components/workspace/ChaptersTab";
import { AttachmentsTab } from "@/components/workspace/AttachmentsTab";
import { MuxSettingTab } from "@/components/workspace/MuxSettingTab";
import { OptionsDialog } from "@/components/workspace/OptionsDialog";
import { ModifyTracksDialog } from "@/components/workspace/ModifyTracksDialog";
import { KeyboardShortcutsDialog } from "@/components/workspace/KeyboardShortcutsDialog";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useTabState } from "@/stores/useTabState";
import { toast } from "@/hooks/use-toast";
import type {
  VideoFile,
  ExternalFile,
  OutputSettings,
  MuxJob,
  OptionsData,
  Preset,
  MuxSettings,
  MuxPreviewResult,
} from "@/types";
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
} from "@/lib/backend";
import { listen } from "@tauri-apps/api/event";
import { AppShell } from "@/components/shared/AppShell";
import { SidebarNav } from "@/components/shared/SidebarNav";
import { CommandBar } from "@/components/shared/CommandBar";
import { IconButton } from "@/components/shared/IconButton";

type TabId = "videos" | "subtitles" | "audios" | "chapters" | "attachments" | "mux-setting";

const navItems: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "videos", label: "Videos", icon: Video },
  { id: "subtitles", label: "Subtitles", icon: Subtitles },
  { id: "audios", label: "Audio Tracks", icon: AudioLines },
  { id: "chapters", label: "Chapters", icon: List },
  { id: "attachments", label: "Attachments", icon: Paperclip },
  { id: "mux-setting", label: "Mux Settings", icon: SlidersHorizontal },
];

const Index = () => {
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem("sidebar-collapsed");
    return saved === "true";
  });
  const [activeTab, setActiveTab] = useState<TabId>("videos");
  const [videoFiles, setVideoFiles] = useState<VideoFile[]>([]);
  const [subtitleFiles, setSubtitleFiles] = useState<ExternalFile[]>([]);
  const [audioFiles, setAudioFiles] = useState<ExternalFile[]>([]);
  const [chapterFiles, setChapterFiles] = useState<ExternalFile[]>([]);
  const [attachmentFiles, setAttachmentFiles] = useState<ExternalFile[]>([]);
  const [perVideoExternal, setPerVideoExternal] = useState<
    Record<string, { audios: ExternalFile[]; subtitles: ExternalFile[] }>
  >({});
  const [jobs, setJobs] = useState<MuxJob[]>([]);
  const [previewResults, setPreviewResults] = useState<Record<string, MuxPreviewResult>>({});
  const [previewLoading, setPreviewLoading] = useState(false);
  const [progressTick, setProgressTick] = useState(0);
  const [options, setOptions] = useState<OptionsData | null>(null);
  const [activePreset, setActivePreset] = useState<Preset | null>(null);
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);
  const [isModifyTracksOpen, setIsModifyTracksOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [videoSourceFolder, setVideoSourceFolder] = useState("");
  const createExternalId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

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
    discardOldAttachments: false,
    allowDuplicateAttachments: false,
    attachmentsExpertMode: false,
    makeAudioDefaultLanguage: undefined,
    makeSubtitleDefaultLanguage: undefined,
    useMkvpropedit: false,
  });

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
  }, []);

  // Persist sidebar state
  useEffect(() => {
    localStorage.setItem("sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  useEffect(() => {
    const unlistenPromise = listenMuxProgress((payload) => {
      setJobs((prev) => {
        const now = Date.now();
        return prev.map((job) => {
          if (job.id !== payload.job_id) return job;
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
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (jobs.length === 0) return;
    const intervalId = window.setInterval(() => {
      setProgressTick((tick) => tick + 1);
    }, 300);
    return () => window.clearInterval(intervalId);
  }, [jobs]);

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
    const unlistenPromise = listen<{ paths: string[] }>("tauri://file-drop", async (event) => {
      const paths = event.payload?.paths || [];
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
        include_tracks: type === "video",
      });

      if (type === "video") {
        setVideoFiles((prev) => [...prev, ...(results as VideoFile[])]);
      } else if (type === "subtitle") {
        setSubtitleFiles((prev) => [...prev, ...(results as ExternalFile[])]);
      } else if (type === "audio") {
        setAudioFiles((prev) => [...prev, ...(results as ExternalFile[])]);
      } else if (type === "chapter") {
        setChapterFiles((prev) => [...prev, ...(results as ExternalFile[])]);
      } else {
        setAttachmentFiles((prev) => [...prev, ...(results as ExternalFile[])]);
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [activePreset, activeTab]);

  const handleAddToQueue = () => {
    const newJobs: MuxJob[] = videoFiles
      .filter((f) => f.status === "pending")
      .map((f) => ({
        id: `job-${f.id}`,
        videoFile: f,
        status: "queued" as const,
        progress: 0,
        sizeBefore: f.size,
      }));
    setJobs((prev) => [...prev, ...newJobs]);
  };

  const buildJobRequests = useCallback(() => {
    const normalizeName = (value: string) =>
      value
        .toLowerCase()
        .replace(/\.[^/.]+$/, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

    const findBestVideoMatch = (filePath: string) => {
      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      const normalizedFile = normalizeName(fileName);
      let best: { id: string; score: number } | null = null;
      videoFiles.forEach((video) => {
        const videoName = video.path.split(/[\\/]/).pop() || video.path;
        const normalizedVideo = normalizeName(videoName);
        if (!normalizedFile || !normalizedVideo) return;
        let score = 0;
        if (normalizedVideo.includes(normalizedFile)) {
          score = normalizedFile.length;
        } else if (normalizedFile.includes(normalizedVideo)) {
          score = normalizedVideo.length;
        }
        if (score > 0 && (!best || score > best.score)) {
          best = { id: video.id, score };
        }
      });
      return best?.id;
    };

    const mapByVideoId = <T extends ExternalFile>(files: T[]) => {
      const map = new Map<string, T[]>();
      files.forEach((file, index) => {
        const matchedId =
          file.matchedVideoId || findBestVideoMatch(file.path) || videoFiles[index]?.id;
        if (!matchedId) return;
        const current = map.get(matchedId) || [];
        current.push(file);
        map.set(matchedId, current);
      });
      return map;
    };

    const audioMap = mapByVideoId(audioFiles);
    const subtitleMap = mapByVideoId(subtitleFiles);
    const chapterMap = mapByVideoId(chapterFiles);
    const attachmentMap = mapByVideoId(attachmentFiles);

    const muxAfterRank = (value?: string) => {
      if (!value || value === "video") return 0;
      if (value.startsWith("track-")) {
        const index = Number(value.replace("track-", ""));
        return Number.isFinite(index) ? index : 1;
      }
      if (value === "end") return 99;
      return 0;
    };
    const orderByMuxAfter = (
      files: Array<{ file: ExternalFile; sourcePriority: number; order: number }>,
    ) =>
      [...files].sort((a, b) => {
        const rankDiff = muxAfterRank(a.file.muxAfter) - muxAfterRank(b.file.muxAfter);
        if (rankDiff !== 0) return rankDiff;
        if (a.sourcePriority !== b.sourcePriority) return a.sourcePriority - b.sourcePriority;
        return a.order - b.order;
      });

    return videoFiles.map((video) => {
      const perVideo = perVideoExternal[video.id] || { audios: [], subtitles: [] };
      const bulkAudios = (audioMap.get(video.id) || []).map((file, index) => ({
        file: {
          ...file,
          isDefault: file.isDefault ?? true,
          source: "bulk",
        },
        sourcePriority: 0,
        order: index,
      }));
      const perVideoAudios = perVideo.audios.map((file, index) => ({
        file: {
          ...file,
          isDefault: file.isDefault ?? false,
          source: "per-file",
        },
        sourcePriority: 1,
        order: index,
      }));
      const mergedAudios = orderByMuxAfter([...bulkAudios, ...perVideoAudios]).map(
        (entry) => entry.file,
      );

      const bulkSubtitles = (subtitleMap.get(video.id) || []).map((file, index) => ({
        file: {
          ...file,
          source: "bulk",
        },
        sourcePriority: 0,
        order: index,
      }));
      const perVideoSubtitles = perVideo.subtitles.map((file, index) => ({
        file: {
          ...file,
          source: "per-file",
        },
        sourcePriority: 1,
        order: index,
      }));
      const mergedSubtitles = orderByMuxAfter([...bulkSubtitles, ...perVideoSubtitles]).map(
        (entry) => entry.file,
      );
      return {
        id: `job-${video.id}`,
        video,
        audios: mergedAudios,
        subtitles: mergedSubtitles,
        chapters: chapterMap.get(video.id) || [],
        attachments: attachmentMap.get(video.id) || [],
      };
    });
  }, [audioFiles, attachmentFiles, chapterFiles, subtitleFiles, videoFiles, perVideoExternal]);

  const fastMuxAvailable = useMemo(() => {
    const hasExternal =
      audioFiles.length > 0 ||
      subtitleFiles.length > 0 ||
      chapterFiles.length > 0 ||
      attachmentFiles.length > 0;
    const hasRemovedTracks = videoFiles.some((video) =>
      (video.tracks || []).some((track) => track.action === "remove"),
    );
    const hasLanguageFilters =
      muxSettings.onlyKeepAudiosEnabled ||
      muxSettings.onlyKeepSubtitlesEnabled ||
      Boolean(muxSettings.makeAudioDefaultLanguage) ||
      Boolean(muxSettings.makeSubtitleDefaultLanguage);
    return !hasExternal && !hasRemovedTracks && !hasLanguageFilters;
  }, [
    audioFiles.length,
    attachmentFiles.length,
    chapterFiles.length,
    subtitleFiles.length,
    muxSettings.makeAudioDefaultLanguage,
    muxSettings.makeSubtitleDefaultLanguage,
    muxSettings.onlyKeepAudiosEnabled,
    muxSettings.onlyKeepSubtitlesEnabled,
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
  }, [buildEffectiveMuxSettings, buildJobRequests]);

  const handlePreviewQueue = useCallback(async () => {
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
  }, [buildEffectiveMuxSettings, buildJobRequests]);

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
          ? { ...job, status: "error", errorMessage: "Stopped by user." }
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

  const handleNewTrack = useCallback(() => {
    if (activeTab === "subtitles" && (window as any).__subtitlesAddTrack) {
      (window as any).__subtitlesAddTrack();
    } else if (activeTab === "audios" && (window as any).__audiosAddTrack) {
      (window as any).__audiosAddTrack();
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
          include_tracks: false,
        });
        const byPath = new Map(
          (inspected as ExternalFile[]).map((item) => [item.path, item]),
        );
        const newEntries = paths.map((path) => {
          const info = byPath.get(path);
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
            onFilesChange={setVideoFiles}
            onAddExternalFiles={handleAddExternalFiles}
            onExternalFilesChange={handleExternalFilesChange}
            externalFilesByVideoId={perVideoExternal}
            preset={activePreset}
          />
        );
      case "subtitles":
        return (
          <SubtitlesTab
            subtitleFiles={subtitleFiles}
            videoFiles={videoFiles}
            onSubtitleFilesChange={setSubtitleFiles}
            onVideoFilesChange={setVideoFiles}
            onAddTrack={handleNewTrack}
            preset={activePreset}
          />
        );
      case "audios":
        return (
          <AudiosTab
            audioFiles={audioFiles}
            videoFiles={videoFiles}
            onAudioFilesChange={setAudioFiles}
            onVideoFilesChange={setVideoFiles}
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
              <>
                <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center shrink-0">
                  <Film className="w-4 h-4 text-primary-foreground" />
                </div>
                {!sidebarCollapsed && (
                  <h1 className="text-sm font-semibold text-foreground tracking-tight">MKV Batch</h1>
                )}
              </>
            }
          />
        }
        topbar={
          <CommandBar
            title={activeNavItem?.label || "Videos"}
            rightActions={
              <>
                <IconButton onClick={() => setIsOptionsOpen(true)} aria-label="Settings">
                  <Settings />
                </IconButton>
                <IconButton onClick={() => setIsShortcutsOpen(true)} aria-label="Keyboard shortcuts">
                  <Keyboard />
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
          onFilesChange={setVideoFiles}
        />

        <KeyboardShortcutsDialog open={isShortcutsOpen} onOpenChange={setIsShortcutsOpen} />
      </AppShell>
    </TooltipProvider>
  );
};

export default Index;
