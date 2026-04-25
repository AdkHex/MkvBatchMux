import { useEffect, useState } from "react";
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
import { ATTACHMENT_EXTENSIONS } from "@/shared/lib/extensions";

interface AttachmentsTabProps {
  attachmentFiles: ExternalFile[];
  onAttachmentFilesChange: (files: ExternalFile[]) => void;
  preset?: Preset | null;
  onMuxSettingsChange: (settings: Partial<MuxSettings>) => void;
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
}: AttachmentsTabProps) {
  const { attachmentTabState, updateAttachmentTabState } = useTabState((state) => ({
    attachmentTabState: state.attachmentTabState,
    updateAttachmentTabState: state.updateAttachmentTabState,
  }));

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!preset) return;
    updateAttachmentTabState({
      sourceFolder: preset.Default_Attachment_Directory || "",
    });
  }, [preset, updateAttachmentTabState]);

  const attachmentsEnabled = attachmentTabState.attachmentsEnabled;
  const sourceFolder = attachmentTabState.sourceFolder;
  const extension = attachmentTabState.extension;
  const allowDuplicate = attachmentTabState.allowDuplicate;
  const discardOld = attachmentTabState.discardOld;
  const expertMode = attachmentTabState.expertMode;

  const scanAttachments = async (folderPath: string) => {
    if (!folderPath) {
      onAttachmentFilesChange([]);
      return;
    }
    const extensions = extension === "all" ? [] : [extension];
    const results = await scanMedia({
      folder: folderPath,
      extensions,
      recursive: false,
      type: "attachment",
      include_tracks: false,
    });
    const normalized = (results as ExternalFile[]).map((file) => ({
      ...file,
      type: "attachment" as const,
      matchedVideoId: undefined,
    }));
    onAttachmentFilesChange(normalized);
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
    setSelectedIndex(null);
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
            Attachments
          </label>
          <span className="text-[11px] font-mono text-muted-foreground">{attachmentFiles.length}</span>
        </div>
        <div className="track-selector-actions">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-2"
            disabled={!attachmentsEnabled}
            onClick={handleAddFiles}
          >
            <Plus className="w-4 h-4" />
            Add Files
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-2"
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
        <h3 className="text-[12px] uppercase tracking-[0.5px] text-muted-foreground font-semibold">
          Attachment Configuration
        </h3>

        {/* Source Folder */}
        <div className="flex items-center gap-3">
          <label className="config-label">Source Folder</label>
          <div className="flex-1 flex items-center gap-2">
            <Input
              value={sourceFolder}
              onChange={(e) => updateAttachmentTabState({ sourceFolder: e.target.value })}
              placeholder="Select attachments folder path..."
              className="h-8 flex-1 font-mono"
              disabled={!attachmentsEnabled}
            />
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
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
              className="h-8 w-8 bg-primary/10 text-primary hover:bg-primary/20"
              disabled={!attachmentsEnabled}
              onClick={() => scanAttachments(sourceFolder)}
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 bg-destructive/10 text-destructive hover:bg-destructive/20"
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
              <SelectTrigger className="h-8 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Formats</SelectItem>
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
            <label htmlFor="discard-attachments" className="text-[12px] cursor-pointer">
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
            <label htmlFor="allow-duplicate-attachments" className="text-[12px] cursor-pointer">
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
            <label htmlFor="attachment-expert" className="text-[12px] cursor-pointer">
              Expert Mode
            </label>
          </div>
        </div>
      </div>

      {/* Files Panel */}
      <div className="panel-card flex-1 flex flex-col overflow-hidden">
        <div className="panel-card-header">
          <div className="flex items-center gap-2">
            <h4 className="panel-card-title">Attachment Files</h4>
            <span className="text-[11px] font-mono text-muted-foreground">{attachmentFiles.length}</span>
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
        <div className="grid grid-cols-[1fr_80px_100px] border-b border-panel-border/20 px-4 py-1.5 bg-panel-header/30">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Name</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 text-center">Type</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 text-right">Size</div>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {attachmentFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-16">
              <div className="w-11 h-11 rounded-lg bg-muted/50 flex items-center justify-center mb-3">
                <Paperclip className="w-5 h-5 text-muted-foreground/50" />
              </div>
              <p className="text-muted-foreground text-sm">No attachment files added</p>
              <p className="text-muted-foreground/60 text-xs mt-1">
                Enable attachments, then click Add Files above
              </p>
            </div>
          ) : (
            attachmentFiles.map((file, index) => (
              <div
                key={file.id}
                onClick={() => setSelectedIndex(index)}
                className={cn(
                  "grid grid-cols-[1fr_80px_100px] h-10 border-b border-panel-border/15 cursor-pointer transition-smooth px-4",
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
            ))
          )}
        </div>
      </div>
    </div>
  );
}
