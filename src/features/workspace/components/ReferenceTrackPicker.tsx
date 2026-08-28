/** Chooses which of a video's audio tracks a measurement compares against.
 *
 *  Auto-picks the video's default audio track, falling back to its first, but
 *  a container often carries an original language, a dub and a commentary --
 *  measuring against the wrong one produces a confident, wrong delay.
 *
 *  Populated from the track data mediainfo/mkvmerge already gave this app, so
 *  opening this does not cost a second probe of every file. See plan §5.3b.
 */

import { Button } from "@/shared/ui/button";
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
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Reference audio track</span>
        {withChoice.length > 1 && (
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">Apply to all:</span>
            {firstTracks.map((track, index) => (
              <Button
                key={track.id}
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={disabled}
                onClick={() => applyToAll(index)}
              >
                #{index + 1}
              </Button>
            ))}
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Delays are measured against this track of each video.
      </p>
      <div className="space-y-1.5 max-h-48 overflow-y-auto">
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
                <SelectTrigger className="h-7 w-56 text-xs">
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
