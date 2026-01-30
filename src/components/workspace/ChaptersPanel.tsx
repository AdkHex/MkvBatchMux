import { Plus, BookOpen, FileText, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ChapterFile {
  id: string;
  name: string;
  path: string;
  format: 'xml' | 'txt' | 'ogm';
}

interface ChaptersPanelProps {
  chapterFiles: ChapterFile[];
  onAddChapters: () => void;
  onRemoveChapter: (id: string) => void;
}

const formatConfig = {
  xml: { label: 'XML', className: 'bg-orange-500/20 text-orange-500' },
  txt: { label: 'TXT', className: 'bg-blue-500/20 text-blue-500' },
  ogm: { label: 'OGM', className: 'bg-green-500/20 text-green-500' },
};

export function ChaptersPanel({ 
  chapterFiles, 
  onAddChapters, 
  onRemoveChapter 
}: ChaptersPanelProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-panel-border bg-panel-header">
        <div>
          <h2 className="text-lg font-semibold">Chapter Files</h2>
          <p className="text-sm text-muted-foreground">Add chapter markers to your videos</p>
        </div>
        <Button variant="outline" size="sm" onClick={onAddChapters}>
          <Plus className="w-4 h-4 mr-1.5" />
          Add Chapters
        </Button>
      </div>

      {/* Content */}
      {chapterFiles.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <div className="w-16 h-16 rounded-2xl bg-track-chapter/20 flex items-center justify-center mb-4">
            <BookOpen className="w-8 h-8 text-track-chapter" />
          </div>
          <h3 className="text-lg font-medium mb-2">No chapter files</h3>
          <p className="text-muted-foreground mb-4 max-w-md">
            Add chapter files (XML, TXT, or OGM format) to include chapter markers in your MKV files.
          </p>
          <Button onClick={onAddChapters}>
            <Plus className="w-4 h-4 mr-2" />
            Add Chapter Files
          </Button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {chapterFiles.map((file, index) => {
            const config = formatConfig[file.format];

            return (
              <div
                key={file.id}
                className="px-4 py-3 border-b border-panel-border hover:bg-muted/50 transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded bg-track-chapter/20 flex items-center justify-center flex-shrink-0">
                    <BookOpen className="w-4 h-4 text-track-chapter" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{file.name}</p>
                    <p className="text-xs text-muted-foreground truncate font-mono">{file.path}</p>
                  </div>
                  <span className={cn(
                    "px-2 py-0.5 rounded text-xs font-medium",
                    config.className
                  )}>
                    {config.label}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => onRemoveChapter(file.id)}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Info */}
      <div className="p-4 border-t border-panel-border bg-muted/30">
        <div className="flex items-start gap-3 p-3 rounded-lg bg-card border border-border">
          <FileText className="w-5 h-5 text-muted-foreground flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium mb-1">Supported Formats</p>
            <p className="text-muted-foreground">
              XML (Matroska chapters), simple text files, or OGM-style chapter files.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
