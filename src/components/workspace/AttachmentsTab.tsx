import { useEffect, useState } from "react";
import { X, RefreshCw, FolderOpen, Plus, Trash2, Paperclip } from "lucide-react";
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
import type { ExternalFile, MuxSettings, Preset } from "@/types";
import { pickDirectory, pickFiles, scanMedia } from "@/lib/backend";
import { useTabState } from "@/stores/useTabState";
import { ATTACHMENT_EXTENSIONS } from "@/lib/extensions";

interface AttachmentsTabProps {
  attachmentFiles: ExternalFile[];
  onAttachmentFilesChange: (files: ExternalFile[]) => void;
  preset?: Preset | null;
  onMuxSettingsChange: (settings: Partial<MuxSettings>) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
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

  // Initialize from preset on mount
  useEffect(() => {
    if (!preset) return;
    updateAttachmentTabState({
      sourceFolder: preset.Default_Attachment_Directory || '',
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
    const extensions = extension === 'all' ? [] : [extension];
    const results = await scanMedia({
      folder: folderPath,
      extensions,
      recursive: true,
      type: 'attachment',
      include_tracks: false,
    });
    const normalized = (results as ExternalFile[]).map((file, index) => ({
      ...file,
      type: 'attachment' as const,
      matchedVideoId: undefined,
    }));
    onAttachmentFilesChange(normalized);
  };

  return (
    <div className="flex flex-col h-full p-5 gap-4">
      {/* Attachments Enable Toggle */}
      <div className="panel-card flex items-center gap-2 px-4 py-2.5">
        <Checkbox 
          id="attachments-enabled" 
          checked={attachmentsEnabled}
          onCheckedChange={(checked) => {
            const enabled = checked as boolean;
            updateAttachmentTabState({ attachmentsEnabled: enabled });
            if (!enabled) {
              onAttachmentFilesChange([]);
            }
          }}
        />
        <label htmlFor="attachments-enabled" className="text-sm font-medium cursor-pointer">Attachments</label>
      </div>

      <div className="fluent-surface p-3 space-y-2.5">
        {/* Controls Row 1 */}
        <div className="control-row">
          <label className="text-sm text-muted-foreground whitespace-nowrap min-w-[160px]">
            Attachments Source Folder:
          </label>
          <Input
            value={sourceFolder}
            onChange={(e) => updateAttachmentTabState({ sourceFolder: e.target.value })}
            placeholder="Enter Attachments Folder Path"
            className="app-input flex-1"
            disabled={!attachmentsEnabled}
          />
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="btn-icon bg-muted/50 text-foreground hover:bg-muted/70"
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
              className="btn-icon bg-primary/10 text-primary hover:bg-primary/20"
              disabled={!attachmentsEnabled}
              onClick={() => scanAttachments(sourceFolder)}
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="btn-icon bg-destructive/10 text-destructive hover:bg-destructive/20"
              disabled={!attachmentsEnabled}
              onClick={() => {
                updateAttachmentTabState({ sourceFolder: '' });
                onAttachmentFilesChange([]);
              }}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Controls Row 2 */}
        <div className="control-row">
          <label className="text-sm text-muted-foreground whitespace-nowrap">Attachment Extension:</label>
          <Select value={extension} onValueChange={(v) => updateAttachmentTabState({ extension: v })} disabled={!attachmentsEnabled}>
            <SelectTrigger className="w-40 h-8 bg-input border-0 text-sm">
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

          <div className="flex-1" />

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="btn-toolbar gap-1.5"
              disabled={!attachmentsEnabled}
              onClick={async () => {
                const filters = extension === 'all' ? undefined : [{ name: extension.toUpperCase(), extensions: [extension] }];
                const files = await pickFiles(filters);
                if (!files.length) return;
                const newFiles = files.map((path, index) => {
                  const name = path.split(/[\\/]/).pop() || path;
                  return {
                    id: `attachment-${Date.now()}-${index}`,
                    name,
                    path,
                    type: 'attachment' as const,
                  };
                });
                onAttachmentFilesChange([...attachmentFiles, ...newFiles]);
              }}
            >
              <Plus className="w-3.5 h-3.5" />
              Add Files
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="btn-toolbar gap-1.5"
              disabled={!attachmentsEnabled || selectedIndex === null}
              onClick={() => {
                if (selectedIndex === null) return;
                const updated = attachmentFiles.filter((_, index) => index !== selectedIndex);
                onAttachmentFilesChange(updated);
                setSelectedIndex(null);
              }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Remove
            </Button>
          </div>
        </div>
      </div>

      <div className="panel-card px-4 py-2.5">
        <div className="flex items-center gap-6 flex-wrap">
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
            <label htmlFor="discard-attachments" className="text-sm cursor-pointer">Discard Old Attachments</label>
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
            <label htmlFor="allow-duplicate-attachments" className="text-sm cursor-pointer">Allow Duplicates</label>
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
            <label htmlFor="attachment-expert" className="text-sm cursor-pointer">Expert Mode</label>
          </div>
        </div>
      </div>

      <div className="panel-card flex-1 flex flex-col overflow-hidden">
        {/* Attachments Table Header */}
        <div className="panel-card-header !px-0">
          <div className="grid grid-cols-[1fr_100px_120px] gap-0">
            <div className="px-4 py-2 panel-card-title">Name</div>
            <div className="px-4 py-2 text-center panel-card-title">Type</div>
            <div className="px-4 py-2 text-right panel-card-title">Size</div>
          </div>
        </div>

        {/* Attachments List */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {attachmentFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-16">
              <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
                <Paperclip className="w-8 h-8 text-muted-foreground" />
              </div>
              <p className="text-muted-foreground text-sm">No attachment files added</p>
              <p className="text-muted-foreground/60 text-xs mt-1">Enable attachments, then click Add Files above</p>
            </div>
          ) : (
            attachmentFiles.map((file, index) => (
              <div
                key={file.id}
                onClick={() => setSelectedIndex(index)}
                className={cn(
                  "grid grid-cols-[1fr_100px_120px] gap-0 h-11 border-b border-panel-border/25 cursor-pointer transition-smooth",
                  selectedIndex === index
                    ? "bg-selection border-l-2 border-l-selection-border"
                    : "hover:bg-accent/30"
                )}
              >
                <div className="px-4 text-sm truncate font-mono flex items-center">
                  <span className="media-row-index mr-2">{index + 1}</span>
                  <span className="media-row-name">{file.name}</span>
                </div>
                <div className="px-4 text-sm text-center text-muted-foreground flex items-center justify-center">
                  {file.name.split('.').pop()?.toUpperCase() || 'Unknown'}
                </div>
                <div className="px-4 text-sm text-right text-muted-foreground font-mono flex items-center justify-end">
                  {file.size ? formatFileSize(file.size) : '-'}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
