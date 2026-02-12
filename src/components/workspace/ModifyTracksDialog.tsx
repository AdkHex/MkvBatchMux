import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, X, ChevronUp, ChevronDown, RotateCcw, Film, Subtitles, Volume2, Info, GripVertical, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TextField, DropdownTrigger, DropdownContent } from "@/components/shared/Fields";
import { BaseModal } from "@/components/shared/BaseModal";
import {
  ReorderableTable,
  ReorderableTableHeader,
  ReorderableTableBody,
  ReorderableRow,
  ReorderableTableCell,
  ReorderHandle,
} from "@/components/shared/ReorderableTable";
import { DataTable, DataTableHeader, DataTableBody, DataTableRow, DataTableCell } from "@/components/shared/DataTable";
import { cn } from "@/lib/utils";
import type { Track, VideoFile } from "@/types";
import { LanguageSelect } from "@/components/LanguageSelect";
import { CODE_TO_LABEL } from "@/data/languages-iso6393";

interface ModifyTracksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  videoFiles: VideoFile[];
  selectedVideoId?: string | null;
  onFilesChange: (files: VideoFile[]) => void;
}

type TrackTab = "videos" | "subtitles" | "audios";

interface TrackRow {
  id: string;
  trackIndex: number;
  copyTrack: boolean;
  setDefault: boolean;
  setForced: boolean;
  trackName: string;
  language: string;
  originalTrack: Track;
}

const tabConfig: { id: TrackTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "videos", label: "Videos", icon: Film },
  { id: "subtitles", label: "Subtitles", icon: Subtitles },
  { id: "audios", label: "Audios", icon: Volume2 },
];

