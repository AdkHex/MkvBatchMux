import { useState } from "react";
import { Plus, Trash2, FileText, Image, File, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Attachment {
  id: string;
  name: string;
  type: 'font' | 'image' | 'other';
  size: number;
}

interface AttachmentsPanelProps {
  attachments: Attachment[];
  onAddAttachments: () => void;
  onRemoveAttachment: (id: string) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

const typeConfig = {
  font: { icon: FileText, label: 'Font', className: 'bg-purple-500/20 text-purple-500' },
  image: { icon: Image, label: 'Image', className: 'bg-green-500/20 text-green-500' },
  other: { icon: File, label: 'File', className: 'bg-muted text-muted-foreground' },
};

export function AttachmentsPanel({ 
  attachments, 
  onAddAttachments, 
  onRemoveAttachment 
}: AttachmentsPanelProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-panel-border bg-panel-header">
        <div>
          <h2 className="text-lg font-semibold">Attachments</h2>
          <p className="text-sm text-muted-foreground">Add fonts, cover art, or other files</p>
        </div>
        <Button variant="outline" size="sm" onClick={onAddAttachments}>
          <Plus className="w-4 h-4 mr-1.5" />
          Add Files
        </Button>
      </div>

      {/* Content */}
      {attachments.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
            <FileText className="w-8 h-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-medium mb-2">No attachments</h3>
          <p className="text-muted-foreground mb-4 max-w-md">
            Add fonts (for styled subtitles), cover images, or other files to embed in your MKV files.
          </p>
          <Button onClick={onAddAttachments}>
            <Plus className="w-4 h-4 mr-2" />
            Add Attachments
          </Button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {attachments.map(attachment => {
              const config = typeConfig[attachment.type];
              const TypeIcon = config.icon;

              return (
                <div
                  key={attachment.id}
                  className="relative group p-4 rounded-lg bg-card border border-border hover:border-primary/50 transition-colors"
                >
                  <button
                    onClick={() => onRemoveAttachment(attachment.id)}
                    className="absolute top-2 right-2 w-6 h-6 rounded-full bg-destructive/10 text-destructive flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/20"
                  >
                    <X className="w-3 h-3" />
                  </button>
                  
                  <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center mb-3", config.className)}>
                    <TypeIcon className="w-5 h-5" />
                  </div>
                  
                  <p className="font-medium text-sm truncate">{attachment.name}</p>
                  <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                    <span>{config.label}</span>
                    <span>•</span>
                    <span>{formatFileSize(attachment.size)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Footer */}
      {attachments.length > 0 && (
        <div className="px-4 py-2 border-t border-panel-border bg-muted/30 text-sm text-muted-foreground">
          {attachments.length} attachment{attachments.length !== 1 ? 's' : ''} • 
          {' '}{formatFileSize(attachments.reduce((sum, a) => sum + a.size, 0))} total
        </div>
      )}
    </div>
  );
}
