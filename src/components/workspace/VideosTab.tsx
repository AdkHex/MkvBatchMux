import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, RefreshCw, FolderOpen, Film, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";
import { ModifyTracksDialog } from "./ModifyTracksDialog";
import { VideoFileEditDialog } from "./VideoFileEditDialog";
import type { Preset, VideoFile, ExternalFile } from "@/types";
import {
  pickDirectory,
  scanMedia,
  inspectPathsStream,
  listenInspectPathsStreamChunk,
  listenInspectPathsStreamDone,
  listenInspectPathsStreamError,
} from "@/lib/backend";
import { open as openExternal } from "@tauri-apps/api/shell";
import { VIDEO_EXTENSIONS } from "@/lib/extensions";
import { PageLayout } from "@/components/shared/PageLayout";
import { TextField, DropdownTrigger, DropdownContent } from "@/components/shared/Fields";
import { IconButton } from "@/components/shared/IconButton";
import {
  DataTable,
  DataTableHeader,
  DataTableBody,
  DataTableRow,
  DataTableCell,
} from "@/components/shared/DataTable";
import { EmptyState } from "@/components/shared/EmptyState";

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
  const scanTokenRef = useRef(0);
  const scanAbortRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const ROW_HEIGHT = 44;
  const OVERSCAN_ROWS = 8;
  const shouldVirtualize = files.length > 120;

  const virtualRange = useMemo(() => {
    if (!shouldVirtualize) {
      return {
        startIndex: 0,
        endIndex: files.length,
        topSpacer: 0,
        bottomSpacer: 0,
      };
    }
    const visibleRows = Math.ceil(viewportHeight / ROW_HEIGHT);
    const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
    const endIndex = Math.min(files.length, startIndex + visibleRows + OVERSCAN_ROWS * 2);
    return {
      startIndex,
      endIndex,
      topSpacer: startIndex * ROW_HEIGHT,
      bottomSpacer: Math.max(0, (files.length - endIndex) * ROW_HEIGHT),
    };
  }, [files.length, scrollTop, viewportHeight, shouldVirtualize]);

  const visibleFiles = shouldVirtualize
    ? files.slice(virtualRange.startIndex, virtualRange.endIndex)
    : files;

  const updateFiles = (next: VideoFile[]) => {
    startTransition(() => {
      onFilesChange(next);
    });
  };

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
      const allIds = files.map((file) => file.id);
      setSelectedFileIds(allIds);
      setSelectedFileId(allIds[0] ?? null);
      setLastSelectedIndex(files.length > 0 ? files.length - 1 : null);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [files]);

  const handleRowClick = useCallback((event: React.MouseEvent, index: number, fileId: string) => {
    const isToggle = event.metaKey || event.ctrlKey;
    const isRange = event.shiftKey;
    if (isRange && lastSelectedIndex !== null) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      const rangeIds = files.slice(start, end + 1).map((file) => file.id);
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
  }, [files, lastSelectedIndex, selectedFileId]);

  const handleSaveFile = (updatedFile: VideoFile) => {
    onFilesChange(files.map((f) => (f.id === updatedFile.id ? updatedFile : f)));
  };

  const handleMediaInfo = () => {
    if (selectedFileIds.length === 0) return;
    const selectedFile = files.find((file) => file.id === selectedFileIds[0]);
    if (!selectedFile) return;
    openExternal(selectedFile.path).catch(() => undefined);
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
        recursive: true,
        type: "video",
        include_tracks: false,
      })) as VideoFile[];
      const normalizedExtensions = new Set(extensions.map((ext) => ext.toLowerCase()));
      let currentFiles = results.filter((file) => {
        const ext = file.path.split(".").pop()?.toLowerCase();
        return ext ? normalizedExtensions.has(ext) : false;
      });
      if (scanAbortRef.current || scanTokenRef.current !== scanToken) return;
      updateFiles(currentFiles);

      const paths = currentFiles.map((file) => file.path);
      setScanProgress({ current: 0, total: paths.length });

      const byPath = new Map(currentFiles.map((file) => [file.path, file]));
      let processed = 0;
      let updateQueued = false;
      const queueUiUpdate = () => {
        if (updateQueued) return;
        updateQueued = true;
        requestAnimationFrame(() => {
          updateQueued = false;
          if (scanAbortRef.current || scanTokenRef.current !== scanToken) return;
          currentFiles = Array.from(byPath.values());
          updateFiles(currentFiles);
          setScanProgress({ current: processed, total: paths.length });
        });
      };

      const streamId = `video-scan-${scanToken}`;
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
        for (const item of payload.items as VideoFile[]) {
          byPath.set(item.path, item);
        }
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
        unlistenChunk();
        unlistenDone();
        unlistenError();
      }

      if (scanAbortRef.current || scanTokenRef.current !== scanToken) return;
      if (!updateQueued) {
        currentFiles = Array.from(byPath.values());
        updateFiles(currentFiles);
        setScanProgress({ current: paths.length, total: paths.length });
      }

      if (import.meta.env.DEV) {
        const completedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        const firstPaintMs = firstChunkAt ? Math.round(firstChunkAt - scanStartedAt) : -1;
        const totalMs = Math.round(completedAt - scanStartedAt);
        // eslint-disable-next-line no-console
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
                <span>Loading Media Info</span>
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
        <div className="flex items-center gap-4">
          <label className="text-sm font-medium text-foreground whitespace-nowrap">Source Folder</label>
          <TextField
            value={sourceFolder}
            onChange={(e) => onSourceFolderChange(e.target.value)}
            placeholder="Select video source folder..."
            className="flex-1"
          />
          <div className="flex items-center gap-2">
            <IconButton
              className="bg-muted/50 text-foreground hover:bg-muted/70"
              onClick={async () => {
                const folder = await pickDirectory();
                if (folder) {
                  onSourceFolderChange(folder);
                  scanVideos(folder);
                }
              }}
              aria-label="Browse folder"
            >
              <FolderOpen className="w-4 h-4" />
            </IconButton>
            <IconButton
              className="bg-primary/10 text-primary hover:bg-primary/20"
              onClick={() => scanVideos(sourceFolder)}
              aria-label="Rescan"
            >
              <RefreshCw className="w-4 h-4" />
            </IconButton>
            <IconButton
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
              onClick={() => {
                cancelScan();
                onSourceFolderChange("");
                onFilesChange([]);
              }}
              aria-label="Clear folder"
            >
              <X className="w-4 h-4" />
            </IconButton>
          </div>
        </div>

        <div className="flex items-center gap-6 mt-4 pt-4 border-t border-panel-border">
          <div className="flex items-center gap-2">
            <label className="text-sm text-muted-foreground">Extension</label>
            <Select value={videoExtension} onValueChange={setVideoExtension}>
              <DropdownTrigger className="w-40">
                <SelectValue />
              </DropdownTrigger>
              <DropdownContent>
                <SelectItem value="all">All Formats</SelectItem>
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
              Modify Tracks
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleMediaInfo}
              disabled={selectedFileIds.length === 0}
            >
              Media Info
            </Button>
          </div>
        </div>
      </div>

      <div className="fluent-surface flex-1 flex flex-col min-h-0 p-0 overflow-hidden">
        <DataTable className="h-full flex flex-col">
          <DataTableHeader className="grid grid-cols-[1fr_90px_120px_140px] items-center">
            <DataTableCell>File Name</DataTableCell>
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
                    : "Click the folder icon above or drag & drop files here"
                }
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
                  className="group grid grid-cols-[1fr_90px_120px_140px] items-center cursor-pointer h-[44px]"
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
          <div className="flex items-center justify-between px-3 py-2 border-t border-panel-border/40 bg-panel-header/40">
            <Button variant="ghost" size="sm" className="h-8 px-3 text-xs text-muted-foreground" disabled>
              Actions
            </Button>
            <IconButton
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={() => {
                if (selectedFileIds.length === 0) return;
                const selectedSet = new Set(selectedFileIds);
                onFilesChange(files.filter((f) => !selectedSet.has(f.id)));
              }}
              aria-label="Remove selected file"
              disabled={selectedFileIds.length === 0}
            >
              <Trash2 className="w-4 h-4" />
            </IconButton>
          </div>
        </DataTable>
      </div>

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
