/** Modify tracks: change the tracks every loaded video already holds, by
 *  position — track 2 of each video at once — or only the selected videos'
 *  when some are selected. Which to keep, default and forced flags, names,
 *  languages and order. The rows are built and applied by lib/modifyTracks:
 *  a field left as the dialog showed it keeps each video's own value. */

import { ArrowDownRegular, ArrowUpRegular } from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useState } from "react";

import { aggregateTrackRows, applyTrackRowsToVideo, moveTrackRow, type AggregatedTrackRow } from "@/features/workspace/lib/modifyTracks";
import { CODE_TO_LABEL } from "@/shared/data/languages-iso6393";
import type { Track, VideoFile } from "@/shared/types";
import { Dialog, DialogTabs } from "@/ui/frame";
import { Btn, Cmd, MidText, Status, Table, Tr } from "@/ui/kit";

import { TrackRowsTable, type TrackFlag } from "./TrackRowsTable";

interface ModifyTracksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  videoFiles: VideoFile[];
  /** The videos to change; none or absent means every video. */
  selectedVideoIds?: string[];
  onFilesChange: (files: VideoFile[]) => void;
}

type TrackTab = "videos" | "subtitles" | "audios";

type TrackRow = AggregatedTrackRow;

const TABS: { id: TrackTab; label: string; type: Track["type"] }[] = [
  { id: "videos", label: "Videos", type: "video" },
  { id: "subtitles", label: "Subtitles", type: "subtitle" },
  { id: "audios", label: "Audio", type: "audio" },
];