export function ModifyTracksDialog({ open, onOpenChange, videoFiles, selectedVideoId, onFilesChange }: ModifyTracksDialogProps) {
  const [activeTab, setActiveTab] = useState<TrackTab>("subtitles");
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [videoTracks, setVideoTracks] = useState<TrackRow[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<TrackRow[]>([]);
  const [audioTracks, setAudioTracks] = useState<TrackRow[]>([]);
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const toTrackRows = (tracks: Track[], type: Track["type"]): TrackRow[] =>
    tracks
      .filter((track) => track.type === type)
      .map((track, idx) => ({
        id: track.id,
        trackIndex: idx + 1,
        copyTrack: track.action !== "remove",
        setDefault: track.isDefault || false,
        setForced: track.isForced || false,
        trackName: track.name || track.codec || `Track ${idx + 1}`,
        language: track.language || "und",
        originalTrack: track,
      }));

  const scopedFiles = useMemo(() => {
    if (!selectedVideoId) return videoFiles;
    const selected = videoFiles.find((file) => file.id === selectedVideoId);
    return selected ? [selected] : videoFiles;
  }, [selectedVideoId, videoFiles]);

  useEffect(() => {
    if (!open) return;
    const buildAggregatedRows = (type: Track["type"]) => {
      const trackLists = scopedFiles.map((file) => (file.tracks || []).filter((track) => track.type === type));
      const maxCount = Math.max(0, ...trackLists.map((list) => list.length));
      const rows: TrackRow[] = [];
      for (let index = 0; index < maxCount; index += 1) {
        const tracksAtIndex = trackLists.map((list) => list[index]).filter(Boolean) as Track[];
        const names = tracksAtIndex.map((track) => track.name || track.codec || "");
        const languages = tracksAtIndex.map((track) => track.language || "und");
        const uniqueName = names.find(Boolean) && names.every((name) => name === names[0]) ? names[0] : "Multiple";
        const uniqueLanguage =
          languages.length > 0 && languages.every((lang) => lang === languages[0]) ? languages[0] : "und";
        const copyTrack = tracksAtIndex.length > 0 && tracksAtIndex.every((track) => track.action !== "remove");
        const allHaveDefault = tracksAtIndex.every((track) => track.isDefault === true);
        const allHaveForced = tracksAtIndex.every((track) => track.isForced === true);
        const someHaveDefaultUndefined = tracksAtIndex.some((track) => track.isDefault === undefined);
        const someHaveForcedUndefined = tracksAtIndex.some((track) => track.isForced === undefined);
        const setDefault = allHaveDefault && !someHaveDefaultUndefined;
        const setForced = allHaveForced && !someHaveForcedUndefined;
        const trackWithBitrate =
          type === "audio" ? tracksAtIndex.find((t) => t.bitrate !== undefined) || tracksAtIndex[0] : tracksAtIndex[0];

        rows.push({
          id: `${type}-${index}`,
          trackIndex: index + 1,
          copyTrack,
          setDefault,
          setForced,
          trackName: uniqueName || `Track ${index + 1}`,
          language: uniqueLanguage,
          originalTrack: trackWithBitrate || { id: `${type}-${index}`, type },
        } as TrackRow);
      }
      return rows;
    };

    setVideoTracks(buildAggregatedRows("video"));
    setSubtitleTracks(buildAggregatedRows("subtitle"));
    setAudioTracks(buildAggregatedRows("audio"));
  }, [open, scopedFiles]);

  const currentTracks = activeTab === "videos" ? videoTracks : activeTab === "subtitles" ? subtitleTracks : audioTracks;
  const setCurrentTracks = activeTab === "videos" ? setVideoTracks : activeTab === "subtitles" ? setSubtitleTracks : setAudioTracks;
  const selectedIndexRaw = currentTracks.findIndex((track) => track.id === selectedTrackId);
  const selectedTrackNumber = selectedIndexRaw >= 0 ? selectedIndexRaw + 1 : 1;
  const allCopyChecked = currentTracks.length > 0 && currentTracks.every((track) => track.copyTrack);
  const allDefaultChecked = currentTracks.length > 0 && currentTracks.every((track) => track.setDefault);
  const allForcedChecked = currentTracks.length > 0 && currentTracks.every((track) => track.setForced);

  useEffect(() => {
    if (!currentTracks.length) {
      setSelectedTrackId(null);
      return;
    }
    if (!currentTracks.find((track) => track.id === selectedTrackId)) {
      setSelectedTrackId(currentTracks[0].id);
    }
  }, [currentTracks, selectedTrackId]);

  const handleTrackChange = (trackId: string, field: keyof TrackRow, value: boolean | string) => {
    setCurrentTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;
        if (field === "copyTrack" && value === false) {
          return { ...t, copyTrack: false, setDefault: false, setForced: false };
        }
        return { ...t, [field]: value };
      }),
    );
  };

  const startEditing = (track: TrackRow) => {
    setEditingTrackId(track.id);
    setEditingName(track.trackName);
  };

  const finishEditing = () => {
    if (editingTrackId && editingName.trim()) {
      handleTrackChange(editingTrackId, "trackName", editingName.trim());
    }
    setEditingTrackId(null);
    setEditingName("");
  };

  const deleteTrack = (trackId: string) => {
    setCurrentTracks((prev) => prev.filter((t) => t.id !== trackId));
    if (selectedTrackId === trackId) {
      setSelectedTrackId(null);
    }
  };

  const setAllCopy = (value: boolean) => {
    setCurrentTracks((prev) =>
      prev.map((track) => ({
        ...track,
        copyTrack: value,
        setDefault: value ? track.setDefault : false,
        setForced: value ? track.setForced : false,
      })),
    );
  };

  const setAllDefault = (value: boolean) => {
    setCurrentTracks((prev) =>
      prev.map((track) => ({
        ...track,
        copyTrack: value ? true : track.copyTrack,
        setDefault: value,
      })),
    );
  };

  const setAllForced = (value: boolean) => {
    setCurrentTracks((prev) =>
      prev.map((track) => ({
        ...track,
        copyTrack: value ? true : track.copyTrack,
        setForced: value,
      })),
    );
  };

  const moveTrack = (direction: "up" | "down") => {
    if (!selectedTrackId) return;
    const tracks = currentTracks;
    const idx = tracks.findIndex((t) => t.id === selectedTrackId);
    if (idx < 0) return;
    if (direction === "up" && idx > 0) {
      setCurrentTracks((prev) => {
        const newTracks = [...prev];
        [newTracks[idx - 1], newTracks[idx]] = [newTracks[idx], newTracks[idx - 1]];
        return newTracks;
      });
    } else if (direction === "down" && idx < tracks.length - 1) {
      setCurrentTracks((prev) => {
        const newTracks = [...prev];
        [newTracks[idx + 1], newTracks[idx]] = [newTracks[idx], newTracks[idx + 1]];
        return newTracks;
      });
    }
  };

  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const pointerDragActive = useRef(false);
  const pointerIdRef = useRef<number | null>(null);

  const handleDragEnd = useCallback(() => {
    if (
      dragItem.current !== null &&
      dragOverItem.current !== null &&
      dragItem.current !== dragOverItem.current
    ) {
      setCurrentTracks((prev) => {
        const newTracks = [...prev];
        const draggedItem = newTracks[dragItem.current!];
        newTracks.splice(dragItem.current!, 1);
        newTracks.splice(dragOverItem.current!, 0, draggedItem);
        return newTracks;
      });
    }
    dragItem.current = null;
    dragOverItem.current = null;
    setDraggedIndex(null);
    setDragOverIndex(null);
  }, [setCurrentTracks]);

  const startPointerDrag = (event: React.PointerEvent, index: number) => {
    event.preventDefault();
    pointerDragActive.current = true;
    pointerIdRef.current = event.pointerId;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragItem.current = index;
    dragOverItem.current = index;
    setDraggedIndex(index);
    setDragOverIndex(index);
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!pointerDragActive.current || pointerIdRef.current !== event.pointerId) return;
      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const row = target?.closest("[data-reorder-index]") as HTMLElement | null;
      if (!row) return;
      const idx = Number(row.dataset.reorderIndex);
      if (!Number.isFinite(idx) || idx === dragOverItem.current) return;
      dragOverItem.current = idx;
      setDragOverIndex(idx);
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!pointerDragActive.current || pointerIdRef.current !== event.pointerId) return;
      pointerDragActive.current = false;
      pointerIdRef.current = null;
      handleDragEnd();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [handleDragEnd]);

  const applyRowsToVideo = (file: VideoFile, rows: TrackRow[], type: Track["type"]) => {
    const tracks = file.tracks || [];
    const typeTracks = tracks.filter((track) => track.type === type);
    const updatedTypeTracks = typeTracks.map((track, index) => {
      const row = rows[index];
      if (!row) return track;

      const originalDefault = row.originalTrack.isDefault;
      const originalForced = row.originalTrack.isForced;

      let newDefault: boolean | undefined;
      if (originalDefault === undefined && row.setDefault === false) {
        newDefault = undefined;
      } else if (originalDefault !== row.setDefault) {
        newDefault = row.setDefault;
      } else {
        newDefault = originalDefault;
      }

      let newForced: boolean | undefined;
      if (originalForced === undefined && row.setForced === false) {
        newForced = undefined;
      } else if (originalForced !== row.setForced) {
        newForced = row.setForced;
      } else {
        newForced = originalForced;
      }

      const existingOriginalName = track.originalName ?? track.name ?? track.codec ?? "";
      const existingOriginalLanguage = track.originalLanguage ?? track.language ?? "";
      const existingOriginalDefault =
        track.originalDefault !== undefined ? track.originalDefault : track.isDefault;
      const existingOriginalForced =
        track.originalForced !== undefined ? track.originalForced : track.isForced;

      const nextName = row.trackName === "Multiple" ? track.name : row.trackName;
      const nextLanguage = row.language;
      const nextAction = row.copyTrack ? "keep" : "remove";
      const hasChanged =
        nextAction !== "remove" &&
        ((nextName || "") !== (track.name || "") ||
          (nextLanguage || "") !== (track.language || "") ||
          newDefault !== track.isDefault ||
          newForced !== track.isForced);
      return {
        ...track,
        name: nextName,
        language: nextLanguage,
        isDefault: newDefault,
        isForced: newForced,
        action: nextAction === "remove" ? "remove" : hasChanged ? "modify" : "keep",
        originalName: existingOriginalName,
        originalLanguage: existingOriginalLanguage,
        originalDefault: existingOriginalDefault,
        originalForced: existingOriginalForced,
      };
    });
    let typeIndex = 0;
    const merged = tracks.map((track) => (track.type === type ? updatedTypeTracks[typeIndex++] || track : track));
    return { ...file, tracks: merged };
  };

  const applyChanges = () => {
    const updated = videoFiles.map((file) => {
      if (selectedVideoId && file.id !== selectedVideoId) return file;
      let updatedFile = applyRowsToVideo(file, videoTracks, "video");
      updatedFile = applyRowsToVideo(updatedFile, subtitleTracks, "subtitle");
      updatedFile = applyRowsToVideo(updatedFile, audioTracks, "audio");
      return updatedFile;
    });
    onFilesChange(updated);
    onOpenChange(false);
  };

  return (
    <BaseModal
      open={open}
      onOpenChange={onOpenChange}
      title="Modify Old Tracks"
      subtitle="Edit existing tracks in source videos"
      icon={<Film className="w-5 h-5 text-primary" />}
      className="max-w-4xl"
      bodyClassName="p-0"
      footerLeft={
        <Button
          variant="ghost"
          className="h-9 px-4 text-sm text-muted-foreground hover:text-foreground gap-2"
          onClick={() => {
            const buildAggregatedRows = (type: Track["type"]) => {
              const trackLists = videoFiles.map((file) => (file.tracks || []).filter((track) => track.type === type));
              const maxCount = Math.max(0, ...trackLists.map((list) => list.length));
              const rows: TrackRow[] = [];
              for (let index = 0; index < maxCount; index += 1) {
                const tracksAtIndex = trackLists.map((list) => list[index]).filter(Boolean) as Track[];
                const names = tracksAtIndex.map((track) => track.name || track.codec || "");
                const languages = tracksAtIndex.map((track) => track.language || "und");
                const uniqueName =
                  names.find(Boolean) && names.every((name) => name === names[0]) ? names[0] : "Multiple";
                const uniqueLanguage =
                  languages.length > 0 && languages.every((lang) => lang === languages[0]) ? languages[0] : "und";
                const copyTrack = tracksAtIndex.length > 0 && tracksAtIndex.every((track) => track.action !== "remove");
                const setDefault = tracksAtIndex.length > 0 && tracksAtIndex.every((track) => track.isDefault);
                const setForced = tracksAtIndex.length > 0 && tracksAtIndex.every((track) => track.isForced);
                const trackWithBitrate =
                  type === "audio" ? tracksAtIndex.find((t) => t.bitrate !== undefined) || tracksAtIndex[0] : tracksAtIndex[0];

                rows.push({
                  id: `${type}-${index}`,
                  trackIndex: index + 1,
                  copyTrack,
                  setDefault,
                  setForced,
                  trackName: uniqueName || `Track ${index + 1}`,
                  language: uniqueLanguage,
                  originalTrack: trackWithBitrate || { id: `${type}-${index}`, type },
                } as TrackRow);
              }
              return rows;
            };

            setVideoTracks(buildAggregatedRows("video"));
            setSubtitleTracks(buildAggregatedRows("subtitle"));
            setAudioTracks(buildAggregatedRows("audio"));
          }}
        >
          <RotateCcw className="w-4 h-4" />
          Reset
        </Button>
      }
      footerRight={
        <>
          <Button variant="outline" className="h-9 px-5 text-sm text-muted-foreground hover:text-foreground" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="h-9 px-5 text-sm" onClick={applyChanges}>
            Apply Changes
          </Button>
        </>
      }
    >
      <div className="px-6 h-11 border-b border-panel-border/70 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {tabConfig.map((tab) => {
            const Icon = tab.icon;
            const count = tab.id === "videos" ? videoTracks.length : tab.id === "subtitles" ? subtitleTracks.length : audioTracks.length;
            return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1 text-sm font-medium rounded-md transition-all",
                    activeTab === tab.id
                      ? "bg-accent/60 text-primary border border-primary/30"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/40 border border-transparent",
                  )}
                >
                <Icon className="w-4 h-4" />
                {tab.label}
                <span className="text-xs text-muted-foreground">({count})</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="w-3.5 h-3.5" />
            Drag to reorder
          </div>
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground rounded-l-md rounded-r-none border border-panel-border"
              onClick={() => moveTrack("up")}
              disabled={!selectedTrackId}
            >
              <ChevronUp className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground rounded-r-md rounded-l-none border border-l-0 border-panel-border"
              onClick={() => moveTrack("down")}
              disabled={!selectedTrackId}
            >
              <ChevronDown className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col overflow-hidden px-6 py-2 h-[280px]">
        <ReorderableTable className="h-full min-h-0">
          <ReorderableTableHeader
            className={cn(
              "grid items-center py-2",
              activeTab === "audios"
                ? "grid-cols-[28px_56px_84px_84px_84px_96px_1fr_180px_44px]"
                : "grid-cols-[28px_56px_84px_84px_84px_1fr_180px_44px]",
            )}
          >
            <ReorderableTableCell className="center" />
            <ReorderableTableCell className="center">#</ReorderableTableCell>
            <ReorderableTableCell className="center">
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Copy</span>
                <Checkbox
                  className="h-3.5 w-7"
                  checked={allCopyChecked}
                  onCheckedChange={(checked) => setAllCopy(checked as boolean)}
                />
              </div>
            </ReorderableTableCell>
            <ReorderableTableCell className="center">
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Default</span>
                <Checkbox
                  className="h-3.5 w-7"
                  checked={allDefaultChecked}
                  onCheckedChange={(checked) => setAllDefault(checked as boolean)}
                />
              </div>
            </ReorderableTableCell>
            <ReorderableTableCell className="center">
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Forced</span>
                <Checkbox
                  className="h-3.5 w-7"
                  checked={allForcedChecked}
                  onCheckedChange={(checked) => setAllForced(checked as boolean)}
                />
              </div>
            </ReorderableTableCell>
            {activeTab === "audios" && <ReorderableTableCell className="center">Bitrate</ReorderableTableCell>}
            <ReorderableTableCell>Track Name</ReorderableTableCell>
            <ReorderableTableCell className="right">Language</ReorderableTableCell>
            <ReorderableTableCell className="center" />
          </ReorderableTableHeader>

          <ReorderableTableBody className="max-h-[220px] overflow-y-auto">
            {currentTracks.length === 0 ? (
              <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">No tracks available</div>
            ) : (
              currentTracks.map((track, index) => (
                <ReorderableRow
                  key={track.id}
                  onClick={() => setSelectedTrackId(track.id)}
                  onMouseDown={() => setSelectedTrackId(track.id)}
                  selected={selectedTrackId === track.id}
                  dragging={draggedIndex === index}
                  dropTarget={dragOverIndex === index}
                  data-reorder-index={index}
                  className={cn(
                    "group grid items-center cursor-pointer h-12",
                    activeTab === "audios"
                      ? "grid-cols-[28px_56px_84px_84px_84px_96px_minmax(260px,1fr)_180px_44px]"
                      : "grid-cols-[28px_56px_84px_84px_84px_minmax(260px,1fr)_180px_44px]",
                  )}
                >
                  <ReorderableTableCell className="center">
                    <ReorderHandle
                      className="flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity touch-none"
                      onPointerDown={(event) => startPointerDrag(event, index)}
                    >
                      <GripVertical className="w-4 h-4" />
                    </ReorderHandle>
                  </ReorderableTableCell>
                  <ReorderableTableCell className="center text-muted-foreground/80 font-mono text-sm">
                    {String(index + 1).padStart(2, "0")}
                  </ReorderableTableCell>
                  <ReorderableTableCell
                    className="center flex items-center justify-center"
                    onClick={() => handleTrackChange(track.id, "copyTrack", !track.copyTrack)}
                  >
                    <Checkbox
                      checked={track.copyTrack}
                      onCheckedChange={(checked) => handleTrackChange(track.id, "copyTrack", checked as boolean)}
                      className="h-3.5 w-7"
                    />
                  </ReorderableTableCell>
                  <ReorderableTableCell
                    className="center flex items-center justify-center"
                    onClick={() => {
                      if (!track.copyTrack) return;
                      handleTrackChange(track.id, "setDefault", !track.setDefault);
                    }}
                  >
                    <Checkbox
                      checked={track.setDefault}
                      disabled={!track.copyTrack}
                      onCheckedChange={(checked) => handleTrackChange(track.id, "setDefault", checked as boolean)}
                      className={cn(
                        "h-3.5 w-7",
                        !track.copyTrack && "cursor-not-allowed",
                      )}
                    />
                  </ReorderableTableCell>
                  <ReorderableTableCell
                    className="center flex items-center justify-center"
                    onClick={() => {
                      if (!track.copyTrack) return;
                      handleTrackChange(track.id, "setForced", !track.setForced);
                    }}
                  >
                    <Checkbox
                      checked={track.setForced}
                      disabled={!track.copyTrack}
                      onCheckedChange={(checked) => handleTrackChange(track.id, "setForced", checked as boolean)}
                      className={cn(
                        "h-3.5 w-7",
                        !track.copyTrack && "cursor-not-allowed",
                      )}
                    />
                  </ReorderableTableCell>
                  {activeTab === "audios" && (
                    <ReorderableTableCell className="center text-muted-foreground font-mono">
                      {track.originalTrack.bitrate ? `${Math.round(track.originalTrack.bitrate / 1000)} kbps` : "—"}
                    </ReorderableTableCell>
                  )}
                  <ReorderableTableCell className="pl-2 pr-2">
                    {editingTrackId === track.id ? (
                      <TextField
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={finishEditing}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") finishEditing();
                          if (e.key === "Escape") {
                            setEditingTrackId(null);
                            setEditingName("");
                          }
                        }}
                        autoFocus
                        className="h-7 text-sm"
                      />
                  ) : (
                    <div
                      className="text-sm text-foreground break-words leading-snug cursor-text hover:text-primary transition-colors"
                      onDoubleClick={() => startEditing(track)}
                      title="Double-click to edit"
                    >
                      {track.trackName}
                    </div>
                  )}
                </ReorderableTableCell>
                  <ReorderableTableCell className="pr-4">
                    <LanguageSelect
                      value={track.language}
                      onChange={(value) => handleTrackChange(track.id, "language", value)}
                      className="h-8 justify-end bg-input/40 border border-panel-border/40 hover:bg-input/60"
                    />
                  </ReorderableTableCell>
                  {activeTab !== "videos" ? (
                    <ReorderableTableCell className="center" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => deleteTrack(track.id)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </ReorderableTableCell>
                  ) : (
                    <ReorderableTableCell className="center" />
                  )}
                </ReorderableRow>
              ))
            )}
          </ReorderableTableBody>
        </ReorderableTable>
      </div>

      <div className="px-6 pt-3 pb-3 border-t border-panel-border/40 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Track Info Across Videos</h3>
          <span className="text-[11px] text-muted-foreground bg-muted/40 px-2 py-1 rounded-full">
            Track {String(selectedTrackNumber).padStart(2, "0")}
          </span>
        </div>

        <DataTable>
          <DataTableHeader className="grid grid-cols-[1fr_70px_70px_70px_minmax(220px,1fr)_120px] items-center">
            <DataTableCell>Video</DataTableCell>
            <DataTableCell className="center">Found</DataTableCell>
            <DataTableCell className="center">Def</DataTableCell>
            <DataTableCell className="center">Frc</DataTableCell>
            <DataTableCell>Name</DataTableCell>
            <DataTableCell className="right">Language</DataTableCell>
          </DataTableHeader>
          <DataTableBody className="max-h-32">
            {videoFiles.map((file, index) => {
              const tracks = (file.tracks || []).filter((track) =>
                activeTab === "videos" ? track.type === "video" : activeTab === "subtitles" ? track.type === "subtitle" : track.type === "audio",
              );
              const selectedIndex = selectedIndexRaw >= 0 ? selectedIndexRaw : 0;
              const selectedTrack = tracks[selectedIndex];
              const hasDefault = selectedTrack?.isDefault;
              const hasForced = selectedTrack?.isForced;
              return (
                <DataTableRow
                  key={file.id}
                  className="grid grid-cols-[1fr_70px_70px_70px_minmax(220px,1fr)_120px] items-center"
                >
                  <DataTableCell className="text-muted-foreground truncate pr-2" title={file.name}>
                    <span className="text-primary mr-1">{index + 1}.</span>
                    {file.name}
                  </DataTableCell>
                  <DataTableCell className="center">
                    {selectedTrack ? <Check className="w-4 h-4 text-success" /> : <X className="w-4 h-4 text-destructive/50" />}
                  </DataTableCell>
                  <DataTableCell className="center">
                    {hasDefault ? <Check className="w-4 h-4 text-success" /> : <X className="w-4 h-4 text-destructive/50" />}
                  </DataTableCell>
                  <DataTableCell className="center">
                    {hasForced ? <Check className="w-4 h-4 text-success" /> : <X className="w-4 h-4 text-destructive/50" />}
                  </DataTableCell>
                  <DataTableCell className="text-foreground break-words leading-snug" title={selectedTrack?.name || selectedTrack?.codec || ""}>
                    {selectedTrack?.name || selectedTrack?.codec || "-"}
                  </DataTableCell>
                  <DataTableCell className="right text-primary">
                    {selectedTrack?.language ? CODE_TO_LABEL[selectedTrack.language] || selectedTrack.language : "-"}
                  </DataTableCell>
                </DataTableRow>
              );
            })}
          </DataTableBody>
        </DataTable>
      </div>
    </BaseModal>
  );
}
