import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, RefreshCw, FolderOpen, Film, Trash2 } from "lucide-react";
import { Button } from "@/shared/ui/button";
import {
  Select,
  SelectItem,
  SelectValue,
} from "@/shared/ui/select";
import { ModifyTracksDialog } from "./ModifyTracksDialog";
import { VideoFileEditDialog } from "./VideoFileEditDialog";
import { MediaInfoDialog } from "./MediaInfoDialog";
import type { Preset, VideoFile, ExternalFile } from "@/shared/types";
import {
  cancelScan as cancelBackendScan,
  pickDirectory,
  scanMedia,
  inspectPathsStream,
  listenInspectPathsStreamChunk,
  listenInspectPathsStreamDone,
  listenInspectPathsStreamError,
} from "@/shared/lib/backend";
import { VIDEO_EXTENSIONS } from "@/shared/lib/extensions";
import { PageLayout } from "@/shared/components/PageLayout";
import { TextField, DropdownTrigger, DropdownContent } from "@/shared/components/Fields";
import { IconButton } from "@/shared/components/IconButton";
import {
  DataTable,
  DataTableHeader,
  DataTableBody,
  DataTableRow,
  DataTableCell,
} from "@/shared/components/DataTable";
import { EmptyState } from "@/shared/components/EmptyState";
import { mergeVideoFiles } from "../lib/videoMerge";

interface VideosTabProps {
  files: VideoFile[];
  sourceFolder: string;
  onSourceFolderChange: (folder: string) => void;
  onFilesChange: (files: VideoFile[]) => void;
  onAddExternalFiles?: (
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
  ) => void;
  externalFilesByVideoId?: Record<string, { audios: ExternalFile[]; subtitles: ExternalFile[] }>;
  onExternalFilesChange?: (videoFileId: string, type: "audio" | "subtitle", files: ExternalFile[]) => void;
  preset?: Preset | null;
  searchValue?: string;
  filterValue?: string;
  sortValue?: string;
}

function formatFileSize(bytes?: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const gb = bytes / 1073741824;
  return gb.toFixed(2) + " GB";
}

