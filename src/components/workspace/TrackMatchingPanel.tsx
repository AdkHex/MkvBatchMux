import { useState } from "react";
import { 
  Plus, 
  Trash2, 
  ChevronUp, 
  ChevronDown,
  Link2,
  Unlink,
  Subtitles,
  Music
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { LanguageSelect } from "@/components/LanguageSelect";
import { cn } from "@/lib/utils";
import type { VideoFile, ExternalFile } from "@/types";
import { CODE_TO_LABEL } from "@/data/languages-iso6393";

interface TrackMatchingPanelProps {
  type: 'subtitle' | 'audio';
  externalFiles: ExternalFile[];
  videoFiles: VideoFile[];
  onAddFiles: () => void;
  onRemoveFiles: (ids: string[]) => void;
  onReorderFile: (id: string, direction: 'up' | 'down') => void;
  onUpdateFile: (id: string, updates: Partial<ExternalFile>) => void;
  selectedFileId: string | null;
  onSelectFile: (id: string | null) => void;
}

export function TrackMatchingPanel({
  type,
  externalFiles,
  videoFiles,
  onAddFiles,
  onRemoveFiles,
  onReorderFile,
  onUpdateFile,
  selectedFileId,
  onSelectFile,
}: TrackMatchingPanelProps) {
  const Icon = type === 'subtitle' ? Subtitles : Music;
  const title = type === 'subtitle' ? 'Subtitle Tracks' : 'Audio Tracks';
  const fileTypeLabel = type === 'subtitle' ? 'subtitle' : 'audio';
  
  const selectedFile = externalFiles.find(f => f.id === selectedFileId);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-panel-border bg-panel-header">
        <h2 className="text-lg font-semibold">Add {title}</h2>
        <Button variant="outline" size="sm" onClick={onAddFiles}>
          <Plus className="w-4 h-4 mr-1.5" />
          Add {type === 'subtitle' ? 'Subtitles' : 'Audio'}
        </Button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - External Files */}
        <div className="w-1/2 border-r border-panel-border flex flex-col">
          <div className="px-4 py-2 bg-muted/50 text-xs font-medium uppercase tracking-wider text-muted-foreground border-b border-panel-border">
            External {type === 'subtitle' ? 'Subtitle' : 'Audio'} Files
          </div>
          
          {externalFiles.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
              <div className={cn(
                "w-12 h-12 rounded-xl flex items-center justify-center mb-3",
                type === 'subtitle' ? "bg-track-subtitle/20" : "bg-track-audio/20"
              )}>
                <Icon className={cn(
                  "w-6 h-6",
                  type === 'subtitle' ? "text-track-subtitle" : "text-track-audio"
                )} />
              </div>
              <p className="text-sm text-muted-foreground mb-3">
                No {fileTypeLabel} files added yet
              </p>
              <Button size="sm" onClick={onAddFiles}>
                <Plus className="w-4 h-4 mr-1.5" />
                Add Files
              </Button>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto scrollbar-thin">
              {externalFiles.map((file, index) => {
                const isSelected = file.id === selectedFileId;
                const isMatched = !!file.matchedVideoId;
                const matchedVideo = videoFiles.find(v => v.id === file.matchedVideoId);

                return (
                  <div
                    key={file.id}
                    className={cn(
                      "px-4 py-3 border-b border-panel-border cursor-pointer transition-colors",
                      isSelected ? "bg-selection border-l-2 border-l-selection-border" : "hover:bg-muted/50"
                    )}
                    onClick={() => onSelectFile(file.id)}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex flex-col gap-0.5 mt-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5"
                          onClick={(e) => { e.stopPropagation(); onReorderFile(file.id, 'up'); }}
                          disabled={index === 0}
                        >
                          <ChevronUp className="w-3 h-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5"
                          onClick={(e) => { e.stopPropagation(); onReorderFile(file.id, 'down'); }}
                          disabled={index === externalFiles.length - 1}
                        >
                          <ChevronDown className="w-3 h-3" />
                        </Button>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{file.name}</p>
                        <div className="flex items-center gap-2 mt-1">
                          {file.language && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                              {CODE_TO_LABEL[file.language] || file.language}
                            </span>
                          )}
                          {isMatched ? (
                            <span className="flex items-center gap-1 text-xs text-primary">
                              <Link2 className="w-3 h-3" />
                              Matched
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Unlink className="w-3 h-3" />
                              Unmatched
                            </span>
                          )}
                        </div>
                        {matchedVideo && (
                          <p className="text-xs text-muted-foreground mt-1 truncate">
                            → {matchedVideo.name}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Panel - Properties or Video List */}
        <div className="w-1/2 flex flex-col">
          {selectedFile ? (
            <>
              <div className="px-4 py-2 bg-muted/50 text-xs font-medium uppercase tracking-wider text-muted-foreground border-b border-panel-border">
                Track Properties
              </div>
              <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
                <div>
                  <Label className="text-sm font-medium">Track Name</Label>
                  <Input
                    value={selectedFile.trackName || ''}
                    onChange={(e) => onUpdateFile(selectedFile.id, { trackName: e.target.value })}
                    placeholder="e.g., English Full Subtitles"
                    className="mt-1.5"
                  />
                </div>

                <div>
                  <Label className="text-sm font-medium">Language</Label>
                  <div className="mt-1.5">
                    <LanguageSelect
                      value={selectedFile.language || 'und'}
                      onChange={(value) => onUpdateFile(selectedFile.id, { language: value })}
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-sm font-medium">Delay (ms)</Label>
                  <Input
                    type="number"
                    value={selectedFile.delay || 0}
                    onChange={(e) => onUpdateFile(selectedFile.id, { delay: parseInt(e.target.value) || 0 })}
                    className="mt-1.5 font-mono"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Positive values delay the track, negative values make it earlier.
                  </p>
                </div>

                <div className="pt-2 space-y-3">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="default-track" className="text-sm font-medium">Default Track</Label>
                    <Switch
                      id="default-track"
                      checked={selectedFile.isDefault || false}
                      onCheckedChange={(checked) => onUpdateFile(selectedFile.id, { isDefault: checked })}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    This track will be selected by default when playing.
                  </p>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="forced-track" className="text-sm font-medium">Forced Track</Label>
                    <Switch
                      id="forced-track"
                      checked={selectedFile.isForced || false}
                      onCheckedChange={(checked) => onUpdateFile(selectedFile.id, { isForced: checked })}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Forced tracks are shown even when subtitles are turned off (e.g., for signs/songs).
                  </p>
                </div>

                <div className="pt-4">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      onRemoveFiles([selectedFile.id]);
                      onSelectFile(null);
                    }}
                  >
                    <Trash2 className="w-4 h-4 mr-1.5" />
                    Remove Track
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="px-4 py-2 bg-muted/50 text-xs font-medium uppercase tracking-wider text-muted-foreground border-b border-panel-border">
                Source Videos ({videoFiles.length})
              </div>
              <div className="flex-1 overflow-y-auto scrollbar-thin">
                {videoFiles.map((video, index) => {
                  const matchedExternal = externalFiles.find(f => f.matchedVideoId === video.id);
                  
                  return (
                    <div
                      key={video.id}
                      className="px-4 py-3 border-b border-panel-border"
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded bg-muted flex items-center justify-center text-xs font-medium">
                          {index + 1}
                        </span>
                        <p className="text-sm truncate flex-1">{video.name}</p>
                        {matchedExternal ? (
                          <Link2 className="w-4 h-4 text-primary" />
                        ) : (
                          <Unlink className="w-4 h-4 text-muted-foreground" />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      {externalFiles.length > 0 && (
        <div className="px-4 py-2 border-t border-panel-border bg-muted/30 text-sm text-muted-foreground">
          {externalFiles.length} {fileTypeLabel} file{externalFiles.length !== 1 ? 's' : ''} • 
          {' '}{externalFiles.filter(f => f.matchedVideoId).length} matched
        </div>
      )}
    </div>
  );
}
