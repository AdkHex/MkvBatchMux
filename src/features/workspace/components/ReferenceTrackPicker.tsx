/** Chooses which of a video's audio tracks a measurement compares against.
 *
 *  Auto-picks the video's default audio track, falling back to its first, but
 *  a container often carries an original language, a dub and a commentary --
 *  measuring against the wrong one produces a confident, wrong delay.
 *
 *  Populated from the track data mediainfo/mkvmerge already gave this app, so
 *  opening this does not cost a second probe of every file. See plan §5.3b.
 */

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import type { VideoFile } from "@/shared/types";
import { defaultReferenceTrack } from "@/features/workspace/lib/measurePairs";
import { CODE_TO_LABEL } from "@/shared/data/languages-iso6393";

interface ReferenceTrackPickerProps {
  videos: VideoFile[];
  value: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
  disabled?: boolean;
}

/** A label with enough detail to tell a dub from a commentary. */
function trackLabel(
  track: { language?: string; name?: string; codec?: string },
  index: number,
): string {
  const parts: string[] = [`#${index + 1}`];
  const language = track.language ? CODE_TO_LABEL[track.language] ?? track.language : null;
  if (language) parts.push(language);
  if (track.codec) parts.push(track.codec.toUpperCase());
  if (track.name) parts.push(track.name);
  return parts.join(" · ");
}

export function ReferenceTrackPicker({
  videos,
  value,
  onChange,
  disabled,
}: ReferenceTrackPickerProps) {
  const [expanded, setExpanded] = useState(false);
  // Only worth showing for videos that actually offer a choice.
  const withChoice = videos.filter(
    (video) => (video.tracks ?? []).filter((track) => track.type === "audio").length > 1,
  );

  if (withChoice.length === 0) return null;

  const applyToAll = (index: number) => {
    const next = { ...value };
    withChoice.forEach((video) => {
      const audioTracks = (video.tracks ?? []).filter((track) => track.type === "audio");
      // Clamp: not every video necessarily has that many tracks.
      next[video.id] = Math.min(index, audioTracks.length - 1);
    });
    onChange(next);
  };

  const first = withChoice[0];
  const firstTracks = (first.tracks ?? []).filter((track) => track.type === "audio");

  return (
    // Collapsed by default: the per-video list is one row per file, which on a
    // full season took half the window for a setting almost nobody changes.
    <div className="rounded border border-panel-border">
      <div className="flex items-center gap-3 px-3 h-10">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex items-center gap-2 min-w-0 flex-1 text-left"
          aria-expanded={expanded}
        >
          <ChevronRight
            className={cn(
              "w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
          <span className="text-[13px] shrink-0">Reference audio track</span>
          <span className="text-xs text-muted-foreground truncate">
            Delays are measured against this track of each video.
          </span>
        </button>
        {withChoice.length > 1 && (
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-xs text-muted-foreground">Apply to all</span>
            {firstTracks.map((track, index) => (
              <Button
                key={track.id}
                type="button"
                variant="outline"
                size="sm"
                className="h-[26px] px-2 text-xs"
                disabled={disabled}
                onClick={() => applyToAll(index)}
              >
                #{index + 1}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div
        className={cn(
          "space-y-1.5 max-h-48 overflow-y-auto scrollbar-thin px-3 pb-3",
          !expanded && "hidden",
        )}
      >
        {withChoice.map((video) => {
          const audioTracks = (video.tracks ?? []).filter((track) => track.type === "audio");
          const selected = value[video.id] ?? defaultReferenceTrack(video);
          return (
            <div key={video.id} className="flex items-center gap-2">
              <span className="flex-1 truncate text-xs" title={video.name}>
                {video.name}
              </span>
              <Select
                value={String(selected)}
                disabled={disabled}
                onValueChange={(next) => onChange({ ...value, [video.id]: Number(next) })}
              >
                <SelectTrigger className="h-[26px] w-56 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {audioTracks.map((track, index) => (
                    <SelectItem key={track.id} value={String(index)} className="text-xs">
                      {trackLabel(track, index)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