export function VideosTab({
  files,
  sourceFolder,
  onSourceFolderChange,
  onFilesChange,
  onAddExternalFiles,
  externalFilesByVideoId,
  onExternalFilesChange,
  preset,
  searchValue = "",
  filterValue = "all",
  sortValue = "loaded",
}: VideosTabProps) {
  const videoExtensions = VIDEO_EXTENSIONS.map((ext) => ext.toLowerCase());
  const [videoExtension, setVideoExtension] = useState("all");
  const [durationFps, setDurationFps] = useState("default");
  const [isModifyTracksOpen, setIsModifyTracksOpen] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ current: 0, total: 0 });
  const [showScanOverlay, setShowScanOverlay] = useState(false);
  const [editingFile, setEditingFile] = useState<VideoFile | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isMediaInfoOpen, setIsMediaInfoOpen] = useState(false);
  const scanTokenRef = useRef(0);
  const scanAbortRef = useRef(false);
  const activeScanIdRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const ROW_HEIGHT = 34;
  const OVERSCAN_ROWS = 8;
  const normalizedSearch = searchValue.trim().toLowerCase();
  const displayFiles = useMemo(() => {
    const filtered = files.filter((file) => {
      if (normalizedSearch && !`${file.name} ${file.path}`.toLowerCase().includes(normalizedSearch)) {
        return false;
      }
      if (filterValue === "linked") {
        return Boolean(externalFilesByVideoId?.[file.id]?.audios.length || externalFilesByVideoId?.[file.id]?.subtitles.length);
      }
      if (filterValue === "unlinked") {
        return !(externalFilesByVideoId?.[file.id]?.audios.length || externalFilesByVideoId?.[file.id]?.subtitles.length);
      }
      return true;
    });
    if (sortValue === "name-asc") {
      return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    }
    if (sortValue === "name-desc") {
      return [...filtered].sort((a, b) => b.name.localeCompare(a.name));
    }
    if (sortValue === "size-desc") {
      return [...filtered].sort((a, b) => (b.size || 0) - (a.size || 0));
    }
    return filtered;
  }, [externalFilesByVideoId, files, filterValue, normalizedSearch, sortValue]);

  useEffect(() => {
    setSelectedFileIds([]);
    setSelectedFileId(null);
    setLastSelectedIndex(null);
  }, [normalizedSearch]);

  const shouldVirtualize = displayFiles.length > 120;

  const virtualRange = useMemo(() => {
    if (!shouldVirtualize) {
      return {
        startIndex: 0,
        endIndex: displayFiles.length,
        topSpacer: 0,
        bottomSpacer: 0,
      };
    }
    const visibleRows = Math.ceil(viewportHeight / ROW_HEIGHT);
    const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
    const endIndex = Math.min(displayFiles.length, startIndex + visibleRows + OVERSCAN_ROWS * 2);
    return {
      startIndex,
      endIndex,
      topSpacer: startIndex * ROW_HEIGHT,
      bottomSpacer: Math.max(0, (displayFiles.length - endIndex) * ROW_HEIGHT),
    };
  }, [displayFiles.length, scrollTop, viewportHeight, shouldVirtualize]);

  const visibleFiles = shouldVirtualize
    ? displayFiles.slice(virtualRange.startIndex, virtualRange.endIndex)
    : displayFiles;

  const updateFiles = useCallback((next: VideoFile[]) => {
    startTransition(() => {
      onFilesChange(mergeVideoFiles(next));
    });
  }, [onFilesChange]);

  const handleDoubleClick = useCallback((file: VideoFile) => {
    setEditingFile(file);
    setIsEditDialogOpen(true);
  }, []);

  useEffect(() => {
    if (files.length === 0) {
      setSelectedFileIds([]);
      setSelectedFileId(null);
      setLastSelectedIndex(null);
      return;
    }
    setSelectedFileIds((prev) => prev.filter((id) => files.some((file) => file.id === id)));
    if (selectedFileId && !files.some((file) => file.id === selectedFileId)) {
      setSelectedFileId(null);
    }
  }, [files, selectedFileId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isSelectAll = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a";
      if (!isSelectAll) return;
      const target = event.target as HTMLElement | null;
      const isEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          (target as HTMLElement).isContentEditable);
      if (isEditable) return;
      event.preventDefault();
      const allIds = displayFiles.map((file) => file.id);
      setSelectedFileIds(allIds);
      setSelectedFileId(allIds[0] ?? null);
      setLastSelectedIndex(displayFiles.length > 0 ? displayFiles.length - 1 : null);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [displayFiles]);

  const handleRowClick = useCallback((event: React.MouseEvent, index: number, fileId: string) => {
    const isToggle = event.metaKey || event.ctrlKey;
    const isRange = event.shiftKey;
    if (isRange && lastSelectedIndex !== null) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      const rangeIds = displayFiles.slice(start, end + 1).map((file) => file.id);
      setSelectedFileIds(rangeIds);
      setSelectedFileId(fileId);
      setLastSelectedIndex(index);
      return;
    }
    if (isToggle) {
      setSelectedFileIds((prev) => {
        const set = new Set(prev);
        if (set.has(fileId)) {
          set.delete(fileId);
        } else {
          set.add(fileId);
        }
        const next = Array.from(set);
        if (!set.has(selectedFileId || "")) {
          setSelectedFileId(next[0] ?? null);
        } else {
          setSelectedFileId(fileId);
        }
        return next;
      });
      setLastSelectedIndex(index);
      return;
    }
    setSelectedFileIds([fileId]);
    setSelectedFileId(fileId);
    setLastSelectedIndex(index);
  }, [displayFiles, lastSelectedIndex, selectedFileId]);

  const handleSaveFile = (updatedFile: VideoFile) => {
    onFilesChange(files.map((f) => (f.id === updatedFile.id ? updatedFile : f)));
  };

  const handleMediaInfo = () => {
    if (selectedFileIds.length === 0) return;
    setIsMediaInfoOpen(true);
  };


  useEffect(() => {
    if (!preset) return;
    const defaultExt = preset.Default_Video_Extensions?.[0];
    if (defaultExt) {
      setVideoExtension(defaultExt.toLowerCase());
    }
  }, [preset]);
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setViewportHeight(element.clientHeight);
    });
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const cancelScan = () => {
    scanAbortRef.current = true;
    if (activeScanIdRef.current) {
      void cancelBackendScan(activeScanIdRef.current);
    }
    setIsScanning(false);
    setShowScanOverlay(false);
  };

  const scanVideos = async (folderPath: string) => {
    if (!folderPath) {
      cancelScan();
      onFilesChange([]);
      return;
    }
    scanAbortRef.current = false;
    scanTokenRef.current += 1;
    const scanToken = scanTokenRef.current;
    setIsScanning(true);
    setShowScanOverlay(true);
    setScanProgress({ current: 0, total: 0 });
    const scanStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    let firstChunkAt: number | null = null;
    const extensions = videoExtension === "all" ? [...videoExtensions] : [videoExtension];
    try {
      const results = (await scanMedia({
        folder: folderPath,
        extensions,
        recursive: false,
        type: "video",
        include_tracks: false,
      })) as VideoFile[];
      const normalizedExtensions = new Set(extensions.map((ext) => ext.toLowerCase()));
      let currentFiles = mergeVideoFiles(results.filter((file) => {
        const ext = file.path.split(".").pop()?.toLowerCase();
        return ext ? normalizedExtensions.has(ext) : false;
      }));
      if (scanAbortRef.current || scanTokenRef.current !== scanToken) return;
      updateFiles(currentFiles);

      const paths = currentFiles.map((file) => file.path);
      setScanProgress({ current: 0, total: paths.length });

      let scannedFiles = currentFiles;
      let processed = 0;
      let updateQueued = false;
      const queueUiUpdate = () => {
        if (updateQueued) return;
        updateQueued = true;
        requestAnimationFrame(() => {
          updateQueued = false;
          if (scanAbortRef.current || scanTokenRef.current !== scanToken) return;
          currentFiles = scannedFiles;
          updateFiles(scannedFiles);
          setScanProgress({ current: processed, total: paths.length });
        });
      };

      const streamId = `video-scan-${scanToken}`;
      activeScanIdRef.current = streamId;
      let resolveDone: () => void = () => undefined;
      let rejectDone: (error: Error) => void = () => undefined;
      const donePromise = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });

      const unlistenChunk = await listenInspectPathsStreamChunk((payload) => {
        if (payload.scanId !== streamId) return;
        if (scanAbortRef.current || scanTokenRef.current !== scanToken) return;
        if (firstChunkAt === null) {
          firstChunkAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        }
        scannedFiles = mergeVideoFiles([...scannedFiles, ...(payload.items as VideoFile[])]);
        processed = payload.processed;
        queueUiUpdate();
      });
      const unlistenDone = await listenInspectPathsStreamDone((payload) => {
        if (payload.scanId !== streamId) return;
        resolveDone();
      });
      const unlistenError = await listenInspectPathsStreamError((payload) => {
        if (payload.scanId !== streamId) return;
        rejectDone(new Error(payload.message || "Scan stream failed."));
      });

      try {
        await inspectPathsStream({
          scan_id: streamId,
          paths,
          type: "video",
          include_tracks: true,
          batch_size: 24,
        });
        await donePromise;
      } finally {
        if (activeScanIdRef.current === streamId) {
          activeScanIdRef.current = null;
        }
        unlistenChunk();
        unlistenDone();
        unlistenError();
      }

      if (scanAbortRef.current || scanTokenRef.current !== scanToken) return;
      if (!updateQueued) {
        currentFiles = scannedFiles;
        updateFiles(scannedFiles);
        setScanProgress({ current: paths.length, total: paths.length });
      }

      if (import.meta.env.DEV) {
        const completedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        const firstPaintMs = firstChunkAt ? Math.round(firstChunkAt - scanStartedAt) : -1;
        const totalMs = Math.round(completedAt - scanStartedAt);
        console.info(`[perf] video scan first-chunk=${firstPaintMs}ms total=${totalMs}ms files=${paths.length}`);
      }
    } finally {
      if (scanTokenRef.current === scanToken) {
        setIsScanning(false);
        setShowScanOverlay(false);
      }
    }
  };

  const formatFps = (fps?: number) => {
    if (!fps) return "—";
    const fixed = fps.toFixed(3);
    return fixed.replace(/\.?0+$/, "");
  };

  return (
    <PageLayout>
      {showScanOverlay && (
        <div className="fluent-loading-overlay">
          <div className="fluent-loading-card">
            <div className="fluent-loading-header">
              <div className="fluent-loading-title">
                <Film className="w-4 h-4" />
                <span>Loading media Info</span>
              </div>
              <button
                type="button"
                className="fluent-loading-close"
                onClick={cancelScan}
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="fluent-loading-body">
              <div className="fluent-spinner" />
            <div className="fluent-loading-text">
                {scanProgress.total > 0
                  ? `${Math.min(scanProgress.current, scanProgress.total)}/${scanProgress.total} files loaded`
                  : "Scanning videos..."}
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="fluent-surface p-4">
        <div className="video-source-panel">
          <div className="video-source-copy">
            <div className="video-source-kicker">Video import</div>
            <div className="video-source-title-row">
              <label className="text-xs font-medium text-muted-foreground whitespace-nowrap">Source folder</label>
            </div>
          </div>
          <div className="video-source-controls">
            <TextField
              value={sourceFolder}
              onChange={(e) => onSourceFolderChange(e.target.value)}
              placeholder="Select video source folder..."
              className="flex-1"
            />
            <div className="flex items-center gap-2">
              <IconButton
                className="border border-panel-border bg-[hsl(var(--control))] hover:bg-[hsl(var(--control-hover))] text-foreground"
                onClick={async () => {
                  const folder = await pickDirectory();
                  if (folder) {
                    onSourceFolderChange(folder);
                    scanVideos(folder);
                  }
                }}
                aria-label="Browse for source folder"
              >
                <FolderOpen className="w-4 h-4" />
              </IconButton>
              <IconButton
                className="border border-panel-border bg-[hsl(var(--control))] hover:bg-[hsl(var(--control-hover))] text-foreground"
                onClick={() => scanVideos(sourceFolder)}
                aria-label="Rescan folder"
              >
                <RefreshCw className="w-4 h-4" />
              </IconButton>
              <IconButton
                className="border border-panel-border bg-[hsl(var(--control))] hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
                onClick={() => {
                  cancelScan();
                  onSourceFolderChange("");
                  onFilesChange([]);
                }}
                aria-label="Clear folder and loaded files"
              >
                <X className="w-4 h-4" />
              </IconButton>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-6 mt-4 pt-4 border-t border-panel-border">
          <div className="flex items-center gap-2">
            <label className="text-sm text-muted-foreground">Extension</label>
            <Select value={videoExtension} onValueChange={setVideoExtension}>
              <DropdownTrigger className="w-40">
                <SelectValue />
              </DropdownTrigger>
              <DropdownContent>
                <SelectItem value="all">All formats</SelectItem>
                {VIDEO_EXTENSIONS.map((ext) => (
                  <SelectItem key={ext} value={ext}>
                    {ext.toUpperCase()}
                  </SelectItem>
                ))}
              </DropdownContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm text-muted-foreground">FPS</label>
            <Select value={durationFps} onValueChange={setDurationFps}>
              <DropdownTrigger className="w-32">
                <SelectValue />
              </DropdownTrigger>
              <DropdownContent>
                <SelectItem value="default">Default</SelectItem>
                <SelectItem value="23.976">23.976</SelectItem>
                <SelectItem value="24">24</SelectItem>
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="29.97">29.97</SelectItem>
                <SelectItem value="30">30</SelectItem>
                <SelectItem value="60">60</SelectItem>
              </DropdownContent>
            </Select>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setIsModifyTracksOpen(true)}>
              Modify tracks
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleMediaInfo}
              disabled={selectedFileIds.length === 0}
            >
              Media info
            </Button>
          </div>
        </div>
      </div>

      <div className="fluent-surface flex-1 flex flex-col min-h-0 p-0 overflow-hidden">
        <DataTable className="h-full flex flex-col">
          <DataTableHeader className="grid grid-cols-[1fr_90px_120px_140px] items-center">
            <DataTableCell>File name</DataTableCell>
            <DataTableCell className="right">FPS</DataTableCell>
            <DataTableCell className="right">Duration</DataTableCell>
            <DataTableCell className="right">Size</DataTableCell>
          </DataTableHeader>

          <DataTableBody
            ref={bodyRef}
            className="flex-1"
            onScroll={(event) => {
              if (!shouldVirtualize) return;
              setScrollTop(event.currentTarget.scrollTop);
            }}
          >
            {files.length === 0 ? (
              <EmptyState
                icon={
                  isScanning && !showScanOverlay ? (
                    <div className="w-6 h-6 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground/70 animate-spin" />
                  ) : (
                    <Film className="w-6 h-6 text-muted-foreground/60" />
                  )
                }
                title={isScanning && !showScanOverlay ? "Scanning videos..." : "No video files found"}
                description={
                  isScanning && !showScanOverlay
                    ? "Loading video metadata"
                    : "Use the folder button above to choose a source folder"
                }
              />
            ) : displayFiles.length === 0 ? (
              <EmptyState
                icon={<Film className="w-6 h-6 text-muted-foreground/60" />}
                title="No videos match the search"
                description="Clear the search field to show all loaded videos"
              />
            ) : (
              <>
                {virtualRange.topSpacer > 0 && <div style={{ height: virtualRange.topSpacer }} />}
                {visibleFiles.map((file, visibleIndex) => {
                  const index = shouldVirtualize
                    ? virtualRange.startIndex + visibleIndex
                    : visibleIndex;
                  return (
                <DataTableRow
                  key={file.id}
                  selected={selectedFileIds.includes(file.id)}
                  onClick={(event) => handleRowClick(event, index, file.id)}
                  onDoubleClick={() => handleDoubleClick(file)}
                  className="group grid grid-cols-[1fr_90px_120px_140px] items-center cursor-pointer h-[34px]"
                >
                  <DataTableCell className="font-mono text-foreground/85">{file.name}</DataTableCell>
                  <DataTableCell className="right muted tabular-nums">{formatFps(file.fps)}</DataTableCell>
                  <DataTableCell className="right muted tabular-nums">{file.duration || "—"}</DataTableCell>
                  <DataTableCell className="right muted font-mono tabular-nums">
                    {formatFileSize(file.size)}
                  </DataTableCell>
                </DataTableRow>
                  );
                })}
                {virtualRange.bottomSpacer > 0 && <div style={{ height: virtualRange.bottomSpacer }} />}
              </>
            )}
          </DataTableBody>
          <div className="flex items-center justify-between px-3 py-1.5 border-t border-panel-border bg-panel-header">
            <span className="text-xs text-muted-foreground px-1">
              {selectedFileIds.length > 0
                ? `${selectedFileIds.length} of ${files.length} selected`
                : `${files.length} ${files.length === 1 ? "file" : "files"}`}
            </span>
            <IconButton
              size="icon"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => {
                if (selectedFileIds.length === 0) return;
                const selectedSet = new Set(selectedFileIds);
                onFilesChange(files.filter((f) => !selectedSet.has(f.id)));
              }}
              aria-label="Remove selected files"
              disabled={selectedFileIds.length === 0}
            >
              <Trash2 className="w-4 h-4" />
            </IconButton>
          </div>
        </DataTable>
      </div>

      <MediaInfoDialog
        open={isMediaInfoOpen}
        onOpenChange={setIsMediaInfoOpen}
        files={files.filter((f) => selectedFileIds.includes(f.id)).slice(0, 5)}
      />

      <ModifyTracksDialog
        open={isModifyTracksOpen}
        onOpenChange={setIsModifyTracksOpen}
        videoFiles={files}
        selectedVideoId={selectedFileId}
        onFilesChange={onFilesChange}
      />

      <VideoFileEditDialog
        open={isEditDialogOpen}
        onOpenChange={setIsEditDialogOpen}
        videoFile={editingFile}
        allVideoFiles={files}
        onSave={handleSaveFile}
        onAddExternalFiles={onAddExternalFiles}
        externalAudioFiles={editingFile ? externalFilesByVideoId?.[editingFile.id]?.audios : []}
        externalSubtitleFiles={editingFile ? externalFilesByVideoId?.[editingFile.id]?.subtitles : []}
        onExternalFilesChange={onExternalFilesChange}
      />
    </PageLayout>
  );
}
