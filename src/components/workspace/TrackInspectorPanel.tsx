import { 
  FileVideo, 
  Music, 
  Subtitles, 
  Film,
  ChevronDown,
  Trash2,
  Settings2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { VideoFile, Track } from "@/types";
import { useState } from "react";
import { CODE_TO_LABEL } from "@/data/languages-iso6393";

interface TrackInspectorPanelProps {
  selectedFile: VideoFile | null;
  onTrackActionChange: (trackId: string, action: Track['action']) => void;
}

const trackTypeConfig = {
  video: { icon: Film, color: "text-track-video", bgColor: "bg-track-video/20", label: "Video" },
  audio: { icon: Music, color: "text-track-audio", bgColor: "bg-track-audio/20", label: "Audio" },
  subtitle: { icon: Subtitles, color: "text-track-subtitle", bgColor: "bg-track-subtitle/20", label: "Subtitle" },
  chapter: { icon: FileVideo, color: "text-track-chapter", bgColor: "bg-track-chapter/20", label: "Chapter" },
};

export function TrackInspectorPanel({ selectedFile, onTrackActionChange }: TrackInspectorPanelProps) {
  const [expandedTypes, setExpandedTypes] = useState<string[]>(['video', 'audio', 'subtitle']);

  const toggleType = (type: string) => {
    setExpandedTypes(prev => 
      prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
    );
  };

  if (!selectedFile) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-3 border-b border-panel-border bg-panel-header">
          <h2 className="text-lg font-semibold">Track Inspector</h2>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
            <Settings2 className="w-8 h-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-medium mb-2">No file selected</h3>
          <p className="text-muted-foreground max-w-md">
            Select a source video file to inspect and modify its existing tracks.
          </p>
        </div>
      </div>
    );
  }

  const tracksByType = {
    video: selectedFile.tracks.filter(t => t.type === 'video'),
    audio: selectedFile.tracks.filter(t => t.type === 'audio'),
    subtitle: selectedFile.tracks.filter(t => t.type === 'subtitle'),
    chapter: selectedFile.tracks.filter(t => t.type === 'chapter'),
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-panel-border bg-panel-header">
        <div>
          <h2 className="text-lg font-semibold">Track Inspector</h2>
          <p className="text-sm text-muted-foreground truncate max-w-lg">{selectedFile.name}</p>
        </div>
      </div>

      {/* Track List */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
        {(Object.entries(tracksByType) as [keyof typeof tracksByType, Track[]][]).map(([type, tracks]) => {
          if (tracks.length === 0) return null;
          
          const config = trackTypeConfig[type];
          const TypeIcon = config.icon;
          const isExpanded = expandedTypes.includes(type);

          return (
            <Collapsible key={type} open={isExpanded} onOpenChange={() => toggleType(type)}>
              <CollapsibleTrigger asChild>
                <button className="w-full flex items-center gap-3 p-3 rounded-lg bg-card border border-border hover:bg-muted/50 transition-colors">
                  <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", config.bgColor)}>
                    <TypeIcon className={cn("w-4 h-4", config.color)} />
                  </div>
                  <span className="flex-1 text-left font-medium">{config.label} Tracks</span>
                  <Badge variant="secondary" className="mr-2">{tracks.length}</Badge>
                  <ChevronDown className={cn(
                    "w-4 h-4 text-muted-foreground transition-transform",
                    isExpanded && "rotate-180"
                  )} />
                </button>
              </CollapsibleTrigger>
              
              <CollapsibleContent className="mt-2 space-y-2">
                {tracks.map((track, index) => (
                  <div 
                    key={track.id}
                    className={cn(
                      "ml-4 p-4 rounded-lg border transition-colors",
                      track.action === 'remove' 
                        ? "bg-destructive/5 border-destructive/20" 
                        : "bg-card border-border"
                    )}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">Track {index + 1}</span>
                        {track.isDefault && (
                          <Badge variant="outline" className="text-xs">Default</Badge>
                        )}
                        {track.isForced && (
                          <Badge variant="outline" className="text-xs">Forced</Badge>
                        )}
                      </div>
                      <Select 
                        value={track.action || 'keep'} 
                        onValueChange={(value) => onTrackActionChange(track.id, value as Track['action'])}
                      >
                        <SelectTrigger className="w-28 h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="keep">Keep</SelectItem>
                          <SelectItem value="modify">Modify</SelectItem>
                          <SelectItem value="remove">Remove</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground">Codec</p>
                        <p className="font-mono">{track.codec || 'Unknown'}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Language</p>
                        <p>{CODE_TO_LABEL[track.language] || track.language || 'Unknown'}</p>
                      </div>
                      {track.name && (
                        <div className="col-span-2">
                          <p className="text-muted-foreground">Track Name</p>
                          <p>{track.name}</p>
                        </div>
                      )}
                    </div>

                    {track.action === 'modify' && (
                      <div className="mt-4 pt-4 border-t border-border space-y-3">
                        <div className="flex items-center justify-between">
                          <Label htmlFor={`default-${track.id}`} className="text-sm">Set as Default</Label>
                          <Switch id={`default-${track.id}`} checked={track.isDefault} />
                        </div>
                        <div className="flex items-center justify-between">
                          <Label htmlFor={`forced-${track.id}`} className="text-sm">Forced Track</Label>
                          <Switch id={`forced-${track.id}`} checked={track.isForced} />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>

      {/* Actions */}
      <div className="p-4 border-t border-panel-border bg-panel-header">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="flex-1">
            <Trash2 className="w-4 h-4 mr-1.5" />
            Remove All Non-Default
          </Button>
        </div>
      </div>
    </div>
  );
}
