import { useEffect, useRef, useState } from "react";
import { X, RefreshCw, FolderOpen, Plus, Trash2, Paperclip } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { cn } from "@/shared/lib/utils";
import type { ExternalFile, MuxSettings, Preset } from "@/shared/types";
import { pickDirectory, pickFiles, scanMedia } from "@/shared/lib/backend";
import { useTabState } from "@/features/workspace/store/useTabState";
import { toast } from "@/shared/hooks/use-toast";
import { ATTACHMENT_EXTENSIONS } from "@/shared/lib/extensions";

interface AttachmentsTabProps {
  attachmentFiles: ExternalFile[];
  onAttachmentFilesChange: (files: ExternalFile[]) => void;
  preset?: Preset | null;
  onMuxSettingsChange: (settings: Partial<MuxSettings>) => void;
  searchValue?: string;
  sortValue?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

function truncateMiddle(value: string, maxLength = 56): string {
  if (!value || value.length <= maxLength) return value;
  const side = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, side)}...${value.slice(value.length - side)}`;
}

export function AttachmentsTab({
  attachmentFiles,
  onAttachmentFilesChange,
  preset,
  onMuxSettingsChange,
  searchValue = "",
  sortValue = "loaded",
}: AttachmentsTabProps) {
  const { attachmentTabState, updateAttachmentTabState } = useTabState((state) => ({
    attachmentTabState: state.attachmentTabState,
    updateAttachmentTabState: state.updateAttachmentTabState,
  }));

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  /** See ChaptersTab: the highlight follows the file, not the row number, so a
   *  rescan cannot leave Remove pointed at a different attachment. */
  const selectedAttachmentIdRef = useRef<string | null>(null);

  const selectAttachmentIndex = (index: number | null) => {
    selectedAttachmentIdRef.current =
      index === null ? null : (attachmentFiles[index]?.id ?? null);
    setSelectedIndex(index);
  };

  useEffect(() => {
    const selectedId = selectedAttachmentIdRef.current;
    if (selectedId === null) return;
    const nextIndex = attachmentFiles.findIndex((file) => file.id === selectedId);
    if (nextIndex < 0) selectedAttachmentIdRef.current = null;
    setSelectedIndex(nextIndex >= 0 ? nextIndex : null);
  }, [attachmentFiles]);

  // See ChaptersTab: keyed on the folder value, not the preset object, so
  // saving an unrelated option does not discard a folder the user just typed.
  const appliedPresetFolderRef = useRef<string | null>(null);

  useEffect(() => {
    if (!preset) return;
    const presetFolder = preset.Default_Attachment_Directory || "";
    if (appliedPresetFolderRef.current === presetFolder) return;
    appliedPresetFolderRef.current = presetFolder;
    updateAttachmentTabState({
      sourceFolder: presetFolder,
    });
  }, [preset, updateAttachmentTabState]);

  const attachmentsEnabled = attachmentTabState.attachmentsEnabled;
  const sourceFolder = attachmentTabState.sourceFolder;
  const extension = attachmentTabState.extension;
  const allowDuplicate = attachmentTabState.allowDuplicate;
  const discardOld = attachmentTabState.discardOld;
  const expertMode = attachmentTabState.expertMode;
  const visibleAttachments = [...attachmentFiles]
    .filter((file) =>
      searchValue.trim()
        ? `${file.name} ${file.path}`.toLowerCase().includes(searchValue.trim().toLowerCase())
        : true,
    )
    .sort((a, b) => {
      if (sortValue === "name-asc") return a.name.localeCompare(b.name);
      if (sortValue === "name-desc") return b.name.localeCompare(a.name);
      if (sortValue === "size-desc") return (b.size || 0) - (a.size || 0);
      return attachmentFiles.indexOf(a) - attachmentFiles.indexOf(b);
    });

  /** Identifies the newest scan, so stale replies can be dropped. */
  const scanRequestRef = useRef(0);

  const scanAttachments = async (folderPath: string) => {
    // Scans of two folders can be in flight at once, and the slower one is not
    // always the older one. Only the newest request is allowed to publish, so a
    // late reply for a folder the user has already moved on from is discarded.
    const requestId = ++scanRequestRef.current;
    if (!folderPath) {
      onAttachmentFilesChange([]);
      return;
    }
    try {
      const extensions = extension === "all" ? [] : [extension];
      const results = await scanMedia({
        folder: folderPath,
        extensions,
        recursive: false,
        type: "attachment",
        include_tracks: false,
      });
      if (requestId !== scanRequestRef.current) return;
      const normalized = ((results as ExternalFile[]) || []).map((file) => ({
        ...file,
        type: "attachment" as const,
        matchedVideoId: undefined,
      }));
      onAttachmentFilesChange(normalized);
    } catch (error) {
      if (requestId !== scanRequestRef.current) return;
      // Leaving the previous folder's listing on screen with no explanation
      // reads as "this folder has those files in it".
      onAttachmentFilesChange([]);
      toast({
        title: "Could not scan attachments",
        description: String(error),
        variant: "destructive",
      });
    }
  };

  const handleAddFiles = async () => {
    const filters =
      extension === "all"
        ? undefined
        : [{ name: extension.toUpperCase(), extensions: [extension] }];
    const files = await pickFiles(filters);
    if (!files.length) return;
    const newFiles = files.map((path, index) => {
      const name = path.split(/[\\/]/).pop() || path;
      return {
        id: `attachment-${Date.now()}-${index}`,
        name,
        path,
        type: "attachment" as const,
      };
    });
    onAttachmentFilesChange([...attachmentFiles, ...newFiles]);
  };

  const handleRemove = () => {
    if (selectedIndex === null) return;
    const updated = attachmentFiles.filter((_, i) => i !== selectedIndex);
    onAttachmentFilesChange(updated);
    selectAttachmentIndex(null);
  };

  return (
    <div className="flex flex-col h-full p-5 gap-4 bg-background">
      {/* Track Selector Bar */}
      <div className="track-selector-bar">
        <div className="flex items-center gap-3">
          <Checkbox
            id="attachments-enabled"
            checked={attachmentsEnabled}
            onCheckedChange={(checked) => {
              const enabled = checked as boolean;
              updateAttachmentTabState({ attachmentsEnabled: enabled });
              if (!enabled) onAttachmentFilesChange([]);
            }}
          />
          <label htmlFor="attachments-enabled" className="text-sm font-medium cursor-pointer">
            Global Attachments
          </label>
          <span className="text-xs font-mono text-muted-foreground">{attachmentFiles.length}</span>
        </div>
        <div className="track-selector-actions">
          <Button
            variant="outline"
            size="sm"
            className="h-[30px] gap-2"
            disabled={!attachmentsEnabled}
            onClick={handleAddFiles}
          >
            <Plus className="w-4 h-4" />
            Add Files
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-[30px] gap-2"
            disabled={!attachmentsEnabled || selectedIndex === null}
            onClick={handleRemove}
          >
            <Trash2 className="w-4 h-4" />
            Remove
          </Button>
        </div>
      </div>

      {/* Configuration Card */}
      <div className="config-card space-y-4">
        <h3 className="text-xs text-muted-foreground font-semibold">
          Attachment Configuration
        </h3>

        {/* Source Folder */}
        <div className="flex items-center gap-3">
          <label className="config-label">Source folder</label>
          <div className="flex-1 flex items-center gap-2">
            <Input
              value={sourceFolder}
              onChange={(e) => updateAttachmentTabState({ sourceFolder: e.target.value })}
              placeholder="Select attachments folder path..."
              className="h-[30px] flex-1 font-mono"
              disabled={!attachmentsEnabled}
            />
            <Button
              variant="outline"
              size="icon"
              className="h-[30px] w-[30px]"
              disabled={!attachmentsEnabled}
              onClick={async () => {
                const folder = await pickDirectory();
                if (folder) {
                  updateAttachmentTabState({ sourceFolder: folder });
                  scanAttachments(folder);
                }
              }}
            >
              <FolderOpen className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-[30px] w-[30px] border border-panel-border bg-[hsl(var(--control))] hover:bg-[hsl(var(--control-hover))] text-foreground"
              disabled={!attachmentsEnabled}
              onClick={() => scanAttachments(sourceFolder)}
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-[30px] w-[30px] border border-panel-border bg-[hsl(var(--control))] hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
              disabled={!attachmentsEnabled}
              onClick={() => {
                updateAttachmentTabState({ sourceFolder: "" });
                onAttachmentFilesChange([]);
              }}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Settings Row */}
        <div className="flex flex-wrap items-center gap-5">
          <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-2">
            <label className="config-label">Extension</label>
            <Select
              value={extension}
              onValueChange={(v) => updateAttachmentTabState({ extension: v })}
              disabled={!attachmentsEnabled}
            >
              <SelectTrigger className="h-[30px] w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All formats</SelectItem>
                {ATTACHMENT_EXTENSIONS.map((ext) => (
                  <SelectItem key={ext} value={ext}>
                    {ext.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="h-4 w-px bg-panel-border/40" />

          <div className="flex items-center gap-2">
            <Checkbox
              id="discard-attachments"
              checked={discardOld}
              onCheckedChange={(checked) => {
                const enabled = checked as boolean;
                updateAttachmentTabState({ discardOld: enabled });
                onMuxSettingsChange({ discardOldAttachments: enabled });
              }}
              disabled={!attachmentsEnabled}
            />
            <label htmlFor="discard-attachments" className="text-xs cursor-pointer">
              Discard Old
            </label>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="allow-duplicate-attachments"
              checked={allowDuplicate}
              onCheckedChange={(checked) => {
                const enabled = checked as boolean;
                updateAttachmentTabState({ allowDuplicate: enabled });
                onMuxSettingsChange({ allowDuplicateAttachments: enabled });
              }}
              disabled={!attachmentsEnabled}
            />
            <label htmlFor="allow-duplicate-attachments" className="text-xs cursor-pointer">
              Allow Duplicates
            </label>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="attachment-expert"
              checked={expertMode}
              onCheckedChange={(checked) => {
                const enabled = checked as boolean;
                updateAttachmentTabState({ expertMode: enabled });
                onMuxSettingsChange({ attachmentsExpertMode: enabled });
              }}
              disabled={!attachmentsEnabled}
            />
            <label htmlFor="attachment-expert" className="text-xs cursor-pointer">
              Expert Mode
            </label>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Attachment files are added to every queued video. Disable duplicates to keep one attachment per matching file name.
        </p>
      </div>

      {/* Files Panel */}
      <div className="panel-card flex-1 flex flex-col overflow-hidden">
        <div className="panel-card-header">
          <div className="flex items-center gap-2">
            <h4 className="panel-card-title">Attachment files</h4>
            <span className="text-xs font-mono text-muted-foreground">{attachmentFiles.length}</span>
          </div>
          <div className="panel-card-actions">
            <Button
              variant="ghost"
              size="sm"
              className="panel-text-btn"
              disabled={!attachmentsEnabled || selectedIndex === null}
              onClick={handleRemove}
            >
              <Trash2 className="w-3 h-3 mr-1" />
              Remove
            </Button>
          </div>
        </div>

        {/* Column headers */}
        <div className="grid grid-cols-[1fr_80px_100px] border-b border-panel-border px-4 py-1.5 bg-panel-header/30">
          <div className="text-xs text-muted-foreground/60">Name</div>
          <div className="text-xs text-muted-foreground/60 text-center">Type</div>
          <div className="text-xs text-muted-foreground/60 text-right">Size</div>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {attachmentFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-16">
              <div className="w-11 h-11 rounded-lg bg-muted/50 flex items-center justify-center mb-3">
                <Paperclip className="w-5 h-5 text-muted-foreground/50" />
              </div>
              <p className="text-muted-foreground text-sm">
                {attachmentFiles.length > 0 ? "No attachments match the current filter" : "No attachment files added"}
              </p>
              <p className="text-muted-foreground/60 text-xs mt-1">
                Enable attachments, then click Add Files above
              </p>
            </div>
          ) : (
            visibleAttachments.map((file) => {
              const index = attachmentFiles.findIndex((entry) => entry.id === file.id);
              return (
              <div
                key={file.id}
                onClick={() => setSelectedIndex(index)}
                className={cn(
                  "grid grid-cols-[1fr_80px_100px] h-10 border-b border-panel-border cursor-pointer transition-smooth px-4",
                  selectedIndex === index
                    ? "bg-selection border-l-2 border-l-selection-border"
                    : "hover:bg-accent/30"
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="media-row-index">{index + 1}.</span>
                  <span className="media-row-name truncate">{truncateMiddle(file.name)}</span>
                </div>
                <div className="flex items-center justify-center text-xs text-muted-foreground">
                  {file.name.split(".").pop()?.toUpperCase() || "—"}
                </div>
                <div className="flex items-center justify-end text-xs text-muted-foreground font-mono">
                  {file.size ? formatFileSize(file.size) : "—"}
                </div>
              </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
