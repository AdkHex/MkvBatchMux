import { useEffect, useState } from "react";
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
import { pickDirectory, scanMedia, inspectPaths } from "@/lib/backend";
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

function formatFileSize(bytes: number): string {
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

  const handleDoubleClick = (file: VideoFile) => {
    setEditingFile(file);
    setIsEditDialogOpen(true);
  };

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

  const handleRowClick = (event: React.MouseEvent, index: number, fileId: string) => {
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
  };

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

  const scanVideos = async (folderPath: string) => {
    if (!folderPath) {
      onFilesChange([]);
      return;
    }
    setIsScanning(true);
    setShowScanOverlay(true);
    setScanProgress({ current: 0, total: 0 });
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
      onFilesChange(currentFiles);

      const paths = currentFiles.map((file) => file.path);
      setScanProgress({ current: 0, total: paths.length });

      const batchSize = 4;
      let processed = 0;
      for (let i = 0; i < paths.length; i += batchSize) {
        const batch = paths.slice(i, i + batchSize);
        const inspected = (await inspectPaths({
          paths: batch,
          type: "video",
          include_tracks: true,
        })) as VideoFile[];

        const byPath = new Map(currentFiles.map((file) => [file.path, file]));
        for (const item of inspected) {
          byPath.set(item.path, item);
        }
        currentFiles = Array.from(byPath.values());
        onFilesChange(currentFiles);

        processed += inspected.length;
        setScanProgress({ current: processed, total: paths.length });
      }
    } finally {
      setIsScanning(false);
      setShowScanOverlay(false);
    }
  };

  const formatFps = (fps?: number) => {
    if (!fps) return "—";
    const fixed = fps.toFixed(3);
    return fixed.replace(/\.?0+$/, "");
  };

  return (
    <PageLayout>
      {showScanOverlay && scanProgress.total > 0 && (
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
                onClick={() => setShowScanOverlay(false)}
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

          <DataTableBody className="flex-1">
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
                  isScanning && !showScanOverlay ? "Loading video metadata" : "Add a source folder to load videos"
                }
              />
            ) : (
              files.map((file, index) => (
                <DataTableRow
                  key={file.id}
                  selected={selectedFileIds.includes(file.id)}
                  onClick={(event) => handleRowClick(event, index, file.id)}
                  onDoubleClick={() => handleDoubleClick(file)}
                  className="group grid grid-cols-[1fr_90px_120px_140px] items-center cursor-pointer"
                >
                  <DataTableCell className="font-mono text-foreground/85">{file.name}</DataTableCell>
                  <DataTableCell className="right muted tabular-nums">{formatFps(file.fps)}</DataTableCell>
                  <DataTableCell className="right muted tabular-nums">{file.duration || "—"}</DataTableCell>
                  <DataTableCell className="right muted font-mono tabular-nums">
                    {formatFileSize(file.size)}
                  </DataTableCell>
                </DataTableRow>
              ))
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
        onSave={handleSaveFile}
        onAddExternalFiles={onAddExternalFiles}
        externalAudioFiles={editingFile ? externalFilesByVideoId?.[editingFile.id]?.audios : []}
        externalSubtitleFiles={editingFile ? externalFilesByVideoId?.[editingFile.id]?.subtitles : []}
        onExternalFilesChange={onExternalFilesChange}
      />
    </PageLayout>
  );
}
