import { BaseModal } from "@/shared/components/BaseModal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import type { VideoFile, Track } from "@/shared/types";
import { BarChart2 } from "lucide-react";

interface MediaInfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: VideoFile[];
}

function formatFileSize(bytes?: number): string {
  if (!Number.isFinite(bytes) || !bytes) return "—";
  const gb = bytes / 1073741824;
  if (gb >= 1) return gb.toFixed(2) + " GB";
  const mb = bytes / 1048576;
  if (mb >= 1) return mb.toFixed(1) + " MB";
  return (bytes / 1024).toFixed(0) + " KB";
}

function formatBitrate(bps?: number): string {
  if (!bps) return "";
  const kbps = bps / 1000;
  if (kbps >= 1000) return (kbps / 1000).toFixed(2) + " Mbps";
  return Math.round(kbps) + " kbps";
}

function formatFps(fps?: number): string {
  if (!fps) return "—";
  return fps.toFixed(3).replace(/\.?0+$/, "") + " fps";
}

function Badge({ children, variant = "default" }: { children: React.ReactNode; variant?: "default" | "primary" | "teal" }) {
  const cls =
    variant === "primary"
      ? "bg-primary/15 text-primary border-primary/20"
      : variant === "teal"
      ? "bg-accent-teal/15 text-accent-teal border-accent-teal/20"
      : "bg-muted/60 text-muted-foreground border-panel-border/40";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {children}
    </span>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
      <span className="text-[10px] font-mono text-muted-foreground/60">({count})</span>
    </div>
  );
}

function TrackRow({ track, index }: { track: Track; index: number }) {
  const codecLabel = track.codec?.toUpperCase() || "Unknown";
  const bitrate = formatBitrate(track.bitrate);

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-md border border-panel-border/20 bg-panel-header/30">
      <span className="text-[11px] font-mono text-muted-foreground/50 w-5 shrink-0">{index + 1}</span>

      <span className="text-xs font-mono font-medium text-foreground w-16 shrink-0">{codecLabel}</span>

      <div className="flex items-center gap-1.5 flex-1 flex-wrap">
        {track.language && track.language !== "und" && (
          <Badge>{track.language.toUpperCase()}</Badge>
        )}
        {track.name && (
          <span className="text-xs text-muted-foreground truncate max-w-[160px]">{track.name}</span>
        )}
        {track.isDefault && <Badge variant="primary">Default</Badge>}
        {track.isForced && <Badge variant="teal">Forced</Badge>}
      </div>

      {bitrate && (
        <span className="text-[11px] font-mono text-muted-foreground/70 shrink-0">{bitrate}</span>
      )}
    </div>
  );
}

function FileMediaInfo({ file }: { file: VideoFile }) {
  const videoTracks = file.tracks.filter((t) => t.type === "video");
  const audioTracks = file.tracks.filter((t) => t.type === "audio");
  const subtitleTracks = file.tracks.filter((t) => t.type === "subtitle");
  const hasNoTracks = file.tracks.length === 0;

  return (
    <div className="space-y-4 py-1">
      {/* General */}
      <div className="rounded-lg border border-panel-border/25 bg-card px-4 py-3 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          General
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-xs">
          <div className="flex gap-2">
            <span className="text-muted-foreground/60 w-20 shrink-0">Filename</span>
            <span className="font-mono text-foreground/90 truncate" title={file.name}>{file.name}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground/60 w-20 shrink-0">Size</span>
            <span className="font-mono">{formatFileSize(file.size)}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground/60 w-20 shrink-0">Duration</span>
            <span className="font-mono">{file.duration || "—"}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground/60 w-20 shrink-0">Frame Rate</span>
            <span className="font-mono">{formatFps(file.fps)}</span>
          </div>
          <div className="col-span-2 flex gap-2">
            <span className="text-muted-foreground/60 w-20 shrink-0">Path</span>
            <span className="font-mono text-muted-foreground/70 text-[11px] truncate" title={file.path}>
              {file.path}
            </span>
          </div>
        </div>
      </div>

      {hasNoTracks ? (
        <div className="text-center py-6 text-sm text-muted-foreground/60">
          Track details not yet loaded. Scan the file to inspect tracks.
        </div>
      ) : (
        <>
          {/* Video Tracks */}
          {videoTracks.length > 0 && (
            <div>
              <SectionHeader title="Video" count={videoTracks.length} />
              <div className="space-y-1.5">
                {videoTracks.map((track, i) => (
                  <TrackRow key={track.id} track={track} index={i} />
                ))}
              </div>
            </div>
          )}

          {/* Audio Tracks */}
          {audioTracks.length > 0 && (
            <div>
              <SectionHeader title="Audio" count={audioTracks.length} />
              <div className="space-y-1.5">
                {audioTracks.map((track, i) => (
                  <TrackRow key={track.id} track={track} index={i} />
                ))}
              </div>
            </div>
          )}

          {/* Subtitle Tracks */}
          {subtitleTracks.length > 0 && (
            <div>
              <SectionHeader title="Subtitles" count={subtitleTracks.length} />
              <div className="space-y-1.5">
                {subtitleTracks.map((track, i) => (
                  <TrackRow key={track.id} track={track} index={i} />
                ))}
              </div>
            </div>
          )}

          {videoTracks.length === 0 && audioTracks.length === 0 && subtitleTracks.length === 0 && (
            <div className="text-center py-6 text-sm text-muted-foreground/60">
              No track information available.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function truncateTabLabel(name: string, maxLen = 20): string {
  if (name.length <= maxLen) return name;
  return name.slice(0, maxLen - 1) + "…";
}

export function MediaInfoDialog({ open, onOpenChange, files }: MediaInfoDialogProps) {
  if (files.length === 0) return null;

  return (
    <BaseModal
      open={open}
      onOpenChange={onOpenChange}
      title="Media Info"
      subtitle={
        files.length === 1
          ? files[0].name
          : `Comparing ${files.length} files`
      }
      icon={<BarChart2 className="w-5 h-5 text-primary" />}
      className="max-w-2xl"
      bodyClassName="px-5 py-3"
    >
      {files.length === 1 ? (
        <FileMediaInfo file={files[0]} />
      ) : (
        <Tabs defaultValue={files[0].id}>
          <TabsList className="mb-3 h-8 gap-1 bg-panel-header/60 border border-panel-border/30 p-0.5">
            {files.map((file) => (
              <TabsTrigger
                key={file.id}
                value={file.id}
                className="h-7 px-3 text-xs"
                title={file.name}
              >
                {truncateTabLabel(file.name)}
              </TabsTrigger>
            ))}
          </TabsList>
          {files.map((file) => (
            <TabsContent key={file.id} value={file.id} className="mt-0">
              <FileMediaInfo file={file} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </BaseModal>
  );
}
