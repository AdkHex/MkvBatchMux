import { useState } from "react";
import { 
  Plus, 
  Trash2, 
  FolderOpen, 
  FileVideo, 
  CheckCircle2, 
  AlertCircle, 
  Clock,
  Loader2,
  MoreHorizontal,
  ArrowUpDown
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { VideoFile } from "@/types";

interface SourceFilesPanelProps {
  files: VideoFile[];
  selectedFiles: string[];
  onSelectionChange: (ids: string[]) => void;
  onAddFiles: () => void;
  onRemoveFiles: (ids: string[]) => void;
  onFileSelect: (file: VideoFile) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

const statusConfig = {
  pending: { icon: Clock, className: "text-muted-foreground", label: "Pending" },
  processing: { icon: Loader2, className: "text-primary animate-spin", label: "Processing" },
  completed: { icon: CheckCircle2, className: "text-success", label: "Completed" },
  error: { icon: AlertCircle, className: "text-destructive", label: "Error" },
};

export function SourceFilesPanel({
  files,
  selectedFiles,
  onSelectionChange,
  onAddFiles,
  onRemoveFiles,
  onFileSelect,
}: SourceFilesPanelProps) {
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'status'>('name');
  const [sortAsc, setSortAsc] = useState(true);

  const allSelected = files.length > 0 && selectedFiles.length === files.length;
  const someSelected = selectedFiles.length > 0 && selectedFiles.length < files.length;

  const toggleAll = () => {
    if (allSelected) {
      onSelectionChange([]);
    } else {
      onSelectionChange(files.map(f => f.id));
    }
  };

  const toggleFile = (id: string) => {
    if (selectedFiles.includes(id)) {
      onSelectionChange(selectedFiles.filter(fid => fid !== id));
    } else {
      onSelectionChange([...selectedFiles, id]);
    }
  };

  const sortedFiles = [...files].sort((a, b) => {
    let comparison = 0;
    if (sortBy === 'name') comparison = a.name.localeCompare(b.name);
    else if (sortBy === 'size') comparison = a.size - b.size;
    else if (sortBy === 'status') comparison = a.status.localeCompare(b.status);
    return sortAsc ? comparison : -comparison;
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-panel-border bg-panel-header">
        <h2 className="text-lg font-semibold">Source Video Files</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onAddFiles}>
            <Plus className="w-4 h-4 mr-1.5" />
            Add Files
          </Button>
          <Button variant="outline" size="sm" onClick={onAddFiles}>
            <FolderOpen className="w-4 h-4 mr-1.5" />
            Add Folder
          </Button>
          {selectedFiles.length > 0 && (
            <Button 
              variant="destructive" 
              size="sm" 
              onClick={() => onRemoveFiles(selectedFiles)}
            >
              <Trash2 className="w-4 h-4 mr-1.5" />
              Remove ({selectedFiles.length})
            </Button>
          )}
        </div>
      </div>

      {/* File List */}
      {files.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
            <FileVideo className="w-8 h-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-medium mb-2">No source files added</h3>
          <p className="text-muted-foreground mb-4 max-w-md">
            Add MKV video files to begin configuring your batch muxing job.
          </p>
          <Button onClick={onAddFiles}>
            <Plus className="w-4 h-4 mr-2" />
            Add Video Files
          </Button>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          {/* Table Header */}
          <div className="grid grid-cols-[auto_1fr_120px_100px_100px_40px] gap-3 px-4 py-2 border-b border-panel-border bg-muted/50 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <div className="flex items-center">
              <Checkbox 
                checked={allSelected ? true : someSelected ? "indeterminate" : false}
                onCheckedChange={toggleAll}
              />
            </div>
            <button 
              className="flex items-center gap-1 hover:text-foreground transition-colors"
              onClick={() => { setSortBy('name'); setSortAsc(sortBy === 'name' ? !sortAsc : true); }}
            >
              Filename
              <ArrowUpDown className="w-3 h-3" />
            </button>
            <button 
              className="flex items-center gap-1 hover:text-foreground transition-colors"
              onClick={() => { setSortBy('size'); setSortAsc(sortBy === 'size' ? !sortAsc : true); }}
            >
              Size
              <ArrowUpDown className="w-3 h-3" />
            </button>
            <span>Duration</span>
            <button 
              className="flex items-center gap-1 hover:text-foreground transition-colors"
              onClick={() => { setSortBy('status'); setSortAsc(sortBy === 'status' ? !sortAsc : true); }}
            >
              Status
              <ArrowUpDown className="w-3 h-3" />
            </button>
            <span></span>
          </div>

          {/* File Rows */}
          <div className="overflow-y-auto scrollbar-thin max-h-[calc(100vh-280px)]">
            {sortedFiles.map((file) => {
              const StatusIcon = statusConfig[file.status].icon;
              const isSelected = selectedFiles.includes(file.id);

              return (
                <div
                  key={file.id}
                  className={cn(
                    "grid grid-cols-[auto_1fr_120px_100px_100px_40px] gap-3 px-4 py-3 border-b border-panel-border items-center transition-colors cursor-pointer",
                    isSelected && "bg-selection",
                    !isSelected && "hover:bg-muted/50"
                  )}
                  onClick={() => onFileSelect(file)}
                >
                  <div onClick={(e) => e.stopPropagation()}>
                    <Checkbox 
                      checked={isSelected}
                      onCheckedChange={() => toggleFile(file.id)}
                    />
                  </div>
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded bg-track-video/20 flex items-center justify-center flex-shrink-0">
                      <FileVideo className="w-4 h-4 text-track-video" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium truncate">{file.name}</p>
                      <p className="text-xs text-muted-foreground truncate font-mono">{file.path}</p>
                    </div>
                  </div>
                  <div className="text-sm text-muted-foreground font-mono">
                    {formatFileSize(file.size)}
                  </div>
                  <div className="text-sm text-muted-foreground font-mono">
                    {file.duration || '--:--:--'}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <StatusIcon className={cn("w-4 h-4", statusConfig[file.status].className)} />
                    <span className="text-sm">{statusConfig[file.status].label}</span>
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onFileSelect(file)}>
                          Inspect Tracks
                        </DropdownMenuItem>
                        <DropdownMenuItem 
                          onClick={() => onRemoveFiles([file.id])}
                          className="text-destructive"
                        >
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Footer Stats */}
      {files.length > 0 && (
        <div className="px-4 py-2 border-t border-panel-border bg-muted/30 text-sm text-muted-foreground flex items-center justify-between">
          <div>
            {files.length} file{files.length !== 1 ? 's' : ''} • 
            {' '}{formatFileSize(files.reduce((sum, f) => sum + f.size, 0))} total
            {selectedFiles.length > 0 && ` • ${selectedFiles.length} selected`}
          </div>
          <div className="text-xs text-muted-foreground/70">Ionicboy</div>
        </div>
      )}
    </div>
  );
}
