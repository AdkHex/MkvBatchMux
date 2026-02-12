import { useEffect, useState } from "react";
import { X, RefreshCw, FolderOpen, ChevronUp, ChevronDown, ChevronsUp, ChevronsDown, BookOpen, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { BaseModal } from "@/components/shared/BaseModal";
import { EmptyState } from "@/components/shared/EmptyState";
import type { VideoFile, ExternalFile, Preset, MuxSettings } from "@/types";
import { pickDirectory, scanMedia } from "@/lib/backend";
import { useTabState } from "@/stores/useTabState";
import { CHAPTER_EXTENSIONS } from "@/lib/extensions";

interface ChaptersTabProps {
  chapterFiles: ExternalFile[];
  videoFiles: VideoFile[];
  onChapterFilesChange: (files: ExternalFile[]) => void;
  preset?: Preset | null;
  onMuxSettingsChange: (settings: Partial<MuxSettings>) => void;
}

export function ChaptersTab({
  chapterFiles,
  videoFiles,
  onChapterFilesChange,
  preset,
  onMuxSettingsChange,
}: ChaptersTabProps) {
  const { chapterTabState, updateChapterTabState } = useTabState((state) => ({
    chapterTabState: state.chapterTabState,
    updateChapterTabState: state.updateChapterTabState,
  }));
  
  const [selectedVideoIndex, setSelectedVideoIndex] = useState<number | null>(null);
  const [selectedChapterIndex, setSelectedChapterIndex] = useState<number | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    delay: "0.000",
    applyDelayToAll: false,
  });

  // Initialize from preset on mount
  useEffect(() => {
    if (!preset) return;
    updateChapterTabState({
      sourceFolder: preset.Default_Chapter_Directory || '',
      extension: 'all',
    });
  }, [preset, updateChapterTabState]);

  const chaptersEnabled = chapterTabState.chaptersEnabled;
  const sourceFolder = chapterTabState.sourceFolder;
  const extension = chapterTabState.extension;
  const discardOldChapters = chapterTabState.discardOldChapters;
  const chapterDelay = chapterTabState.delay;

  const scanChapters = async (folderPath: string) => {
    if (!folderPath) {
      onChapterFilesChange([]);
      return;
    }
    try {
      const extensions = extension === 'all' ? [] : [extension];
      const results = await scanMedia({
        folder: folderPath,
        extensions,
        recursive: true,
        type: 'chapter',
        include_tracks: false,
      });
      if (!results || !Array.isArray(results)) {
        onChapterFilesChange([]);
        return;
      }
      // Safely normalize results, filtering out any invalid entries
      const normalized = (results as ExternalFile[])
        .filter((file): file is ExternalFile => {
          // Validate that file has required fields
          return !!(
            file &&
            typeof file === 'object' &&
            file.id &&
            file.name &&
            file.path
          );
        })
        .map((file, index) => ({
          ...file,
          type: 'chapter' as const,
          matchedVideoId: videoFiles[index]?.id,
        }));
      onChapterFilesChange(normalized);
    } catch (error) {
      console.error('Error scanning chapters:', error);
      // Ensure we always set an empty array on error to prevent UI crashes
      onChapterFilesChange([]);
    }
  };

  const syncChapterLinks = (files: ExternalFile[]) =>
    files.map((file, index) => ({
      ...file,
      matchedVideoId: videoFiles[index]?.id,
    }));

  useEffect(() => {
    if (chapterFiles.length === 0) return;
    const isSynced = chapterFiles.every((file, index) => file.matchedVideoId === videoFiles[index]?.id);
    if (!isSynced) {
      onChapterFilesChange(syncChapterLinks(chapterFiles));
    }
  }, [chapterFiles, onChapterFilesChange, videoFiles]);

  const reorderChapterFile = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= chapterFiles.length) return;
    const updated = [...chapterFiles];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    onChapterFilesChange(updated);
    setSelectedChapterIndex(toIndex);
  };

  const linkChapterToVideo = () => {
    if (selectedVideoIndex === null || selectedChapterIndex === null) return;
    const targetVideo = videoFiles[selectedVideoIndex];
    if (!targetVideo) return;
    const updated = chapterFiles.map((file, index) =>
      index === selectedChapterIndex ? { ...file, matchedVideoId: targetVideo.id } : file
    );
    onChapterFilesChange(updated);
  };

  const openEditDialog = (fileId: string) => {
    const file = chapterFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    setEditingFileId(fileId);
    setEditForm({
      delay: (file.delay ?? 0).toFixed(3),
      applyDelayToAll: false,
    });
    setEditDialogOpen(true);
  };

  const applyEditChanges = () => {
    if (!editingFileId) return;
    const delayValue = Number(editForm.delay) || 0;
    const updated = chapterFiles.map((file) => {
      if (file.id === editingFileId) {
        return { ...file, delay: delayValue };
      }
      if (editForm.applyDelayToAll) {
        return { ...file, delay: delayValue };
      }
      return file;
    });
    onChapterFilesChange(updated);
    setEditDialogOpen(false);
    setEditingFileId(null);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Chapters Enable Toggle */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-panel-header">
        <Checkbox 
          id="chapters-enabled" 
          checked={chaptersEnabled}
          onCheckedChange={(checked) => {
            const enabled = checked as boolean;
            updateChapterTabState({ chaptersEnabled: enabled });
            if (!enabled) {
              onChapterFilesChange([]);
            }
          }}
        />
        <label htmlFor="chapters-enabled" className="text-sm font-medium cursor-pointer">Chapters</label>
      </div>

      <div className="fluent-surface p-3 space-y-2.5">
        {/* Controls Row 1 */}
        <div className="control-row">
          <label className="text-sm text-muted-foreground whitespace-nowrap min-w-[140px]">
            Chapter Source Folder:
          </label>
          <Input
            value={sourceFolder}
            onChange={(e) => updateChapterTabState({ sourceFolder: e.target.value })}
            placeholder="Enter Chapter Folder Path"
            className="app-input flex-1"
            disabled={!chaptersEnabled}
          />
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="btn-icon bg-muted/50 text-foreground hover:bg-muted/70"
              disabled={!chaptersEnabled}
              onClick={async () => {
                const folder = await pickDirectory();
                if (folder) {
                  updateChapterTabState({ sourceFolder: folder });
                  scanChapters(folder);
                }
              }}
            >
              <FolderOpen className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="btn-icon bg-primary/10 text-primary hover:bg-primary/20"
              disabled={!chaptersEnabled}
              onClick={() => scanChapters(sourceFolder)}
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="btn-icon bg-destructive/10 text-destructive hover:bg-destructive/20"
              disabled={!chaptersEnabled}
              onClick={() => {
                updateChapterTabState({ sourceFolder: '' });
                onChapterFilesChange([]);
              }}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Settings Row */}
        <div className="grid grid-cols-[1.1fr_1fr_1.2fr] gap-4 items-center">
          <div className="grid grid-cols-[124px_minmax(0,1fr)] items-center gap-2">
            <label className="text-[13px] text-muted-foreground whitespace-nowrap">Chapter Extension</label>
            <Select
              value={extension}
              onValueChange={(v) => updateChapterTabState({ extension: v })}
              disabled={!chaptersEnabled}
            >
              <SelectTrigger className="h-9 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Formats</SelectItem>
                {CHAPTER_EXTENSIONS.map((ext) => (
                  <SelectItem key={ext} value={ext}>
                    {ext.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-2">
            <label className="text-[13px] text-muted-foreground whitespace-nowrap">Delay</label>
            <Input
              value={chapterDelay}
              onChange={(e) => updateChapterTabState({ delay: e.target.value })}
              className="h-9 w-28 text-center font-mono"
              disabled={!chaptersEnabled}
            />
            <span className="text-[12px] text-muted-foreground">sec</span>
          </div>

          <div className="flex items-center justify-end gap-4">
            <div className="flex items-center gap-2 min-w-[220px] justify-end">
              <Checkbox
                id="discard-chapters"
                checked={discardOldChapters}
                onCheckedChange={(checked) => {
                  const enabled = checked as boolean;
                  updateChapterTabState({ discardOldChapters: enabled });
                  onMuxSettingsChange({ discardOldChapters: enabled });
                }}
                disabled={!chaptersEnabled}
              />
              <label htmlFor="discard-chapters" className="text-[13px] cursor-pointer">Discard Old Chapters</label>
            </div>
            <Button
              variant="default"
              size="sm"
              className="h-9 px-4 text-xs"
              disabled={!chaptersEnabled || chapterFiles.length === 0}
              onClick={() => {
                const delayValue = Number(chapterDelay) || 0;
                const updated = chapterFiles.map((file) => ({ ...file, delay: delayValue }));
                onChapterFilesChange(updated);
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      </div>

      {/* Matching Section Label */}
      <div className="section-label">
        Chapter Matching
      </div>

      {/* Dual Panel Matching */}
      <div className="flex-1 flex overflow-hidden">
        {/* Video List */}
        <div className="flex-1 flex flex-col border-r border-panel-border/30 bg-card">
          <div className="table-header">
            <div className="px-4 flex items-center min-h-[44px]">Video Name</div>
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {videoFiles.map((file, index) => (
              <div
                key={file.id}
                onClick={() => setSelectedVideoIndex(index)}
                className={cn(
                  "table-row px-4 text-sm cursor-pointer transition-smooth font-mono flex items-center",
                  selectedVideoIndex === index && "selected",
                )}
              >
                <span className="text-muted-foreground mr-2">{index + 1}</span>
                {file.name}
              </div>
            ))}
          </div>
        </div>

        {/* Reorder Controls */}
        <div className="flex flex-col items-center justify-center gap-2 px-3 py-4 bg-panel-header border-r border-panel-border">
          <Button
            variant="secondary"
            size="sm"
            className="btn-toolbar h-8 w-8 p-0"
            disabled={!chaptersEnabled || selectedChapterIndex === null || selectedChapterIndex === 0}
            onClick={() => selectedChapterIndex !== null && reorderChapterFile(selectedChapterIndex, 0)}
          >
            <ChevronsUp className="w-4 h-4" />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="btn-toolbar h-8 w-8 p-0"
            disabled={!chaptersEnabled || selectedChapterIndex === null || selectedChapterIndex === 0}
            onClick={() =>
              selectedChapterIndex !== null && reorderChapterFile(selectedChapterIndex, selectedChapterIndex - 1)
            }
          >
            <ChevronUp className="w-4 h-4" />
          </Button>
          <Button
            variant="default"
            size="sm"
            className="btn-toolbar h-8 w-8 p-0"
            disabled={!chaptersEnabled || selectedVideoIndex === null || selectedChapterIndex === null}
            onClick={linkChapterToVideo}
          >
            Link
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="btn-toolbar h-8 w-8 p-0"
            disabled={
              !chaptersEnabled || selectedChapterIndex === null || selectedChapterIndex === chapterFiles.length - 1
            }
            onClick={() =>
              selectedChapterIndex !== null && reorderChapterFile(selectedChapterIndex, selectedChapterIndex + 1)
            }
          >
            <ChevronDown className="w-4 h-4" />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="btn-toolbar h-8 w-8 p-0"
            disabled={
              !chaptersEnabled || selectedChapterIndex === null || selectedChapterIndex === chapterFiles.length - 1
            }
            onClick={() =>
              selectedChapterIndex !== null && reorderChapterFile(selectedChapterIndex, chapterFiles.length - 1)
            }
          >
            <ChevronsDown className="w-4 h-4" />
          </Button>
        </div>

        {/* Chapter List */}
        <div className="flex-1 flex flex-col bg-card">
          <div className="table-header">
            <div className="px-4 flex items-center min-h-[44px]">Chapter Name</div>
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {chapterFiles.length === 0 ? (
              <EmptyState
                icon={<BookOpen className="w-5 h-5 text-muted-foreground/65" />}
                title="No chapter files found"
                description="Enable chapters, then click the folder icon above"
                className="h-full"
              />
            ) : (
              chapterFiles.map((file, index) => (
                <div
                  key={file.id}
                  onClick={() => setSelectedChapterIndex(index)}
                  onDoubleClick={() => openEditDialog(file.id)}
                  className={cn(
                    "table-row px-4 text-sm cursor-pointer transition-smooth font-mono flex items-center justify-between gap-2",
                    selectedChapterIndex === index && "selected",
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-muted-foreground mr-2">{index + 1}</span>
                    <span className="truncate">{file.name}</span>
                    {Number(file.delay) !== 0 && (
                      <span className="text-xs text-muted-foreground/60">
                        ({Number(file.delay) > 0 ? '+' : ''}{Number(file.delay).toFixed(3)}s)
                      </span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground shrink-0"
                    onClick={(event) => {
                      event.stopPropagation();
                      openEditDialog(file.id);
                    }}
                  >
                    <Pencil className="w-3 h-3" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Edit Delay Dialog */}
      <BaseModal
        open={editDialogOpen}
        onOpenChange={(open) => {
          setEditDialogOpen(open);
          if (!open) {
            setEditingFileId(null);
          }
        }}
        title="Edit Chapter Delay"
        subtitle={chapterFiles.find(f => f.id === editingFileId)?.name || "Update chapter delay."}
        icon={<BookOpen className="w-5 h-5 text-primary" />}
        className="max-w-lg"
        footerRight={
          <>
            <Button variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={applyEditChanges}>Save Changes</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Delay (sec)</label>
            <Input
              value={editForm.delay}
              onChange={(event) => setEditForm((prev) => ({ ...prev, delay: event.target.value }))}
              className="h-9 font-mono"
              placeholder="0.000"
            />
            <p className="text-xs text-muted-foreground">
              Positive values delay chapters, negative values make them earlier.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Checkbox
              id="chapter-edit-delay-all"
              checked={editForm.applyDelayToAll}
              onCheckedChange={(checked) =>
                setEditForm((prev) => ({ ...prev, applyDelayToAll: checked as boolean }))
              }
            />
            <label htmlFor="chapter-edit-delay-all" className="text-sm cursor-pointer">
              Apply delay to all chapters
            </label>
          </div>
        </div>
      </BaseModal>
    </div>
  );
}
