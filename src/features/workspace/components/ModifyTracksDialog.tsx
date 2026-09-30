/** Modify tracks: change the tracks every loaded video already holds, by
 *  position — track 2 of each video at once — or one video's when a video is
 *  selected. Which to keep, default and forced flags, names, languages and
 *  order. The rows are built and applied exactly as before (lib/modifyTracks). */

import { ArrowDownRegular, ArrowUpRegular } from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useState } from "react";

import { applyTrackRowsToVideo, moveTrackRow, type TrackRowDraft } from "@/features/workspace/lib/modifyTracks";
import { CODE_TO_LABEL } from "@/shared/data/languages-iso6393";
import type { Track, VideoFile } from "@/shared/types";
import { Dialog, DockTabs } from "@/ui/frame";
import { Btn, Cmd, MidText, Status, Table, Tr } from "@/ui/kit";

import { TrackRowsTable, type TrackFlag } from "./TrackRowsTable";

interface ModifyTracksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  videoFiles: VideoFile[];
  selectedVideoId?: string | null;
  onFilesChange: (files: VideoFile[]) => void;
}

type TrackTab = "videos" | "subtitles" | "audios";

interface TrackRow extends TrackRowDraft {
  originalTrack: Track;
  bitrate?: number;
}

const TABS: { id: TrackTab; label: string; type: Track["type"] }[] = [
  { id: "videos", label: "Videos", type: "video" },
  { id: "subtitles", label: "Subtitles", type: "subtitle" },
  { id: "audios", label: "Audio", type: "audio" },
];

export function ModifyTracksDialog({ open, onOpenChange, videoFiles, selectedVideoId, onFilesChange }: ModifyTracksDialogProps) {
  const [activeTab, setActiveTab] = useState<TrackTab>("subtitles");
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [videoTracks, setVideoTracks] = useState<TrackRow[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<TrackRow[]>([]);
  const [audioTracks, setAudioTracks] = useState<TrackRow[]>([]);

  const scopedFiles = useMemo(() => {
    if (!selectedVideoId) return videoFiles;
    const selected = videoFiles.find((file) => file.id === selectedVideoId);
    return selected ? [selected] : videoFiles;
  }, [selectedVideoId, videoFiles]);

  const buildAggregatedRows = useCallback(
    (type: Track["type"]) => {
      const trackLists = scopedFiles.map((file) => (file.tracks || []).filter((track) => track.type === type));
      const maxCount = Math.max(0, ...trackLists.map((list) => list.length));
      const rows: TrackRow[] = [];
      for (let index = 0; index < maxCount; index += 1) {
        const tracksAtIndex = trackLists.map((list) => list[index]).filter(Boolean) as Track[];
        const names = tracksAtIndex.map((track) => track.name || track.codec || "");
        const languages = tracksAtIndex.map((track) => track.language || "und");
        const uniqueName = names.find(Boolean) && names.every((name) => name === names[0]) ? names[0] : "Multiple";
        const uniqueLanguage = languages.length > 0 && languages.every((lang) => lang === languages[0]) ? languages[0] : "und";
        const copyTrack = tracksAtIndex.length > 0 && tracksAtIndex.every((track) => track.action !== "remove");
        const setDefault = tracksAtIndex.every((track) => track.isDefault === true) && !tracksAtIndex.some((track) => track.isDefault === undefined);
        const setForced = tracksAtIndex.every((track) => track.isForced === true) && !tracksAtIndex.some((track) => track.isForced === undefined);
        const trackWithBitrate = type === "audio" ? tracksAtIndex.find((track) => track.bitrate !== undefined) || tracksAtIndex[0] : tracksAtIndex[0];
        rows.push({
          id: `${type}-${index}`,
          sourceTrackPosition: index,
          trackIndex: index + 1,
          copyTrack,
          setDefault,
          setForced,
          trackName: uniqueName || `Track ${index + 1}`,
          language: uniqueLanguage,
          originalTrack: trackWithBitrate || { id: `${type}-${index}`, type },
          bitrate: trackWithBitrate?.bitrate,
        });
      }
      return rows;
    },
    [scopedFiles],
  );

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
        if (selectedVideoId && file.id !== selectedVideoId) return file;
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
      size="wide"
      title="Modify tracks"
      sub={scopedFiles.length === 1 && selectedVideoId ? scopedFiles[0].name : "Every loaded video, track by position"}
      onClose={() => onOpenChange(false)}
      left={<Btn onClick={rebuild}>Reset</Btn>}
      foot={
        <>
          <Btn onClick={() => onOpenChange(false)}>Cancel</Btn>
          <Btn accent onClick={applyChanges}>Apply</Btn>
        </>
      }
    >
      <div className="frame">
        <DockTabs<TrackTab>
          tabs={TABS.map((t) => ({ id: t.id, label: `${t.label} ${counts[t.id]}` }))}
          on={activeTab}
          onTab={setActiveTab}
          tools={
            <>
              <Cmd sm icon={<ArrowUpRegular />} title="Move up" disabled={selectedIndexRaw <= 0} onClick={() => moveTrack("up")} />
              <Cmd sm icon={<ArrowDownRegular />} title="Move down" disabled={selectedIndexRaw < 0 || selectedIndexRaw >= currentTracks.length - 1} onClick={() => moveTrack("down")} />
            </>
          }
        />
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
      </div>
      {selectedRow && (
        <div className="frame">
          <div className="dtabs"><span className="tab on">Track {String(selectedIndexRaw >= 0 ? selectedIndexRaw + 1 : 1).padStart(2, "0")} in each video</span></div>
          <Table cols="minmax(0,1fr) 64px 64px 56px 120px 96px" head={["Video", "Found", "Default", "Forced", "Name", "Language"]} label="The selected track in each video" style={{ maxHeight: 180 }}>
            {videoFiles.map((file) => {
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
