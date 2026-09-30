/** Media info: what is inside up to five selected videos, side by side as
 *  pivots. Read-only. */

import { useEffect, useState } from "react";

import { CODE_TO_LABEL } from "@/shared/data/languages-iso6393";
import type { Track, VideoFile } from "@/shared/types";
import { Dialog, DockTabs } from "@/ui/frame";
import { Btn, DL } from "@/ui/kit";

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
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mb/s` : `${Math.round(kbps)} kb/s`;
}

const formatFps = (fps?: number) => (fps ? `${fps.toFixed(3).replace(/\.?0+$/, "")} fps` : "—");
const language = (code?: string) => (code && code !== "und" ? (CODE_TO_LABEL[code] ?? code) : null);
/** A pivot's label: short, the full name in its tooltip. */
const short = (name: string) => (name.length > 22 ? `${name.slice(0, 10)}…${name.slice(-10)}` : name);

function Tracks({ title, tracks }: { title: string; tracks: Track[] }) {
  return (
    <div className="col" style={{ gap: 2 }}>
      <span className="sec">
        {title} <span className="t3" style={{ fontWeight: 400 }}>{tracks.length}</span>
      </span>
      {tracks.map((track, index) => (
        <div key={`${track.id}-${index}`} className="trk">
          <span className="num t3" style={{ width: 16 }}>{index + 1}</span>
          <span className="grow truncate">{[track.codec?.toUpperCase() || "Unknown", language(track.language), track.name].filter(Boolean).join(" · ")}</span>
          <span className="fl">{[track.isDefault ? "Default" : null, track.isForced ? "Forced" : null, formatBitrate(track.bitrate) || null].filter(Boolean).join(" · ")}</span>
        </div>
      ))}
    </div>
  );
}

export function MediaInfoDialog({ open, onOpenChange, files }: MediaInfoDialogProps) {
  const [activeId, setActiveId] = useState(files[0]?.id ?? "");
  useEffect(() => {
    if (open) setActiveId(files[0]?.id ?? "");
  }, [open, files]);
  if (!open || files.length === 0) return null;
  const file = files.find((f) => f.id === activeId) ?? files[0];
  const tracks = file.tracks || [];
  const video = tracks.filter((t) => t.type === "video");
  const audio = tracks.filter((t) => t.type === "audio");
  const subtitles = tracks.filter((t) => t.type === "subtitle");
  return (
    <Dialog
      size="wide"
      title="Media info"
      sub={files.length > 1 ? `Comparing ${files.length} videos` : file.name}
      onClose={() => onOpenChange(false)}
      foot={<Btn accent onClick={() => onOpenChange(false)}>Close</Btn>}
    >
      <div className="frame" style={{ overflow: "visible" }}>
        {files.length > 1 && (
          <DockTabs tabs={files.map((f) => ({ id: f.id, label: short(f.name) }))} on={file.id} onTab={setActiveId} />
        )}
        <div className="box-b" style={{ gap: 14 }}>
          <DL
            rows={[
              ["File", <span key="n" className="truncate" title={file.name}>{file.name}</span>],
              ["Size", formatFileSize(file.size)],
              ["Duration", file.duration || "—"],
              ["Frame rate", formatFps(file.fps)],
              ["Path", <span key="p" className="truncate" title={file.path}>{file.path}</span>],
            ]}
          />
          {tracks.length === 0 ? (
            <span className="t3">Track details are not read yet. Scan the folder to read them.</span>
          ) : (
            <>
              {video.length > 0 && <Tracks title="Video" tracks={video} />}
              {audio.length > 0 && <Tracks title="Audio" tracks={audio} />}
              {subtitles.length > 0 && <Tracks title="Subtitles" tracks={subtitles} />}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