export function ModifyTracksDialog({ open, onOpenChange, videoFiles, selectedVideoIds, onFilesChange }: ModifyTracksDialogProps) {
  const [activeTab, setActiveTab] = useState<TrackTab>("subtitles");
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [videoTracks, setVideoTracks] = useState<TrackRow[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<TrackRow[]>([]);
  const [audioTracks, setAudioTracks] = useState<TrackRow[]>([]);

  // Keyed on the ids, not the array, so a re-render of the page does not
  // rebuild the rows and throw away the edits made here.
  const scopeKey = (selectedVideoIds ?? []).join("\n");
  const scopedFiles = useMemo(() => {
    const ids = new Set(scopeKey ? scopeKey.split("\n") : []);
    const selected = videoFiles.filter((file) => ids.has(file.id));
    return selected.length ? selected : videoFiles;
  }, [scopeKey, videoFiles]);
  const scoped = scopedFiles.length < videoFiles.length;

  const buildAggregatedRows = useCallback((type: Track["type"]) => aggregateTrackRows(scopedFiles, type), [scopedFiles]);

  const rebuild = useCallback(() => {
    setVideoTracks(buildAggregatedRows("video"));
    setSubtitleTracks(buildAggregatedRows("subtitle"));
    setAudioTracks(buildAggregatedRows("audio"));
  }, [buildAggregatedRows]);

  useEffect(() => {
    if (open) rebuild();
  }, [open, rebuild]);

  const currentTracks = activeTab === "videos" ? videoTracks : activeTab === "subtitles" ? subtitleTracks : audioTracks;
  const setCurrentTracks = activeTab === "videos" ? setVideoTracks : activeTab === "subtitles" ? setSubtitleTracks : setAudioTracks;
  const selectedIndexRaw = currentTracks.findIndex((track) => track.id === selectedTrackId);

  useEffect(() => {
    if (!currentTracks.length) {
      setSelectedTrackId(null);
      return;
    }
    if (!currentTracks.find((track) => track.id === selectedTrackId)) setSelectedTrackId(currentTracks[0].id);
  }, [currentTracks, selectedTrackId]);

  const handleTrackChange = (trackId: string, field: TrackFlag | "trackName" | "language", value: boolean | string) => {
    setCurrentTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;
        if (field === "copyTrack" && value === false) return { ...t, copyTrack: false, setDefault: false, setForced: false };
        return { ...t, [field]: value };
      }),
    );
  };

  const setAll = (field: TrackFlag, value: boolean) =>
    setCurrentTracks((prev) =>
      prev.map((track) =>
        field === "copyTrack"
          ? { ...track, copyTrack: value, setDefault: value ? track.setDefault : false, setForced: value ? track.setForced : false }
          : { ...track, copyTrack: value ? true : track.copyTrack, [field]: value },
      ),
    );

  const deleteTrack = (trackId: string) => {
    setCurrentTracks((prev) => prev.filter((t) => t.id !== trackId));
    if (selectedTrackId === trackId) setSelectedTrackId(null);
  };

  const moveTrack = (direction: "up" | "down") => {
    const idx = selectedIndexRaw;
    if (idx < 0) return;
    if (direction === "up" && idx > 0) setCurrentTracks((prev) => moveTrackRow(prev, idx, idx - 1));
    else if (direction === "down" && idx < currentTracks.length - 1) setCurrentTracks((prev) => moveTrackRow(prev, idx, idx + 1));
  };

  const applyChanges = () => {
    onFilesChange(
      videoFiles.map((file) => {
        if (!scopedFiles.includes(file)) return file;
        let updated = applyTrackRowsToVideo(file, videoTracks, "video");
        updated = applyTrackRowsToVideo(updated, subtitleTracks, "subtitle");
        return applyTrackRowsToVideo(updated, audioTracks, "audio");
      }),
    );
    onOpenChange(false);
  };

  if (!open) return null;
  const tabType = TABS.find((t) => t.id === activeTab)!.type;
  const selectedRow = currentTracks[selectedIndexRaw >= 0 ? selectedIndexRaw : 0];
  const counts: Record<TrackTab, number> = { videos: videoTracks.length, subtitles: subtitleTracks.length, audios: audioTracks.length };

  return (
    <Dialog
      size="xl"
      title="Modify tracks"
      sub={scopedFiles.length === 1 && scopeKey ? scopedFiles[0].name : scoped ? `${scopedFiles.length} selected videos, track by position` : "Every loaded video, track by position"}
      onClose={() => onOpenChange(false)}
      left={<Btn onClick={rebuild}>Reset</Btn>}
      bar={
        <DialogTabs<TrackTab>
          tabs={TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))}
          on={activeTab}
          onTab={setActiveTab}
          tools={
            <>
              <Cmd sm icon={<ArrowUpRegular />} title="Move up" disabled={selectedIndexRaw <= 0} onClick={() => moveTrack("up")} />
              <Cmd sm icon={<ArrowDownRegular />} title="Move down" disabled={selectedIndexRaw < 0 || selectedIndexRaw >= currentTracks.length - 1} onClick={() => moveTrack("down")} />
            </>
          }
        />
      }
      foot={
        <>
          <Btn onClick={() => onOpenChange(false)}>Cancel</Btn>
          <Btn accent onClick={applyChanges}>Apply</Btn>
        </>
      }
    >
      <TrackRowsTable
        rows={currentTracks}
        audio={activeTab === "audios"}
        label={`${TABS.find((t) => t.id === activeTab)!.label} tracks`}
        selectedId={selectedTrackId}
        onSelect={setSelectedTrackId}
        onChange={handleTrackChange}
        onSetAll={setAll}
        onDelete={activeTab === "videos" ? undefined : deleteTrack}
        onMove={(from, to) => setCurrentTracks((prev) => moveTrackRow(prev, from, to))}
      />
      {selectedRow && (
        <div className="frame">
          <div className="dtabs"><span className="tab on">Track {String(selectedIndexRaw >= 0 ? selectedIndexRaw + 1 : 1).padStart(2, "0")} in each video</span></div>
          <Table cols="minmax(0,1fr) 64px 64px 56px 120px 96px" head={["Video", "Found", "Default", "Forced", "Name", "Language"]} label="The selected track in each video" style={{ maxHeight: 180 }}>
            {scopedFiles.map((file) => {
              const tracks = (file.tracks || []).filter((track) => track.type === tabType);
              const track = tracks[selectedRow.sourceTrackPosition];
              return (
                <Tr key={file.id}>
                  <span className="cell"><MidText text={file.name} tail={20} /></span>
                  <Status s={track ? "ok" : "bad"} text={track ? "Yes" : "No"} />
                  <span className="t2">{track ? (track.isDefault ? "Yes" : "No") : "—"}</span>
                  <span className="t2">{track ? (track.isForced ? "Yes" : "No") : "—"}</span>
                  <span className="truncate t2">{track?.name || track?.codec || "—"}</span>
                  <span className="t2 truncate">{track?.language ? CODE_TO_LABEL[track.language] || track.language : "—"}</span>
                </Tr>
              );
            })}
          </Table>
        </div>
      )}
    </Dialog>
  );
}
